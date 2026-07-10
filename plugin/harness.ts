/**
 * harness.ts — OpenCode server plugin (WASM edition)
 *
 * The Rust DAG state machine is compiled to WASM and loaded directly into
 * this process.  No separate binary is spawned; no HTTP server is started.
 *
 * Data flow:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  OpenCode                                                           │
 *   │    └─ loads plugin/harness.ts                                       │
 *   │         └─ initSync(readFileSync("...wasm"))  → DagEngine in-proc  │
 *   │         └─ get_agent_configs() → write .md files on first boot     │
 *   │         └─ setInterval 500ms → dag.tick() → session + prompt       │
 *   │         └─ session.idle / session.error → dag.process_event()      │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Native-dispatch mode
 * ────────────────────
 * Workflows submitted with native_dispatch:true are executed through
 * OpenCode's native subagent (Task tool) mechanism instead of the plugin's
 * own session-creation loop.  This makes every agent turn visible as a
 * collapsible subagent block inside the orchestrator's conversation.
 *
 * Protocol (orchestrator side):
 *   1. submit_plan({ plan_id, native_dispatch: true }) → { workflow_id }
 *   2. LOOP until status is "done", "failed", or "cancelled":
 *      a. harness_dispatch_tasks({ workflow_id }) → { status, tasks }
 *      b. For each task spawn via Task tool using description "[harness-task:<task_id>]"
 *         and the agent/prompt from the tasks array.
 *      c. When each Task tool call returns, extract the session_id from the
 *         "task_id: <session_id>" prefix in the output.
 *      d. harness_task_complete({ task_id, session_id, status: "done" | "failed" })
 *   3. harness_state({ workflow_id }) for final results.
 *
 * Cancellation
 * ────────────
 * harness_cancel({ workflow_id } | { task_id }) cancels a workflow or a single
 * task (cascading to its transitive dependents), aborts + deletes the backing
 * OpenCode session(s), and flips harness_dispatch_tasks into terminal
 * "cancelled" status for the affected workflow. Late session.idle/error events
 * for aborted sessions are dropped via the module-level `cancelledSessions`
 * guard so they can't resurrect a cancelled task through orphaned-event replay.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import {
  DagEngine,
  agent_fallback_configs_json,
  get_agent_configs,
  initSync,
} from "./wasm/openagent_harness.js";

import type { EventResult } from "./types.js";
import { classifyError } from "./errors.js";
import { createPlanArtifact, savePlanArtifact, loadPlanArtifact } from "./plans.js";
import { createSession, sendMessage, deleteSession, showToast } from "./client.js";
import {
  listHarnessWorkflows,
  getHarnessWorkflowSnapshot,
  extractWorkflowStatus,
  findOwningWorkflowId,
  sleep,
  handleEventResult,
  cleanupOrphanedSession,
} from "./dag.js";
import { BoundedSet, BoundedMap } from "./bounded.js";
import { createCard, appendTrace, assembleContext, promoteFinding, listActiveCards } from "./memory.js";

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
 * time the plugin loads.  Skips existing files so user edits are preserved.
 *
 * This replaces the need to run `openagent-harness install` manually — the
 * configs are embedded in the WASM binary and installed automatically.
 */
