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
