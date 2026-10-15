import { describe, it, expect } from 'vitest';
import indexPlugin from './index.js';
import harnessPlugin from './harness.js';

describe('plugin directory entrypoint', () => {
  it('re-exports the harness plugin as default', () => {
    expect(indexPlugin).toBe(harnessPlugin);
  });

  it('has the expected id and a setup function', () => {
    const plugin = indexPlugin as unknown as { id: string; setup: unknown };
    expect(plugin.id).toBe('openagent-harness');
    expect(typeof plugin.setup).toBe('function');
  });
});
