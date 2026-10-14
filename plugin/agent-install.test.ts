import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isStaleV1Agent, installAgentsInto } from './agent-install.js';

const V1 = '---\nmodel: a/b\npermission:\n  edit: deny\n  bash: deny\n---\n\nBody.\n';
const V2 = '---\nmodel: a/b\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\n---\n\nBody.\n';

describe('isStaleV1Agent', () => {
  it('detects a top-level permission map', () => {
    expect(isStaleV1Agent(V1)).toBe(true);
    expect(isStaleV1Agent('---\nmodel: a/b\npermission: allow\n---\nBody\n')).toBe(true);
  });

  it('ignores v2, body mentions, nested keys and non-frontmatter', () => {
    expect(isStaleV1Agent(V2)).toBe(false);
    expect(isStaleV1Agent('no frontmatter\npermission:\n')).toBe(false);
    expect(isStaleV1Agent('---\nmodel: a/b\n---\n\npermission:\n  edit: deny\n')).toBe(false);
    expect(isStaleV1Agent('---\nmodel: a/b\nmeta:\n  permission:\n    x: y\n---\n')).toBe(false);
    expect(isStaleV1Agent('---\npermissions:\n  - x\n---\n')).toBe(false);
  });
});

describe('installAgentsInto', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-install-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes missing files', () => {
    const log = vi.fn();
    expect(installAgentsInto(dir, { a: V2 }, log)).toBe(1);
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(V2);
    expect(log).not.toHaveBeenCalled();
  });

  it('preserves existing v2 files (user edits)', () => {
    writeFileSync(join(dir, 'a.md'), 'user edited\n');
    const log = vi.fn();
    expect(installAgentsInto(dir, { a: V2 }, log)).toBe(0);
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('user edited\n');
    expect(log).not.toHaveBeenCalled();
  });

  it('overwrites stale v1 files and logs', () => {
    writeFileSync(join(dir, 'a.md'), V1);
    writeFileSync(join(dir, 'b.md'), V2.replace('Body', 'Custom'));
    const log = vi.fn();
    const n = installAgentsInto(dir, { a: V2, b: V2 }, log);
    expect(n).toBe(1);
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(V2);
    expect(readFileSync(join(dir, 'b.md'), 'utf8')).toContain('Custom');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('a.md');
    expect(log.mock.calls[0][0]).toContain('v1');
  });
});
