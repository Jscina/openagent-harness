import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { savePlanArtifact, loadPlanArtifact } from './plans.js';
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
