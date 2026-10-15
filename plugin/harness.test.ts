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
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
  buildTaskMemoryPreamble: vi.fn(),
  hasMemoryPreamble: vi.fn(),
}));

import harnessPlugin from './harness.js';
import { DagEngine } from './wasm/openagent_harness.js';
import { loadPlanArtifact, savePlanArtifact } from './plans.js';
import { MEMORY_TOOL_ACCESS } from './memory-access.js';
import {
  createCard as createCardImport,
  appendTrace as appendTraceImport,
  assembleContext as assembleContextImport,
  promoteFinding as promoteFindingImport,
  listActiveCards as listActiveCardsImport,
  buildTaskMemoryPreamble as buildTaskMemoryPreambleImport,
  hasMemoryPreamble as hasMemoryPreambleImport,
} from './memory.js';

const memoryMocks = {
  createCard: vi.mocked(createCardImport),
  appendTrace: vi.mocked(appendTraceImport),
  assembleContext: vi.mocked(assembleContextImport),
  promoteFinding: vi.mocked(promoteFindingImport),
  listActiveCards: vi.mocked(listActiveCardsImport),
  buildTaskMemoryPreamble: vi.mocked(buildTaskMemoryPreambleImport),
  hasMemoryPreamble: vi.mocked(hasMemoryPreambleImport),
};

/** What the mocked preamble builder produces for a task. */
const preambleFor = (cardId: string | undefined, agent: string | undefined) =>
  `<memory-context>\ncard=${cardId ?? 'none'} agent=${agent}\n</memory-context>\n`;

// ─── v2 ctx mock ────────────────────────────────────────────────────────────

/** Event stream that honours the AbortSignal, like the real `ctx.event.subscribe`. */
type Counts = { subscribe: number; transform: number };

function makeEventStream(counts: Counts) {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  const signals: AbortSignal[] = [];
  return {
    signals,
    push(...batch: unknown[]) {
      pending.push(...batch);
      wake?.();
    },
    subscribe: ((options?: { signal?: AbortSignal }) => {
      counts.subscribe++;
      if (options?.signal) signals.push(options.signal);
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<unknown>> {
              while (true) {
                if (options?.signal?.aborted) return { done: true, value: undefined };
                if (pending.length > 0) return { done: false, value: pending.shift() };
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  options?.signal?.addEventListener('abort', () => resolve(), { once: true });
                });
              }
            },
          };
        },
      };
    }),
  };
}

let sessionCounter = 0;

/** Build a v2 `Plugin.Context` mock, run the plugin's `setup`, and expose what it registered. */
async function makeHarness() {
  const counts: Counts = { subscribe: 0, transform: 0 };
  const events = makeEventStream(counts);
  const session = {
    create: vi.fn(async () => ({ id: `ses_mock_${++sessionCounter}` })),
    prompt: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue({ interrupted: true }),
    switchAgent: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue(undefined),
  };

  const tools = new Map<string, any>();
  const toolDispose = vi.fn().mockResolvedValue(undefined);
  const hooks = new Map<string, (event: any) => unknown>();
  const hookDispose = vi.fn().mockResolvedValue(undefined);

  const ctx = {
    location: { directory: '/tmp' },
    session,
    event: { subscribe: events.subscribe },
    tool: {
      transform: async (cb: (editor: { add: (t: any) => void }) => void) => {
        counts.transform++;
        cb({ add: (t) => tools.set(t.name, t) });
        return { dispose: toolDispose };
      },
      hook: vi.fn(async (name: string, cb: (event: any) => unknown) => {
        hooks.set(name, cb);
        return { dispose: hookDispose };
      }),
    },
  };

  const cleanup = (await (harnessPlugin as any).setup(ctx)) as () => Promise<void>;

  /** Call a registered tool and return its `content` string (v2 result shape). */
  const call = async (name: string, input: unknown, context = makeContext()) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const result = await tool.execute(input, context);
    return result.content as string;
  };

  return { ctx, session, events, counts, tools, hooks, toolDispose, hookDispose, cleanup, call };
}

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** Let the event pump and any chained promises settle (real setImmediate; see beforeAll). */
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// Minimal v2 ToolContext stub — only the fields the tools under test actually
// read (agent gating reads .agent; submit_review reads .sessionID).
function makeContext(agent = 'orchestrator', sessionID = 'ses_ctx') {
  return {
    sessionID,
    messageID: 'msg_ctx',
    agent,
    id: 'call_ctx',
    signal: new AbortController().signal,
    progress: async () => {},
  } as any;
}

let harness: Harness;
const callTool = (name: string, input: unknown, context?: unknown) =>
  harness.call(name, input, context as any);

// setup() installs agent files under homedir(); keep that out of the real
// ~/.config/opencode (it overwrites stale v1 agents).
const realHome = process.env.HOME;
const fakeHome = mkdtempSync(join(tmpdir(), 'harness-test-home-'));
process.env.HOME = fakeHome;
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

beforeAll(async () => {
  // Must be enabled before the plugin is instantiated so the setInterval it
  // registers internally is captured by the fake clock, not the real one.
  // setImmediate/setTimeout stay real so tests can flush promises.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  harness = await makeHarness();
  await ackMemory(harness);
});

afterAll(async () => {
  await harness.cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  memoryMocks.createCard.mockReset();
  memoryMocks.appendTrace.mockReset();
  memoryMocks.assembleContext.mockReset();
  memoryMocks.promoteFinding.mockReset();
  memoryMocks.listActiveCards.mockReset();
  memoryMocks.buildTaskMemoryPreamble.mockReset();
  memoryMocks.hasMemoryPreamble.mockReset();
  memoryMocks.buildTaskMemoryPreamble.mockImplementation((opts) => preambleFor(opts?.cardId, opts?.agent));
  memoryMocks.hasMemoryPreamble.mockImplementation((p) => p.includes('<memory-context>'));
});

/**
 * Satisfy the memory_context acknowledgement gate for `sessionID` with a
 * card-less call (the same no-card call the gate error tells agents to make).
 */
async function ackMemory(h: Harness, sessionID = 'ses_ctx') {
  memoryMocks.assembleContext.mockReturnValue('# RAG Context — system (no card)');
  await h.call('memory_context', {}, makeContext('orchestrator', sessionID));
}

/** Submit a single-task workflow directly against the real DAG and return its ids. */
async function submitOneTask(agent = 'builder') {
  const raw = await callTool(
    'submit_workflow',
    { tasks: [{ agent, prompt: 'do work', depends_on: [] }] },
    makeContext('orchestrator'),
  );
  return JSON.parse(raw) as { workflow_id: string; task_ids: string[] };
}

async function getWorkflowStatus(workflow_id: string): Promise<string | null> {
  const raw = await callTool('harness_state', { workflow_id }, makeContext());
  const parsed = JSON.parse(raw) as { snapshot: { status?: { type?: string } } };
  return parsed.snapshot?.status?.type ?? null;
}

