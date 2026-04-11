import type { Plugin } from "@opencode-ai/plugin";
import { spawn, type ChildProcess } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HARNESS_URL = process.env.HARNESS_URL ?? "http://localhost:7837";

async function isHarnessRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`${HARNESS_URL}/tasks`, {
      signal: AbortSignal.timeout(1000),
    });
    return resp.status < 500;
  } catch {
    return false;
  }
}

async function waitForHarness(maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isHarnessRunning()) return true;
  }
  return false;
}

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
  const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  let child: ChildProcess | undefined;

  if (!(await isHarnessRunning())) {
    console.log("[harness-plugin] harness not running, spawning...");
    child = spawn("cargo", ["run"], {
      cwd: harnessRoot,
      stdio: "inherit",
    });

    child.on("error", (err) => {
      console.error("[harness-plugin] failed to spawn harness:", err.message);
    });

    const ready = await waitForHarness();
    if (ready) {
      console.log("[harness-plugin] harness ready");
    } else {
      console.error("[harness-plugin] harness did not become ready in 30s");
    }

    const cleanup = () => {
      if (child && !child.killed) {
        child.kill();
      }
    };
    process.on("exit", cleanup);
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
  } else {
    console.log(`[harness-plugin] harness already running at ${HARNESS_URL}`);
  }

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
