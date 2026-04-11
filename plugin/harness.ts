import type { Plugin } from "@opencode-ai/plugin";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:7837";

async function emit(type: string, session_id: string, payload: unknown) {
  await fetch(`${HARNESS_URL}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, session_id, payload }),
  }).catch((err) => {
    console.error(`[harness-plugin] emit ${type} failed:`, err.message);
  });
}

export default (async () => {
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await emit(
          "session.idle",
          event.properties.sessionID,
          event.properties,
        );
      } else if (event.type === "session.error") {
        await emit(
          "session.error",
          event.properties.sessionID ?? "",
          event.properties,
        );
      }
    },

    "tool.execute.before": async (input, output) => {
      await emit("tool.execute.before", input.sessionID, {
        tool: input.tool,
        callID: input.callID,
        args: output.args,
      });
    },

    "tool.execute.after": async (input, output) => {
      await emit("tool.execute.after", input.sessionID, {
        tool: input.tool,
        callID: input.callID,
        args: input.args,
        result: output.output,
      });
    },
  };
}) satisfies Plugin;