// ─── memory_card ────────────────────────────────────────────────────────────

describe('memory_card tool', () => {
  it('calls createCard with the given args and returns the created files + success', async () => {
    memoryMocks.createCard.mockReturnValue(['context.md', 'trace.md', 'benchmarks.md', 'artifacts/.gitkeep']);

    const result = await callTool('memory_card', 
      { cardId: 'CARD-123', symptom: 'crash on export', source: 'ado', backlog: false },
      makeContext(),
    );

    expect(memoryMocks.createCard).toHaveBeenCalledWith({
      cardId: 'CARD-123',
      symptom: 'crash on export',
      source: 'ado',
      backlog: false,
    });
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({
      success: true,
      cardId: 'CARD-123',
      created: ['context.md', 'trace.md', 'benchmarks.md', 'artifacts/.gitkeep'],
    });
  });

  it('passes through undefined optional args unchanged', async () => {
    memoryMocks.createCard.mockReturnValue(['context.md']);
    await callTool('memory_card', { cardId: 'CARD-BACKLOG', backlog: true }, makeContext());
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
      callTool('memory_card', { cardId: 'CARD-123' }, makeContext()),
    ).rejects.toThrow(/memory_card failed:.*card already exists/);
  });

  it('wraps a non-Error throw from createCard as a string message', async () => {
    memoryMocks.createCard.mockImplementation(() => {
      throw 'disk full';
    });

    await expect(
      callTool('memory_card', { cardId: 'CARD-123' }, makeContext()),
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

    const result = await callTool('memory_trace', 
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
      callTool('memory_trace', { cardId: 'CARD-1', type: 'next-step', body: '   ' }, makeContext()),
    ).rejects.toThrow(/memory_trace failed:.*empty entry body/);
  });
});

// ─── memory_context ─────────────────────────────────────────────────────────

