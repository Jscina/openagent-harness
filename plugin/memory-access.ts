// ─── Memory tool access control ───────────────────────────────────────────────
//
// Single source of truth for which agents may call which memory_* tool.
// builder-junior is intentionally absent everywhere: it receives memory
// context through the dispatch preamble instead of calling tools.

export const MEMORY_TOOL_ACCESS: Readonly<Record<string, readonly string[]>> = {
  memory_context: [
    "orchestrator",
    "planner",
    "builder",
    "debugger",
    "consultant",
    "explorer",
    "researcher",
    "reviewer",
    "docs-writer",
    "vision",
  ],
  memory_card: ["orchestrator", "debugger"],
  memory_trace: ["orchestrator", "builder", "debugger", "consultant"],
  memory_promote: ["orchestrator", "debugger", "consultant"],
};

/** Throw `<tool> is not permitted for agent <x>` unless `agent` may call `tool`. */
export function assertMemoryAccess(tool: string, agent: string | undefined): void {
  const allowed = MEMORY_TOOL_ACCESS[tool];
  if (!agent || !allowed?.includes(agent)) {
    throw new Error(`${tool} is not permitted for agent ${agent ?? "(unknown)"}`);
  }
}

/** Exact no-card acknowledgement call, spelled out in gate errors for one-step recovery. */
export const NO_CARD_MEMORY_CONTEXT_CALL = "memory_context({})";

/** Error text for a tool that requires a prior memory_context call in this session. */
export function memoryAckRequiredMessage(tool: string): string {
  return (
    `${tool} requires memory_context to be called first in this session. ` +
    `If the user supplied a ticket/card id, call memory_context({ cardId: "<id>" }); ` +
    `otherwise call ${NO_CARD_MEMORY_CONTEXT_CALL} (no card — system knowledge only), then retry ${tool}.`
  );
}
