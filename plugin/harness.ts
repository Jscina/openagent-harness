/**
 * harness.ts — OpenCode server plugin (WASM edition)
 *
 * The Rust DAG state machine is compiled to WASM and loaded directly into
 * this process.  No separate binary is spawned; no HTTP server is started.
 *
 * Data flow:
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  OpenCode                                                           │
 *   │    └─ loads plugin/harness.ts                                       │
 *   │         └─ initSync(readFileSync("...wasm"))  → DagEngine in-proc  │
 *   │         └─ get_agent_configs() → write .md files on first boot     │
 *   │         └─ setInterval 500ms → dag.tick() → session + prompt       │
 *   │         └─ session.idle / session.error → dag.process_event()      │
 *   └─────────────────────────────────────────────────────────────────────┘
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import {
  DagEngine,
  get_agent_configs,
  initSync,
} from "./wasm/openagent_harness.js";

// ─── WASM initialisation ──────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * Load and initialise the WASM module synchronously so the plugin is ready
 * before the first hook fires.
 */
function loadWasm(): DagEngine {
  const wasmPath = join(__dir, "wasm", "openagent_harness_bg.wasm");
  const wasmBytes = readFileSync(wasmPath);
  initSync({ module: wasmBytes });
  return new DagEngine();
}

// ─── Agent config installation ────────────────────────────────────────────────

/**
 * Write all embedded agent configs to `~/.config/opencode/agents/` the first
 * time the plugin loads.  Skips existing files so user edits are preserved.
 *
 * This replaces the need to run `openagent-harness install` manually — the
 * configs are embedded in the WASM binary and installed automatically.
 */
function installAgentsIfNeeded(): void {
  try {
    const agentsDir = join(homedir(), ".config", "opencode", "agents");
    mkdirSync(agentsDir, { recursive: true });

    const configs: Record<string, string> = JSON.parse(get_agent_configs());
    let installed = 0;
    for (const [name, content] of Object.entries(configs)) {
      const dest = join(agentsDir, `${name}.md`);
      if (!existsSync(dest)) {
        writeFileSync(dest, content, "utf8");
        installed++;
      }
    }
    if (installed > 0) {
      console.log(
        `[harness-plugin] installed ${installed} agent config(s) to ${agentsDir}`,
      );
    }
  } catch (e) {
    console.error("[harness-plugin] agent install failed (non-fatal):", e);
  }
}

// ─── OpenCode ACP helpers ─────────────────────────────────────────────────────

/**
 * Parse "provider/model" → `{ providerID, modelID }` for prompt_async.
 * No slash → defaults to `anthropic`.  Empty string → no model sent.
 */
function parseModel(
  model: string,
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash >= 0
    ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
    : { providerID: "anthropic", modelID: model };
}

/** Common request headers; injects Basic-auth when the env var is set. */
function makeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const pw = process.env.OPENCODE_SERVER_PASSWORD;
  if (pw) {
    headers["Authorization"] =
      "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
  }
  return headers;
}

async function createSession(baseUrl: string): Promise<string> {
  const resp = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: makeHeaders(),
    body: "{}",
  });
  if (!resp.ok) throw new Error(`createSession failed: ${resp.status}`);
  const data = (await resp.json()) as { id: string };
  return data.id;
}

async function sendMessage(
  baseUrl: string,
  sessionId: string,
  prompt: string,
  model: string,
  agent?: string | null,
): Promise<void> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: prompt }],
  };
  const modelSpec = parseModel(model);
  if (modelSpec) body["model"] = modelSpec;
  if (agent) body["agent"] = agent;
  await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify(body),
  });
}

async function deleteSession(baseUrl: string, sessionId: string): Promise<void> {
  await fetch(`${baseUrl}/session/${sessionId}`, {
    method: "DELETE",
    headers: makeHeaders(),
  }).catch((e: unknown) => {
    console.error("[harness-plugin] deleteSession failed:", e);
  });
}

async function showToast(
  baseUrl: string,
  title: string,
  message: string,
  variant: string,
  duration?: number,
): Promise<void> {
  await fetch(`${baseUrl}/tui/show-toast`, {
    method: "POST",
    headers: makeHeaders(),
    body: JSON.stringify({ title, message, variant, duration: duration ?? 8000 }),
  }).catch((e: unknown) => {
    console.error("[harness-plugin] showToast failed:", e);
  });
}

// ─── Notification handling ────────────────────────────────────────────────────

interface ToastNotification {
  type: "toast";
  title: string;
  message: string;
  variant: string;
  duration?: number;
}
type Notification = ToastNotification;

