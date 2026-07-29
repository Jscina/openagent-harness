import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseJson,
  extractWorkflowStatus,
  findOwningWorkflowId,
  sleep,
  handleEventResult,
  cleanupOrphanedSession,
  bindSessionOrCleanup,
} from './dag.js';
import { BoundedSet } from './bounded.js';

// ─── parseJson ────────────────────────────────────────────────────────────────

describe('parseJson', () => {
  it('parses valid JSON object', () => {
    expect(parseJson('{"a":1,"b":"two"}')).toEqual({ a: 1, b: 'two' });
  });

  it('parses valid JSON array', () => {
    expect(parseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON null', () => {
    expect(parseJson('null')).toBeNull();
  });

  it('parses JSON number', () => {
    expect(parseJson('42')).toBe(42);
  });

  it('returns the raw string when JSON is invalid', () => {
    expect(parseJson('not json')).toBe('not json');
  });

  it('returns empty string when input is empty string', () => {
    expect(parseJson('')).toBe('');
  });

  it('returns raw string for truncated JSON', () => {
    expect(parseJson('{"a":')).toBe('{"a":');
  });
});

// ─── extractWorkflowStatus ────────────────────────────────────────────────────

describe('extractWorkflowStatus', () => {
  it('returns null for null input', () => {
    expect(extractWorkflowStatus(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(extractWorkflowStatus(undefined)).toBeNull();
  });

  it('returns null for a non-object primitive', () => {
    expect(extractWorkflowStatus('running')).toBeNull();
    expect(extractWorkflowStatus(42)).toBeNull();
  });

  it('extracts a plain string status and lowercases it', () => {
    expect(extractWorkflowStatus({ status: 'RUNNING' })).toBe('running');
    expect(extractWorkflowStatus({ status: 'Done' })).toBe('done');
  });

  it('extracts a tagged-union status via the type field', () => {
    expect(extractWorkflowStatus({ status: { type: 'running' } })).toBe('running');
    expect(extractWorkflowStatus({ status: { type: 'done' } })).toBe('done');
    expect(extractWorkflowStatus({ status: { type: 'failed', message: 'oops' } })).toBe('failed');
  });

  it('falls back to state field when status is absent', () => {
    expect(extractWorkflowStatus({ state: 'done' })).toBe('done');
  });

  it('falls back to nested workflow.status', () => {
    expect(extractWorkflowStatus({ workflow: { status: 'done' } })).toBe('done');
  });

  it('falls back to nested workflow.state', () => {
    expect(extractWorkflowStatus({ workflow: { state: 'running' } })).toBe('running');
  });

  it('returns null when no recognised key is present', () => {
    expect(extractWorkflowStatus({})).toBeNull();
    expect(extractWorkflowStatus({ other: 'value' })).toBeNull();
  });

  it('returns null when status is a non-string non-object primitive', () => {
    expect(extractWorkflowStatus({ status: 42 })).toBeNull();
    expect(extractWorkflowStatus({ status: true })).toBeNull();
  });

  it('extracts "cancelled" from a plain string status', () => {
    expect(extractWorkflowStatus({ status: 'Cancelled' })).toBe('cancelled');
  });

  it('extracts "cancelled" from a tagged-union status (matches WorkflowStatus::Cancelled)', () => {
    expect(extractWorkflowStatus({ status: { type: 'cancelled' } })).toBe('cancelled');
  });
});

// ─── findOwningWorkflowId ──────────────────────────────────────────────────────

describe('findOwningWorkflowId', () => {
  it('returns the workflow_id whose task list contains the given task id', () => {
    const dag = {
      list_workflow_summaries: () => JSON.stringify([{ id: 'wf_1' }, { id: 'wf_2' }]),
      get_workflow: (id: string) =>
        id === 'wf_1'
          ? JSON.stringify({ id: 'wf_1', tasks: ['t_a', 't_b'] })
          : JSON.stringify({ id: 'wf_2', tasks: ['t_c'] }),
    } as any;

    expect(findOwningWorkflowId(dag, 't_c')).toBe('wf_2');
    expect(findOwningWorkflowId(dag, 't_a')).toBe('wf_1');
  });

  it('returns null when no workflow contains the task id', () => {
    const dag = {
      list_workflow_summaries: () => JSON.stringify([{ id: 'wf_1' }]),
      get_workflow: () => JSON.stringify({ id: 'wf_1', tasks: ['t_a'] }),
    } as any;

    expect(findOwningWorkflowId(dag, 't_unknown')).toBeNull();
  });

  it('returns null when there are no workflows', () => {
    const dag = {
      list_workflow_summaries: () => '[]',
      get_workflow: () => 'null',
    } as any;

    expect(findOwningWorkflowId(dag, 't_a')).toBeNull();
  });
});

// ─── sleep ────────────────────────────────────────────────────────────────────

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the specified milliseconds with fake timers', async () => {
    vi.useFakeTimers();
    const p = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
  });

  it('does not resolve before the specified time', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const p = sleep(500).then(() => { resolved = true; });
    vi.advanceTimersByTime(499);
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);
    vi.advanceTimersByTime(1);
    await p;
    expect(resolved).toBe(true);
  });
});

