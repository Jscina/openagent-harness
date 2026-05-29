// ─── DAG utilities ────────────────────────────────────────────────────────────

import type { DagEngine } from "./wasm/openagent_harness.js";

import type { EventResult } from "./types.js";
import { deleteSession, showToast } from "./client.js";

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