interface EventResult {
  notifications: Notification[];
  delete_session: string | null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function listHarnessWorkflows(dag: DagEngine): unknown {
  return parseJson(dag.list_workflow_summaries());
}

function getHarnessWorkflowSnapshot(dag: DagEngine, workflowId: string): unknown {
  return parseJson(dag.get_workflow_snapshot(workflowId));
}

function extractWorkflowStatus(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const obj = snapshot as {
    status?: unknown;
    state?: unknown;
    workflow?: { status?: unknown; state?: unknown };
  };

  const status =
    obj.status ?? obj.state ?? obj.workflow?.status ?? obj.workflow?.state;
  if (typeof status === "string") {
    return status.toLowerCase();
  }
  if (status && typeof status === "object") {
    const tagged = status as { type?: unknown };
    return typeof tagged.type === "string" ? tagged.type.toLowerCase() : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleEventResult(
  result: EventResult,
  baseUrl: string,
): Promise<void> {
  for (const n of result.notifications) {
    if (n.type === "toast") {
      await showToast(baseUrl, n.title, n.message, n.variant, n.duration);
    }
  }
  if (result.delete_session) {
    await deleteSession(baseUrl, result.delete_session);
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default (async (input: PluginInput) => {
  const baseUrl = input.serverUrl.toString().replace(/\/$/, "");

  // Load WASM DAG engine.
  const dag = loadWasm();
  console.log("[harness-plugin] WASM DAG engine loaded");

  // Install agent configs the first time this plugin runs.
  installAgentsIfNeeded();

  // ── Tick loop ──────────────────────────────────────────────────────────────
  // Every 500 ms, find unblocked tasks and start them in OpenCode sessions.

  let ticking = false;

  const tickInterval = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      const readyTasks = JSON.parse(dag.tick()) as Array<{
        id: string;
        prompt: string;
        model: string;
        agent: string | null;
      }>;

      for (const task of readyTasks) {
        let sessionId: string | null = null;
        try {
          sessionId = await createSession(baseUrl);
          dag.task_started(task.id, sessionId);
          await sendMessage(baseUrl, sessionId, task.prompt, task.model, task.agent);
          console.log(`[harness-plugin] task ${task.id} → session ${sessionId}`);
        } catch (e) {
          console.error(`[harness-plugin] failed to start task ${task.id}:`, e);
          const message = e instanceof Error ? e.message : String(e);
          // Mark the task failed so visibility reflects the startup error.
          try {
            const { session_id } = JSON.parse(dag.fail_task(task.id, message)) as {
              session_id: string | null;
            };
            if (session_id) await deleteSession(baseUrl, session_id);
          } catch {
            // already terminal — ignore
          }
        }
      }
    } finally {
      ticking = false;
    }
  }, 500);

  // Cleanup on process exit.
  const cleanup = () => {
    clearInterval(tickInterval);
    dag.free();
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT",  () => { cleanup(); process.exit(0); });

  // ── Hooks ──────────────────────────────────────────────────────────────────

  return {
    tool: {
      submit_workflow: tool({
        description:
          "Submit a workflow plan to the harness DAG for execution. Input is the tasks array from planner output. Returns a workflow_id for tracking.",
        args: {
          tasks: tool.schema.array(
            tool.schema.object({
              agent: tool.schema.string(),
              prompt: tool.schema.string(),
              depends_on: tool.schema.array(tool.schema.number()),
              model: tool.schema.string().optional(),
            }),
          ),
        },
        async execute({ tasks }) {
          return dag.submit_workflow(JSON.stringify(tasks));
        },
      }),

      harness_state: tool({
        description:
          "Read-only harness visibility. Without workflow_id lists workflows; with workflow_id returns workflow snapshot.",
        args: {
          workflow_id: tool.schema.string().optional(),
        },
        async execute({ workflow_id }) {
          const payload = workflow_id
            ? { workflow_id, snapshot: getHarnessWorkflowSnapshot(dag, workflow_id) }
            : { workflows: listHarnessWorkflows(dag) };
          return JSON.stringify(payload);
        },
      }),

      wait_for_workflow: tool({
        description:
          "Poll a workflow internally until terminal state (done/failed) or timeout.",
        args: {
          workflow_id: tool.schema.string(),
          timeout_ms: tool.schema.number().optional(),
          interval_ms: tool.schema.number().optional(),
        },
        async execute({ workflow_id, timeout_ms, interval_ms }) {
          const timeoutMs = Math.max(1, timeout_ms ?? 60_000);
          const intervalMs = Math.max(50, interval_ms ?? 1_000);
          const startedAt = Date.now();

          let snapshot: unknown = null;
          let status: string | null = null;

          while (Date.now() - startedAt < timeoutMs) {
            snapshot = getHarnessWorkflowSnapshot(dag, workflow_id);
            if (snapshot === null) {
              return JSON.stringify({
                workflow_id,
                terminal: false,
                timed_out: false,
                missing: true,
                elapsed_ms: Date.now() - startedAt,
              });
            }
            status = extractWorkflowStatus(snapshot);

            if (status === "done" || status === "failed") {
              return JSON.stringify({
                workflow_id,
                terminal: true,
                status,
                elapsed_ms: Date.now() - startedAt,
                snapshot,
              });
            }

            await sleep(intervalMs);
          }

          return JSON.stringify({
            workflow_id,
            terminal: false,
            timed_out: true,
            status,
            elapsed_ms: Date.now() - startedAt,
            snapshot,
          });
        },
      }),
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        const sessionId: string = event.properties.sessionID;
        const result: EventResult = JSON.parse(
          dag.process_event("session.idle", sessionId, JSON.stringify(event.properties)),
        );
        await handleEventResult(result, baseUrl);
      } else if (event.type === "session.error") {
        const sessionId: string = event.properties.sessionID ?? "";
        if (!sessionId) return;
        const result: EventResult = JSON.parse(
          dag.process_event("session.error", sessionId, JSON.stringify(event.properties)),
        );
        await handleEventResult(result, baseUrl);
      }
    },

    "tool.execute.before": async (_input) => {
      // No state change on before-hook; reserved for future use.
    },

    "tool.execute.after": async (input, output) => {
      dag.process_event(
        "tool.execute.after",
        input.sessionID,
        JSON.stringify({
          tool: input.tool,
          callID: input.callID,
          args: input.args,
          result: output.output,
        }),
      );
    },
  };
}) satisfies Plugin;
