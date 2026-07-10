/**
 * Integration tests for the WASM DagEngine.
 *
 * These tests load the real .wasm binary and exercise the state machine
 * directly — no mocks.  They guard against regressions in the core
 * DAG logic, fallback handling, and workflow status transitions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DagEngine, initSync } from './wasm/openagent_harness.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load WASM once for the entire suite.
beforeAll(() => {
  const wasmBytes = readFileSync(join(__dir, 'wasm', 'openagent_harness_bg.wasm'));
  initSync({ module: wasmBytes });
});

/** Convenience: fresh DagEngine per test. */
function newDag(): DagEngine {
  return new DagEngine();
}

const TWO_TASKS = JSON.stringify([
  { agent: 'explorer', prompt: 'Explore the codebase', depends_on: [] },
  { agent: 'builder',  prompt: 'Fix the bug',          depends_on: [0] },
]);

const ONE_TASK = JSON.stringify([
  { agent: 'builder', prompt: 'Do something', depends_on: [] },
]);

const FALLBACK_CONFIG = JSON.stringify({
  explorer: { name: 'explorer', model: 'anthropic/claude-haiku-4-5', fallback_models: ['ollama/qwen:7b'] },
  builder:  { name: 'builder',  model: 'anthropic/claude-sonnet-4-6', fallback_models: ['ollama/qwen:7b'] },
});

// ─── Basic workflow ───────────────────────────────────────────────────────────

describe('DagEngine — basic workflow', () => {
  it('submit_workflow returns a workflow_id and task_ids', () => {
    const dag = newDag();
    const result = JSON.parse(dag.submit_workflow(TWO_TASKS)) as {
      workflow_id: string;
      task_ids: string[];
    };
    expect(result.workflow_id).toBeTypeOf('string');
    expect(result.task_ids).toHaveLength(2);
    dag.free();
  });

  it('tick() returns only the first unblocked task', () => {
    const dag = newDag();
    const { task_ids } = JSON.parse(dag.submit_workflow(TWO_TASKS));
    const ready = JSON.parse(dag.tick()) as Array<{ id: string; agent: string }>;
    expect(ready).toHaveLength(1);
    expect(ready[0].agent).toBe('explorer');
    expect(ready[0].id).toBe(task_ids[0]);
    dag.free();
  });

  it('second task becomes ready after first completes via session.idle', () => {
    const dag = newDag();
    const { task_ids } = JSON.parse(dag.submit_workflow(TWO_TASKS));
    JSON.parse(dag.tick()); // marks explorer Running
    dag.task_started(task_ids[0], 'ses_explorer');
    dag.process_event('session.idle', 'ses_explorer', '{}');

    const ready2 = JSON.parse(dag.tick()) as Array<{ id: string }>;
    expect(ready2).toHaveLength(1);
    expect(ready2[0].id).toBe(task_ids[1]);
    dag.free();
  });

  it('tick() returns empty array when all tasks are Running or blocked', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(TWO_TASKS));
    JSON.parse(dag.tick()); // explorer now Running
    const ready2 = JSON.parse(dag.tick()) as unknown[];
    expect(ready2).toHaveLength(0); // builder still blocked
    dag.free();
  });
});

// ─── Workflow status transitions ──────────────────────────────────────────────

describe('DagEngine — workflow status transitions', () => {
  it('workflow transitions to done when all tasks complete', () => {
    const dag = newDag();
    const { workflow_id } = JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');
    dag.process_event('session.idle', 'ses_1', '{}');

    const snapshot = JSON.parse(dag.get_workflow_snapshot(workflow_id)) as {
      status: { type: string };
    };
    expect(snapshot.status.type).toBe('done');
    dag.free();
  });

  it('workflow transitions to failed when a task fails', () => {
    const dag = newDag();
    const { workflow_id } = JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');
    dag.fail_task(task.id, 'auth failure');

    const snapshot = JSON.parse(dag.get_workflow_snapshot(workflow_id)) as {
      status: { type: string };
    };
    expect(snapshot.status.type).toBe('failed');
    dag.free();
  });
});