describe('memory_context tool', () => {
  it('calls assembleContext with the given args and returns the assembled markdown', async () => {
    memoryMocks.assembleContext.mockReturnValue('# RAG Context — CARD-1\n\n...');

    const result = await callTool('memory_context', 
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
      callTool('memory_context', { cardId: 'CARD-NOPE' }, makeContext()),
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

    const result = await callTool('memory_promote', 
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
    expect(JSON.parse(result)).toEqual({
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
      callTool('memory_promote', 
        { cardId: 'CARD-NOPE', finding: 'x', targetPath: 'known-behaviors/x.md' },
        makeContext(),
      ),
    ).rejects.toThrow(/memory_promote failed:.*card not found/);
  });
});

// ─── harness_task_complete auto-trace glue ─────────────────────────────────

describe('harness_task_complete — auto-trace-on-failure glue', () => {
  // Every scenario below reaches the dag.fail_task() call deterministically.
  const TERMINAL_ERROR = 'Unexpected error: build step blew up';

  it('does not call appendTrace when zero active cards exist, and still fails the task', async () => {
    memoryMocks.listActiveCards.mockReturnValue([]);
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await callTool('harness_task_complete', 
      { task_id: task_ids[0], session_id: 'ses_a', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
    expect(JSON.parse(raw).status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('appends a trace entry when exactly one active card exists, and still fails the task', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['CARD-ONLY-ONE']);
    const { workflow_id, task_ids } = await submitOneTask();
    const taskId = task_ids[0];

    const raw = await callTool('harness_task_complete', 
      { task_id: taskId, session_id: 'ses_b', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).toHaveBeenCalledTimes(1);
    const call = memoryMocks.appendTrace.mock.calls[0][0];
    expect(call.cardId).toBe('CARD-ONLY-ONE');
    expect(call.type).toBe('finding');
    expect(call.body).toContain(taskId);
    expect(call.body).toContain(TERMINAL_ERROR);

    expect(JSON.parse(raw).status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('does not call appendTrace when multiple active cards exist, and still fails the task', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['CARD-A', 'CARD-B']);
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await callTool('harness_task_complete', 
      { task_id: task_ids[0], session_id: 'ses_c', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
    expect(JSON.parse(raw).status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });

  it('swallows an appendTrace throw and still fails the task normally', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['CARD-ONLY-ONE']);
    memoryMocks.appendTrace.mockImplementation(() => {
      throw new Error('disk full (injected)');
    });
    const { workflow_id, task_ids } = await submitOneTask();

    const raw = await callTool('harness_task_complete', 
      { task_id: task_ids[0], session_id: 'ses_d', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    // The glue attempted the call (and threw internally) but that must not
    // propagate: the tool call itself resolves normally...
    expect(memoryMocks.appendTrace).toHaveBeenCalledTimes(1);
    const result = JSON.parse(raw);
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

    const raw = await callTool('harness_task_complete', 
      { task_id: task_ids[0], session_id: 'ses_e', status: 'failed', error: TERMINAL_ERROR },
      makeContext(),
    );

    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
    const result = JSON.parse(raw);
    expect(result.status).toBe('failed');
    expect(await getWorkflowStatus(workflow_id)).toBe('failed');
  });
});

// ─── plan_task / save_plan ──────────────────────────────────────────────────
//
// Exercises the real WASM DagEngine's plan-draft accumulator (append_plan_task /
// get_plan_draft / discard_plan_draft) through the tool layer end-to-end, plus
// real plan-artifact disk I/O (redirected to a per-test temp dir, same approach
// as plans.test.ts).

describe('plan_task / save_plan tools', () => {
  let planTmpDir: string;

  beforeEach(() => {
    planTmpDir = mkdtempSync(join(tmpdir(), 'harness-plan-task-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(planTmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(planTmpDir, { recursive: true, force: true });
  });

  it('rejects plan_task and save_plan calls from a non-planner agent', async () => {
    await expect(
      callTool('plan_task', 
        { agent: 'builder', prompt: 'do work', depends_on: [] },
        makeContext('orchestrator'),
      ),
    ).rejects.toThrow('plan_task can only be executed by the planner agent');

    await expect(
      callTool('save_plan', 
        { plan_id: 'whatever', summary: ['x'] },
        makeContext('orchestrator'),
      ),
    ).rejects.toThrow('save_plan can only be executed by the planner agent');
  });

  it('accumulates tasks one call at a time and finalizes into a plan artifact', async () => {
    const first = JSON.parse(
      (await callTool('plan_task', 
        { agent: 'explorer', prompt: 'map the repo', depends_on: [] },
        makeContext('planner'),
      )) as string,
    );
    expect(first).toMatchObject({
      task_index: 0,
      task_count: 1,
      agent: 'explorer',
      prompt_chars: 'map the repo'.length,
      agents: ['explorer'],
    });
    expect(typeof first.plan_id).toBe('string');
    const planId = first.plan_id as string;

    const second = JSON.parse(
      (await callTool('plan_task', 
        { agent: 'builder', prompt: 'build it', depends_on: [0], plan_id: planId },
        makeContext('planner'),
      )) as string,
    );
    expect(second).toMatchObject({
      plan_id: planId,
      task_index: 1,
      task_count: 2,
      agent: 'builder',
      agents: ['explorer', 'builder'],
    });

    const saved = JSON.parse(
      (await callTool('save_plan', 
        { plan_id: planId, summary: ['step 1', 'step 2'], recommendations: ['do it well'] },
        makeContext('planner'),
      )) as string,
    );

    expect(saved).toEqual({
      plan_id: planId,
      path: expect.stringContaining(`${planId}.json`),
      task_count: 2,
      summary: ['step 1', 'step 2'],
      recommendations: ['do it well'],
    });

    const artifact = loadPlanArtifact(planId);
    expect(artifact.tasks).toEqual([
      { agent: 'explorer', prompt: 'map the repo', depends_on: [] },
      { agent: 'builder', prompt: 'build it', depends_on: [0] },
    ]);
  });

  it('passes model through to the appended task and preserves it in the saved artifact', async () => {
    const first = JSON.parse(
      (await callTool('plan_task', 
        { agent: 'builder', prompt: 'build it', depends_on: [], model: 'anthropic/claude-sonnet-4-6' },
        makeContext('planner'),
      )) as string,
    );
    const planId = first.plan_id as string;

    await callTool('save_plan', 
      { plan_id: planId, summary: ['done'] },
      makeContext('planner'),
    );

    const artifact = loadPlanArtifact(planId);
    expect(artifact.tasks[0].model).toBe('anthropic/claude-sonnet-4-6');
  });

  it('rejects an out-of-bounds depends_on index with the draft-scoped error', async () => {
    const first = JSON.parse(
      (await callTool('plan_task', 
        { agent: 'explorer', prompt: 'first', depends_on: [] },
        makeContext('planner'),
      )) as string,
    );
    const planId = first.plan_id as string;

    await expect(
      callTool('plan_task', 
        { agent: 'builder', prompt: 'second', depends_on: [5], plan_id: planId },
        makeContext('planner'),
      ),
    ).rejects.toThrow(
      `plan_task failed: plan draft '${planId}' depends_on index 5 is out of bounds (only 1 tasks)`,
    );
  });

  it('rejects an invalid caller-supplied plan_id on the very first plan_task call, before any draft is built', async () => {
    await expect(
      callTool('plan_task', 
        { agent: 'explorer', prompt: 'first', depends_on: [], plan_id: '../escape' },
        makeContext('planner'),
      ),
    ).rejects.toThrow('invalid plan artifact id: ../escape (must not contain "/", "\\" or "..")');
  });

  it('save_plan surfaces the exact Rust error when the draft is missing', async () => {
    await expect(
      callTool('save_plan', 
        { plan_id: 'never-appended-to', summary: ['x'] },
        makeContext('planner'),
      ),
    ).rejects.toThrow(
      "plan draft 'never-appended-to' not found — call plan_task before save_plan",
    );
  });

  it('save_plan discards the draft after a successful save so it cannot be re-saved without new appends', async () => {
    const first = JSON.parse(
      (await callTool('plan_task', 
        { agent: 'explorer', prompt: 'only task', depends_on: [] },
        makeContext('planner'),
      )) as string,
    );
    const planId = first.plan_id as string;

    await callTool('save_plan', 
      { plan_id: planId, summary: ['ok'] },
      makeContext('planner'),
    );

    await expect(
      callTool('save_plan', { plan_id: planId, summary: ['again'] }, makeContext('planner')),
    ).rejects.toThrow(`plan draft '${planId}' not found — call plan_task before save_plan`);
  });

  it('does not accept a tasks argument on save_plan (draft-only finalize path)', () => {
    expect(harness.tools.get('save_plan').input.properties).not.toHaveProperty('tasks');
  });
});

// ─── v2 entrypoint & tool registration ─────────────────────────────────────

const EXPECTED_TOOLS = [
  'submit_workflow',
  'plan_task',
  'save_plan',
  'submit_plan',
  'harness_state',
  'harness_cancel',
  'harness_dispatch_tasks',
  'harness_task_complete',
  'submit_review',
  'memory_card',
  'memory_trace',
  'memory_context',
  'memory_promote',
];

describe('plugin entrypoint (v2)', () => {
  it('is a Plugin.define() plugin with the openagent-harness id', () => {
    expect((harnessPlugin as any).id).toBe('openagent-harness');
    expect(typeof (harnessPlugin as any).setup).toBe('function');
  });

  it('registers exactly the 13 un-namespaced tools via ctx.tool.transform', () => {
    expect([...harness.tools.keys()].sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(harness.counts.transform).toBe(1);
    for (const tool of harness.tools.values()) {
      expect(typeof tool.description).toBe('string');
      expect(tool.options?.namespace).toBeUndefined();
    }
  });

  it('declares every tool input as a closed JSON Schema object', () => {
    for (const tool of harness.tools.values()) {
      expect(tool.input.type).toBe('object');
      expect(tool.input.additionalProperties).toBe(false);
    }
  });

  it('keeps required/optional, enums, arrays and nested objects in the schemas', () => {
    const t = (n: string) => harness.tools.get(n).input;

    expect(t('submit_workflow')).toEqual({
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: { type: 'string' },
              prompt: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'number' } },
              model: { type: 'string' },
              card_id: { type: 'string' },
            },
            required: ['agent', 'prompt', 'depends_on'],
            additionalProperties: false,
          },
        },
        card_id: { type: 'string' },
      },
      required: ['tasks'],
      additionalProperties: false,
    });

    expect(t('plan_task').required).toEqual(['agent', 'prompt']);
    expect(Object.keys(t('plan_task').properties)).toEqual(['agent', 'prompt', 'depends_on', 'model', 'plan_id', 'card_id']);
    expect(t('save_plan').required).toEqual(['plan_id', 'summary']);
    expect(t('submit_plan').required).toEqual(['plan_id']);
    expect(t('harness_state').required).toBeUndefined();
    expect(t('harness_cancel').required).toBeUndefined();
    expect(t('harness_dispatch_tasks').required).toEqual(['workflow_id']);
    expect(t('harness_dispatch_tasks').properties.timeout_ms).toEqual({ type: 'number' });
    expect(t('harness_task_complete').required).toEqual(['task_id', 'session_id', 'status']);
    expect(t('harness_task_complete').properties.status).toEqual({ type: 'string', enum: ['done', 'failed'] });
    expect(t('memory_card').properties.source.enum).toEqual(['ado', 'qa', 'prod', 'other']);
    expect(t('memory_trace').properties.type.enum).toEqual(['finding', 'ruled-out', 'hypothesis', 'next-step']);
    expect(t('memory_context').properties.mode.enum).toEqual(['compact', 'full']);
    expect(t('memory_promote').required).toEqual(['finding', 'targetPath']);
    expect(t('memory_context').required).toBeUndefined();
    expect(t('memory_card').required).toEqual(['cardId']);
    expect(t('memory_trace').required).toEqual(['cardId', 'type', 'body']);

    const findings = t('submit_review').properties.findings;
    expect(t('submit_review').required).toEqual(['task_id', 'status', 'summary']);
    expect(findings.type).toBe('array');
    expect(findings.items.required).toEqual(['message']);
    expect(findings.items.additionalProperties).toBe(false);
    expect(Object.keys(findings.items.properties)).toEqual(['message', 'file', 'line', 'severity']);
  });

  it('wraps the tool string result as { content } and keeps the orchestrator/planner gating', async () => {
    const raw = await harness.tools.get('harness_state').execute({}, makeContext());
    expect(Object.keys(raw)).toEqual(['content']);
    expect(JSON.parse(raw.content)).toEqual({ workflows: expect.any(Array) });

    await expect(
      callTool('submit_workflow', { tasks: [] }, makeContext('builder')),
    ).rejects.toThrow('submit_workflow can only be executed by the orchestrator agent');
    await expect(
      callTool('submit_plan', { plan_id: 'x' }, makeContext('planner')),
    ).rejects.toThrow('submit_plan can only be executed by the orchestrator agent');
  });

  it('describes harness_dispatch_tasks / harness_task_complete in terms of the v2 subagent tool', () => {
    const dispatch = harness.tools.get('harness_dispatch_tasks').description as string;
    const complete = harness.tools.get('harness_task_complete').description as string;
    for (const text of [dispatch, complete]) {
      expect(text).toContain('subagent');
      expect(text).toContain('sessionID');
      expect(text).not.toContain('Task tool');
      expect(text).not.toContain("'task_id: <session_id>'");
    }
    expect(dispatch).toContain('<subagent sessionID=');
    expect(dispatch).toContain('Subagent failed (sessionID:');
  });

  it('registers only an execute.after tool hook (no empty execute.before)', () => {
    expect([...harness.hooks.keys()]).toEqual(['execute.after']);
  });

  it('subscribes to events with an AbortSignal', () => {
    expect(harness.counts.subscribe).toBe(1);
    expect(harness.events.signals).toHaveLength(1);
  });
});

// ─── v2 events, hook and cleanup (real WASM engine) ────────────────────────

const ev = (type: string, data: unknown) => ({ id: 'evt', created: 0, type, data });
const idleEvent = (sessionID: string) => ev('session.idle', { sessionID });
const statusEvent = (sessionID: string, type: 'idle' | 'busy') =>
  ev('session.status', { sessionID, status: { type } });
const failedEvent = (sessionID: string, error: unknown) =>
  ev('session.execution.failed', { sessionID, error });

describe('v2 events, tool hook and cleanup', () => {
  const harnesses: Harness[] = [];
  let processEvent: MockInstance<DagEngine['process_event']>;

  async function fresh(): Promise<Harness> {
    const h = await makeHarness();
    harnesses.push(h);
    await ackMemory(h);
    return h;
  }

  /** Submit a one-task workflow and tick it so it is Running, bound to `sid`. */
  async function startTask(h: Harness, sid: string, agent = 'builder') {
    h.session.create.mockResolvedValueOnce({ id: sid });
    const { workflow_id, task_ids } = JSON.parse(
      await h.call('submit_workflow', { tasks: [{ agent, prompt: 'do work', depends_on: [] }] }),
    ) as { workflow_id: string; task_ids: string[] };
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    return { workflow_id, task_id: task_ids[0] };
  }

  const status = async (h: Harness, workflow_id: string) =>
    (JSON.parse(await h.call('harness_state', { workflow_id })) as { snapshot: { status?: { type?: string } } })
      .snapshot?.status?.type;

  const engineCalls = (type: string) => processEvent.mock.calls.filter((c) => c[0] === type);

  beforeEach(() => {
    processEvent = vi.spyOn(DagEngine.prototype, 'process_event');
  });

  afterEach(async () => {
    processEvent.mockRestore();
    while (harnesses.length) await harnesses.pop()!.cleanup();
  });

  it('starts a task through the v2 session adapter on tick', async () => {
    const h = await fresh();
    await startTask(h, 'ses_start', 'builder');
    expect(h.session.create).toHaveBeenCalledWith(expect.objectContaining({ parentID: 'ses_ctx', agent: 'builder' }));
    expect(h.session.switchAgent).toHaveBeenCalledWith({ sessionID: 'ses_start', agent: 'builder' });
    expect(h.session.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_start',
      text: `${preambleFor(undefined, 'builder')}\ndo work`,
    });
  });

  it('completes a task on a v2 session.idle event (reads data.sessionID)', async () => {
    const h = await fresh();
    const { workflow_id } = await startTask(h, 'ses_idle');
    expect(await status(h, workflow_id)).toBe('running');

    h.events.push(idleEvent('ses_idle'));
    await flush();

    expect(await status(h, workflow_id)).toBe('done');
    const [, sessionId, payload] = engineCalls('session.idle')[0];
    expect(sessionId).toBe('ses_idle');
    expect(JSON.parse(payload as string)).toEqual({ sessionID: 'ses_idle' });
    expect(h.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_idle' });
  });

  it('derives idle from session.status with status.type "idle"', async () => {
    const h = await fresh();
    const { workflow_id } = await startTask(h, 'ses_status');

    h.events.push(statusEvent('ses_status', 'busy'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(0);
    expect(await status(h, workflow_id)).toBe('running');

    h.events.push(statusEvent('ses_status', 'idle'));
    await flush();
    expect(await status(h, workflow_id)).toBe('done');
    expect(engineCalls('session.idle')).toHaveLength(1);
  });

  it('de-duplicates session.idle + session.status(idle) per session', async () => {
    const h = await fresh();
    await startTask(h, 'ses_dup');

    h.events.push(idleEvent('ses_dup'), statusEvent('ses_dup', 'idle'), idleEvent('ses_dup'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(1);
  });

  it('lets a later idle through after a busy status or once the dedupe window has passed', async () => {
    const h = await fresh();
    await startTask(h, 'ses_again');

    h.events.push(idleEvent('ses_again'));
    await flush();
    h.events.push(statusEvent('ses_again', 'busy'), idleEvent('ses_again'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(2);

    vi.setSystemTime(Date.now() + 5000);
    h.events.push(statusEvent('ses_again', 'idle'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(3);
  });

  it('maps session.execution.failed to a "session.error" engine event with a string error', async () => {
    const h = await fresh();
    await startTask(h, 'ses_fail');

    h.events.push(failedEvent('ses_fail', { type: 'ApiError', message: 'Unauthorized', status: 401 }));
    await flush();

    const [call] = engineCalls('session.error');
    expect(call[1]).toBe('ses_fail');
    expect(JSON.parse(call[2] as string)).toEqual({
      sessionID: 'ses_fail',
      error: 'ApiError: Unauthorized (HTTP 401)',
    });
  });

  it('fails the task for a terminal v2 error (auth / context overflow)', async () => {
    const h = await fresh();
    const a = await startTask(h, 'ses_auth');
    h.events.push(failedEvent('ses_auth', { name: 'ProviderAuthError', data: { message: 'bad key' } }));
    await flush();
    expect(await status(h, a.workflow_id)).toBe('failed');

    const b = await startTask(h, 'ses_ctxovf');
    h.events.push(failedEvent('ses_ctxovf', { type: 'ContextOverflowError', message: 'too long' }));
    await flush();
    expect(await status(h, b.workflow_id)).toBe('failed');
  });

  it('fails the task and deletes the session on a transient (429) v2 error', async () => {
    const h = await fresh();
    const { workflow_id } = await startTask(h, 'ses_429');

    h.events.push(failedEvent('ses_429', { type: 'ApiError', message: 'Too many requests', status: 429 }));
    await flush();

    expect(await status(h, workflow_id)).toBe('failed');
    expect(h.session.remove).toHaveBeenCalledWith({ sessionID: 'ses_429' });

    // No retry: the next tick must not create a new session.
    h.session.create.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(h.session.create).not.toHaveBeenCalled();
  });

  it('drops late idle/failed events for cancelled sessions (cancelledSessions guard)', async () => {
    const h = await fresh();
    const a = await startTask(h, 'ses_cx1');
    await h.call('harness_cancel', { workflow_id: a.workflow_id });
    expect(h.session.interrupt).toHaveBeenCalledWith({ sessionID: 'ses_cx1' });

    h.events.push(failedEvent('ses_cx1', { type: 'MessageAbortedError', message: 'aborted' }));
    await flush();
    expect(engineCalls('session.error')).toHaveLength(0);
    expect(await status(h, a.workflow_id)).toBe('cancelled');

    const b = await startTask(h, 'ses_cx2');
    await h.call('harness_cancel', { task_id: b.task_id });
    h.events.push(idleEvent('ses_cx2'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(0);
  });

  it('drops the second idle signal of a cancelled session instead of buffering it', async () => {
    const h = await fresh();
    const a = await startTask(h, 'ses_cx3');
    await h.call('harness_cancel', { workflow_id: a.workflow_id });

    h.events.push(idleEvent('ses_cx3'), statusEvent('ses_cx3', 'idle'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(0);
  });

  it('buffers an orphaned idle and replays its payload when harness_task_complete registers the session', async () => {
    const h = await fresh();
    const { workflow_id, task_ids } = JSON.parse(
      await h.call('submit_workflow', { tasks: [{ agent: 'builder', prompt: 'native work', depends_on: [] }] }),
    ) as { workflow_id: string; task_ids: string[] };

    // Flag native dispatch (timeout 0 returns immediately), then let the tick buffer the task.
    const first = JSON.parse(await h.call('harness_dispatch_tasks', { workflow_id, timeout_ms: 0 }));
    expect(first.status).toBe('timeout');
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    const ready = JSON.parse(await h.call('harness_dispatch_tasks', { workflow_id, timeout_ms: 0 }));
    expect(ready.status).toBe('tasks_ready');
    expect(ready.tasks[0]).toMatchObject({
      task_id: task_ids[0],
      agent: 'builder',
      prompt: `${preambleFor(undefined, 'builder')}\nnative work`,
      description: `[harness-task:${task_ids[0]}] @builder`,
    });
    expect(h.session.create).not.toHaveBeenCalled();

    // The subagent finished before harness_task_complete ran.
    h.events.push(idleEvent('ses_native'));
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(1);
    expect(await status(h, workflow_id)).toBe('running');

    const done = JSON.parse(
      await h.call('harness_task_complete', { task_id: task_ids[0], session_id: 'ses_native', status: 'done' }),
    );
    expect(done.status).toBe('done');
    const replay = engineCalls('session.idle')[1];
    expect(JSON.parse(replay[2] as string)).toEqual({ sessionID: 'ses_native' });
    expect(await status(h, workflow_id)).toBe('done');
  });

  it('buffers an orphaned failure and uses its readable message in harness_task_complete', async () => {
    const h = await fresh();
    const { workflow_id, task_ids } = JSON.parse(
      await h.call('submit_workflow', { tasks: [{ agent: 'builder', prompt: 'native work', depends_on: [] }] }),
    ) as { workflow_id: string; task_ids: string[] };
    await h.call('harness_dispatch_tasks', { workflow_id, timeout_ms: 0 });
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    h.events.push(failedEvent('ses_nat_err', { type: 'UnknownError', message: 'boom', status: 400 }));
    await flush();

    const out = JSON.parse(
      await h.call('harness_task_complete', { task_id: task_ids[0], session_id: 'ses_nat_err', status: 'failed' }),
    );
    expect(out.status).toBe('failed');
    expect(out.error).toBe('UnknownError: boom (HTTP 400)');
    expect(await status(h, workflow_id)).toBe('failed');
  });

  it('forwards tool execute.after to the engine with tool/callID/args/result', async () => {
    const h = await fresh();
    const hook = h.hooks.get('execute.after')!;

    hook({
      tool: 'bash',
      sessionID: 'ses_hook',
      agent: 'builder',
      messageID: 'msg',
      id: 'call_1',
      input: { command: 'ls' },
      status: 'completed',
      result: { content: 'file.txt' },
    });
    const [, sessionId, payload] = engineCalls('tool.execute.after')[0];
    expect(sessionId).toBe('ses_hook');
    expect(JSON.parse(payload as string)).toEqual({
      tool: 'bash',
      callID: 'call_1',
      args: { command: 'ls' },
      result: 'file.txt',
    });

    // Array content is joined; string output is the fallback; errors carry no result.
    hook({ tool: 't', sessionID: 's', id: 'c2', input: {}, status: 'completed', result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } });
    hook({ tool: 't', sessionID: 's', id: 'c3', input: {}, status: 'completed', result: { output: 'structured' } });
    hook({ tool: 't', sessionID: 's', id: 'c4', input: {}, status: 'error', error: { message: 'x' } });
    const results = engineCalls('tool.execute.after').slice(1).map((c) => JSON.parse(c[2] as string).result);
    expect(results).toEqual(['a\nb', 'structured', undefined]);
  });

  it('skips tool execute.after for cancelled sessions', async () => {
    const h = await fresh();
    const a = await startTask(h, 'ses_cx_hook');
    await h.call('harness_cancel', { workflow_id: a.workflow_id });

    h.hooks.get('execute.after')!({
      tool: 'bash', sessionID: 'ses_cx_hook', id: 'c', input: {}, status: 'completed', result: { content: 'late' },
    });
    expect(engineCalls('tool.execute.after')).toHaveLength(0);
  });

  it('ignores unrelated events', async () => {
    const h = await fresh();
    h.events.push(ev('session.created', { sessionID: 's' }), ev('session.execution.succeeded', { sessionID: 's' }));
    await flush();
    expect(processEvent).not.toHaveBeenCalled();
  });

  it('cleanup clears the tick interval, aborts the subscription and disposes registrations', async () => {
    const h = await fresh();
    const timersBefore = vi.getTimerCount();

    await h.cleanup();

    expect(vi.getTimerCount()).toBe(timersBefore - 1);
    expect(h.events.signals[0].aborted).toBe(true);
    expect(h.toolDispose).toHaveBeenCalledTimes(1);
    expect(h.hookDispose).toHaveBeenCalledTimes(1);

    // Idempotent, and events/ticks after cleanup are inert.
    await h.cleanup();
    expect(h.toolDispose).toHaveBeenCalledTimes(1);
    h.events.push(idleEvent('ses_after'));
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(engineCalls('session.idle')).toHaveLength(0);
  });
});

// ─── memory tool agent gating ───────────────────────────────────────────────

const ALL_AGENTS = [
  'orchestrator', 'planner', 'explorer', 'researcher', 'vision', 'builder',
  'builder-junior', 'reviewer', 'consultant', 'debugger', 'docs-writer',
];

const GATING_INPUTS: Record<string, unknown> = {
  memory_context: {},
  memory_card: { cardId: 'CARD-G', symptom: 'boom' },
  memory_trace: { cardId: 'CARD-G', type: 'finding', body: 'b' },
  memory_promote: { finding: 'f', targetPath: 'known-behaviors/x.md' },
};

describe('memory tool agent gating', () => {
  beforeEach(() => {
    memoryMocks.createCard.mockReturnValue(['context.md']);
    memoryMocks.appendTrace.mockReturnValue({ formatted: 'appended' } as any);
    memoryMocks.assembleContext.mockReturnValue('# ctx');
    memoryMocks.promoteFinding.mockReturnValue({ systemPath: '/s/x.md', benchmarksPath: null, created: true });
  });

  it('exposes exactly the documented matrix', () => {
    expect(MEMORY_TOOL_ACCESS).toEqual({
      memory_context: [
        'orchestrator', 'planner', 'builder', 'debugger', 'consultant',
        'explorer', 'researcher', 'reviewer', 'docs-writer', 'vision',
      ],
      memory_card: ['orchestrator', 'debugger'],
      memory_trace: ['orchestrator', 'builder', 'debugger', 'consultant'],
      memory_promote: ['orchestrator', 'debugger', 'consultant'],
    });
    for (const allowed of Object.values(MEMORY_TOOL_ACCESS)) {
      expect(allowed).not.toContain('builder-junior');
    }
  });

  for (const tool of Object.keys(GATING_INPUTS)) {
    it(`${tool}: allows only its listed agents, denies everyone else (incl. builder-junior)`, async () => {
      for (const agent of ALL_AGENTS) {
        const call = callTool(tool, GATING_INPUTS[tool], makeContext(agent));
        if (MEMORY_TOOL_ACCESS[tool].includes(agent)) {
          await expect(call).resolves.toBeTypeOf('string');
        } else {
          await expect(call).rejects.toThrow(`${tool} is not permitted for agent ${agent}`);
        }
      }
    });

    it(`${tool}: denies an undefined agent without touching memory`, async () => {
      memoryMocks.createCard.mockClear();
      memoryMocks.appendTrace.mockClear();
      memoryMocks.assembleContext.mockClear();
      memoryMocks.promoteFinding.mockClear();
      await expect(
        callTool(tool, GATING_INPUTS[tool], { ...makeContext(), agent: undefined }),
      ).rejects.toThrow(`${tool} is not permitted for agent`);
      expect(memoryMocks.createCard).not.toHaveBeenCalled();
      expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
      expect(memoryMocks.assembleContext).not.toHaveBeenCalled();
      expect(memoryMocks.promoteFinding).not.toHaveBeenCalled();
    });
  }

  it('memory_context with no card succeeds and passes cardId undefined', async () => {
    const out = await callTool('memory_context', {}, makeContext('explorer'));
    expect(out).toBe('# ctx');
    expect(memoryMocks.assembleContext).toHaveBeenCalledWith({
      cardId: undefined,
      mode: undefined,
      sections: undefined,
    });
  });

  it('memory_promote with no card returns a null benchmarksPath', async () => {
    const out = JSON.parse(
      await callTool('memory_promote', { finding: 'f', targetPath: 'known-behaviors/x.md' }, makeContext('consultant')),
    );
    expect(out).toEqual({ success: true, systemPath: '/s/x.md', benchmarksPath: null, created: true });
    expect(memoryMocks.promoteFinding).toHaveBeenCalledWith(expect.objectContaining({ cardId: undefined }));
  });
});

// ─── memory_context acknowledgement gate ────────────────────────────────────

describe('memory_context acknowledgement gate', () => {
  let h: Harness;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'harness-ack-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    memoryMocks.assembleContext.mockReturnValue('# ctx');
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const planner = (sid = 'ses_gate') => makeContext('planner', sid);
  const orch = (sid = 'ses_gate') => makeContext('orchestrator', sid);
  const task = { agent: 'explorer', prompt: 'look', depends_on: [] };

  it('blocks plan_task before memory_context and spells out the exact no-card call', async () => {
    const err = await h.call('plan_task', task, planner()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('requires memory_context');
    expect((err as Error).message).toContain('memory_context({ cardId: "<id>" })');
    expect((err as Error).message).toContain('memory_context({})');
  });

  it('allows plan_task after a card-less memory_context call from that session', async () => {
    await h.call('memory_context', {}, planner());
    const out = JSON.parse(await h.call('plan_task', task, planner()));
    expect(out.task_count).toBe(1);
  });

  it('allows plan_task after memory_context with a cardId', async () => {
    await h.call('memory_context', { cardId: 'CARD-A' }, planner());
    await expect(h.call('plan_task', task, planner())).resolves.toBeTypeOf('string');
  });

  it('does not acknowledge when memory_context itself fails (e.g. unknown card)', async () => {
    memoryMocks.assembleContext.mockImplementation(() => {
      throw new Error('assembleContext: card not found: CARD-NOPE');
    });
    await expect(h.call('memory_context', { cardId: 'CARD-NOPE' }, planner())).rejects.toThrow(/card not found/);
    await expect(h.call('plan_task', task, planner())).rejects.toThrow('requires memory_context');
  });

  it('is per session: another session is still blocked', async () => {
    await h.call('memory_context', {}, planner('ses_a'));
    await expect(h.call('plan_task', task, planner('ses_b'))).rejects.toThrow('requires memory_context');
  });

  it('keeps the agent check ahead of the ack check', async () => {
    await expect(h.call('plan_task', task, orch())).rejects.toThrow(
      'plan_task can only be executed by the planner agent',
    );
  });

  it('blocks submit_workflow before memory_context and allows it after a card-less call', async () => {
    const input = { tasks: [{ agent: 'builder', prompt: 'x', depends_on: [] }] };
    await expect(h.call('submit_workflow', input, orch())).rejects.toThrow(/requires memory_context.*memory_context\(\{\}\)/);
    await h.call('memory_context', {}, orch());
    const out = JSON.parse(await h.call('submit_workflow', input, orch()));
    expect(out.task_ids).toHaveLength(1);
  });

  it('blocks submit_plan before memory_context and allows it after a card-less call', async () => {
    savePlanArtifact({
      id: 'ack-plan',
      created_at: '2026-01-01T00:00:00.000Z',
      summary: ['s'],
      tasks: [{ agent: 'builder', prompt: 'x', depends_on: [] }],
    });
    await expect(h.call('submit_plan', { plan_id: 'ack-plan' }, orch())).rejects.toThrow(
      /requires memory_context.*memory_context\(\{\}\)/,
    );
    await h.call('memory_context', {}, orch());
    const out = JSON.parse(await h.call('submit_plan', { plan_id: 'ack-plan' }, orch()));
    expect(out.workflow_id).toBeTypeOf('string');
  });
});

// ─── card_id threading + preamble (real WASM engine) ────────────────────────

describe('card_id threading and task memory preamble', () => {
  const harnesses: Harness[] = [];
  let tmp: string;

  async function fresh(): Promise<Harness> {
    const h = await makeHarness();
    harnesses.push(h);
    await ackMemory(h);
    return h;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'harness-card-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  });

  afterEach(async () => {
    while (harnesses.length) await harnesses.pop()!.cleanup();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const tickOnce = async () => {
    await vi.advanceTimersByTimeAsync(500);
    await flush();
  };

  /** Flag a workflow native, tick, and return the drained dispatch result. */
  async function dispatchNative(h: Harness, workflow_id: string) {
    await h.call('harness_dispatch_tasks', { workflow_id, timeout_ms: 0 });
    await tickOnce();
    return JSON.parse(await h.call('harness_dispatch_tasks', { workflow_id, timeout_ms: 0 }));
  }

  it('flows plan_task -> save_plan artifact -> submit_plan -> snapshot -> dispatch output', async () => {
    const h = await fresh();
    const first = JSON.parse(
      await h.call('plan_task', { agent: 'explorer', prompt: 'map', depends_on: [], card_id: 'CARD-1' }, makeContext('planner')),
    );
    expect(first.card_id).toBe('CARD-1');
    const planId = first.plan_id as string;
    await h.call('plan_task', { agent: 'builder', prompt: 'build', depends_on: [0], plan_id: planId }, makeContext('planner'));

    const saved = JSON.parse(await h.call('save_plan', { plan_id: planId, summary: ['s'] }, makeContext('planner')));
    expect(saved.card_id).toBe('CARD-1');
    const artifact = loadPlanArtifact(planId);
    expect(artifact.card_id).toBe('CARD-1');
    expect(artifact.tasks.map((t) => t.card_id)).toEqual(['CARD-1', 'CARD-1']);

    const { workflow_id } = JSON.parse(await h.call('submit_plan', { plan_id: planId, native_dispatch: true }, makeContext('orchestrator')));
    const snap = JSON.parse(await h.call('harness_state', { workflow_id })).snapshot;
    expect(snap.card_id).toBe('CARD-1');
    expect(snap.tasks.every((t: any) => t.card_id === 'CARD-1')).toBe(true);

    await tickOnce();
    const ready = JSON.parse(await h.call('harness_dispatch_tasks', { workflow_id, timeout_ms: 0 }));
    expect(ready.status).toBe('tasks_ready');
    expect(ready.tasks[0]).toMatchObject({
      agent: 'explorer',
      card_id: 'CARD-1',
      prompt: `${preambleFor('CARD-1', 'explorer')}\nmap`,
    });
  });

  it('submits a legacy artifact without card_id as no-card work', async () => {
    const h = await fresh();
    savePlanArtifact({
      id: 'legacy',
      created_at: '2026-01-01T00:00:00.000Z',
      summary: ['s'],
      tasks: [{ agent: 'builder', prompt: 'work', depends_on: [] }],
    });
    expect(loadPlanArtifact('legacy').card_id).toBeUndefined();

    const { workflow_id } = JSON.parse(await h.call('submit_plan', { plan_id: 'legacy' }, makeContext('orchestrator')));
    expect(JSON.parse(await h.call('harness_state', { workflow_id })).snapshot).not.toHaveProperty('card_id');

    const ready = await dispatchNative(h, workflow_id);
    expect(ready.tasks[0]).not.toHaveProperty('card_id');
    expect(ready.tasks[0].prompt).toBe(`${preambleFor(undefined, 'builder')}\nwork`);
  });

  it('save_plan omits card_id from the artifact when the plan has none', async () => {
    const h = await fresh();
    const { plan_id } = JSON.parse(await h.call('plan_task', { agent: 'explorer', prompt: 'x' }, makeContext('planner')));
    const saved = JSON.parse(await h.call('save_plan', { plan_id, summary: ['s'] }, makeContext('planner')));
    expect(saved).not.toHaveProperty('card_id');
    expect(loadPlanArtifact(plan_id)).not.toHaveProperty('card_id');
  });

  it('prepends the preamble once on the plugin tick-loop path (card and no-card)', async () => {
    const h = await fresh();
    h.session.create.mockResolvedValueOnce({ id: 'ses_card' }).mockResolvedValueOnce({ id: 'ses_nocard' });
    await h.call('submit_workflow', {
      tasks: [{ agent: 'builder', prompt: 'with card', depends_on: [] }],
      card_id: 'CARD-2',
    });
    await tickOnce();
    await h.call('submit_workflow', { tasks: [{ agent: 'explorer', prompt: 'no card', depends_on: [] }] });
    await tickOnce();

    expect(h.session.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_card',
      text: `${preambleFor('CARD-2', 'builder')}\nwith card`,
    });
    expect(h.session.prompt).toHaveBeenCalledWith({
      sessionID: 'ses_nocard',
      text: `${preambleFor(undefined, 'explorer')}\nno card`,
    });
  });

  it('per-task card_id overrides the workflow card_id', async () => {
    const h = await fresh();
    const { workflow_id } = JSON.parse(
      await h.call('submit_workflow', {
        tasks: [{ agent: 'builder', prompt: 'p', depends_on: [], card_id: 'CARD-T' }],
        card_id: 'CARD-W',
      }),
    );
    const ready = await dispatchNative(h, workflow_id);
    expect(ready.tasks[0].card_id).toBe('CARD-T');
  });

  it('does not double-prepend when the prompt already carries a preamble (both paths)', async () => {
    const h = await fresh();
    const prompt = '<memory-context>\nalready\n</memory-context>\nwork';
    h.session.create.mockResolvedValueOnce({ id: 'ses_pre' });
    await h.call('submit_workflow', { tasks: [{ agent: 'builder', prompt, depends_on: [] }] });
    await tickOnce();
    expect(h.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_pre', text: prompt });

    const { workflow_id } = JSON.parse(
      await h.call('submit_workflow', { tasks: [{ agent: 'builder', prompt, depends_on: [] }] }),
    );
    const ready = await dispatchNative(h, workflow_id);
    expect(ready.tasks[0].prompt).toBe(prompt);
    expect(memoryMocks.buildTaskMemoryPreamble).not.toHaveBeenCalled();
  });

  it('never blocks dispatch when the preamble builder throws', async () => {
    const h = await fresh();
    memoryMocks.buildTaskMemoryPreamble.mockImplementation(() => {
      throw new Error('preamble exploded');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.session.create.mockResolvedValueOnce({ id: 'ses_boom' });
    await h.call('submit_workflow', { tasks: [{ agent: 'builder', prompt: 'raw', depends_on: [] }] });
    await tickOnce();
    expect(h.session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_boom', text: 'raw' });
  });
});

// ─── auto-trace on task completion ──────────────────────────────────────────

describe('harness_task_complete — auto-trace with card_id', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await ackMemory(h);
  });

  afterEach(async () => {
    await h.cleanup();
  });

  async function submitCardTask(card_id?: string, agent = 'builder') {
    const raw = await h.call(
      'submit_workflow',
      { tasks: [{ agent, prompt: 'do work', depends_on: [] }], ...(card_id ? { card_id } : {}) },
      makeContext('orchestrator'),
    );
    return JSON.parse(raw) as { workflow_id: string; task_ids: string[] };
  }

  it('traces success to the task card', async () => {
    const { task_ids } = await submitCardTask('CARD-T');
    const out = JSON.parse(
      await h.call('harness_task_complete', { task_id: task_ids[0], session_id: 'ses_s1', status: 'done' }),
    );
    expect(out).toMatchObject({ status: 'done', auto_traced: true });
    expect(memoryMocks.appendTrace).toHaveBeenCalledTimes(1);
    expect(memoryMocks.appendTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'CARD-T',
        type: 'finding',
        body: `Task ${task_ids[0]} (@builder) completed`,
      }),
    );
    expect(memoryMocks.listActiveCards).not.toHaveBeenCalled();
  });

  it('traces failure to the task card even when several cards are active (no heuristic)', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['A', 'B']);
    const { workflow_id, task_ids } = await submitCardTask('CARD-T');
    const out = JSON.parse(
      await h.call('harness_task_complete', {
        task_id: task_ids[0], session_id: 'ses_f1', status: 'failed', error: 'kaboom',
      }),
    );
    expect(out).toMatchObject({ status: 'failed', auto_traced: true });
    expect(memoryMocks.appendTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'CARD-T',
        type: 'finding',
        body: `Task ${task_ids[0]} (@builder) failed: kaboom`,
      }),
    );
    expect(memoryMocks.listActiveCards).not.toHaveBeenCalled();
    expect(JSON.parse(await h.call('harness_state', { workflow_id })).snapshot.status.type).toBe('failed');
  });

  it('does not trace success for a task without a card', async () => {
    const { task_ids } = await submitCardTask();
    const out = JSON.parse(
      await h.call('harness_task_complete', { task_id: task_ids[0], session_id: 'ses_s2', status: 'done' }),
    );
    expect(out.auto_traced).toBe(false);
    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();
  });

  it('uses the single-active-card heuristic for failures only when the task has no card', async () => {
    memoryMocks.listActiveCards.mockReturnValue(['ONLY']);
    const { task_ids } = await submitCardTask();
    const out = JSON.parse(
      await h.call('harness_task_complete', {
        task_id: task_ids[0], session_id: 'ses_f2', status: 'failed', error: 'nope',
      }),
    );
    expect(out.auto_traced).toBe(true);
    expect(memoryMocks.appendTrace).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'ONLY', body: `Task ${task_ids[0]} (@builder) failed: nope` }),
    );
  });

  it('is non-fatal when the card does not exist / is not active', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    memoryMocks.appendTrace.mockImplementation(() => {
      throw new Error('appendTrace: no active card CARD-GONE');
    });
    const { task_ids } = await submitCardTask('CARD-GONE');
    const out = JSON.parse(
      await h.call('harness_task_complete', { task_id: task_ids[0], session_id: 'ses_s3', status: 'done' }),
    );
    expect(out).toMatchObject({ registered: true, status: 'done', auto_traced: false });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('event-driven auto-trace', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    while (harnesses.length) await harnesses.pop()!.cleanup();
  });

  async function startCardTask(sid: string, card_id?: string) {
    const h = await makeHarness();
    harnesses.push(h);
    await ackMemory(h);
    h.session.create.mockResolvedValueOnce({ id: sid });
    await h.call('submit_workflow', {
      tasks: [{ agent: 'builder', prompt: 'do work', depends_on: [] }],
      ...(card_id ? { card_id } : {}),
    });
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    return h;
  }

  it('traces a session.idle completion to the task card', async () => {
    const h = await startCardTask('ses_ev_ok', 'CARD-E');
    h.events.push(idleEvent('ses_ev_ok'));
    await flush();
    expect(memoryMocks.appendTrace).toHaveBeenCalledTimes(1);
    expect(memoryMocks.appendTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'CARD-E',
        type: 'finding',
        body: expect.stringMatching(/^Task \S+ \(@builder\) completed$/),
      }),
    );
  });

  it('traces a session.execution.failed failure to the task card', async () => {
    const h = await startCardTask('ses_ev_bad', 'CARD-E');
    h.events.push(failedEvent('ses_ev_bad', { type: 'ApiError', message: 'Unauthorized', status: 401 }));
    await flush();
    expect(memoryMocks.appendTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: 'CARD-E',
        body: expect.stringContaining('failed: ApiError: Unauthorized (HTTP 401)'),
      }),
    );
  });

  it('does not trace a card-less completion, and keeps the failure heuristic', async () => {
    const ok = await startCardTask('ses_ev_nc_ok');
    ok.events.push(idleEvent('ses_ev_nc_ok'));
    await flush();
    expect(memoryMocks.appendTrace).not.toHaveBeenCalled();

    memoryMocks.listActiveCards.mockReturnValue(['ONLY']);
    const bad = await startCardTask('ses_ev_nc_bad');
    bad.events.push(failedEvent('ses_ev_nc_bad', { type: 'ApiError', message: 'x', status: 401 }));
    await flush();
    expect(memoryMocks.appendTrace).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'ONLY' }));
  });
});
