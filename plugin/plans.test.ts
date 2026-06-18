import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createPlanArtifact, savePlanArtifact, loadPlanArtifact } from './plans.js';
import type { PlanArtifact } from './types.js';

// Each test gets its own temp directory; process.cwd() is redirected there.
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-plans-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

const minimal: PlanArtifact = {
  id: 'plan-abc',
  created_at: '2026-01-01T00:00:00.000Z',
  summary: ['Step 1', 'Step 2'],
  tasks: [
    { agent: 'explorer', prompt: 'Explore', depends_on: [] },
    { agent: 'builder', prompt: 'Build', depends_on: [0] },
  ],
};

describe('savePlanArtifact', () => {
  it('returns the path to the written JSON file', () => {
    const path = savePlanArtifact(minimal);
    expect(path).toMatch(/plan-abc\.json$/);
  });

  it('writes valid JSON that can be parsed back', () => {
    savePlanArtifact(minimal);
    const loaded = loadPlanArtifact('plan-abc');
    expect(loaded).toEqual(minimal);
  });

  it('strips transient plan_id fields before persisting', () => {
    savePlanArtifact({
      ...minimal,
      id: 'plan-strip',
      plan_id: 'transient-edit-id',
    } as PlanArtifact & { plan_id: string });

    const raw = readFileSync(join(tmpDir, '.opencode', 'plans', 'plan-strip.json'), 'utf8');
    expect(raw).not.toContain('"plan_id"');
    expect(loadPlanArtifact('plan-strip')).toEqual({
      ...minimal,
      id: 'plan-strip',
    });
  });

  it('rejects invalid plan IDs on save', () => {
    expect(() => savePlanArtifact({ ...minimal, id: '../escape' })).toThrow(
      'invalid plan artifact id: ../escape (must not contain "/", "\\" or "..")',
    );
  });
});

describe('createPlanArtifact', () => {
  it('preserves created_at and overwrites in place when editing an existing plan', () => {
    savePlanArtifact(minimal);

    const edited = createPlanArtifact({
      plan_id: 'plan-abc',
      summary: ['Updated summary'],
      recommendations: ['Keep editing'],
      tasks: [{ agent: 'builder', prompt: 'Edited build', depends_on: [] }],
    });
    const path = savePlanArtifact(edited);
    const files = readdirSync(join(tmpDir, '.opencode', 'plans'));

    expect(edited.id).toBe('plan-abc');
    expect(path).toMatch(/plan-abc\.json$/);
    expect(files).toEqual(['plan-abc.json']);
    expect(loadPlanArtifact('plan-abc')).toEqual({
      id: 'plan-abc',
      created_at: minimal.created_at,
      summary: ['Updated summary'],
      recommendations: ['Keep editing'],
      tasks: [{ agent: 'builder', prompt: 'Edited build', depends_on: [] }],
    });
  });

  it('uses the provided ID and a fresh timestamp when creating a missing plan', () => {
    const before = Date.now();
    const created = createPlanArtifact({
      plan_id: 'new-plan',
      summary: ['Created'],
      tasks: [{ agent: 'planner', prompt: 'Create', depends_on: [] }],
    });
    const after = Date.now();

    expect(created.id).toBe('new-plan');
    expect(new Date(created.created_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(created.created_at).getTime()).toBeLessThanOrEqual(after);
  });

  it('rejects invalid plan IDs before any load or save path is used', () => {
    expect(() =>
      createPlanArtifact({
        plan_id: '..\\escape',
        summary: ['Bad'],
        tasks: [{ agent: 'planner', prompt: 'Nope', depends_on: [] }],
      }),
    ).toThrow('invalid plan artifact id: ..\\escape (must not contain "/", "\\" or "..")');
  });
});

describe('loadPlanArtifact', () => {
  it('round-trips a full artifact including recommendations', () => {
    const withRecs: PlanArtifact = {
      ...minimal,
      id: 'plan-with-recs',
      recommendations: ['Use DI', 'Write tests'],
    };
    savePlanArtifact(withRecs);
    const loaded = loadPlanArtifact('plan-with-recs');
    expect(loaded.recommendations).toEqual(['Use DI', 'Write tests']);
  });

  it('throws with a clear message when the plan does not exist', () => {
    expect(() => loadPlanArtifact('nonexistent-id')).toThrow('plan artifact not found: nonexistent-id');
  });

  it('rejects invalid plan IDs on load', () => {
    expect(() => loadPlanArtifact('../escape')).toThrow(
      'invalid plan artifact id: ../escape (must not contain "/", "\\" or "..")',
    );
  });

  it('throws when the file contains invalid JSON', () => {
    const dir = join(tmpDir, '.opencode', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad-json.json'), 'NOT VALID JSON', 'utf8');
    expect(() => loadPlanArtifact('bad-json')).toThrow();
  });

  it('throws with "invalid plan artifact" when tasks is not an array', () => {
    const dir = join(tmpDir, '.opencode', 'plans');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad-tasks.json'),
      JSON.stringify({ id: 'bad-tasks', tasks: 'not-an-array' }),
      'utf8',
    );
    expect(() => loadPlanArtifact('bad-tasks')).toThrow('invalid plan artifact: bad-tasks');
  });

  it('preserves task ordering', () => {
    savePlanArtifact(minimal);
    const loaded = loadPlanArtifact('plan-abc');
    expect(loaded.tasks[0].agent).toBe('explorer');
    expect(loaded.tasks[1].agent).toBe('builder');
    expect(loaded.tasks[1].depends_on).toEqual([0]);
  });

  it('preserves optional model field on tasks', () => {
    const withModel: PlanArtifact = {
      ...minimal,
      id: 'plan-with-model',
      tasks: [
        { agent: 'builder', prompt: 'Build', depends_on: [], model: 'anthropic/claude-sonnet-4-6' },
      ],
    };
    savePlanArtifact(withModel);
    const loaded = loadPlanArtifact('plan-with-model');
    expect(loaded.tasks[0].model).toBe('anthropic/claude-sonnet-4-6');
  });
});