// ─── Agent fallback registration ──────────────────────────────────────────────

describe('DagEngine — fallback registration', () => {
  it('tasks receive fallback_models from the agent registry', () => {
    const dag = newDag();
    dag.set_agent_fallbacks(FALLBACK_CONFIG);
    JSON.parse(dag.submit_workflow(TWO_TASKS));
    const [task] = JSON.parse(dag.tick()) as Array<{
      id: string;
      agent: string;
      fallback_models: string[];
    }>;
    expect(task.agent).toBe('explorer');
    expect(task.fallback_models).toEqual(['ollama/qwen:7b']);
    dag.free();
  });

  it('task-level fallback_models override the registry', () => {
    const dag = newDag();
    dag.set_agent_fallbacks(FALLBACK_CONFIG);
    const custom = JSON.stringify([
      {
        agent: 'explorer',
        prompt: 'go',
        depends_on: [],
        fallback_models: ['custom/model-override'],
      },
    ]);
    JSON.parse(dag.submit_workflow(custom));
    const [task] = JSON.parse(dag.tick()) as Array<{ fallback_models: string[] }>;
    expect(task.fallback_models).toEqual(['custom/model-override']);
    dag.free();
  });

  it('task without registry entry and no task-level fallback has empty fallback_models', () => {
    const dag = newDag();
    // No set_agent_fallbacks call — registry is empty
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ fallback_models: string[] }>;
    expect(task.fallback_models).toEqual([]);
    dag.free();
  });
});

// ─── try_fallback ─────────────────────────────────────────────────────────────

describe('DagEngine — try_fallback', () => {
  it('advances to the next model and resets the task to Pending', () => {
    const dag = newDag();
    dag.set_agent_fallbacks(FALLBACK_CONFIG);
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    const fb = JSON.parse(dag.try_fallback(task.id, '429 Too Many Requests')) as {
      fallback: boolean;
      new_model: string;
      attempt: number;
      session_id: string | null;
    };
    expect(fb.fallback).toBe(true);
    expect(fb.new_model).toBe('ollama/qwen:7b');
    expect(fb.attempt).toBe(1);
    expect(fb.session_id).toBe('ses_1'); // old session for cleanup
    dag.free();
  });

  it('task is Pending again after try_fallback — tick picks it up', () => {
    const dag = newDag();
    dag.set_agent_fallbacks(FALLBACK_CONFIG);
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');
    dag.try_fallback(task.id, '429');

    const retry = JSON.parse(dag.tick()) as Array<{ id: string; model: string }>;
    expect(retry).toHaveLength(1);
    expect(retry[0].id).toBe(task.id);
    expect(retry[0].model).toBe('ollama/qwen:7b');
    dag.free();
  });

  it('throws "no more fallback models" when the chain is exhausted', () => {
    const dag = newDag();
    dag.set_agent_fallbacks(FALLBACK_CONFIG); // one fallback: ollama/qwen:7b
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    dag.try_fallback(task.id, '429'); // consumes the one fallback (attempt → 1)
    JSON.parse(dag.tick());           // picks up the retried task
    dag.task_started(task.id, 'ses_2');

    expect(() => dag.try_fallback(task.id, '429')).toThrow('no more fallback models');
    dag.free();
  });
});

// ─── process_event session.error + fallback_hint ─────────────────────────────

