/**
 * Integration tests for the WASM DagEngine.
 *
 * These tests load the real .wasm binary and exercise the state machine
 * directly — no mocks.  They guard against regressions in the core
 * DAG logic and workflow status transitions.
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

// ─── Task-level model override ────────────────────────────────────────────────

describe('DagEngine — task model override', () => {
  it('task-level model flows through tick()', () => {
    const dag = newDag();
    dag.submit_workflow(
      JSON.stringify([
        { agent: 'builder', prompt: 'x', depends_on: [], model: 'custom/model-override' },
      ]),
    );
    const [task] = JSON.parse(dag.tick()) as Array<{ model: string }>;
    expect(task.model).toBe('custom/model-override');
    dag.free();
  });
});

// ─── process_event session.error ──────────────────────────────────────────────

describe('DagEngine — session.error', () => {
  it('marks the task Failed, fails the workflow and deletes the session', () => {
    const dag = newDag();
    const { workflow_id } = JSON.parse(dag.submit_workflow(ONE_TASK));
    const [task] = JSON.parse(dag.tick()) as Array<{ id: string }>;
    dag.task_started(task.id, 'ses_1');

    const result = JSON.parse(
      dag.process_event('session.error', 'ses_1', JSON.stringify({ error: '429 Too Many Requests' })),
    ) as { delete_session: string | null };

    expect(result.delete_session).toBe('ses_1');
    const t = JSON.parse(dag.get_task(task.id)) as { status: { type: string } };
    expect(t.status.type).toBe('failed');
    const snapshot = JSON.parse(dag.get_workflow_snapshot(workflow_id)) as {
      status: { type: string };
    };
    expect(snapshot.status.type).toBe('failed');
    // Already terminal: the plugin must not call fail_task afterwards.
    expect(() => dag.fail_task(task.id, 'again')).toThrow();
    dag.free();
  });

  it('returns an empty result when the session is unknown', () => {
    const dag = newDag();
    const result = JSON.parse(
      dag.process_event('session.error', 'ses_unknown', JSON.stringify({ error: '429' })),
    ) as { delete_session: string | null; notifications: unknown[] };

    expect(result.delete_session).toBeNull();
    expect(result.notifications).toHaveLength(0);
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

// ─── card_id ──────────────────────────────────────────────────────────────────

describe('DagEngine — optional card_id', () => {
  it('workflow card_id propagates to ready tasks and snapshot', () => {
    const dag = newDag();
    const { workflow_id } = JSON.parse(dag.submit_workflow(ONE_TASK, 'ses_p', 'CARD-1')) as {
      workflow_id: string;
    };
    const ready = JSON.parse(dag.tick()) as Array<{ card_id?: string }>;
    expect(ready[0].card_id).toBe('CARD-1');
    const snap = JSON.parse(dag.get_workflow_snapshot(workflow_id)) as {
      card_id?: string;
      tasks: Array<{ card_id?: string }>;
    };
    expect(snap.card_id).toBe('CARD-1');
    expect(snap.tasks[0].card_id).toBe('CARD-1');
    dag.free();
  });

  it('no-card workflow omits card_id', () => {
    const dag = newDag();
    JSON.parse(dag.submit_workflow(ONE_TASK));
    expect(dag.tick()).not.toContain('card_id');
    dag.free();
  });

  it('plan draft binds the first card_id and rejects a conflicting one', () => {
    const dag = newDag();
    const first = JSON.parse(
      dag.append_plan_task(JSON.stringify({ agent: 'a', prompt: 'p', card_id: 'CARD-1' })),
    ) as { plan_id: string };
    expect(dag.get_plan_card_id(first.plan_id)).toBe('CARD-1');
    expect(() =>
      dag.append_plan_task(
        JSON.stringify({ agent: 'a', prompt: 'p', card_id: 'CARD-2' }),
        first.plan_id,
      ),
    ).toThrow('already bound to card CARD-1');
    dag.free();
  });
});
