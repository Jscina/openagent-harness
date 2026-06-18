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
 *   2. LOOP until status is "done" or "failed":
 *      a. harness_dispatch_tasks({ workflow_id }) → { status, tasks }
 *      b. For each task spawn via Task tool using description "[harness-task:<task_id>]"
 *         and the agent/prompt from the tasks array.
 *      c. When each Task tool call returns, extract the session_id from the
 *         "task_id: <session_id>" prefix in the output.
 *      d. harness_task_complete({ task_id, session_id, status: "done" | "failed" })
 *   3. harness_state({ workflow_id }) for final results.
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
  sleep,
  handleEventResult,
} from "./dag.js";

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
  const pendingReviews = new Map<string, string>();

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
            dag.task_started(task.id, sessionId);
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

  // Cleanup on process exit.
  const cleanup = () => {
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
            if (wfStatus === "done" || wfStatus === "failed") {
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
          // Register the session → task mapping in the DAG.
          dag.task_started(task_id, session_id);

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
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId: string = event.properties.sessionID;
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
