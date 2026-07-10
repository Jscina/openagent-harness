// ─── OpenCode ACP helpers ─────────────────────────────────────────────────────

import type { PluginInput } from "@opencode-ai/plugin";

/**
 * Parse "provider/model" → `{ providerID, modelID }` for prompt_async.
 * No slash → defaults to `anthropic`.  Empty string → no model sent.
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

export async function createSession(
  client: PluginInput["client"],
  parentSessionId?: string | null,
  title?: string | null,
  agent?: string | null,
): Promise<string> {
  const result = await client.session.create({
    body: {
      ...(parentSessionId && { parentID: parentSessionId }),
      ...(title && { title }),
      ...(agent && { agent }),
    },
  });
  if (!result.data) throw new Error("createSession failed: no data returned");
  return result.data.id;
}

export async function sendMessage(
  client: PluginInput["client"],
  sessionId: string,
  prompt: string,
  model: string,
  agent?: string | null,
): Promise<void> {
  const modelSpec = parseModel(model);
  await client.session.promptAsync({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text: prompt }],
      ...(modelSpec && { model: modelSpec }),
      ...(agent && { agent }),
    },
  });
}

export async function deleteSession(
  client: PluginInput["client"],
  sessionId: string,
): Promise<void> {
  await client.session.delete({ path: { id: sessionId } }).catch((e: unknown) => {
    console.error("[harness-plugin] deleteSession failed:", e);
  });
}

/**
 * Abort a running session via the SDK's `POST /session/{id}/abort` endpoint.
 * Never throws: callers use this as a best-effort signal to stop an
 * in-flight agent turn before the session is deleted, and are not expected to
 * wrap the call in their own try/catch. Failures are logged here and
 * reflected in the returned boolean instead of being swallowed silently, so
 * callers that need an accurate success count (e.g. `harness_cancel`'s
 * "Sessions aborted: X/Y" summary) can compute it from the return value.
 * Safe to call on a session that already finished.
 *
 * @returns `true` if the abort request succeeded, `false` if it failed.
 */
export async function abortSession(
  client: PluginInput["client"],
  sessionId: string,
): Promise<boolean> {
  try {
    await client.session.abort({ path: { id: sessionId } });
    return true;
  } catch (e) {
    console.error("[harness-plugin] abortSession failed:", e);
    return false;
  }
}

/**
 * Post a toast notification to the OpenCode TUI via the SDK client.
 * Non-fatal: errors are logged as warnings and silently dropped.
 */
export async function showToast(
  client: PluginInput["client"],
  title: string,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  duration?: number,
): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration: duration ?? 8000 },
    });
  } catch (e) {
    console.warn("[harness-plugin] showToast failed:", (e as Error)?.message ?? e);
  }
}
