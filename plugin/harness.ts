/**
 * harness.ts — OpenCode v2 server plugin (WASM edition)
 *
 * The Rust DAG state machine is compiled to WASM and loaded directly into
 * this process.  No separate binary is spawned; no HTTP server is started.
 *
 * Data flow:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  OpenCode                                                           │
 *   │    └─ loads plugin/harness.ts  (Plugin.define → setup(ctx))         │
 *   │         └─ initSync(readFileSync("...wasm"))  → DagEngine in-proc  │
 *   │         └─ get_agent_configs() → write .md files on first boot     │
 *   │         └─ setInterval 500ms → dag.tick() → session + prompt       │
 *   │         └─ ctx.event.subscribe(): session.idle / session.status     │
 *   │            (idle) / session.execution.failed → dag.process_event()  │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * The Rust engine still speaks the v1 event names ("session.idle",
 * "session.error"); the v2 events are mapped onto them here.
 *
 * Native-dispatch mode
 * ────────────────────
 * Workflows submitted with native_dispatch:true are executed through
 * OpenCode's native `subagent` tool instead of the plugin's own
 * session-creation loop.  This makes every agent turn visible as a
 * collapsible subagent block inside the orchestrator's conversation.
 *
 * Protocol (orchestrator side):
 *   1. submit_plan({ plan_id, native_dispatch: true }) → { workflow_id }
 *   2. LOOP until status is "done", "failed", or "cancelled":
 *      a. harness_dispatch_tasks({ workflow_id }) → { status, tasks }
 *      b. For each task call the `subagent` tool with the task's agent,
 *         description and prompt.
 *      c. When each subagent call returns, read the child session id from the
 *         `sessionID` attribute of `<subagent sessionID="ses_…" state="…">`
 *         (or from "Subagent failed (sessionID: ses_…)" when it errored).
 *      d. harness_task_complete({ task_id, session_id, status: "done" | "failed" })
 *   3. harness_state({ workflow_id }) for final results.
 *
 * Cancellation
 * ────────────
 * harness_cancel({ workflow_id } | { task_id }) cancels a workflow or a single
 * task (cascading to its transitive dependents), interrupts + deletes the
 * backing OpenCode session(s), and flips harness_dispatch_tasks into terminal
 * "cancelled" status for the affected workflow. Late idle/error events for
 * interrupted sessions are dropped via the `cancelledSessions` guard so they
 * can't resurrect a cancelled task through orphaned-event replay.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import { Plugin } from "@opencode/plugin";
import {
  DagEngine,
  agent_fallback_configs_json,
  get_agent_configs,
  initSync,
} from "./wasm/openagent_harness.js";

import type { EventResult, WorkflowTaskInput } from "./types.js";
import { classifyError, extractErrorMessage } from "./errors.js";
import { installAgentsInto } from "./agent-install.js";
import {
  createPlanArtifact,
  savePlanArtifact,
  loadPlanArtifact,
  validatePlanId,
} from "./plans.js";
import {
  createSession,
  sendMessage,
  deleteSession,
  showToast,
} from "./client.js";
import {
  listHarnessWorkflows,
  getHarnessWorkflowSnapshot,
  extractWorkflowStatus,
  findOwningWorkflowId,
  sleep,
  handleEventResult,
  cleanupOrphanedSession,
  bindSessionOrCleanup,
} from "./dag.js";
import { BoundedSet, BoundedMap } from "./bounded.js";
import {
  createCard,
  appendTrace,
  assembleContext,
  promoteFinding,
  listActiveCards,
} from "./memory.js";
import {
  type JsonSchema,
  arr,
  bool,
  enumOf,
  num,
  obj,
  optional,
  str,
} from "./json-schema.js";

/** A v2 event as yielded by `ctx.event.subscribe()`. */
type V2Event =
  ReturnType<Plugin.Context["event"]["subscribe"]> extends AsyncIterable<
    infer E
  >
    ? E
    : never;

/** The subset of the v2 tool context the harness tools read. */
interface HarnessToolContext {
  sessionID: string;
  agent: string;
}

interface HarnessToolDef<I> {
  name: string;
  description: string;
  input: JsonSchema;
  execute: (input: I, context: HarnessToolContext) => Promise<string>;
}

/** Window in which a second idle signal for the same session is a duplicate. */
const IDLE_DEDUPE_MS = 2000;

// ─── WASM initialisation ──────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * Load and initialise the WASM module synchronously so the plugin is ready
 * before the first hook fires.
 */
function loadWasm(): DagEngine {
  const wasmPath = join(__dir, "wasm", "openagent_harness_bg.wasm");
  const wasmBytes = readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  return new DagEngine();
}

// ─── Agent config installation ────────────────────────────────────────────────

/**
 * Write all embedded agent configs to `~/.config/opencode/agents/` the first
 * time the plugin loads.  Skips existing files so user edits are preserved,
 * except stale v1-format files (top-level `permission:` map), which are
 * overwritten — same rule as `openagent-harness install`.
 *
 * This replaces the need to run `openagent-harness install` manually — the
 * configs are embedded in the WASM binary and installed automatically.
 */
function installAgentsIfNeeded(): number {
  try {
    const agentsDir = join(homedir(), ".config", "opencode", "agents");
    const configs: Record<string, string> = JSON.parse(get_agent_configs());
    return installAgentsInto(agentsDir, configs);
  } catch (e) {
    console.error("[harness-plugin] agent install failed (non-fatal):", e);
    return 0;
  }
}

/**
 * Flatten a v2 tool result (`{ content?, output? }`) to the string the Rust
 * engine records. Text content parts are joined; a string `output` is the
 * fallback.
 */
