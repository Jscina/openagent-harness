/**
 * Tests for the memory_* tool definitions and the harness_task_complete
 * auto-trace-on-failure glue added to harness.ts.
 *
 * memory.ts is fully mocked here — these tests only verify that the tool
 * defs call the right memory.ts function with the right args and surface
 * results/errors cleanly. Real corpus I/O is covered by memory.test.ts.
 *
 * The plugin itself loads the real WASM DagEngine synchronously at init
 * (same approach as wasm.test.ts — no mocking of DagEngine), so
 * harness_task_complete / submit_workflow / harness_state exercise the real
 * state machine. Timers are faked for the whole suite so the plugin's
 * internal 500ms tick loop never fires: none of these tests rely on it
 * (harness_task_complete binds sessions directly, the same way it does for
 * real native-dispatch tasks), and letting it fire nondeterministically
 * against the mocked client would make tests flaky.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { PluginInput } from '@opencode-ai/plugin';

// vi.mock factories are hoisted above top-level const declarations, so the
// mock fns must be created inline here rather than referencing an outer
// variable (see https://vitest.dev/api/vi.html#vi-mock) — the mocked module
// is then imported normally below and its exports (already vi.fn()s thanks
// to this mock) are wrapped with vi.mocked() for typed assertions.
vi.mock('./memory.js', () => ({
  createCard: vi.fn(),
  appendTrace: vi.fn(),
  assembleContext: vi.fn(),
  promoteFinding: vi.fn(),
  listActiveCards: vi.fn(),
}));

import harnessPlugin from './harness.js';
import {
  createCard as createCardImport,
  appendTrace as appendTraceImport,
  assembleContext as assembleContextImport,
  promoteFinding as promoteFindingImport,
  listActiveCards as listActiveCardsImport,
} from './memory.js';

const memoryMocks = {
  createCard: vi.mocked(createCardImport),
  appendTrace: vi.mocked(appendTraceImport),
  assembleContext: vi.mocked(assembleContextImport),
  promoteFinding: vi.mocked(promoteFindingImport),
  listActiveCards: vi.mocked(listActiveCardsImport),
};

function makeClient() {
  return {
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: 'ses_mock' } }),
      promptAsync: vi.fn().mockResolvedValue({ data: {} }),
      delete: vi.fn().mockResolvedValue({ data: {} }),
      abort: vi.fn().mockResolvedValue({ data: {} }),
    },
    tui: {
      showToast: vi.fn().mockResolvedValue({ data: {} }),
    },
  } as unknown as PluginInput['client'];
}

// Minimal ToolContext stub — only the fields the tools under test actually
// read (submit_workflow reads .agent; harness_task_complete/memory_* tools
// read none of it) are meaningful; the rest exist only to satisfy the type.
function makeContext(agent = 'orchestrator') {
  return {
    sessionID: 'ses_ctx',
    messageID: 'msg_ctx',
    agent,
    directory: '/tmp',
    worktree: '/tmp',
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as any;
}

let plugin: Awaited<ReturnType<typeof harnessPlugin>>;
let client: ReturnType<typeof makeClient>;

beforeAll(async () => {
  // Must be enabled before the plugin is instantiated so the setInterval it
  // registers internally is captured by the fake clock, not the real one.
  vi.useFakeTimers();
  client = makeClient();
  plugin = await harnessPlugin({ client } as unknown as PluginInput);
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  memoryMocks.createCard.mockReset();
  memoryMocks.appendTrace.mockReset();
  memoryMocks.assembleContext.mockReset();
  memoryMocks.promoteFinding.mockReset();
  memoryMocks.listActiveCards.mockReset();
});

/** Submit a single-task workflow directly against the real DAG and return its ids. */
async function submitOneTask(agent = 'builder') {
  const raw = await plugin.tool.submit_workflow.execute(
    { tasks: [{ agent, prompt: 'do work', depends_on: [] }] },
    makeContext('orchestrator'),
  );
  return JSON.parse(raw as string) as { workflow_id: string; task_ids: string[] };
}

async function getWorkflowStatus(workflow_id: string): Promise<string | null> {
  const raw = await plugin.tool.harness_state.execute({ workflow_id }, makeContext());
  const parsed = JSON.parse(raw as string) as { snapshot: { status?: { type?: string } } };
  return parsed.snapshot?.status?.type ?? null;
}

// ─── memory_card ────────────────────────────────────────────────────────────