describe('DagEngine — session.error fallback_hint', () => {
  it('sets has_fallbacks=true when fallbacks remain', () => {
    const dag = newDag();
    dag.set_agent_fallbacks(FALLBACK_CONFIG);
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    const result = JSON.parse(
      dag.process_event('session.error', 'ses_1', JSON.stringify({ error: '429 Too Many Requests' })),
    ) as { fallback_hint: { task_id: string; error_message: string; has_fallbacks: boolean } };

    expect(result.fallback_hint).toBeDefined();
    expect(result.fallback_hint.has_fallbacks).toBe(true);
    expect(result.fallback_hint.error_message).toContain('429');
    expect(result.fallback_hint.task_id).toBe(task.id);
    dag.free();
  });

  it('sets has_fallbacks=false when no fallbacks are registered', () => {
    const dag = newDag();
    // No set_agent_fallbacks — empty registry
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    const result = JSON.parse(
      dag.process_event('session.error', 'ses_1', JSON.stringify({ error: '429' })),
    ) as { fallback_hint: { has_fallbacks: boolean } };

    expect(result.fallback_hint.has_fallbacks).toBe(false);
    dag.free();
  });

  it('returns empty result (no fallback_hint) when session is unknown', () => {
    const dag = newDag();
    const result = JSON.parse(
      dag.process_event('session.error', 'ses_unknown', JSON.stringify({ error: '429' })),
    ) as { fallback_hint?: unknown; notifications: unknown[] };

    expect(result.fallback_hint).toBeUndefined();
    expect(result.notifications).toHaveLength(0);
    dag.free();
  });

  it('sets delete_session to the erroring session id', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    const result = JSON.parse(
      dag.process_event('session.error', 'ses_1', JSON.stringify({ error: '500' })),
    ) as { delete_session: string | null };

    expect(result.delete_session).toBe('ses_1');
    dag.free();
  });
});

// ─── cancel_task / cancel_workflow ─────────────────────────────────────────────

describe('DagEngine — cancel_task', () => {
  it('cancels a running task and returns its session_id', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    const result = JSON.parse(dag.cancel_task(task.id)) as {
      cancelled_task_ids: string[];
      session_ids: string[];
    };
    expect(result.cancelled_task_ids).toEqual([task.id]);
    expect(result.session_ids).toEqual(['ses_1']);

    const cancelledTask = JSON.parse(dag.get_task(task.id)) as { status: { type: string } };
    expect(cancelledTask.status.type).toBe('cancelled');
    dag.free();
  });

  it('cascades cancellation to transitive dependents', () => {
    const dag = newDag();
    const { task_ids } = JSON.parse(dag.submit_workflow(TWO_TASKS)) as { task_ids: string[] };
    JSON.parse(dag.tick()); // explorer becomes Running

    const result = JSON.parse(dag.cancel_task(task_ids[0])) as {
      cancelled_task_ids: string[];
    };
    expect(result.cancelled_task_ids.sort()).toEqual([...task_ids].sort());

    const builderTask = JSON.parse(dag.get_task(task_ids[1])) as { status: { type: string } };
    expect(builderTask.status.type).toBe('cancelled');
    dag.free();
  });

  it('marks the whole workflow cancelled once no active branch remains', () => {
    const dag = newDag();
    const { workflow_id, task_ids } = JSON.parse(dag.submit_workflow(ONE_TASK)) as {
      workflow_id: string;
      task_ids: string[];
    };
    JSON.parse(dag.tick());
    dag.task_started(task_ids[0], 'ses_1');
    dag.cancel_task(task_ids[0]);

    const snapshot = JSON.parse(dag.get_workflow_snapshot(workflow_id)) as {
      status: { type: string };
    };
    expect(snapshot.status.type).toBe('cancelled');
    dag.free();
  });

  it('throws when the task is already terminal', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');
    dag.process_event('session.idle', 'ses_1', '{}'); // task now Done

    expect(() => dag.cancel_task(task.id)).toThrow('already terminal');
    dag.free();
  });

  it('throws for an unknown task id', () => {
    const dag = newDag();
    expect(() => dag.cancel_task('nope')).toThrow('not found');
    dag.free();
  });

  it('a late session.idle for the cancelled session is a no-op (no session_to_task mapping)', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');
    dag.cancel_task(task.id);

    const result = JSON.parse(dag.process_event('session.idle', 'ses_1', '{}')) as {
      delete_session: string | null;
      notifications: unknown[];
    };
    expect(result.delete_session).toBeNull();
    expect(result.notifications).toHaveLength(0);

    const stillCancelled = JSON.parse(dag.get_task(task.id)) as { status: { type: string } };
    expect(stillCancelled.status.type).toBe('cancelled');
    dag.free();
  });

  it('task_started() returns false through the real WASM boundary for a cancelled task, and creates no binding', () => {
    // This exercises the actual compiled bool return marshalling (not just
    // the Rust unit test or a JS-side mock) — regression coverage for the
    // createSession()/task_started() race: a task cancelled while a session
    // was being created must reject the late bind attempt.
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.cancel_task(task.id);

    const bound = dag.task_started(task.id, 'ses_orphan');
    expect(bound).toBe(false);

    // No mapping was created — a subsequent event for this session is a no-op.
    const result = JSON.parse(dag.process_event('session.idle', 'ses_orphan', '{}')) as {
      delete_session: string | null;
      notifications: unknown[];
    };
    expect(result.delete_session).toBeNull();
    expect(result.notifications).toHaveLength(0);

    const stillCancelled = JSON.parse(dag.get_task(task.id)) as {
      status: { type: string };
      session_id: string | null;
    };
    expect(stillCancelled.status.type).toBe('cancelled');
    expect(stillCancelled.session_id).toBeNull();
    dag.free();
  });

  it('task_started() returns true through the real WASM boundary for a Running task', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;

    expect(dag.task_started(task.id, 'ses_ok')).toBe(true);
    dag.free();
  });
});

