// ─── DAG utilities ────────────────────────────────────────────────────────────

import type { DagEngine } from "./wasm/openagent_harness.js";

import type { EventResult } from "./types.js";
import { abortSession, deleteSession, showToast } from "./client.js";
import type { BoundedSet } from "./bounded.js";

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function listHarnessWorkflows(dag: DagEngine): unknown {
  return parseJson(dag.list_workflow_summaries());
}

export function getHarnessWorkflowSnapshot(dag: DagEngine, workflowId: string): unknown {
  return parseJson(dag.get_workflow_snapshot(workflowId));
}

/**
 * Possible workflow status labels surfaced by `extractWorkflowStatus`.
 * `"cancelled"` is produced by `dag.cancel_workflow` / `dag.cancel_task`
 * (when the cancelled task was the last active branch of its workflow).
 */
export type WorkflowStatusLabel = "running" | "done" | "failed" | "cancelled";

/**
 * Extract and lowercase the workflow status label from a snapshot/workflow
 * object. Passes through whatever the Rust engine tags the status with
 * (`running` | `done` | `failed` | `cancelled`), so no code change is needed
 * here when new statuses are added on the Rust side — this doc-comments the
 * ones currently in use.
 */
export function extractWorkflowStatus(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const obj = snapshot as {
    status?: unknown;
    state?: unknown;
    workflow?: { status?: unknown; state?: unknown };
  };

  const status =
    obj.status ?? obj.state ?? obj.workflow?.status ?? obj.workflow?.state;
  if (typeof status === "string") {
    return status.toLowerCase();
  }
  if (status && typeof status === "object") {
    const tagged = status as { type?: unknown };
    return typeof tagged.type === "string" ? tagged.type.toLowerCase() : null;
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the workflow_id that owns `taskId` by scanning workflow summaries and
 * checking each workflow's task list for membership. `Task` itself does not
 * carry a `workflow_id` field, so this is the only way to resolve it from a
 * bare task id (e.g. after a task-level `cancel_task` call).
 *
 * Returns `null` if no workflow contains the task (unknown id).
 */
export function findOwningWorkflowId(dag: DagEngine, taskId: string): string | null {
  const summaries = parseJson(dag.list_workflow_summaries()) as Array<{ id: string }> | null;
  if (!Array.isArray(summaries)) return null;

  for (const { id } of summaries) {
    const wf = parseJson(dag.get_workflow(id)) as { tasks?: string[] } | null;
    if (wf?.tasks?.includes(taskId)) return id;
  }
  return null;
}

/**
 * Clean up a session that `dag.task_started()` refused to bind because its
 * task was already terminal (typically `Cancelled`, but the DAG's guard also
 * covers `Done`/`Failed` defensively) by the time the session was created —
 * e.g. a task cancelled via `harness_cancel` while `createSession()` was
 * still in flight, or while a native-dispatch Task tool call was still
 * running.
 *
 * Ordering matters: the session is tracked as cancelled BEFORE
 * `abortSession`/`deleteSession` run, so the abort-induced `session.error`
 * (or a late `session.idle`) is guaranteed to be dropped by the
 * `cancelledSessions` guard in the plugin's event hooks, instead of being
 * buffered/replayed as an orphaned or native-dispatch event that could
 * resurrect the cancelled task.
 *
 * @returns whether `abortSession` succeeded, so callers that need an
 *   accurate abort count (e.g. `harness_cancel`'s summary) can use it.
 */
export async function cleanupOrphanedSession(
  client: Parameters<typeof deleteSession>[0],
  sessionId: string,
  cancelledSessions: BoundedSet<string>,
): Promise<boolean> {
  cancelledSessions.add(sessionId);
  const aborted = await abortSession(client, sessionId);
  await deleteSession(client, sessionId);
  return aborted;
}

/**
 * Bind `sessionId` to `taskId` via `dag.task_started()`, cleaning up the
 * session as orphaned if the DAG refuses the bind.
 *
 * This is the single call site for the "bind, then check, then clean up if
 * rejected" pattern required at every place a session gets associated with
 * a task: `dag.task_started()` returns `false` whenever the task is already
 * terminal (typically `Cancelled` via a concurrent `harness_cancel`, but the
 * DAG's guard also covers `Done`/`Failed` defensively) — see
 * `DagEngine::task_started` in `src/dag.rs`. That can happen at any of these
 * call sites:
 *   - tick loop, fresh session: `harness_cancel` lands while `createSession()`
 *     was in flight.
 *   - tick loop, reused session (`existing_session_id`): `harness_cancel`
 *     lands in the tick-interval-sized gap between the reuse pre-assignment
 *     (`handleEventResult`, when the prior task went idle) and this tick
 *     picking the task back up.
 *   - `harness_task_complete` (native dispatch): `harness_cancel` lands while
 *     the Task tool call was still in flight.
 *
 * Routing every call through this one function means the return value can
 * never be silently discarded at a new (or existing) call site — which is
 * exactly how the reuse-path gap above went unguarded while the other two
 * call sites were already fixed.
 *
 * @returns `true` if the bind succeeded, `false` if the session was cleaned
 *   up as orphaned instead (caller must not send/replay anything into it).
 */
export async function bindSessionOrCleanup(
  dag: DagEngine,
  client: Parameters<typeof deleteSession>[0],
  taskId: string,
  sessionId: string,
  cancelledSessions: BoundedSet<string>,
): Promise<boolean> {
  const bound = dag.task_started(taskId, sessionId);
  if (!bound) {
    await cleanupOrphanedSession(client, sessionId, cancelledSessions);
    return false;
  }
  return true;
}

export async function handleEventResult(
  result: EventResult,
  client: Parameters<typeof deleteSession>[0],
  dag: DagEngine,
): Promise<void> {
  for (const n of result.notifications) {
    if (n.type === "toast") {
      await showToast(client, n.title, n.message, n.variant as "info" | "success" | "warning" | "error", n.duration);
    }
  }
  if (result.reuse_session) {
    // Pre-assign the session to the next task so the tick loop skips createSession.
    // task_started also updates session_to_task in the WASM engine.
    dag.task_started(result.reuse_session.next_task_id, result.reuse_session.session_id);
  } else if (result.delete_session) {
    await deleteSession(client, result.delete_session);
  }
}