describe('memory_card tool', () => {
  it('calls createCard with the given args and returns the created files + success', async () => {
    memoryMocks.createCard.mockReturnValue(['context.md', 'trace.md', 'benchmarks.md', 'artifacts/.gitkeep']);

    const result = await plugin.tool.memory_card.execute(
      { cardId: 'CARD-123', symptom: 'crash on export', source: 'ado', backlog: false },
      makeContext(),
    );

    expect(memoryMocks.createCard).toHaveBeenCalledWith({
      cardId: 'CARD-123',
      symptom: 'crash on export',
      source: 'ado',
      backlog: false,
    });
    const parsed = JSON.parse(result as string);
    expect(parsed).toEqual({
      success: true,
      cardId: 'CARD-123',
      created: ['context.md', 'trace.md', 'benchmarks.md', 'artifacts/.gitkeep'],
    });
  });

  it('passes through undefined optional args unchanged', async () => {
    memoryMocks.createCard.mockReturnValue(['context.md']);
    await plugin.tool.memory_card.execute({ cardId: 'CARD-BACKLOG', backlog: true }, makeContext());
    expect(memoryMocks.createCard).toHaveBeenCalledWith({
      cardId: 'CARD-BACKLOG',
      symptom: undefined,
      source: undefined,
      backlog: true,
    });
  });

  it('surfaces createCard errors as a clean tool-execution error', async () => {
    memoryMocks.createCard.mockImplementation(() => {
      throw new Error('createCard: card already exists: /foo/CARD-123 (refusing to overwrite)');
    });

    await expect(
      plugin.tool.memory_card.execute({ cardId: 'CARD-123' }, makeContext()),
    ).rejects.toThrow(/memory_card failed:.*card already exists/);
  });

  it('wraps a non-Error throw from createCard as a string message', async () => {
    memoryMocks.createCard.mockImplementation(() => {
      throw 'disk full';
    });

    await expect(
      plugin.tool.memory_card.execute({ cardId: 'CARD-123' }, makeContext()),
    ).rejects.toThrow('memory_card failed: disk full');
  });
});

// ─── memory_trace ───────────────────────────────────────────────────────────

describe('memory_trace tool', () => {
  it('calls appendTrace with the given args and returns the economy-readout string', async () => {
    memoryMocks.appendTrace.mockReturnValue({
      path: '/root/issues/active/CARD-1/trace.md',
      linesBefore: 5,
      linesAfter: 9,
      bytesBefore: 120,
      tokensAvoided: 30,
      formatted: 'Appended finding entry to /root/issues/active/CARD-1/trace.md (5 -> 9 lines)\n  ~30 tokens not pulled into context',
    });

    const result = await plugin.tool.memory_trace.execute(
      { cardId: 'CARD-1', type: 'finding', body: 'Truncation is at export.c:342', session: 'opencode' },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).toHaveBeenCalledWith({
      cardId: 'CARD-1',
      type: 'finding',
      body: 'Truncation is at export.c:342',
      session: 'opencode',
    });
    expect(result).toBe('Appended finding entry to /root/issues/active/CARD-1/trace.md (5 -> 9 lines)\n  ~30 tokens not pulled into context');
  });

  it('surfaces appendTrace errors as a clean tool-execution error', async () => {
    memoryMocks.appendTrace.mockImplementation(() => {
      throw new Error('appendTrace: empty entry body (body must not be empty or whitespace-only)');
    });

    await expect(
      plugin.tool.memory_trace.execute({ cardId: 'CARD-1', type: 'next-step', body: '   ' }, makeContext()),
    ).rejects.toThrow(/memory_trace failed:.*empty entry body/);
  });
});

// ─── memory_context ─────────────────────────────────────────────────────────

describe('memory_context tool', () => {
  it('calls assembleContext with the given args and returns the assembled markdown', async () => {
    memoryMocks.assembleContext.mockReturnValue('# RAG Context — CARD-1\n\n...');

    const result = await plugin.tool.memory_context.execute(
      { cardId: 'CARD-1', mode: 'full', sections: ['known-behaviors'] },
      makeContext(),
    );

    expect(memoryMocks.assembleContext).toHaveBeenCalledWith({
      cardId: 'CARD-1',
      mode: 'full',
      sections: ['known-behaviors'],
    });
    expect(result).toBe('# RAG Context — CARD-1\n\n...');
  });

  it('surfaces assembleContext errors as a clean tool-execution error', async () => {
    memoryMocks.assembleContext.mockImplementation(() => {
      throw new Error('assembleContext: card not found: CARD-NOPE');
    });

    await expect(
      plugin.tool.memory_context.execute({ cardId: 'CARD-NOPE' }, makeContext()),
    ).rejects.toThrow(/memory_context failed:.*card not found/);
  });
});

// ─── memory_promote ─────────────────────────────────────────────────────────