function toolResultText(result: {
  content?: string | ReadonlyArray<{ type: string; text?: string }>;
  output?: unknown;
}): string | undefined {
  const { content, output } = result;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (text) return text;
  }
  return typeof output === "string" ? output : undefined;
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default Plugin.define({
  id: "openagent-harness",

  async setup(ctx) {
    // v2 session adapter: every client.ts helper takes `ctx.session`.
    const client = ctx.session;

    // Load WASM DAG engine.
    const dag = loadWasm();
    void showToast("Harness Plugin", "WASM DAG engine loaded", "info", 5000);

    // Install agent configs the first time this plugin runs.
    const installed = installAgentsIfNeeded();
    if (installed > 0) {
      void showToast(
        "Harness Plugin",
        `Installed ${installed} agent config(s)`,
        "info",
      );
    }

    // Load agent fallback configs from WASM and register with DAG engine.
    try {
      const fallbackConfigs = agent_fallback_configs_json();
      dag.set_agent_fallbacks(fallbackConfigs);
      void showToast(
        "Harness Plugin",
        "Agent fallback models registered",
        "info",
        5000,
      );
    } catch (e) {
      console.error(
        "[harness-plugin] fallback config load failed (non-fatal):",
        e,
      );
    }

    // ── Native-dispatch state ────────────────────────────────────────────────
    //
    // Workflows added to `nativeDispatchWorkflows` are dispatched through the
    // orchestrator's own `subagent` tool calls (native OpenCode subagents), not
    // by the plugin tick loop.  Tasks belonging to these workflows are placed
    // in `nativeDispatchBuffer` by the tick loop instead of being
    // session-created.
    //
    // Orphaned-event buffers hold idle / error events that fired for sessions
    // the DAG doesn't yet know about.  This happens because the subagent tool
    // is synchronous: the agent may complete (firing idle) before the
    // orchestrator calls harness_task_complete to register the session
    // mapping.  We replay the buffered events at registration time.

    /** Set of workflow IDs whose tasks are dispatched via `subagent`, not by the tick loop. */
    const nativeDispatchWorkflows = new Set<string>();

    /**
     * Buffer of tasks ready to be dispatched natively, keyed by workflow_id.
     * The tick loop populates this instead of creating sessions for these tasks.
     */
    const nativeDispatchBuffer = new Map<
      string,
      Array<{
        id: string;
        prompt: string;
        model: string;
        agent: string | null;
        parent_session_id: string | null;
        fallback_models: string[];
        existing_session_id?: string | null;
        workflow_id?: string | null;
      }>
    >();

    /**
     * Buffer for idle events whose session ID is not yet registered in the
     * DAG's session_to_task map.  Replayed when harness_task_complete registers
     * the mapping.
     */
    const orphanedIdleEvents = new Map<string, unknown>();

    /**
     * Buffer for session-error events whose session ID is not yet registered.
     * Value is the extracted error message string.
     */
    const orphanedErrorEvents = new Map<string, string>();

    // Reviews deferred because the target task was still Running when submit_review was called.
    // Keyed by target task_id; value is the serialized review JSON string.
    //
    // Bounded (same discipline as `cancelledSessions` below) for defense in
    // depth: a review for a task that gets cancelled instead of completing
    // would otherwise sit here forever, retried on every subsequent
    // idle with no eviction. Cancellation paths also proactively
    // delete the entry for any cancelled task_id (see harness_cancel).
    const PENDING_REVIEWS_CAP = 1000;
    const pendingReviews = new BoundedMap<string, string>(PENDING_REVIEWS_CAP);

    // ── Cancellation state ───────────────────────────────────────────────────
    //
    // Sessions that belonged to a task/workflow cancelled via `harness_cancel`,
    // or a session `dag.task_started()` refused to bind because its task was
    // already terminal by the time the session was created (see
    // `cleanupOrphanedSession` in dag.ts). The DAG engine never registers a
    // session_to_task mapping for these, so a late idle / failed event would
    // otherwise be treated as an "orphaned" event and buffered for
    // native-dispatch replay — which would incorrectly resurrect a cancelled
    // task. The event handlers (and the tool `execute.after` hook) check this
    // set first and drop matching events outright.
    //
    // Entries are removed once their terminating event is observed. A hard cap
    // guards against unbounded growth if a session never produces an event
    // (e.g. the provider silently drops an interrupted request).
    const CANCELLED_SESSIONS_CAP = 1000;
    const cancelledSessions = new BoundedSet<string>(CANCELLED_SESSIONS_CAP);

    // ── Idle de-duplication ──────────────────────────────────────────────────
    //
    // v2 may signal "session went idle" twice: `session.idle` and
    // `session.status` with `status.type === "idle"`. Only the first one per
    // idle transition may reach the engine. A duplicate is any idle signal for
    // the same session within IDLE_DEDUPE_MS of the last handled one with no
    // busy/retry status in between (a busy/retry status resets the marker so a
    // reused session's next idle is never swallowed).
    const idleHandledAt = new BoundedMap<string, number>(1000);

    let disposed = false;

    // ── Tick loop ────────────────────────────────────────────────────────────
    // Every 500 ms, find unblocked tasks and start them in OpenCode sessions.
    // Tasks belonging to native-dispatch workflows are buffered instead.

    let ticking = false;

    const tickInterval = setInterval(async () => {
      if (ticking || disposed) return;
      ticking = true;
      try {
        const readyTasks = JSON.parse(dag.tick()) as Array<{
          id: string;
          prompt: string;
          model: string;
          agent: string | null;
          parent_session_id: string | null;
          fallback_models: string[];
          existing_session_id?: string | null;
          workflow_id?: string | null;
        }>;

        for (const task of readyTasks) {
          // ── Native dispatch: buffer instead of creating a session ────────
          const wfId = task.workflow_id ?? null;
          if (wfId && nativeDispatchWorkflows.has(wfId)) {
            let buf = nativeDispatchBuffer.get(wfId);
            if (!buf) {
              buf = [];
              nativeDispatchBuffer.set(wfId, buf);
            }
            buf.push(task);
            continue;
          }

          // ── Plugin dispatch: create session and send prompt ──────────────
          let sessionId: string | null = null;
          try {
            if (task.existing_session_id) {
              // Session was pre-assigned from a prior task's reuse — skip createSession.
              sessionId = task.existing_session_id;
            } else {
              const agentName = task.agent ?? undefined;
              const taskLabel = task.id.slice(0, 8);
              const title = agentName
                ? `@${agentName}: ${taskLabel}`
                : `task: ${taskLabel}`;
              sessionId = await createSession(
                client,
                task.parent_session_id,
                title,
                agentName,
              );
            }

            // BLOCKING BUG FIX: the task may have been cancelled via
            // harness_cancel while the session above was being set up — either
            // a brand-new createSession() call in flight (fresh-session path
            // above), or the tick-interval-sized gap between a reuse
            // assignment (existing_session_id, first bound in
            // handleEventResult when the prior task went idle) and this tick
            // picking the task back up (reuse path above). bindSessionOrCleanup
            // checks dag.task_started()'s return value for us and cleans up
            // the session as orphaned if the bind was refused — applied
            // unconditionally after BOTH branches above, so neither one can
            // silently skip the check the way the reuse path once did.
            const bound = await bindSessionOrCleanup(
              dag,
              client,
              task.id,
              sessionId,
              cancelledSessions,
            );
            if (!bound) continue;
            await sendMessage(
              client,
              sessionId,
              task.prompt,
              task.model,
              task.agent,
            );
            void showToast(
              "Task Started",
              `Task ${task.id} dispatched`,
              "info",
              5000,
            );
          } catch (e) {
            console.error(
              `[harness-plugin] failed to start task ${task.id}:`,
              e,
            );
            const message = e instanceof Error ? e.message : String(e);
            const classification = classifyError(message);
            void showToast(
              "Harness Plugin",
              `Error classified as ${classification}`,
              classification === "retryable" ? "warning" : "error",
            );

            if (
              classification === "retryable" &&
              task.fallback_models &&
              task.fallback_models.length > 0
            ) {
              try {
                const fallbackResult = JSON.parse(
                  dag.try_fallback(task.id, message),
                );
                void showToast(
                  "Fallback",
                  `Task ${task.id} falling back to ${fallbackResult.new_model}`,
                  "warning",
                );
                if (sessionId) await deleteSession(client, sessionId);
                // Task is Pending again — next tick will pick it up
                continue;
              } catch {
                // No more fallbacks — fall through to fail
              }
            }

            try {
              const { session_id } = JSON.parse(
                dag.fail_task(task.id, message),
              ) as {
                session_id: string | null;
              };
              if (session_id) await deleteSession(client, session_id);
            } catch {
              // already terminal — ignore
            }
          }
        }
      } catch (e) {
        if (!disposed) console.error("[harness-plugin] tick failed:", e);
      } finally {
        ticking = false;
      }
    }, 500);

    // ── Tools ────────────────────────────────────────────────────────────────
    //
    // Tool names are deliberately un-namespaced: agents and skills reference
    // them verbatim (plan_task, save_plan, harness_dispatch_tasks, …).

    const tools: Array<HarnessToolDef<any>> = [];
    const defineTool = <I>(def: HarnessToolDef<I>) => {
      tools.push(def);
    };

    defineTool<{
      tasks: Array<{
        agent: string;
        prompt: string;
        depends_on: number[];
        model?: string;
      }>;
    }>({
      name: "submit_workflow",
      description:
        "Orchestrator-only low-level escape hatch: submit a workflow tasks array directly to the harness DAG. Returns a workflow_id for tracking.",
      input: obj({
        tasks: arr(
          obj({
            agent: str(),
            prompt: str(),
            depends_on: arr(num()),
            model: optional(str()),
          }),
        ),
      }),
      async execute({ tasks }, context) {
        if (context.agent !== "orchestrator") {
          throw new Error(
            "submit_workflow can only be executed by the orchestrator agent",
          );
        }
        return dag.submit_workflow(JSON.stringify(tasks), context.sessionID);
      },
    });

    defineTool<{
      agent: string;
      prompt: string;
      depends_on?: number[];
      model?: string;
      plan_id?: string;
    }>({
      name: "plan_task",
      description: [
        "Planner-only: append exactly one task to an in-progress plan draft.",
        "Call this once per task instead of building the whole tasks array up",
        "front. The first call may omit plan_id — the response's plan_id must",
        "then be captured and passed on every subsequent call so all tasks land",
        "in the same draft. depends_on indices refer only to tasks already",
        "appended to this draft (0-based, backward-only). Once every task has",
        "been appended, call save_plan with the same plan_id (no tasks arg — it",
        "reads the accumulated draft) to finalize and persist the plan.",
      ].join("\n"),
      input: obj({
        agent: str(),
        prompt: str(),
        depends_on: optional(arr(num())),
        model: optional(str()),
        plan_id: optional(str()),
      }),
      async execute({ agent, prompt, depends_on, model, plan_id }, context) {
        if (context.agent !== "planner") {
          throw new Error(
            "plan_task can only be executed by the planner agent",
          );
        }

        if (plan_id !== undefined) {
          validatePlanId(plan_id);
        }

        const taskJson = JSON.stringify({
          agent,
          prompt,
          depends_on: depends_on ?? [],
          ...(model !== undefined ? { model } : {}),
        });

        try {
          return dag.append_plan_task(taskJson, plan_id);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`plan_task failed: ${msg}`);
        }
      },
    });

    defineTool<{
      plan_id: string;
      summary: string[];
      recommendations?: string[];
    }>({
      name: "save_plan",
      description:
        "Planner-only: finalize an in-progress plan draft (built via plan_task) into a persisted artifact under .opencode/plans and return its reference metadata.",
      input: obj({
        plan_id: str(),
        summary: arr(str()),
        recommendations: optional(arr(str())),
      }),
      async execute({ plan_id, summary, recommendations }, context) {
        if (context.agent !== "planner") {
          throw new Error(
            "save_plan can only be executed by the planner agent",
          );
        }

        let draftJson: string;
        try {
          draftJson = dag.get_plan_draft(plan_id);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(msg);
        }

        const tasks = JSON.parse(draftJson) as WorkflowTaskInput[];

        const artifact = createPlanArtifact({
          plan_id,
          tasks,
          summary,
          recommendations,
        });

        const path = savePlanArtifact(artifact);

        // Discard only after the artifact is durably on disk — a write
        // failure above must never destroy the accumulated draft, since
        // the planner would then have to rebuild it from scratch.
        try {
          dag.discard_plan_draft(plan_id);
        } catch (e) {
          console.error(
            `[harness-plugin] discard_plan_draft(${plan_id}) failed (non-fatal, artifact already saved):`,
            e,
          );
        }

        return JSON.stringify({
          plan_id: artifact.id,
          path,
          task_count: artifact.tasks.length,
          summary: artifact.summary,
          recommendations: artifact.recommendations,
        });
      },
    });

    defineTool<{ plan_id: string; native_dispatch?: boolean }>({
      name: "submit_plan",
      description:
        "Orchestrator-only: load a saved plan artifact by plan_id and submit its tasks to the harness DAG. Set native_dispatch:true to execute agents as visible OpenCode subagents (recommended — agents appear inline in the conversation).",
      input: obj({
        plan_id: str(),
        native_dispatch: optional(bool()),
      }),
      async execute({ plan_id, native_dispatch }, context) {
        if (context.agent !== "orchestrator") {
          throw new Error(
            "submit_plan can only be executed by the orchestrator agent",
          );
        }
        const artifact = loadPlanArtifact(plan_id);
        const result = dag.submit_workflow(
          JSON.stringify(artifact.tasks),
          context.sessionID,
        );
        const parsed = JSON.parse(result) as {
          workflow_id: string;
          task_ids: string[];
        };

        if (native_dispatch) {
          nativeDispatchWorkflows.add(parsed.workflow_id);
        }

        return result;
      },
    });

    defineTool<{ workflow_id?: string }>({
      name: "harness_state",
      description:
        "Read-only harness visibility. Without workflow_id lists workflows; with workflow_id returns workflow snapshot.",
      input: obj({ workflow_id: optional(str()) }),
      async execute({ workflow_id }) {
        const payload = workflow_id
          ? {
              workflow_id,
              snapshot: getHarnessWorkflowSnapshot(dag, workflow_id),
            }
          : { workflows: listHarnessWorkflows(dag) };
        return JSON.stringify(payload);
      },
    });

    defineTool<{ workflow_id?: string; task_id?: string; reason?: string }>({
      name: "harness_cancel",
      description: [
        "Cancel a pending/running workflow or a single task (cascades to its",
        "transitive dependents). Provide exactly one of workflow_id or task_id.",
        "reason is informational only and is not persisted.",
        "Aborts and deletes the OpenCode session(s) backing any cancelled task.",
        "After cancelling a workflow, harness_dispatch_tasks returns a terminal",
        "'cancelled' status for it — stop the native-dispatch loop when you see it.",
      ].join("\n"),
      input: obj({
        workflow_id: optional(str()),
        task_id: optional(str()),
        reason: optional(str()),
      }),
      async execute({ workflow_id, task_id }) {
        if (Boolean(workflow_id) === Boolean(task_id)) {
          return "harness_cancel requires exactly one of workflow_id or task_id (got both or neither)";
        }

        let raw: string;
        try {
          raw = workflow_id
            ? dag.cancel_workflow(workflow_id)
            : dag.cancel_task(task_id as string);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return `cancel failed: ${msg}`;
        }

        const { cancelled_task_ids, session_ids } = JSON.parse(raw) as {
          cancelled_task_ids: string[];
          session_ids: string[];
        };

        // Stop native-dispatch delivery for the cancelled work immediately —
        // do not wait for the next harness_dispatch_tasks poll.
        if (workflow_id) {
          nativeDispatchWorkflows.delete(workflow_id);
          nativeDispatchBuffer.delete(workflow_id);
        } else {
          const cancelledSet = new Set(cancelled_task_ids);
          for (const [wfId, buf] of nativeDispatchBuffer) {
            const filtered = buf.filter((t) => !cancelledSet.has(t.id));
            if (filtered.length !== buf.length) {
              nativeDispatchBuffer.set(wfId, filtered);
            }
          }
        }

        // A cancelled task will never reach Done, so any deferred review
        // sitting in pendingReviews for it would otherwise be retried
        // forever on every subsequent idle. Drop it now.
        for (const tid of cancelled_task_ids) {
          pendingReviews.delete(tid);
        }

        // Interrupt + delete every session backing a cancelled task.
        // Best-effort: engine state is already Cancelled regardless of
        // transport outcome. cleanupOrphanedSession tracks each session as
        // cancelled BEFORE interrupting it, so the interrupt-induced
        // idle/failed event is guaranteed to be dropped by the
        // cancelledSessions guard in the event handlers instead of being
        // misclassified as a real provider failure.
        let aborted = 0;
        for (const sid of session_ids) {
          const ok = await cleanupOrphanedSession(
            client,
            sid,
            cancelledSessions,
          );
          if (ok) aborted++;
        }

        // Best-effort workflow status lookup for the summary. task_id cancels
        // don't carry a workflow_id in the engine response, so resolve it by
        // scanning workflow membership.
        const resolvedWorkflowId =
          workflow_id ?? findOwningWorkflowId(dag, task_id as string);
        const wfStatus = resolvedWorkflowId
          ? extractWorkflowStatus(
              JSON.parse(dag.get_workflow(resolvedWorkflowId)),
            )
          : null;

        // A task-level cancel can also cancel its whole workflow (e.g. it was
        // the last active branch) — stop native dispatch for it too in that case.
        if (!workflow_id && resolvedWorkflowId && wfStatus === "cancelled") {
          nativeDispatchWorkflows.delete(resolvedWorkflowId);
          nativeDispatchBuffer.delete(resolvedWorkflowId);
        }

        return (
          `Cancelled ${cancelled_task_ids.length} task(s)` +
          (resolvedWorkflowId ? ` in workflow ${resolvedWorkflowId}` : "") +
          `. Sessions aborted: ${aborted}/${session_ids.length}.` +
          ` Workflow status: ${wfStatus ?? "unknown"}.`
        );
      },
    });

    defineTool<{ workflow_id: string; timeout_ms?: number }>({
      name: "harness_dispatch_tasks",
      description: [
        "Poll a native-dispatch workflow for the next batch of ready tasks.",
        "Returns when at least one task is ready OR the workflow reaches a terminal state.",
        "After this returns tasks_ready, spawn each task with the `subagent` tool using:",
        "  - agent: the task's agent field",
        "  - description: the task's description field ('[harness-task:<task_id>] @<agent>')",
        "  - prompt: the task's prompt field",
        "When the subagent call returns, read the child session id from the sessionID",
        "attribute of its '<subagent sessionID=\"ses_...\" state=\"completed\">' output",
        "(or from 'Subagent failed (sessionID: ses_...)' if it errored), then call",
        "harness_task_complete for that task.",
        "Repeat until status is 'done', 'failed' or 'cancelled'.",
      ].join("\n"),
      input: obj({
        workflow_id: str(),
        timeout_ms: optional(num()),
      }),
      async execute({ workflow_id, timeout_ms }) {
        const timeoutMs = timeout_ms ?? 120_000;
        const startedAt = Date.now();

        // Ensure this workflow is flagged as native-dispatch.
        nativeDispatchWorkflows.add(workflow_id);

        while (true) {
          // Check terminal state first.
          const snapshot = getHarnessWorkflowSnapshot(dag, workflow_id);
          if (snapshot === null) {
            return JSON.stringify({ status: "missing", workflow_id });
          }
          const wfStatus = extractWorkflowStatus(snapshot);
          if (
            wfStatus === "done" ||
            wfStatus === "failed" ||
            wfStatus === "cancelled"
          ) {
            return JSON.stringify({ status: wfStatus, snapshot, tasks: [] });
          }

          // Drain the native-dispatch buffer for this workflow.
          const buf = nativeDispatchBuffer.get(workflow_id);
          if (buf && buf.length > 0) {
            const tasks = buf.splice(0, buf.length);
            return JSON.stringify({
              status: "tasks_ready",
              tasks: tasks.map((t) => ({
                task_id: t.id,
                agent: t.agent ?? "builder",
                prompt: t.prompt,
                model: t.model,
                // Do NOT expose existing_session_id — native dispatch always spawns fresh.
                description: `[harness-task:${t.id}] @${t.agent ?? "builder"}`,
              })),
            });
          }

          if (Date.now() - startedAt >= timeoutMs) {
            return JSON.stringify({
              status: "timeout",
              elapsed_ms: Date.now() - startedAt,
              tasks: [],
            });
          }

          await sleep(500);
        }
      },
    });

    defineTool<{
      task_id: string;
      session_id: string;
      status: "done" | "failed";
      error?: string;
    }>({
      name: "harness_task_complete",
      description: [
        "Register the completion of a natively-dispatched task after its `subagent` tool call returns.",
        "",
        "Pass:",
        "  task_id   — from the tasks array returned by harness_dispatch_tasks",
        "  session_id — the child session id: the sessionID attribute of the",
        "               '<subagent sessionID=\"ses_...\" ...>' output, or the id in",
        "               'Subagent failed (sessionID: ses_...)'",
        "  status    — 'done' if the subagent call succeeded, 'failed' if it errored",
        "  error     — (optional) error message when status is 'failed'",
        "",
        "This call links the session to the DAG task, replays any already-received",
        "idle / error events, and advances the workflow.",
      ].join("\n"),
      input: obj({
        task_id: str(),
        session_id: str(),
        status: enumOf("done", "failed"),
        error: optional(str()),
      }),
      async execute({ task_id, session_id, status, error }) {
        // Register the session → task mapping in the DAG.
        // bindSessionOrCleanup checks dag.task_started()'s return value
        // for us: it's false when the task is already terminal —
        // typically Cancelled (e.g. via harness_cancel while this
        // native-dispatch subagent call was still in flight), but the
        // DAG's guard also rejects Done/Failed defensively. In that case
        // it also cleans up the now-orphaned session; discard the result
        // gracefully here: never resurrect a terminal task into
        // Done/Failed, and never register/replay/fallback for it.
        const bound = await bindSessionOrCleanup(
          dag,
          client,
          task_id,
          session_id,
          cancelledSessions,
        );
        if (!bound) {
          pendingReviews.delete(task_id);
          return JSON.stringify({
            registered: false,
            task_id,
            session_id,
            status: "cancelled",
            message:
              "task was already cancelled (or otherwise terminal); result discarded",
          });
        }

        if (status === "done") {
          // Replay any buffered idle event (agent may have completed before
          // this call was made — the event handler buffered it then).
          const bufferedProps = orphanedIdleEvents.get(session_id) ?? {};
          orphanedIdleEvents.delete(session_id);

          const result: EventResult = JSON.parse(
            dag.process_event(
              "session.idle",
              session_id,
              JSON.stringify(bufferedProps),
            ),
          );

          // For native-dispatch workflows, never reuse sessions across tasks —
          // the orchestrator always spawns fresh via the subagent tool.
          // Convert reuse_session → delete_session so the session is cleaned up.
          if (result.reuse_session && !result.delete_session) {
            result.delete_session = session_id;
            result.reuse_session = undefined;
          }

          await handleEventResult(result, client, dag);

          return JSON.stringify({
            registered: true,
            task_id,
            session_id,
            status: "done",
          });
        } else {
          // Failed path: use buffered error message or the caller-supplied error.
          const errMsg =
            orphanedErrorEvents.get(session_id) ?? // real provider error from the failed event
            error ?? // orchestrator-supplied fallback
            "native task reported failure";
          const errSource = orphanedErrorEvents.has(session_id)
            ? "session.error"
            : error !== undefined
              ? "caller"
              : "default";
          orphanedErrorEvents.delete(session_id);
          console.log(
            `[harness] task_complete failed: task_id=${task_id} session_id=${session_id} source=${errSource} errMsg=${errMsg}`,
          );
          const classification = classifyError(errMsg);
          console.log(
            `[harness] task_complete classification=${classification} hasMoreFallbacks will be evaluated next`,
          );
          const taskJson = JSON.parse(dag.get_task(task_id)) as {
            fallback_models?: string[];
            model_attempt?: number;
          } | null;

          const hasMoreFallbacks =
            taskJson != null &&
            Array.isArray(taskJson.fallback_models) &&
            (taskJson.model_attempt ?? 0) < taskJson.fallback_models.length;

          if (classification === "retryable" && hasMoreFallbacks) {
            try {
              const fallbackResult = JSON.parse(
                dag.try_fallback(task_id, errMsg),
              ) as { fallback: boolean; new_model: string; attempt: number };
              void showToast(
                "Fallback",
                `Task ${task_id} → ${fallbackResult.new_model} (attempt ${fallbackResult.attempt})`,
                "warning",
              );
              // NOTE: For native-dispatch tasks, task.model is updated in the DAG to fallbackResult.new_model.
              // The orchestrator can pass it as the `subagent` tool's `model` input when it re-spawns the
              // task; otherwise the subagent uses its frontmatter model.
              await deleteSession(client, session_id);
              return JSON.stringify({
                registered: true,
                task_id,
                session_id,
                status: "retrying",
                new_model: fallbackResult.new_model,
              });
            } catch {
              // No more fallbacks — fall through to fail
            }
          }

          try {
            const { session_id: sid } = JSON.parse(
              dag.fail_task(task_id, errMsg),
            ) as { session_id: string | null };
            if (sid) await deleteSession(client, sid);
          } catch {
            // already terminal
          }

          // Best-effort auto-trace: if there is exactly one active
          // investigation card, log this task failure to its trace.md so
          // the context isn't lost. Deliberately skipped when zero or
          // multiple cards are active — there's no unambiguous card to
          // attribute the failure to, and guessing would pollute the
          // wrong card's trace. This is strictly additive: any failure
          // here (missing corpus, fs error, whatever) must never affect
          // the dag.fail_task outcome above or the response below.
          try {
            const activeCards = listActiveCards();
            if (activeCards.length === 1) {
              appendTrace({
                cardId: activeCards[0],
                type: "finding",
                body: `Task ${task_id} failed: ${errMsg}`,
              });
            }
          } catch (e) {
            console.error(
              "[harness] auto-trace on task failure skipped (non-fatal):",
              e,
            );
          }

          return JSON.stringify({
            registered: true,
            task_id,
            session_id,
            status: "failed",
            error: errMsg,
          });
        }
      },
    });

    defineTool<{
      task_id: string;
      status: string;
      summary: string;
      findings?: Array<{
        message: string;
        file?: string;
        line?: number;
        severity?: string;
      }>;
    }>({
      name: "submit_review",
      description:
        "Submit structured review feedback for a completed task. Stores the review on the task so the orchestrator can check it via harness_state. Use status 'approved' to approve, 'blocked' for blocking issues, or 'requested_changes' for non-blocking suggestions.",
      input: obj({
        task_id: str(),
        status: str(),
        summary: str(),
        findings: optional(
          arr(
            obj({
              message: str(),
              file: optional(str()),
              line: optional(num()),
              severity: optional(str()),
            }),
          ),
        ),
      }),
      async execute({ task_id, status, summary, findings }, context) {
        // Build the ReviewFeedback JSON that the Rust engine expects
        const allTasks = JSON.parse(dag.list_tasks()) as Array<{
          id: string;
          session_id: string | null;
        }>;
        const match = allTasks.find(
          (t: any) => t.session_id === context.sessionID,
        );
        const reviewerTaskId = match?.id ?? context.sessionID;

        const review = {
          status,
          reviewer_task_id: reviewerTaskId,
          summary,
          findings: findings ?? [],
        };

        const reviewJson = JSON.stringify(review);

        // TODO: auto-trace on blocking review findings deferred — this
        // payload only carries task_id/status/summary/findings, with no
        // card_id. Auto-tracing here would need an explicit task->card
        // mapping (e.g. a card_id field on the review, or a lookup keyed
        // off task metadata) before it could attribute a "blocked" finding
        // to the right investigation card reliably. The single-active-card
        // heuristic used in harness_task_complete is a reasonable
        // best-effort fallback for task *failures*, but a review can be
        // submitted against a task in a different, unrelated workflow than
        // whatever card happens to be active — silently tracing to the
        // wrong card would be worse than not tracing at all.

        try {
          return dag.submit_review(task_id, reviewJson);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("is not done") &&
            msg.includes("cannot submit review")
          ) {
            pendingReviews.set(task_id, reviewJson);
            return JSON.stringify({
              task_id,
              review_status: status,
              stored: false,
              deferred: true,
              reason:
                "Target task is still running; review will be applied when it completes.",
            });
          }
          throw err;
        }
      },
    });

    defineTool<{
      cardId: string;
      symptom?: string;
      source?: "ado" | "qa" | "prod" | "other";
      backlog?: boolean;
    }>({
      name: "memory_card",
      description: [
        "Create a new investigation card under .opencode/memory/issues/.",
        "Active cards (default) require a symptom. Pass backlog:true to park",
        "a not-yet-started idea instead (context.md only, no symptom required).",
        "Refuses if the card already exists in any lifecycle state.",
      ].join("\n"),
      input: obj({
        cardId: str(),
        symptom: optional(str()),
        source: optional(enumOf("ado", "qa", "prod", "other")),
        backlog: optional(bool()),
      }),
      async execute({ cardId, symptom, source, backlog }) {
        try {
          const created = createCard({ cardId, symptom, source, backlog });
          return JSON.stringify({ success: true, cardId, created });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`memory_card failed: ${msg}`);
        }
      },
    });

    defineTool<{
      cardId: string;
      type: "finding" | "ruled-out" | "hypothesis" | "next-step";
      body: string;
      session?: string;
    }>({
      name: "memory_trace",
      description: [
        "Append a structured trace entry (finding, ruled-out, hypothesis, or",
        "next-step) to an active investigation card's trace.md. Append-only —",
        "never rewrites prior entries. Refuses if the card is not active.",
      ].join("\n"),
      input: obj({
        cardId: str(),
        type: enumOf("finding", "ruled-out", "hypothesis", "next-step"),
        body: str(),
        session: optional(str()),
      }),
      async execute({ cardId, type, body, session }) {
        try {
          const result = appendTrace({ cardId, type, body, session });
          return result.formatted;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`memory_trace failed: ${msg}`);
        }
      },
    });

    defineTool<{
      cardId: string;
      mode?: "compact" | "full";
      sections?: string[];
    }>({
      name: "memory_context",
      description: [
        "Assemble a focused markdown context payload for an investigation card,",
        "pulling from its context.md/trace.md/benchmarks.md and selected system/",
        "knowledge sections. Use mode:'compact' (default) to prime a new session",
        "cheaply, or mode:'full' for the complete record.",
      ].join("\n"),
      input: obj({
        cardId: str(),
        mode: optional(enumOf("compact", "full")),
        sections: optional(arr(str())),
      }),
      async execute({ cardId, mode, sections }) {
        try {
          return assembleContext({ cardId, mode, sections });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`memory_context failed: ${msg}`);
        }
      },
    });

    defineTool<{
      cardId: string;
      finding: string;
      impact?: string;
      targetPath: string;
      title?: string;
      sectionTitle?: string;
    }>({
      name: "memory_promote",
      description: [
        "Promote a confirmed finding from an investigation card to durable",
        "system/ knowledge (creating or appending to the target file), and",
        "record a 'promoted' entry in the card's benchmarks.md. Never touches",
        "trace.md.",
      ].join("\n"),
      input: obj({
        cardId: str(),
        finding: str(),
        impact: optional(str()),
        targetPath: str(),
        title: optional(str()),
        sectionTitle: optional(str()),
      }),
      async execute({
        cardId,
        finding,
        impact,
        targetPath,
        title,
        sectionTitle,
      }) {
        try {
          const result = promoteFinding({
            cardId,
            finding,
            impact,
            targetPath,
            title,
            sectionTitle,
          });
          return JSON.stringify({
            success: true,
            systemPath: result.systemPath,
            benchmarksPath: result.benchmarksPath,
            created: result.created,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`memory_promote failed: ${msg}`);
        }
      },
    });

    const toolRegistration = await ctx.tool.transform((editor) => {
      for (const def of tools) {
        editor.add({
          name: def.name,
          description: def.description,
          input: def.input,
          execute: async (input, context) => ({
            content: await def.execute(input, {
              sessionID: context.sessionID,
              agent: context.agent,
            }),
          }),
        });
      }
    });

    // ── Events ───────────────────────────────────────────────────────────────

    /**
     * Handle "session went idle" (from `session.idle` or `session.status` with
     * `status.type === "idle"`). Forwards to the engine as "session.idle".
     */
    async function handleIdle(sessionId: string, data: unknown): Promise<void> {
      // Duplicate idle signal for the same transition: drop. Checked before
      // the cancelled guard so the second signal of a cancelled session can't
      // slip through after the first one consumed its cancelledSessions entry.
      const now = Date.now();
      const last = idleHandledAt.get(sessionId);
      if (last !== undefined && now - last < IDLE_DEDUPE_MS) return;
      idleHandledAt.set(sessionId, now);

      // Cancelled sessions: drop late idle events entirely. Do NOT buffer
      // as orphaned — that would let native-dispatch replay resurrect a
      // task that was already cancelled.
      if (cancelledSessions.has(sessionId)) {
        cancelledSessions.delete(sessionId);
        return;
      }

      const result: EventResult = JSON.parse(
        dag.process_event("session.idle", sessionId, JSON.stringify(data)),
      );

      // Apply any deferred reviews now that tasks may have transitioned to Done.
      if (pendingReviews.size > 0) {
        for (const [targetTaskId, reviewJson] of pendingReviews) {
          try {
            dag.submit_review(targetTaskId, reviewJson);
            pendingReviews.delete(targetTaskId);
          } catch {
            // Target task still not Done (e.g., different task went idle);
            // leave it in the map for the next idle event.
          }
        }
      }

      // Detect no-op result → session not yet registered in the DAG.
      // This happens for native-dispatch tasks whose subagent call finishes
      // before harness_task_complete is called.  Buffer the event so it can be
      // replayed when the session mapping is registered.
      const isNoop =
        result.delete_session === null &&
        result.reuse_session == null &&
        result.fallback_hint == null &&
        result.notifications.length === 0;

      if (isNoop) {
        orphanedIdleEvents.set(sessionId, data);
        return;
      }

      await handleEventResult(result, client, dag);
    }

    /**
     * Handle a failed session execution. `error` is the v2 structured error
     * (or any shape `extractErrorMessage` understands). Forwards to the engine
     * as "session.error" with a string `error` so it can classify/fall back.
     */
    async function handleError(
      sessionId: string,
      error: unknown,
    ): Promise<void> {
      if (!sessionId) return;

      // Cancelled sessions: same guard as idle above. This also covers the
      // abort/interrupt-induced failure OpenCode raises after we interrupt
      // the session — it must never be classified/retried as a transient
      // failure, since the DAG's session_to_task mapping was already removed
      // by cancel_task/cancel_workflow.
      if (cancelledSessions.has(sessionId)) {
        cancelledSessions.delete(sessionId);
        return;
      }

      const errMsg = extractErrorMessage(error);

      const result: EventResult = JSON.parse(
        dag.process_event(
          "session.error",
          sessionId,
          JSON.stringify({ sessionID: sessionId, error: errMsg }),
        ),
      );

      // Detect no-op → buffer for later replay.
      if (!result.fallback_hint) {
        orphanedErrorEvents.set(sessionId, errMsg);
        return;
      }

      // Check if this error is eligible for fallback
      const { task_id, error_message, has_fallbacks } = result.fallback_hint;
      const classification = classifyError(error_message);

      if (classification === "retryable" && has_fallbacks) {
        try {
          const fallbackResult = JSON.parse(
            dag.try_fallback(task_id, error_message),
          ) as {
            fallback: boolean;
            new_model: string;
            attempt: number;
            session_id: string | null;
          };
          void showToast(
            "Fallback",
            `Task ${task_id} → ${fallbackResult.new_model} (attempt ${fallbackResult.attempt})`,
            "warning",
          );
          // Clean up old session
          if (fallbackResult.session_id) {
            await deleteSession(client, fallbackResult.session_id);
          }
          // The task is now Pending again — the tick loop will pick it up
          // Handle any notifications from the original event
          await handleEventResult(result, client, dag);
          return;
        } catch (e) {
          console.error(
            `[harness-plugin] fallback attempt failed for task ${task_id}:`,
            e,
          );
          // Fall through to fail the task
        }
      }

      // Not retryable or no fallbacks — fail the task
      try {
        const { session_id } = JSON.parse(
          dag.fail_task(task_id, error_message),
        ) as {
          session_id: string | null;
        };
        if (session_id) await deleteSession(client, session_id);
      } catch {
        // already terminal — ignore
      }

      await handleEventResult(result, client, dag);
    }

    async function handleEvent(event: V2Event): Promise<void> {
      switch (event.type) {
        case "session.idle":
          await handleIdle(event.data.sessionID, event.data);
          break;
        case "session.status": {
          const { sessionID, status } = event.data;
          if (status.type === "idle") {
            await handleIdle(sessionID, event.data);
          } else {
            // busy / retry: a new run started, so the next idle is a real one.
            idleHandledAt.delete(sessionID);
          }
          break;
        }
        case "session.execution.failed":
          await handleError(event.data.sessionID, event.data.error);
          break;
        default:
          break;
      }
    }

    const eventAbort = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: eventAbort.signal,
      })) {
        if (disposed) break;
        try {
          await handleEvent(event);
        } catch (e) {
          console.error("[harness-plugin] event handler failed:", e);
        }
      }
    })().catch((e) => {
      if (!eventAbort.signal.aborted) {
        console.error("[harness-plugin] event subscription failed:", e);
      }
    });

    // ── Tool hooks ───────────────────────────────────────────────────────────

    const afterHook = await ctx.tool.hook("execute.after", (event) => {
      // A leaked race-window session (see task_started()/cleanupOrphanedSession
      // above) may keep executing tools cooperatively after interrupt() was
      // called but before the provider actually stops it. Skip entirely for
      // any session we know is cancelled so it can't keep writing tool output
      // into what is — or was — a Cancelled task's record.
      if (disposed || cancelledSessions.has(event.sessionID)) return;

      dag.process_event(
        "tool.execute.after",
        event.sessionID,
        JSON.stringify({
          tool: event.tool,
          callID: event.id,
          args: event.input,
          result:
            event.status === "completed"
              ? toolResultText(event.result)
              : undefined,
        }),
      );
    });

    // ── Cleanup ──────────────────────────────────────────────────────────────

    let cleaned = false;
    return async () => {
      if (cleaned) return;
      cleaned = true;
      disposed = true;
      clearInterval(tickInterval);
      eventAbort.abort();
      await Promise.allSettled([
        toolRegistration.dispose(),
        afterHook.dispose(),
      ]);
      dag.free();
    };
  },
});
