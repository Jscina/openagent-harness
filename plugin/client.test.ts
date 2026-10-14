import { describe, it, expect, vi } from 'vitest';
import {
  parseModel,
  toModelRef,
  createSession,
  sendMessage,
  deleteSession,
  abortSession,
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

  it('does not split on "#"', () => {
    expect(parseModel('openai/gpt-5#high')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5#high',
    });
  });
});

// ─── toModelRef ───────────────────────────────────────────────────────────────

describe('toModelRef', () => {
  it('returns undefined for empty string', () => {
    expect(toModelRef('')).toBeUndefined();
  });

  it('maps "provider/model" to { providerID, id }', () => {
    expect(toModelRef('anthropic/claude-sonnet-4-6')).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-4-6',
    });
  });

  it('defaults provider to "anthropic" when no slash present', () => {
    expect(toModelRef('claude-sonnet-4-6')).toEqual({
      providerID: 'anthropic',
      id: 'claude-sonnet-4-6',
    });
  });

  it('splits #variant off the model id', () => {
    expect(toModelRef('openai/gpt-5#high')).toEqual({
      providerID: 'openai',
      id: 'gpt-5',
      variant: 'high',
    });
  });

  it('keeps slashes in model id and drops an empty variant', () => {
    expect(toModelRef('openai/gpt-4/turbo#')).toEqual({
      providerID: 'openai',
      id: 'gpt-4/turbo',
    });
  });
});

// ─── createSession ────────────────────────────────────────────────────────────

describe('createSession', () => {
  it('returns the session id from the session response', async () => {
    const session = { create: vi.fn().mockResolvedValue({ id: 'ses_abc123' }) } as any;

    const id = await createSession(session, null, 'My Session', 'builder');
    expect(id).toBe('ses_abc123');
  });

  it('passes flattened title and agent to session.create', async () => {
    const session = { create: vi.fn().mockResolvedValue({ id: 'ses_x' }) } as any;

    await createSession(session, null, 'My Title', 'explorer');
    expect(session.create).toHaveBeenCalledWith({ title: 'My Title', agent: 'explorer' });
  });

  it('includes parentID when provided', async () => {
    const session = { create: vi.fn().mockResolvedValue({ id: 'ses_child' }) } as any;

    await createSession(session, 'ses_parent', null, null);
    expect(session.create).toHaveBeenCalledWith({ parentID: 'ses_parent' });
  });

  it('omits undefined optional fields', async () => {
    const session = { create: vi.fn().mockResolvedValue({ id: 'ses_bare' }) } as any;

    await createSession(session);
    expect(session.create.mock.calls[0][0]).toEqual({});
  });

  it('throws when the session response has no id', async () => {
    const session = { create: vi.fn().mockResolvedValue(null) } as any;

    await expect(createSession(session)).rejects.toThrow('createSession failed');
  });
});

// ─── sendMessage ──────────────────────────────────────────────────────────────

describe('sendMessage', () => {
  const makeSession = () =>
    ({
      switchAgent: vi.fn().mockResolvedValue(undefined),
      switchModel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue({ id: 'msg_1' }),
    }) as any;

  it('switches agent and model, then prompts with flattened text', async () => {
    const session = makeSession();

    await sendMessage(session, 'ses_abc', 'hello world', 'anthropic/claude-sonnet-4-6', 'builder');

    expect(session.switchAgent).toHaveBeenCalledWith({ sessionID: 'ses_abc', agent: 'builder' });
    expect(session.switchModel).toHaveBeenCalledWith({
      sessionID: 'ses_abc',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-6' },
    });
    expect(session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_abc', text: 'hello world' });
    expect(session.switchAgent.mock.invocationCallOrder[0]).toBeLessThan(
      session.switchModel.mock.invocationCallOrder[0],
    );
    expect(session.switchModel.mock.invocationCallOrder[0]).toBeLessThan(
      session.prompt.mock.invocationCallOrder[0],
    );
  });

  it('passes the #variant through to switchModel', async () => {
    const session = makeSession();

    await sendMessage(session, 'ses_abc', 'hi', 'openai/gpt-5#high');
    expect(session.switchModel).toHaveBeenCalledWith({
      sessionID: 'ses_abc',
      model: { providerID: 'openai', id: 'gpt-5', variant: 'high' },
    });
  });

  it('does not switch model when model string is empty', async () => {
    const session = makeSession();

    await sendMessage(session, 'ses_abc', 'hi', '');
    expect(session.switchModel).not.toHaveBeenCalled();
    expect(session.prompt).toHaveBeenCalledWith({ sessionID: 'ses_abc', text: 'hi' });
  });

  it('does not switch agent when agent is null', async () => {
    const session = makeSession();

    await sendMessage(session, 'ses_abc', 'hi', 'anthropic/claude-haiku-4-5', null);
    expect(session.switchAgent).not.toHaveBeenCalled();
  });

  it('resolves once the prompt is enqueued, without waiting for the turn', async () => {
    const session = makeSession();
    // wait/idle APIs are not touched; prompt resolving is enough.
    await expect(sendMessage(session, 'ses_abc', 'hi', '')).resolves.toBeUndefined();
  });

  it('propagates prompt errors', async () => {
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error('boom'));

    await expect(sendMessage(session, 'ses_abc', 'hi', '')).rejects.toThrow('boom');
  });
});

// ─── deleteSession ────────────────────────────────────────────────────────────

describe('deleteSession', () => {
  it('calls session.remove with the session id', async () => {
    const session = { remove: vi.fn().mockResolvedValue(undefined) } as any;

    await deleteSession(session, 'ses_xyz');
    expect(session.remove).toHaveBeenCalledWith({ sessionID: 'ses_xyz' });
  });

  it('resolves without throwing when session.remove rejects', async () => {
    const session = { remove: vi.fn().mockRejectedValue(new Error('network error')) } as any;

    await expect(deleteSession(session, 'ses_xyz')).resolves.toBeUndefined();
  });
});

// ─── abortSession ─────────────────────────────────────────────────────────────

describe('abortSession', () => {
  it('calls session.interrupt with the session id', async () => {
    const session = { interrupt: vi.fn().mockResolvedValue({ interrupted: true }) } as any;

    await abortSession(session, 'ses_xyz');
    expect(session.interrupt).toHaveBeenCalledWith({ sessionID: 'ses_xyz' });
  });

  it('resolves true when session.interrupt succeeds', async () => {
    const session = { interrupt: vi.fn().mockResolvedValue({ interrupted: false }) } as any;

    await expect(abortSession(session, 'ses_xyz')).resolves.toBe(true);
  });

  it('resolves false (without throwing) when session.interrupt rejects', async () => {
    const session = { interrupt: vi.fn().mockRejectedValue(new Error('already gone')) } as any;

    await expect(abortSession(session, 'ses_xyz')).resolves.toBe(false);
  });
});

// ─── showToast ────────────────────────────────────────────────────────────────

describe('showToast', () => {
  it('is a logged no-op that resolves', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await expect(showToast('Title', 'Message', 'info', 3000)).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Title: Message'));
    info.mockRestore();
  });
});
