import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Vitest cannot vi.spyOn() a live ESM named export (the module namespace is
// frozen), so injected-failure tests below mock the whole 'fs' module at
// resolution time instead, toggled via this shared flag. Default state is a
// pure passthrough to the real implementation, so every other test in this
// file is unaffected.
const injectedFailure = { writeFileSyncFailSuffix: null as string | null };

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: (path: unknown, ...rest: unknown[]) => {
      if (injectedFailure.writeFileSyncFailSuffix && String(path).endsWith(injectedFailure.writeFileSyncFailSuffix)) {
        throw new Error('disk full (injected)');
      }
      return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

import {
  sanitizeCardId,
  scaffoldCorpus,
  createCard,
  findCard,
  listActiveCards,
  appendTrace,
  assembleContext,
  promoteFinding,
  memoryRoot,
  CORPUS_GITIGNORE,
} from './memory.js';

// Each test gets its own temp directory; process.cwd() is redirected there.
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'harness-memory-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── sanitizeCardId ──────────────────────────────────────────────────────────

describe('sanitizeCardId', () => {
  const cases: Array<[string, string]> = [
    ['ADO-11111', 'CARD-ADO-11111'],
    ['CARD-ADO-1', 'CARD-ADO-1'],
    ['card-abc', 'CARD-abc'],
    ['#12345', 'CARD-12345'],
    ['Planned: retry storms', 'CARD-Planned-retry-storms'],
    ['a/b/c', 'CARD-a-b-c'],
    ['a\\b', 'CARD-a-b'],
    ['x---y', 'CARD-x-y'],
    ['../../etc', 'CARD-etc'],
    ['..\\..\\x', 'CARD-x'],
  ];

  it.each(cases)('sanitizes %s -> %s', (raw, expected) => {
    expect(sanitizeCardId(raw)).toBe(expected);
  });

  const throwing = ['', '#', '::', '/', '.', '..', '...'];
  it.each(throwing)('throws for %j', (raw) => {
    expect(() => sanitizeCardId(raw)).toThrow();
  });

  it('never produces a result containing "/", "\\\\", or ".."', () => {
    for (const [, expected] of cases) {
      expect(expected).not.toContain('/');
      expect(expected).not.toContain('\\');
      expect(expected).not.toContain('..');
    }
  });
});

// ─── scaffoldCorpus ──────────────────────────────────────────────────────────

describe('scaffoldCorpus', () => {
  it('creates the full directory tree and boilerplate files', () => {
    const root = memoryRoot();
    scaffoldCorpus(root);

    for (const sub of ['architecture', 'schemas', 'services', 'known-behaviors']) {
      expect(existsSync(join(root, 'system', sub))).toBe(true);
    }
    for (const sub of ['backlog', 'active', 'done', 'archive']) {
      expect(existsSync(join(root, 'issues', sub))).toBe(true);
    }
    expect(existsSync(join(root, '.gitignore'))).toBe(true);
    expect(existsSync(join(root, '.rag-meta.json'))).toBe(true);
    expect(existsSync(join(root, 'README.md'))).toBe(true);
    expect(existsSync(join(root, 'BENCHMARKS.md'))).toBe(true);
    expect(existsSync(join(root, 'system', 'README.md'))).toBe(true);
    expect(existsSync(join(root, 'issues', 'README.md'))).toBe(true);
  });

  it('writes the exact corpus .gitignore commit-boundary contents', () => {
    const root = memoryRoot();
    scaffoldCorpus(root);
    const raw = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(raw).toBe(CORPUS_GITIGNORE);
    expect(raw).toContain('issues/backlog/');
    expect(raw).toContain('issues/active/');
    expect(raw).toContain('issues/done/');
    expect(raw).toContain('**/trace.md');
    expect(raw).not.toContain('issues/archive/\n');
  });

  it('writes .rag-meta.json with the expected shape', () => {
    const root = memoryRoot();
    scaffoldCorpus(root);
    const meta = JSON.parse(readFileSync(join(root, '.rag-meta.json'), 'utf8'));
    expect(meta).toEqual({ format_gen: { doc: 3, card: 1 }, plugin: 'memory' });
  });

  it('is idempotent — never overwrites existing content on repeat calls', () => {
    const root = memoryRoot();
    scaffoldCorpus(root);
    writeFileSync(join(root, 'README.md'), 'user-edited content', 'utf8');

    scaffoldCorpus(root);

    expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('user-edited content');
  });

  it('supports an explicit root param independent of process.cwd()', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'harness-memory-explicit-root-'));
    try {
      scaffoldCorpus(otherRoot);
      expect(existsSync(join(otherRoot, 'system', 'known-behaviors'))).toBe(true);
      // process.cwd()-based default root must be untouched
      expect(existsSync(join(tmpDir, '.opencode', 'memory', 'system'))).toBe(false);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

// ─── createCard ──────────────────────────────────────────────────────────────

describe('createCard', () => {
  it('creates an active card with context.md, trace.md, benchmarks.md, and artifacts/.gitkeep', () => {
    const written = createCard({ cardId: 'ADO-1', symptom: 'Export truncates' });
    const root = memoryRoot();
    const dir = join(root, 'issues', 'active', 'CARD-ADO-1');

    expect(written.sort()).toEqual(['artifacts/.gitkeep', 'benchmarks.md', 'context.md', 'trace.md'].sort());
    expect(existsSync(join(dir, 'context.md'))).toBe(true);
    expect(existsSync(join(dir, 'trace.md'))).toBe(true);
    expect(existsSync(join(dir, 'benchmarks.md'))).toBe(true);
    expect(existsSync(join(dir, 'artifacts', '.gitkeep'))).toBe(true);

    const context = readFileSync(join(dir, 'context.md'), 'utf8');
    expect(context).toContain('card_id: CARD-ADO-1');
    expect(context).toContain('**Symptom**: Export truncates');
    expect(context).toContain('Card created');

    const trace = readFileSync(join(dir, 'trace.md'), 'utf8');
    expect(trace).toContain('# Investigation Trace — CARD-ADO-1');
    expect(trace).toContain('session: manual');
    expect(trace).toContain('type: next-step');

    const benchmarks = readFileSync(join(dir, 'benchmarks.md'), 'utf8');
    expect(benchmarks).toContain('# Benchmark Moments — CARD-ADO-1');
    expect(benchmarks).toContain('target: system/known-behaviors/example.md');
  });

  it('creates a backlog card with context.md only, symptom optional', () => {
    const written = createCard({ cardId: 'Planned: retry storms', backlog: true });
    const root = memoryRoot();
    const dir = join(root, 'issues', 'backlog', 'CARD-Planned-retry-storms');

    expect(written).toEqual(['context.md']);
    expect(existsSync(join(dir, 'trace.md'))).toBe(false);
    expect(existsSync(join(dir, 'benchmarks.md'))).toBe(false);
    expect(existsSync(join(dir, 'artifacts'))).toBe(false);
  });

  it('requires a symptom for active cards but not for backlog cards', () => {
    expect(() => createCard({ cardId: 'CARD-NOSYMPTOM' })).toThrow(/symptom is required/);
    expect(() => createCard({ cardId: 'CARD-NOSYMPTOM', backlog: true })).not.toThrow();
  });

  it.each(['backlog', 'active', 'done', 'archive'] as const)(
    'refuses to create a card that already exists in issues/%s/',
    (state) => {
      const root = memoryRoot();
      mkdirSync(join(root, 'issues', state, 'CARD-DUP'), { recursive: true });
      expect(() => createCard({ cardId: 'CARD-DUP', symptom: 'x' }, root)).toThrow(/already exists/);
    },
  );

  it('rolls back a partially written card on injected failure and rethrows', () => {
    injectedFailure.writeFileSyncFailSuffix = 'benchmarks.md';
    try {
      const root = memoryRoot();
      expect(() => createCard({ cardId: 'CARD-ROLLBACK', symptom: 'x' }, root)).toThrow(/disk full/);

      const cardDir = join(root, 'issues', 'active', 'CARD-ROLLBACK');
      expect(existsSync(cardDir)).toBe(false);
    } finally {
      injectedFailure.writeFileSyncFailSuffix = null;
    }
  });

  it('supports an explicit root param', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'harness-memory-explicit-root-'));
    try {
      createCard({ cardId: 'CARD-EXPLICIT', symptom: 'x' }, otherRoot);
      expect(existsSync(join(otherRoot, 'issues', 'active', 'CARD-EXPLICIT', 'context.md'))).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

// ─── findCard ────────────────────────────────────────────────────────────────

describe('findCard', () => {
  it('locates a card in each lifecycle state', () => {
    const root = memoryRoot();
    scaffoldCorpus(root);
    for (const state of ['backlog', 'active', 'done', 'archive'] as const) {
      mkdirSync(join(root, 'issues', state, `CARD-${state.toUpperCase()}`), { recursive: true });
      expect(findCard(`CARD-${state.toUpperCase()}`, root)).toEqual({
        state,
        dir: join(root, 'issues', state, `CARD-${state.toUpperCase()}`),
      });
    }
  });

  it('returns null when the card does not exist anywhere', () => {
    expect(findCard('CARD-NOPE')).toBeNull();
  });

  it('normalizes the card id the same way createCard does', () => {
    createCard({ cardId: 'ado-99', symptom: 'x' });
    expect(findCard('#ado-99')).toEqual({
      state: 'active',
      dir: join(memoryRoot(), 'issues', 'active', 'CARD-ado-99'),
    });
  });
});

// ─── listActiveCards ─────────────────────────────────────────────────────────

describe('listActiveCards', () => {
  it('returns an empty array when the corpus has never been scaffolded', () => {
    expect(listActiveCards()).toEqual([]);
  });

  it('returns an empty array when issues/active/ exists but is empty', () => {
    scaffoldCorpus();
    expect(listActiveCards()).toEqual([]);
  });

  it('returns the card id for a single active card', () => {
    createCard({ cardId: 'CARD-ONE', symptom: 'x' });
    expect(listActiveCards()).toEqual(['CARD-ONE']);
  });

  it('returns all active card ids when multiple cards are active', () => {
    createCard({ cardId: 'CARD-ONE', symptom: 'x' });
    createCard({ cardId: 'CARD-TWO', symptom: 'y' });
    expect(listActiveCards().sort()).toEqual(['CARD-ONE', 'CARD-TWO']);
  });

  it('excludes backlog cards', () => {
    createCard({ cardId: 'CARD-ACTIVE', symptom: 'x' });
    createCard({ cardId: 'CARD-BACKLOG', backlog: true });
    expect(listActiveCards()).toEqual(['CARD-ACTIVE']);
  });

  it('ignores stray non-directory files inside issues/active/', () => {
    createCard({ cardId: 'CARD-ONE', symptom: 'x' });
    const root = memoryRoot();
    writeFileSync(join(root, 'issues', 'active', 'stray.txt'), 'not a card', 'utf8');
    expect(listActiveCards()).toEqual(['CARD-ONE']);
  });

  it('accepts an explicit root argument', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-EXPLICIT', symptom: 'x' }, root);
    expect(listActiveCards(root)).toEqual(['CARD-EXPLICIT']);
  });
});

// ─── appendTrace ─────────────────────────────────────────────────────────────

describe('appendTrace', () => {
  it('appends an entry and returns an economy readout with correct numbers', () => {
    createCard({ cardId: 'CARD-TRACE1', symptom: 'x' });
    const root = memoryRoot();
    const tracePath = join(root, 'issues', 'active', 'CARD-TRACE1', 'trace.md');
    const before = readFileSync(tracePath, 'utf8');

    const result = appendTrace({ cardId: 'CARD-TRACE1', type: 'finding', body: 'Truncation is at export.c:342' });

    expect(result.path).toBe(tracePath);
    expect(result.bytesBefore).toBe(Buffer.byteLength(before, 'utf8'));
    expect(result.tokensAvoided).toBe(Math.round(result.bytesBefore / 4));
    expect(result.linesAfter).toBeGreaterThan(result.linesBefore);
    expect(result.formatted).toContain('Appended finding entry to');
    expect(result.formatted).toContain(`(${result.linesBefore} -> ${result.linesAfter} lines)`);
    expect(result.formatted).toContain('tokens not pulled into context');

    const after = readFileSync(tracePath, 'utf8');
    expect(after.startsWith(before)).toBe(true); // append-only: prior content untouched
    expect(after).toContain('type: finding');
    expect(after).toContain('Truncation is at export.c:342');
  });

  it('never rewrites existing entries across multiple appends', () => {
    createCard({ cardId: 'CARD-TRACE2', symptom: 'x' });
    appendTrace({ cardId: 'CARD-TRACE2', type: 'finding', body: 'first finding' });
    const afterFirst = readFileSync(join(memoryRoot(), 'issues', 'active', 'CARD-TRACE2', 'trace.md'), 'utf8');

    appendTrace({ cardId: 'CARD-TRACE2', type: 'hypothesis', body: 'second entry' });
    const afterSecond = readFileSync(join(memoryRoot(), 'issues', 'active', 'CARD-TRACE2', 'trace.md'), 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond).toContain('second entry');
  });

  it('bootstraps the header when trace.md is missing (card activated without createCard)', () => {
    const root = memoryRoot();
    scaffoldCorpus(root);
    const dir = join(root, 'issues', 'active', 'CARD-NOHEADER');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context.md'), 'placeholder', 'utf8');

    appendTrace({ cardId: 'CARD-NOHEADER', type: 'next-step', body: 'kick off investigation' }, root);

    const trace = readFileSync(join(dir, 'trace.md'), 'utf8');
    expect(trace).toContain('# Investigation Trace — CARD-NOHEADER');
    expect(trace).toContain('append-only');
    expect(trace).toContain('kick off investigation');
  });

  it('throws a not-found error when the card does not exist', () => {
    expect(() => appendTrace({ cardId: 'CARD-GHOST', type: 'finding', body: 'x' })).toThrow(/no active card/);
  });

  it('refuses and names the actual state when the card is not active', () => {
    createCard({ cardId: 'CARD-BACKLOGGED', backlog: true });
    expect(() => appendTrace({ cardId: 'CARD-BACKLOGGED', type: 'finding', body: 'x' })).toThrow(/backlog/);

    const root = memoryRoot();
    mkdirSync(join(root, 'issues', 'done', 'CARD-DONE1'), { recursive: true });
    expect(() => appendTrace({ cardId: 'CARD-DONE1', type: 'finding', body: 'x' }, root)).toThrow(/done/);

    mkdirSync(join(root, 'issues', 'archive', 'CARD-ARCH1'), { recursive: true });
    expect(() => appendTrace({ cardId: 'CARD-ARCH1', type: 'finding', body: 'x' }, root)).toThrow(/archive/);
  });

  it('throws on empty or whitespace-only body', () => {
    createCard({ cardId: 'CARD-EMPTYBODY', symptom: 'x' });
    expect(() => appendTrace({ cardId: 'CARD-EMPTYBODY', type: 'finding', body: '' })).toThrow(/empty/);
    expect(() => appendTrace({ cardId: 'CARD-EMPTYBODY', type: 'finding', body: '   \n  ' })).toThrow(/empty/);
  });

  it('defaults session to "opencode"', () => {
    createCard({ cardId: 'CARD-SESSIONDEFAULT', symptom: 'x' });
    appendTrace({ cardId: 'CARD-SESSIONDEFAULT', type: 'next-step', body: 'x' });
    const trace = readFileSync(
      join(memoryRoot(), 'issues', 'active', 'CARD-SESSIONDEFAULT', 'trace.md'),
      'utf8',
    );
    expect(trace).toContain('session: opencode');
  });
});

// ─── assembleContext ─────────────────────────────────────────────────────────

describe('assembleContext', () => {
  it('assembles full mode with the whole trace and full system file contents', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-CTX1', symptom: 'x' }, root);
    appendTrace({ cardId: 'CARD-CTX1', type: 'finding', body: 'finding one' }, root);

    mkdirSync(join(root, 'system', 'known-behaviors'), { recursive: true });
    writeFileSync(
      join(root, 'system', 'known-behaviors', 'foo.md'),
      '---\ntitle: Foo\n---\n\n# Foo\n\n## Section A\nBody text here.\n',
      'utf8',
    );

    const out = assembleContext({ cardId: 'CARD-CTX1', mode: 'full' }, root);

    expect(out).toContain('# RAG Context — CARD-CTX1');
    expect(out).toContain('Mode: full');
    expect(out).toContain('## Active Card Summary');
    expect(out).toContain('## Investigation History');
    expect(out).toContain('finding one');
    expect(out).toContain('## Relevant System Knowledge');
    expect(out).toContain('Body text here.');
    expect(out).not.toContain('Compact mode');
  });

  it('assembles compact mode with only the last 10 trace entries and TOC-only system files', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-CTX2', symptom: 'x' }, root);
    for (let i = 0; i < 12; i++) {
      appendTrace({ cardId: 'CARD-CTX2', type: 'next-step', body: `step ${i}` }, root);
    }

    mkdirSync(join(root, 'system', 'known-behaviors'), { recursive: true });
    writeFileSync(
      join(root, 'system', 'known-behaviors', 'foo.md'),
      '---\ntitle: Foo\n---\n\n# Foo\n\n## Section A\nBody text here.\n',
      'utf8',
    );

    const out = assembleContext({ cardId: 'CARD-CTX2', mode: 'compact' }, root);

    expect(out).toContain('Mode: compact');
    expect(out).toContain('Showing last 10 of');
    expect(out).not.toContain('step 0'); // dropped: only last 10 of 13 total entries kept
    expect(out).toContain('step 11');
    expect(out).toContain('Compact mode — showing headings only');
    expect(out).toContain('## Section A');
    expect(out).not.toContain('Body text here.');
  });

  it('honors an explicit sections filter', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-CTX3', symptom: 'x' }, root);
    mkdirSync(join(root, 'system', 'schemas'), { recursive: true });
    writeFileSync(join(root, 'system', 'schemas', 'db.md'), '# DB\n\n## Tables\ncontent', 'utf8');
    mkdirSync(join(root, 'system', 'known-behaviors'), { recursive: true });
    writeFileSync(join(root, 'system', 'known-behaviors', 'kb.md'), '# KB\n\n## Thing\ncontent', 'utf8');

    const out = assembleContext({ cardId: 'CARD-CTX3', sections: ['schemas'] }, root);
    expect(out).toContain('schemas/db.md');
    expect(out).not.toContain('known-behaviors/kb.md');
  });

  it('throws when the card cannot be found', () => {
    expect(() => assembleContext({ cardId: 'CARD-NOWHERE' })).toThrow(/not found/);
  });
});

// ─── promoteFinding ──────────────────────────────────────────────────────────

describe('promoteFinding', () => {
  it('creates a new system file with frontmatter when the target does not exist', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-PROMOTE1', symptom: 'x' }, root);

    const result = promoteFinding(
      {
        cardId: 'CARD-PROMOTE1',
        finding: 'Export truncates at 4096 bytes due to a hard-coded buffer size',
        impact: 'Any export over 4096 bytes silently loses data',
        targetPath: 'known-behaviors/export-truncation.md',
        title: 'Export Truncation',
        sectionTitle: 'Buffer size constant',
      },
      root,
    );

    expect(result.created).toBe(true);
    expect(result.systemPath).toBe(join(root, 'system', 'known-behaviors', 'export-truncation.md'));

    const content = readFileSync(result.systemPath, 'utf8');
    expect(content).toContain('title: Export Truncation');
    expect(content).toContain('domain: known-behaviors');
    expect(content).toContain('source_cards: [CARD-PROMOTE1]');
    expect(content).toContain('format_gen: 3');
    expect(content).toContain('# Export Truncation');
    expect(content).toContain('## Buffer size constant');
    expect(content).toContain('**Source**: CARD-PROMOTE1');
    expect(content).toContain('**Finding**: Export truncates at 4096 bytes due to a hard-coded buffer size');
    expect(content).toContain('**Impact**: Any export over 4096 bytes silently loses data');

    const benchmarks = readFileSync(join(root, 'issues', 'active', 'CARD-PROMOTE1', 'benchmarks.md'), 'utf8');
    expect(benchmarks).toContain('status: promoted');
    expect(benchmarks).toContain('target: system/known-behaviors/export-truncation.md');

    const trace = readFileSync(join(root, 'issues', 'active', 'CARD-PROMOTE1', 'trace.md'), 'utf8');
    expect(trace).not.toContain('Export truncates at 4096 bytes due to a hard-coded buffer size');
  });

  it('appends a new section and updates only source_cards/updated on an existing target', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-PROMOTE2', symptom: 'x' }, root);
    createCard({ cardId: 'CARD-PROMOTE3', symptom: 'y' }, root);

    promoteFinding(
      {
        cardId: 'CARD-PROMOTE2',
        finding: 'First finding',
        targetPath: 'known-behaviors/shared.md',
        title: 'Shared Doc',
        sectionTitle: 'First section',
        date: '2026-01-01',
      },
      root,
    );

    const result = promoteFinding(
      {
        cardId: 'CARD-PROMOTE3',
        finding: 'Second finding',
        targetPath: 'known-behaviors/shared.md',
        sectionTitle: 'Second section',
        date: '2026-02-02',
      },
      root,
    );

    expect(result.created).toBe(false);
    const content = readFileSync(result.systemPath, 'utf8');

    expect(content).toContain('source_cards: [CARD-PROMOTE2, CARD-PROMOTE3]');
    expect(content).toContain('updated: 2026-02-02');
    expect(content).toContain('created: 2026-01-01');
    expect(content).toContain('format_gen: 3');
    expect(content).toContain('## First section');
    expect(content).toContain('First finding');
    expect(content).toContain('## Second section');
    expect(content).toContain('Second finding');
  });

  it('dedupes source_cards when the same card promotes twice to the same file', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-PROMOTE4', symptom: 'x' }, root);

    promoteFinding(
      { cardId: 'CARD-PROMOTE4', finding: 'A', targetPath: 'known-behaviors/dup.md', sectionTitle: 'A' },
      root,
    );
    const result = promoteFinding(
      { cardId: 'CARD-PROMOTE4', finding: 'B', targetPath: 'known-behaviors/dup.md', sectionTitle: 'B' },
      root,
    );

    const content = readFileSync(result.systemPath, 'utf8');
    expect(content).toContain('source_cards: [CARD-PROMOTE4]');
    expect(content.match(/CARD-PROMOTE4/g)?.length).toBeLessThan(4);
  });

  it('rejects targetPath traversal attempts', () => {
    const root = memoryRoot();
    createCard({ cardId: 'CARD-PROMOTE5', symptom: 'x' }, root);

    expect(() =>
      promoteFinding({ cardId: 'CARD-PROMOTE5', finding: 'x', targetPath: '../escape.md' }, root),
    ).toThrow(/invalid targetPath/);
    expect(() =>
      promoteFinding({ cardId: 'CARD-PROMOTE5', finding: 'x', targetPath: 'known-behaviors/../../escape.md' }, root),
    ).toThrow(/invalid targetPath/);
    expect(() =>
      promoteFinding({ cardId: 'CARD-PROMOTE5', finding: 'x', targetPath: '/etc/passwd' }, root),
    ).toThrow(/invalid targetPath/);
  });

  it('throws when the card cannot be found or is still in backlog', () => {
    const root = memoryRoot();
    expect(() =>
      promoteFinding({ cardId: 'CARD-NOPROMOTE', finding: 'x', targetPath: 'known-behaviors/x.md' }, root),
    ).toThrow(/not found/);

    createCard({ cardId: 'CARD-BACKLOGONLY', backlog: true }, root);
    expect(() =>
      promoteFinding({ cardId: 'CARD-BACKLOGONLY', finding: 'x', targetPath: 'known-behaviors/x.md' }, root),
    ).toThrow(/backlog/);
  });
});
