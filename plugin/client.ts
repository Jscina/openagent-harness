// ─── OpenCode v2 session adapter ──────────────────────────────────────────────
//
// Thin wrappers over the v2 plugin `ctx.session` domain. See V2_API_NOTES.md.

import type { Plugin } from "@opencode/plugin";

/** The subset of `ctx.session` (v2 SessionDomain) this plugin uses. */
export type SessionClient = Pick<
  Plugin.Context["session"],
  "create" | "prompt" | "remove" | "interrupt" | "switchAgent" | "switchModel"
>;

/** v2 model reference as accepted by `session.create` / `session.switchModel`. */
export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/**
 * Parse "provider/model" → `{ providerID, modelID }`.
 * No slash → defaults to `anthropic`.  Empty string → no model sent.
 * Does not interpret `#variant`; see {@link toModelRef}.
 */
export function parseModel(
  model: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash >= 0
    ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    : { providerID: "anthropic", modelID: model };
}

/**
 * Convert a "provider/model[#variant]" string to the v2 `{ providerID, id, variant? }`
 * shape. The variant is the text after the first `#` following the provider slash.
 */
export function toModelRef(model: string): ModelRef | undefined {
  const parsed = parseModel(model);
  if (!parsed) return undefined;
  const hash = parsed.modelID.indexOf("#");
  if (hash < 0) return { providerID: parsed.providerID, id: parsed.modelID };
  const id = parsed.modelID.slice(0, hash);
  const variant = parsed.modelID.slice(hash + 1);
  return {
    providerID: parsed.providerID,
    id,
    ...(variant && { variant }),
  };
}

export async function createSession(
  session: SessionClient,
  parentSessionId?: string | null,
  title?: string | null,
  agent?: string | null,
): Promise<string> {
  const result = await session.create({
    ...(parentSessionId && { parentID: parentSessionId }),
    ...(title && { title }),
    ...(agent && { agent }),
  });
  if (!result?.id) throw new Error("createSession failed: no id returned");
  return result.id;
}

/**
 * Send a prompt without waiting for the turn to finish.
 * v2 `session.prompt` only enqueues the message (`POST /api/session/{id}/prompt`);
 * it has no per-prompt model/agent, so those are applied to the session first.
 */
export async function sendMessage(
  session: SessionClient,
  sessionId: string,
  prompt: string,
  model: string,
  agent?: string | null,
): Promise<void> {
  const modelRef = toModelRef(model);
  if (agent) await session.switchAgent({ sessionID: sessionId, agent });
  if (modelRef) await session.switchModel({ sessionID: sessionId, model: modelRef });
  await session.prompt({ sessionID: sessionId, text: prompt });
}

export async function deleteSession(
  session: SessionClient,
  sessionId: string,
): Promise<void> {
  await session.remove({ sessionID: sessionId }).catch((e: unknown) => {
    console.error("[harness-plugin] deleteSession failed:", e);
  });
}

/**
 * Interrupt a running session via v2 `session.interrupt`
 * (`POST /api/session/{id}/interrupt`).
 * Never throws: callers use this as a best-effort signal to stop an
 * in-flight agent turn before the session is deleted, and are not expected to
 * wrap the call in their own try/catch. Failures are logged here and
 * reflected in the returned boolean instead of being swallowed silently, so
 * callers that need an accurate success count (e.g. `harness_cancel`'s
 * "Sessions aborted: X/Y" summary) can compute it from the return value.
 * Safe to call on a session that already finished.
 *
 * @returns `true` if the request succeeded, `false` if it failed.
 */
export async function abortSession(
  session: SessionClient,
  sessionId: string,
): Promise<boolean> {
  try {
    await session.interrupt({ sessionID: sessionId });
    return true;
  } catch (e) {
    console.error("[harness-plugin] abortSession failed:", e);
    return false;
  }
}

/**
 * No-op: the v2 server plugin context has no toast/TUI API (toasts exist only
 * in the separate `@opencode/plugin/tui` entry). Logs the message instead.
 */
export async function showToast(
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  _duration?: number,
): Promise<void> {
  console.info(`[harness-plugin] toast (${variant}): ${title}: ${message}`);
}