describe('DagEngine — cancel_workflow', () => {
  it('cancels every pending/running task and returns their session_ids', () => {
    const dag = newDag();
    const { workflow_id, task_ids } = JSON.parse(dag.submit_workflow(TWO_TASKS)) as {
      workflow_id: string;
      task_ids: string[];
    };
    JSON.parse(dag.tick());
    dag.task_started(task_ids[0], 'ses_1');

    const result = JSON.parse(dag.cancel_workflow(workflow_id)) as {
      cancelled_task_ids: string[];
      session_ids: string[];
    };
    expect(result.cancelled_task_ids.sort()).toEqual([...task_ids].sort());
    expect(result.session_ids).toEqual(['ses_1']);

    const snapshot = JSON.parse(dag.get_workflow_snapshot(workflow_id)) as {
      status: { type: string };
    };
    expect(snapshot.status.type).toBe('cancelled');
    dag.free();
  });

  it('preserves already-Done tasks instead of cancelling them', () => {
    const dag = newDag();
    const { workflow_id, task_ids } = JSON.parse(dag.submit_workflow(TWO_TASKS)) as {
      workflow_id: string;
      task_ids: string[];
    };
    JSON.parse(dag.tick());
    dag.task_started(task_ids[0], 'ses_1');
    dag.process_event('session.idle', 'ses_1', '{}'); // explorer Done, builder now ready

    dag.cancel_workflow(workflow_id);

    const explorerTask = JSON.parse(dag.get_task(task_ids[0])) as { status: { type: string } };
    expect(explorerTask.status.type).toBe('done');
    dag.free();
  });

  it('throws when the workflow is already terminal', () => {
    const dag = newDag();
    const { workflow_id } = JSON.parse(dag.submit_workflow(ONE_TASK)) as { workflow_id: string };
    dag.cancel_workflow(workflow_id);

    expect(() => dag.cancel_workflow(workflow_id)).toThrow('already terminal');
    dag.free();
  });

  it('throws for an unknown workflow id', () => {
    const dag = newDag();
    expect(() => dag.cancel_workflow('nope')).toThrow('not found');
    dag.free();
  });
});
