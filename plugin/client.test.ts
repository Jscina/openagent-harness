import { describe, it, expect, vi } from 'vitest';
import {
  parseModel,
  createSession,
  sendMessage,
  deleteSession,
  showToast,
} from './client.js';

// ─── parseModel ───────────────────────────────────────────────────────────────

describe('parseModel', () => {
  it('returns undefined for empty string', () => {
    expect(parseModel('')).toBeUndefined();
  });

  it('parses "provider/model" into providerID and modelID', () => {
    expect(parseModel('anthropic/claude-sonnet-4-6')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
    });
  });

  it('defaults provider to "anthropic" when no slash present', () => {
    expect(parseModel('claude-sonnet-4-6')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
    });
  });

  it('handles multiple slashes — first segment is provider, rest is model', () => {
    expect(parseModel('openai/gpt-4/turbo')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4/turbo',
    });
  });

  it('handles ollama model with colon tag', () => {
    expect(parseModel('ollama/qwen3-coder:30b')).toEqual({
      providerID: 'ollama',
      modelID: 'qwen3-coder:30b',
    });
  });
});

// ─── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('returns the session id from the client response', async () => {
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_abc123' } }),
      },
    } as any;

    const id = await createSession(client, null, 'My Session', 'builder');
    expect(id).toBe('ses_abc123');
  });

  it('passes title and agent to the client', async () => {
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_x' } }),
      },
    } as any;

    await createSession(client, null, 'My Title', 'explorer');
    expect(client.session.create).toHaveBeenCalledWith({
      body: { title: 'My Title', agent: 'explorer' },
    });
  });

  it('includes parentID when provided', async () => {
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_child' } }),
      },
    } as any;

    await createSession(client, 'ses_parent', null, null);
    expect(client.session.create).toHaveBeenCalledWith({
      body: { parentID: 'ses_parent' },
    });
  });

  it('omits undefined optional fields from the body', async () => {
    const client = {
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: 'ses_bare' } }),
      },
    } as any;

    await createSession(client);
    const body = client.session.create.mock.calls[0][0].body;
    expect(body).not.toHaveProperty('parentID');
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('agent');
  });

  it('throws when the client returns no data', async () => {
    const client = {
      session: { create: vi.fn().mockResolvedValue({ data: null }) },
    } as any;

    await expect(createSession(client)).rejects.toThrow('createSession failed');
  });
});

// ─── sendMessage ──────────────────────────────────────────────────────────────

describe('sendMessage', () => {
  it('calls promptAsync with the correct body including model and agent', async () => {
    const client = {
      session: { promptAsync: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await sendMessage(client, 'ses_abc', 'hello world', 'anthropic/claude-sonnet-4-6', 'builder');

    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: 'ses_abc' },
      body: {
        parts: [{ type: 'text', text: 'hello world' }],
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
        agent: 'builder',
      },
    });
  });

  it('omits model from body when model string is empty', async () => {
    const client = {
      session: { promptAsync: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await sendMessage(client, 'ses_abc', 'hi', '');
    const body = client.session.promptAsync.mock.calls[0][0].body;
    expect(body).not.toHaveProperty('model');
  });

  it('omits agent from body when agent is null', async () => {
    const client = {
      session: { promptAsync: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await sendMessage(client, 'ses_abc', 'hi', 'anthropic/claude-haiku-4-5', null);
    const body = client.session.promptAsync.mock.calls[0][0].body;
    expect(body).not.toHaveProperty('agent');
  });
});

// ─── deleteSession ────────────────────────────────────────────────────────────

describe('deleteSession', () => {
  it('calls client.session.delete with the session id', async () => {
    const client = {
      session: { delete: vi.fn().mockResolvedValue({}) },
    } as any;

    await deleteSession(client, 'ses_xyz');
    expect(client.session.delete).toHaveBeenCalledWith({ path: { id: 'ses_xyz' } });
  });

  it('resolves without throwing when client.session.delete rejects', async () => {
    const client = {
      session: { delete: vi.fn().mockRejectedValue(new Error('network error')) },
    } as any;

    await expect(deleteSession(client, 'ses_xyz')).resolves.toBeUndefined();
  });
});

// ─── showToast ────────────────────────────────────────────────────────────────

describe('showToast', () => {
  it('calls client.tui.showToast with correct parameters', async () => {
    const client = {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await showToast(client, 'Title', 'Message', 'info', 3000);
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { title: 'Title', message: 'Message', variant: 'info', duration: 3000 },
    });
  });

  it('defaults duration to 8000 when not specified', async () => {
    const client = {
      tui: { showToast: vi.fn().mockResolvedValue(undefined) },
    } as any;

    await showToast(client, 'T', 'M', 'warning');
    expect(client.tui.showToast).toHaveBeenCalledWith({
      body: { title: 'T', message: 'M', variant: 'warning', duration: 8000 },
    });
  });

  it('resolves without throwing when client.tui.showToast rejects', async () => {
    const client = {
      tui: { showToast: vi.fn().mockRejectedValue(new Error('TUI unavailable')) },
    } as any;

    await expect(showToast(client, 'T', 'M', 'error')).resolves.toBeUndefined();
  });
});