// ─── handleEventResult ────────────────────────────────────────────────────────

describe('handleEventResult', () => {
  it('fires showToast for each toast notification', async () => {
    const client = {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
    } as any;
    const dag = { task_started: vi.fn() } as any;

    await handleEventResult(
      {
        notifications: [
          { type: 'toast', title: 'T1', message: 'M1', variant: 'info' },
          { type: 'toast', title: 'T2', message: 'M2', variant: 'warning', duration: 3000 },
        ],
        delete_session: null,
      },
      client,
      dag,
    );

    expect(client.tui.showToast).toHaveBeenCalledTimes(2);
  });

  it('calls dag.task_started when reuse_session is set', async () => {
    const client = { tui: { showToast: vi.fn() } } as any;
    const dag = { task_started: vi.fn() } as any;

    await handleEventResult(
      {
        notifications: [],
        delete_session: null,
        reuse_session: { session_id: 'ses_A', next_task_id: 'task_B' },
      },
      client,
      dag,
    );

    expect(dag.task_started).toHaveBeenCalledWith('task_B', 'ses_A');
  });

  it('calls deleteSession when delete_session is set', async () => {
    const client = {
      tui: { showToast: vi.fn() },
      session: { delete: vi.fn().mockResolvedValue({}) },
    } as any;
    const dag = { task_started: vi.fn() } as any;

    await handleEventResult(
      { notifications: [], delete_session: 'ses_old' },
      client,
      dag,
    );

    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: 'ses_old' } });
  });

  it('prefers reuse_session over delete_session when both are present', async () => {
    const client = {
      tui: { showToast: vi.fn() },
      session: { delete: vi.fn() },
    } as any;
    const dag = { task_started: vi.fn() } as any;

    await handleEventResult(
      {
        notifications: [],
        delete_session: 'ses_old',
        reuse_session: { session_id: 'ses_A', next_task_id: 'task_B' },
      },
      client,
      dag,
    );

    expect(client.session.delete).not.toHaveBeenCalled();
    expect(dag.task_started).toHaveBeenCalledWith('task_B', 'ses_A');
  });

  it('does nothing when notifications is empty and neither session key is set', async () => {
    const client = {
      tui: { showToast: vi.fn() },
      session: { delete: vi.fn() },
    } as any;
    const dag = { task_started: vi.fn() } as any;

    await handleEventResult(
      { notifications: [], delete_session: null },
      client,
      dag,
    );

    expect(client.tui.showToast).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(dag.task_started).not.toHaveBeenCalled();
  });
});

// ─── cleanupOrphanedSession ────────────────────────────────────────────────────

