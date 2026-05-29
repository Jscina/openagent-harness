import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseJson,
  extractWorkflowStatus,
  sleep,
  handleEventResult,
} from './dag.js';

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