describe('memory_promote tool', () => {
  it('calls promoteFinding with the given args and returns a confirmation', async () => {
    memoryMocks.promoteFinding.mockReturnValue({
      systemPath: '/root/system/known-behaviors/export-truncation.md',
      benchmarksPath: '/root/issues/active/CARD-1/benchmarks.md',
      created: true,
    });

    const result = await plugin.tool.memory_promote.execute(
      {
        cardId: 'CARD-1',
        finding: 'Export truncates at 4096 bytes',
        impact: 'Affects all export jobs over 4KB',
        targetPath: 'known-behaviors/export-truncation.md',
        title: 'Export Truncation',
        sectionTitle: 'Size Limit',
      },
      makeContext(),
    );

    expect(memoryMocks.promoteFinding).toHaveBeenCalledWith({
      cardId: 'CARD-1',
      finding: 'Export truncates at 4096 bytes',
      impact: 'Affects all export jobs over 4KB',
      targetPath: 'known-behaviors/export-truncation.md',
      title: 'Export Truncation',
      sectionTitle: 'Size Limit',
    });
    expect(JSON.parse(result as string)).toEqual({
      success: true,
      systemPath: '/root/system/known-behaviors/export-truncation.md',
      benchmarksPath: '/root/issues/active/CARD-1/benchmarks.md',
      created: true,
    });
  });

  it('surfaces promoteFinding errors as a clean tool-execution error', async () => {
    memoryMocks.promoteFinding.mockImplementation(() => {
      throw new Error('promoteFinding: card not found: CARD-NOPE');
    });

    await expect(
      plugin.tool.memory_promote.execute(
        { cardId: 'CARD-NOPE', finding: 'x', targetPath: 'known-behaviors/x.md' },
        makeContext(),
      ),
    ).rejects.toThrow(/memory_promote failed:.*card not found/);
  });
});

// ─── harness_task_complete auto-trace glue ─────────────────────────────────

describe('harness_task_complete — auto-trace-on-failure glue', () => {
  // "Unexpected error" is classified as terminal (see errors.test.ts), so
  // every scenario below reaches the dag.fail_task() call deterministically
  // without going through the retryable-fallback branch first.
  const TERMINAL_ERROR = 'Unexpected error: build step blew up';

  it('does not call appendTrace when zero active cards exist, and still fails the task', async () => {
    memoryMocks.listActiveCards.mockReturnValue([]);
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await plugin.tool.harness_task_complete.execute(
      { task_id: task_ids[0], session_id: 'ses_a', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
    expect(JSON.parse(raw as string).status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('appends a trace entry when exactly one active card exists, and still fails the task', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['CARD-ONLY-ONE']);
    const { workflow_id, task_ids } = await submitOneTask();
    const taskId = task_ids[0];

    const raw = await plugin.tool.harness_task_complete.execute(
      { task_id: taskId, session_id: 'ses_b', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).toHaveBeenCalledTimes(1);
    const call = memoryMocks.appendTrace.mock.calls[0][0];
    expect(call.cardId).toBe('CARD-ONLY-ONE');
    expect(call.type).toBe('finding');
    expect(call.body).toContain(taskId);
    expect(call.body).toContain(TERMINAL_ERROR);

    expect(JSON.parse(raw as string).status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('does not call appendTrace when multiple active cards exist, and still fails the task', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['CARD-A', 'CARD-B']);
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await plugin.tool.harness_task_complete.execute(
      { task_id: task_ids[0], session_id: 'ses_c', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
    expect(JSON.parse(raw as string).status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('swallows an appendTrace throw and still fails the task normally', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['CARD-ONLY-ONE']);
    memoryMocks.appendTrace.mockImplementation(() => {
      throw new Error('disk full (injected)');
    });
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await plugin.tool.harness_task_complete.execute(
      { task_id: task_ids[0], session_id: 'ses_d', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    // The glue attempted the call (and threw internally) but that must not
    // propagate: the tool call itself resolves normally...
    expect(memoryMocks.appendTrace).toHaveBeenCalledTimes(1);
    const result = JSON.parse(raw as string);
    expect(result.registered).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.error).toBe(TERMINAL_ERROR);
    // ...and dag.fail_task's effect on the workflow is completely unaffected.
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('swallows a listActiveCards throw and still fails the task normally', async () => {
    memoryMocks.listActiveCards.mockImplementation(() => {
      throw new Error('corpus root is not readable (injected)');
    });
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await plugin.tool.harness_task_complete.execute(
      { task_id: task_ids[0], session_id: 'ses_e', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
    const result = JSON.parse(raw as string);
    expect(result.status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });
});