function installAgentsIfNeeded(): number {
  try {
    const agentsDir = join(homedir(), ".config", "opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });

    const configs: Record<string, string> = JSON.parse(get_agent_configs());
    let installed = 0;
    for (const [name, content] of Object.entries(configs)) {
      const dest = join(agentsDir, `${name}.md`);
      if (!existsSync(dest)) {
        writeFileSync(dest, content, "utf8");
        installed++;
      }
    }
    return installed;
  } catch (e) {
    console.error("[harness-plugin] agent install failed (non-fatal):", e);
    return 0;
  }
}


// ─── Plugin ───────────────────────────────────────────────────────────────────

export default (async (input: PluginInput) => {
  const client = input.client;

  // Load WASM DAG engine.
  const dag = loadWasm();
  void showToast(client, 'Harness Plugin', 'WASM DAG engine loaded', 'info', 5000);

  // Install agent configs the first time this plugin runs.
  const installed = installAgentsIfNeeded();
  if (installed > 0) {
    void showToast(client, 'Harness Plugin', `Installed ${installed} agent config(s)`, 'info');
  }

  // Load agent fallback configs from WASM and register with DAG engine.
  try {
    const fallbackConfigs = agent_fallback_configs_json();
    dag.set_agent_fallbacks(fallbackConfigs);
    void showToast(client, 'Harness Plugin', 'Agent fallback models registered', 'info', 5000);
  } catch (e) {
    console.error('[harness-plugin] fallback config load failed (non-fatal):', e);
  }

  // ── Native-dispatch state ──────────────────────────────────────────────────
  //
  // Workflows added to `nativeDispatchWorkflows` are dispatched through the
  // orchestrator's own Task tool calls (native OpenCode subagents), not by
  // the plugin tick loop.  Tasks belonging to these workflows are placed in
  // `nativeDispatchBuffer` by the tick loop instead of being session-created.
  //
  // Orphaned-event buffers hold `session.idle` / `session.error` events that
  // fired for sessions the DAG doesn't yet know about.  This happens because
  // the Task tool is synchronous: the agent may complete (firing session.idle)
  // before the orchestrator calls harness_task_complete to register the
  // session mapping.  We replay the buffered events at registration time.

  /** Set of workflow IDs whose tasks are dispatched via Task tool, not by the tick loop. */
  const nativeDispatchWorkflows = new Set<string>();

  /**
   * Buffer of tasks ready to be dispatched natively, keyed by workflow_id.
   * The tick loop populates this instead of creating sessions for these tasks.
   */
  const nativeDispatchBuffer = new Map<string, Array<{
    id: string;
    prompt: string;
    model: string;
    agent: string | null;
    parent_session_id: string | null;
    fallback_models: string[];
    existing_session_id?: string | null;
    workflow_id?: string | null;
  }>>();

  /**
   * Buffer for `session.idle` events whose session ID is not yet registered in
   * the DAG's session_to_task map.  Replayed when harness_task_complete registers
   * the mapping.
   */
  const orphanedIdleEvents = new Map<string, unknown>();

  /**
   * Buffer for `session.error` events whose session ID is not yet registered.
   * Value is the extracted error message string.
   */
  const orphanedErrorEvents = new Map<string, string>();

  // Reviews deferred because the target task was still Running when submit_review was called.
  // Keyed by target task_id; value is the serialized review JSON string.
  //
  // Bounded (same discipline as `cancelledSessions` below) for defense in
  // depth: a review for a task that gets cancelled instead of completing
  // would otherwise sit here forever, retried on every subsequent
  // session.idle with no eviction. Cancellation paths also proactively
  // delete the entry for any cancelled task_id (see harness_cancel).
  const PENDING_REVIEWS_CAP = 1000;
  const pendingReviews = new BoundedMap<string, string>(PENDING_REVIEWS_CAP);

  // ── Cancellation state ─────────────────────────────────────────────────────
  //
  // Sessions that belonged to a task/workflow cancelled via `harness_cancel`,
  // or a session `dag.task_started()` refused to bind because its task was
  // already terminal by the time the session was created (see
  // `cleanupOrphanedSession` in dag.ts). The DAG engine never registers a
  // session_to_task mapping for these, so a late `session.idle` /
  // `session.error` event would otherwise be treated as an "orphaned" event
  // and buffered for native-dispatch replay — which would incorrectly
  // resurrect a cancelled task. The event hooks (and the `tool.execute.after`
  // hook) check this set first and drop matching events outright.
  //
  // Entries are removed once their terminating event is observed. A hard cap
  // guards against unbounded growth if a session never produces an event
  // (e.g. the provider silently drops an aborted request).
  const CANCELLED_SESSIONS_CAP = 1000;
  const cancelledSessions = new BoundedSet<string>(CANCELLED_SESSIONS_CAP);

  // ── Tick loop ──────────────────────────────────────────────────────────────
  // Every 500 ms, find unblocked tasks and start them in OpenCode sessions.
  // Tasks belonging to native-dispatch workflows are buffered instead.

  let ticking = false;

  const tickInterval = setInterval(async () => {
    if (ticking) return;
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
        // ── Native dispatch: buffer instead of creating a session ──────────
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

        // ── Plugin dispatch: create session and send prompt ────────────────
        let sessionId: string | null = null;
        try {
          if (task.existing_session_id) {
            // Session was pre-assigned from a prior task's reuse — skip createSession.
            sessionId = task.existing_session_id;
            // task_started was already called in handleEventResult when reuse was set,
            // but call again to be idempotent (it's a no-op if mapping already exists).
            dag.task_started(task.id, sessionId);
          } else {
            const agentName = task.agent ?? undefined;
            const taskLabel = task.id.slice(0, 8);
            const title = agentName
              ? `@${agentName}: ${taskLabel}`
              : `task: ${taskLabel}`;
            sessionId = await createSession(client, task.parent_session_id, title, agentName);

            // BLOCKING BUG FIX: the task may have been cancelled via
            // harness_cancel while createSession() was in flight above. If
            // so, dag.task_started() returns false and does NOT bind this
            // brand-new session to the (now-Cancelled) task — the session is
            // orphaned and would otherwise run to completion untracked,
            // never aborted. Clean it up ourselves and skip sendMessage.
            const bound = dag.task_started(task.id, sessionId);
            if (!bound) {
              await cleanupOrphanedSession(client, sessionId, cancelledSessions);
              continue;
            }
          }
          await sendMessage(client, sessionId, task.prompt, task.model, task.agent);
          void showToast(client, 'Task Started', `Task ${task.id} dispatched`, 'info', 5000);
        } catch (e) {
          console.error(`[harness-plugin] failed to start task ${task.id}:`, e);
          const message = e instanceof Error ? e.message : String(e);
          const classification = classifyError(message);
          void showToast(client, 'Harness Plugin', `Error classified as ${classification}`, classification === 'retryable' ? 'warning' : 'error');

          if (classification === 'retryable' && task.fallback_models && task.fallback_models.length > 0) {
            try {
              const fallbackResult = JSON.parse(dag.try_fallback(task.id, message));
              void showToast(client, 'Fallback', `Task ${task.id} falling back to ${fallbackResult.new_model}`, 'warning');
              if (sessionId) await deleteSession(client, sessionId);
              // Task is Pending again — next tick will pick it up
              continue;
            } catch {
              // No more fallbacks — fall through to fail
            }
          }

          try {
            const { session_id } = JSON.parse(dag.fail_task(task.id, message)) as {
              session_id: string | null;
            };
            if (session_id) await deleteSession(client, session_id);
          } catch {
            // already terminal — ignore
          }
        }
      }
    } finally {
      ticking = false;
    }
  }, 500);

  // Cleanup on process exit. Idempotent: SIGTERM/SIGINT below call cleanup()
  // then process.exit(0), and process.exit() itself re-fires the "exit"
  // listener registered next — without this guard that second invocation
  // would call dag.free() on an already-freed WASM object and crash with
  // "null pointer passed to rust" while the process is tearing down.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(tickInterval);
    dag.free();
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });

  // ── Hooks ──────────────────────────────────────────────────────────────────

  return {
    tool: {
      submit_workflow: tool({
        description:
          "Orchestrator-only low-level escape hatch: submit a workflow tasks array directly to the harness DAG. Returns a workflow_id for tracking.",
        args: {
          tasks: tool.schema.array(
            tool.schema.object({
              agent: tool.schema.string(),
              prompt: tool.schema.string(),
              depends_on: tool.schema.array(tool.schema.number()),
              model: tool.schema.string().optional(),
            }),
          ),
        },
        async execute({ tasks }, context) {
          if (context.agent !== "orchestrator") {
            throw new Error("submit_workflow can only be executed by the orchestrator agent");
          }
          return dag.submit_workflow(JSON.stringify(tasks), context.sessionID);
        },
      }),

      save_plan: tool({
        description:
          "Planner-only: persist a plan artifact under .opencode/plans and return its reference metadata.",
        args: {
          plan_id: tool.schema.string().optional(),
          tasks: tool.schema.array(
            tool.schema.object({
              agent: tool.schema.string(),
              prompt: tool.schema.string(),
              depends_on: tool.schema.array(tool.schema.number()),
              model: tool.schema.string().optional(),
            }),
          ),
          summary: tool.schema.array(tool.schema.string()),
          recommendations: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute({ plan_id, tasks, summary, recommendations }, context) {
          if (context.agent !== "planner") {
            throw new Error("save_plan can only be executed by the planner agent");
          }

          const artifact = createPlanArtifact({
            plan_id,
            tasks,
            summary,
            recommendations,
          });

          const path = savePlanArtifact(artifact);
          return JSON.stringify({
            plan_id: artifact.id,
            path,
            task_count: artifact.tasks.length,
            summary: artifact.summary,
            recommendations: artifact.recommendations,
          });
        },
      }),

      submit_plan: tool({
        description:
          "Orchestrator-only: load a saved plan artifact by plan_id and submit its tasks to the harness DAG. Set native_dispatch:true to execute agents as visible OpenCode subagents (recommended — agents appear inline in the conversation).",
        args: {
          plan_id: tool.schema.string(),
          native_dispatch: tool.schema.boolean().optional(),
        },
        async execute({ plan_id, native_dispatch }, context) {
          if (context.agent !== "orchestrator") {
            throw new Error("submit_plan can only be executed by the orchestrator agent");
          }
          const artifact = loadPlanArtifact(plan_id);
          const result = dag.submit_workflow(JSON.stringify(artifact.tasks), context.sessionID);
          const parsed = JSON.parse(result) as { workflow_id: string; task_ids: string[] };

          if (native_dispatch) {
            nativeDispatchWorkflows.add(parsed.workflow_id);
          }

          return result;
        },
      }),

      harness_state: tool({
        description:
          "Read-only harness visibility. Without workflow_id lists workflows; with workflow_id returns workflow snapshot.",
        args: {
          workflow_id: tool.schema.string().optional(),
        },
        async execute({ workflow_id }) {
          const payload = workflow_id
            ? { workflow_id, snapshot: getHarnessWorkflowSnapshot(dag, workflow_id) }
            : { workflows: listHarnessWorkflows(dag) };
          return JSON.stringify(payload);
        },
      }),

      harness_cancel: tool({
        description: [
          "Cancel a pending/running workflow or a single task (cascades to its",
          "transitive dependents). Provide exactly one of workflow_id or task_id.",
          "reason is informational only and is not persisted.",
          "Aborts and deletes the OpenCode session(s) backing any cancelled task.",
          "After cancelling a workflow, harness_dispatch_tasks returns a terminal",
          "'cancelled' status for it — stop the native-dispatch loop when you see it.",
        ].join("\n"),
        args: {
          workflow_id: tool.schema.string().optional(),
          task_id: tool.schema.string().optional(),
          reason: tool.schema.string().optional(),
        },
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
          // forever on every subsequent session.idle. Drop it now.
          for (const tid of cancelled_task_ids) {
            pendingReviews.delete(tid);
          }

          // Abort + delete every session backing a cancelled task. Best-effort:
          // engine state is already Cancelled regardless of transport outcome.
          // cleanupOrphanedSession tracks each session as cancelled BEFORE
          // aborting it, so the abort-induced session.error is guaranteed to
          // be dropped by the cancelledSessions guard in the event hooks
          // instead of being misclassified as a real provider failure.
          let aborted = 0;
          for (const sid of session_ids) {
            const ok = await cleanupOrphanedSession(client, sid, cancelledSessions);
            if (ok) aborted++;
          }

          // Best-effort workflow status lookup for the summary. task_id cancels
          // don't carry a workflow_id in the engine response, so resolve it by
          // scanning workflow membership.
          const resolvedWorkflowId = workflow_id ?? findOwningWorkflowId(dag, task_id as string);
          const wfStatus = resolvedWorkflowId
            ? extractWorkflowStatus(JSON.parse(dag.get_workflow(resolvedWorkflowId)))
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
      }),

      harness_dispatch_tasks: tool({
        description: [
          "Poll a native-dispatch workflow for the next batch of ready tasks.",
          "Returns when at least one task is ready OR the workflow reaches a terminal state.",
          "After this returns tasks_ready, spawn each task using the Task tool with:",
          "  - agent: the task's agent field",
          "  - description: exactly '[harness-task:<task_id>] @<agent>: <short description>'",
          "  - prompt: the task's prompt field",
          "When the Task tool call returns, extract the session_id from the 'task_id: <session_id>'",
          "prefix in the output, then call harness_task_complete for that task.",
          "Repeat until status is 'done' or 'failed'.",
        ].join("\n"),
        args: {
          workflow_id: tool.schema.string(),
          timeout_ms: tool.schema.number().optional(),
        },
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
            if (wfStatus === "done" || wfStatus === "failed" || wfStatus === "cancelled") {
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
      }),

      harness_task_complete: tool({
        description: [
          "Register the completion of a natively-dispatched task after its Task tool call returns.",
          "",
          "Pass:",
          "  task_id   — from the tasks array returned by harness_dispatch_tasks",
          "  session_id — the session_id extracted from the Task tool output prefix",
          "               'task_id: <session_id>'",
          "  status    — 'done' if the Task tool succeeded, 'failed' if it errored",
          "  error     — (optional) error message when status is 'failed'",
          "",
          "This call links the session to the DAG task, replays any already-received",
          "session.idle / session.error events, and advances the workflow.",
        ].join("\n"),
        args: {
          task_id: tool.schema.string(),
          session_id: tool.schema.string(),
          status: tool.schema.enum(["done", "failed"]),
          error: tool.schema.string().optional(),
        },
        async execute({ task_id, session_id, status, error }) {
          // Register the session → task mapping in the DAG. dag.task_started()
          // returns false when the task is already terminal — typically
          // Cancelled (e.g. via harness_cancel while this native-dispatch
          // Task tool call was still in flight), but the DAG's guard also
          // rejects Done/Failed defensively. In that case discard the result
          // gracefully: never resurrect a terminal task into Done/Failed, and
          // never register/replay/fallback for it — just clean up the
          // now-orphaned session.
          const bound = dag.task_started(task_id, session_id);
          if (!bound) {
            pendingReviews.delete(task_id);
            await cleanupOrphanedSession(client, session_id, cancelledSessions);
            return JSON.stringify({
              registered: false,
              task_id,
              session_id,
              status: "cancelled",
              message: "task was already cancelled (or otherwise terminal); result discarded",
            });
          }

          if (status === "done") {
            // Replay any buffered session.idle event (agent may have completed before
            // this call was made — the tick loop buffered the event then).
            const bufferedProps = orphanedIdleEvents.get(session_id) ?? {};
            orphanedIdleEvents.delete(session_id);

            const result: EventResult = JSON.parse(
              dag.process_event("session.idle", session_id, JSON.stringify(bufferedProps)),
            );

            // For native-dispatch workflows, never reuse sessions across tasks —
            // the orchestrator always spawns fresh via the Task tool.
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
              orphanedErrorEvents.get(session_id) ?? // real provider error from session.error event
              error ??                                 // orchestrator-supplied fallback
              "native task reported failure";
            const errSource = orphanedErrorEvents.has(session_id)
              ? 'session.error'
              : error !== undefined
              ? 'caller'
              : 'default';
            orphanedErrorEvents.delete(session_id);
            console.log(`[harness] task_complete failed: task_id=${task_id} session_id=${session_id} source=${errSource} errMsg=${errMsg}`);
            const classification = classifyError(errMsg);
            console.log(`[harness] task_complete classification=${classification} hasMoreFallbacks will be evaluated next`);
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
                  client,
                  "Fallback",
                  `Task ${task_id} → ${fallbackResult.new_model} (attempt ${fallbackResult.attempt})`,
                  "warning",
                );
                // NOTE: For native-dispatch tasks, task.model is updated in the DAG to fallbackResult.new_model,
                // but the Task tool interface does not support a model override parameter. The subagent will
                // be re-spawned by the orchestrator using its frontmatter model, not the DAG fallback model.
                // This is a known limitation of the native dispatch + Task tool integration.
                await deleteSession(client, session_id);
                return JSON.stringify({ registered: true, task_id, session_id, status: "retrying", new_model: fallbackResult.new_model });
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
              console.error("[harness] auto-trace on task failure skipped (non-fatal):", e);
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
      }),

      submit_review: tool({
        description:
          "Submit structured review feedback for a completed task. Stores the review on the task so the orchestrator can check it via harness_state. Use status 'approved' to approve, 'blocked' for blocking issues, or 'requested_changes' for non-blocking suggestions.",
        args: {
          task_id: tool.schema.string(),
          status: tool.schema.string(),
          summary: tool.schema.string(),
          findings: tool.schema
            .array(
              tool.schema.object({
                message: tool.schema.string(),
                file: tool.schema.string().optional(),
                line: tool.schema.number().optional(),
                severity: tool.schema.string().optional(),
              }),
            )
            .optional(),
        },
        async execute({ task_id, status, summary, findings }, context) {
          // Build the ReviewFeedback JSON that the Rust engine expects
          const allTasks = JSON.parse(dag.list_tasks()) as Array<{
            id: string;
            session_id: string | null;
          }>;
          const match = allTasks.find((t: any) => t.session_id === context.sessionID);
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
            if (msg.includes('is not done') && msg.includes('cannot submit review')) {
              pendingReviews.set(task_id, reviewJson);
              return JSON.stringify({
                task_id,
                review_status: status,
                stored: false,
                deferred: true,
                reason: 'Target task is still running; review will be applied when it completes.',
              });
            }
            throw err;
          }
        },
      }),

      memory_card: tool({
        description: [
          "Create a new investigation card under .opencode/memory/issues/.",
          "Active cards (default) require a symptom. Pass backlog:true to park",
          "a not-yet-started idea instead (context.md only, no symptom required).",
          "Refuses if the card already exists in any lifecycle state.",
        ].join("\n"),
        args: {
          cardId: tool.schema.string(),
          symptom: tool.schema.string().optional(),
          source: tool.schema.enum(["ado", "qa", "prod", "other"]).optional(),
          backlog: tool.schema.boolean().optional(),
        },
        async execute({ cardId, symptom, source, backlog }) {
          try {
            const created = createCard({ cardId, symptom, source, backlog });
            return JSON.stringify({ success: true, cardId, created });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`memory_card failed: ${msg}`);
          }
        },
      }),

      memory_trace: tool({
        description: [
          "Append a structured trace entry (finding, ruled-out, hypothesis, or",
          "next-step) to an active investigation card's trace.md. Append-only —",
          "never rewrites prior entries. Refuses if the card is not active.",
        ].join("\n"),
        args: {
          cardId: tool.schema.string(),
          type: tool.schema.enum(["finding", "ruled-out", "hypothesis", "next-step"]),
          body: tool.schema.string(),
          session: tool.schema.string().optional(),
        },
        async execute({ cardId, type, body, session }) {
          try {
            const result = appendTrace({ cardId, type, body, session });
            return result.formatted;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`memory_trace failed: ${msg}`);
          }
        },
      }),

      memory_context: tool({
        description: [
          "Assemble a focused markdown context payload for an investigation card,",
          "pulling from its context.md/trace.md/benchmarks.md and selected system/",
          "knowledge sections. Use mode:'compact' (default) to prime a new session",
          "cheaply, or mode:'full' for the complete record.",
        ].join("\n"),
        args: {
          cardId: tool.schema.string(),
          mode: tool.schema.enum(["compact", "full"]).optional(),
          sections: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute({ cardId, mode, sections }) {
          try {
            return assembleContext({ cardId, mode, sections });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`memory_context failed: ${msg}`);
          }
        },
      }),

      memory_promote: tool({
        description: [
          "Promote a confirmed finding from an investigation card to durable",
          "system/ knowledge (creating or appending to the target file), and",
          "record a 'promoted' entry in the card's benchmarks.md. Never touches",
          "trace.md.",
        ].join("\n"),
        args: {
          cardId: tool.schema.string(),
          finding: tool.schema.string(),
          impact: tool.schema.string().optional(),
          targetPath: tool.schema.string(),
          title: tool.schema.string().optional(),
          sectionTitle: tool.schema.string().optional(),
        },
        async execute({ cardId, finding, impact, targetPath, title, sectionTitle }) {
          try {
            const result = promoteFinding({ cardId, finding, impact, targetPath, title, sectionTitle });
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
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId: string = event.properties.sessionID;

        // Cancelled sessions: drop late idle events entirely. Do NOT buffer
        // as orphaned — that would let native-dispatch replay resurrect a
        // task that was already cancelled.
        if (cancelledSessions.has(sessionId)) {
          cancelledSessions.delete(sessionId);
          return;
        }

        const result: EventResult = JSON.parse(
          dag.process_event("session.idle", sessionId, JSON.stringify(event.properties)),
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
        // This happens for native-dispatch tasks whose Task tool finishes before
        // harness_task_complete is called.  Buffer the event so it can be
        // replayed when the session mapping is registered.
        const isNoop =
          result.delete_session === null &&
          result.reuse_session == null &&
          result.fallback_hint == null &&
          result.notifications.length === 0;

        if (isNoop) {
          orphanedIdleEvents.set(sessionId, event.properties);
          return;
        }

        await handleEventResult(result, client, dag);
      } else if (event.type === "session.error") {
        const sessionId: string = event.properties.sessionID ?? '';
        if (!sessionId) return;

        // Cancelled sessions: same guard as session.idle above. This also
        // covers MessageAbortedError raised by OpenCode after we call
        // abortSession — it must never be classified/retried as a transient
        // failure, since the DAG's session_to_task mapping was already
        // removed by cancel_task/cancel_workflow.
        if (cancelledSessions.has(sessionId)) {
          cancelledSessions.delete(sessionId);
          return;
        }

        const result: EventResult = JSON.parse(
          dag.process_event('session.error', sessionId, JSON.stringify(event.properties)),
        );

        // Detect no-op → buffer for later replay.
        if (!result.fallback_hint) {
          const errMsg =
            (event.properties as Record<string, unknown>).error as string ??
            (event.properties as Record<string, unknown>).message as string ??
            "unknown error";
          orphanedErrorEvents.set(sessionId, String(errMsg));
          return;
        }

        // Check if this error is eligible for fallback
        if (result.fallback_hint) {
          const { task_id, error_message, has_fallbacks } = result.fallback_hint;
          const classification = classifyError(error_message);

          if (classification === 'retryable' && has_fallbacks) {
            try {
              const fallbackResult = JSON.parse(dag.try_fallback(task_id, error_message)) as {
                fallback: boolean;
                new_model: string;
                attempt: number;
                session_id: string | null;
              };
              void showToast(
                client,
                'Fallback',
                `Task ${task_id} → ${fallbackResult.new_model} (attempt ${fallbackResult.attempt})`,
                'warning',
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
              console.error(`[harness-plugin] fallback attempt failed for task ${task_id}:`, e);
              // Fall through to fail the task
            }
          }

          // Not retryable or no fallbacks — fail the task
          try {
            const { session_id } = JSON.parse(dag.fail_task(task_id, error_message)) as {
              session_id: string | null;
            };
            if (session_id) await deleteSession(client, session_id);
          } catch {
            // already terminal — ignore
          }
        }

        await handleEventResult(result, client, dag);
      }
    },

    "tool.execute.before": async (_input) => {
      // No state change on before-hook; reserved for future use.
    },

    "tool.execute.after": async (input, output) => {
      // A leaked race-window session (see task_started()/cleanupOrphanedSession
      // above) may keep executing tools cooperatively after abortSession() was
      // called but before the provider actually stops it. Skip entirely for
      // any session we know is cancelled so it can't keep writing tool output
      // into what is — or was — a Cancelled task's record.
      if (cancelledSessions.has(input.sessionID)) return;

      dag.process_event(
        "tool.execute.after",
        input.sessionID,
        JSON.stringify({
          tool: input.tool,
          callID: input.callID,
          args: input.args,
          result: output.output,
        }),
      );
    },
  };
}) satisfies Plugin;