describe('cleanupOrphanedSession', () => {
  it('tracks the session as cancelled BEFORE aborting it (ordering matters)', async () => {
    const cancelledSessions = new BoundedSet<string>(1000);
    const callOrder: string[] = [];

    const client = {
      session: {
        abort: vi.fn().mockImplementation(async () => {
          // At the moment abort is invoked, the session must already be
          // tracked — this is what guarantees the abort-induced session.error
          // gets dropped by the cancelledSessions guard instead of being
          // replayed as an orphaned event.
          callOrder.push(cancelledSessions.has('ses_orphan') ? 'tracked-then-abort' : 'abort-before-tracked');
          return undefined;
        }),
        delete: vi.fn().mockImplementation(async () => {
          callOrder.push('delete');
          return {};
        }),
      },
    } as any;

    await cleanupOrphanedSession(client, 'ses_orphan', cancelledSessions);

    expect(callOrder).toEqual(['tracked-then-abort', 'delete']);
  });

  it('aborts and deletes the session, and leaves it in cancelledSessions', async () => {
    const cancelledSessions = new BoundedSet<string>(1000);
    const client = {
      session: {
        abort: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue({}),
      },
    } as any;

    await cleanupOrphanedSession(client, 'ses_orphan', cancelledSessions);

    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: 'ses_orphan' } });
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: 'ses_orphan' } });
    expect(cancelledSessions.has('ses_orphan')).toBe(true);
  });

  it('returns true when abortSession succeeds and false when it fails, without throwing', async () => {
    const cancelledSessions = new BoundedSet<string>(1000);
    const okClient = {
      session: { abort: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue({}) },
    } as any;
    await expect(cleanupOrphanedSession(okClient, 'ses_ok', cancelledSessions)).resolves.toBe(true);

    const failClient = {
      session: {
        abort: vi.fn().mockRejectedValue(new Error('gone')),
        delete: vi.fn().mockResolvedValue({}),
      },
    } as any;
    await expect(cleanupOrphanedSession(failClient, 'ses_fail', cancelledSessions)).resolves.toBe(false);
    // Even when abort fails, delete must still run and the session must
    // still end up tracked as cancelled.
    expect(failClient.session.delete).toHaveBeenCalledWith({ path: { id: 'ses_fail' } });
    expect(cancelledSessions.has('ses_fail')).toBe(true);
  });

});

// ─── bindSessionOrCleanup ───────────────────────────────────────────────────
//
// This is the single shared call site for "bind via task_started(), clean up
// if the DAG refuses" — used by the tick loop's fresh-session path, its
// session-reuse path (existing_session_id), and harness_task_complete. It
// replaces three previously-separate inline copies of this pattern, one of
// which (the reuse path) had silently dropped the bound-check entirely.
// Testing the real function here (rather than re-inlining the pattern in
// the test, as the previous version of this suite did) is exactly what
// would have caught that drift.

describe('bindSessionOrCleanup', () => {
  it('returns true and leaves the session alone when task_started binds successfully', async () => {
    const dag = { task_started: vi.fn().mockReturnValue(true) } as any;
    const cancelledSessions = new BoundedSet<string>(1000);
    const client = {
      session: {
        abort: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const result = await bindSessionOrCleanup(dag, client, 'task_1', 'ses_ok', cancelledSessions);

    expect(result).toBe(true);
    expect(dag.task_started).toHaveBeenCalledWith('task_1', 'ses_ok');
    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
    expect(cancelledSessions.has('ses_ok')).toBe(false);
  });

  it('simulates the createSession/task_started race: returns false and cleans up the orphaned session so it cannot resurrect the task via a late event', async () => {
    // Regression scenario: dag.tick() returned a task (fresh session) or a
    // reuse_session pre-assignment picked one back up (existing_session_id),
    // but the task was cancelled via harness_cancel in the meantime — so
    // dag.task_started() (mocked here) returns false.
    const dag = { task_started: vi.fn().mockReturnValue(false) } as any;
    const cancelledSessions = new BoundedSet<string>(1000);
    const client = {
      session: {
        abort: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue({}),
      },
    } as any;

    const sessionId = 'ses_race';
    const result = await bindSessionOrCleanup(dag, client, 'task_1', sessionId, cancelledSessions);

    expect(result).toBe(false);
    expect(dag.task_started).toHaveBeenCalledWith('task_1', sessionId);
    // The orphaned session was aborted and deleted...
    expect(client.session.abort).toHaveBeenCalledWith({ path: { id: sessionId } });
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: sessionId } });
    // ...and is now tracked, so a late session.idle/session.error event hook
    // (which checks `cancelledSessions.has(sessionId)` before calling
    // dag.process_event) would drop it instead of resurrecting the task.
    expect(cancelledSessions.has(sessionId)).toBe(true);
  });
});
