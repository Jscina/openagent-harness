# openagent-harness

Deterministic agent harness for [OpenCode](https://opencode.ai). Control flow lives in Rust. OpenCode is a worker. The LLM never decides what runs next.

## How it works

```
OpenCode loads plugin  →  plugin checks harness health
                       →  if not running: spawns `openagent-harness` (or `$HARNESS_BIN`), waits for ready
                       →  if already running: attaches

POST /tasks  →  validates agent exists (GET /agent)
             →  Rust schedules task  →  creates OpenCode session via ACP
                                     →  sends prompt + agent to session
                                     →  spawns tmux pane

plugin fires tool.execute.after  →  Rust appends result to task.output
plugin fires session.idle        →  Rust snapshots accumulated output
                                 →  marks task Done
                                 →  deletes ACP session
                                 →  starts next eligible task
```

## Quickstart

```sh
# 1. Build the harness and put it on your PATH
cargo build --release
cp target/release/openagent-harness ~/.local/bin/

# 2. Install the bundled agent team into OpenCode
openagent-harness install

# 3. Install plugin deps
cd plugin && bun install && cd ..

# 4. Register the plugin in your OpenCode config (opencode.json):
#    { "plugins": ["./plugin/harness.ts"] }

# 5. Start OpenCode — the plugin auto-starts the harness on :7837
opencode
```

## Install subcommand

```sh
openagent-harness install           # skip agents that already exist
openagent-harness install --force   # overwrite existing agents
```

Writes 10 agent definitions to `~/.config/opencode/agent/`. Agent markdown files are embedded in the binary at compile time — no separate asset directory needed.

## Agent team

| Agent | Tier | Model | Role |
|-------|------|-------|------|
| `planner` | 1 | `anthropic/claude-opus-4-6` | Task decomposition → structured DAG JSON |
| `explorer` | 2 | `ollama/qwen3-coder` | Read-only codebase reconnaissance |
| `researcher` | 2 | `google/gemini-2.5-flash` | External docs and examples retrieval |
| `vision` | 2 | `google/gemini-2.5-flash` | Visual asset analysis (screenshots, mockups) |
| `builder` | 2 | `openai/gpt-5.2-codex` | Senior engineer — owns subtask execution quality |
| `builder-junior` | 2 | `ollama/qwen3-coder` | Narrow-scope coding worker spawned by builder |
| `consultant` | 2 | `openai/gpt-5.4` | Architecture advisor consulted mid-task by builder |
| `reviewer` | 3 | `anthropic/claude-opus-4-6` | Quality gate — approves plans and diffs |
| `debugger` | 3 | `google/gemini-2.5-flash` | Failure diagnosis for builder |
| `docs-writer` | 3 | `openai/gpt-5-nano` | Documentation updates after builder completes |

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/tasks` | Create a task |
| `GET` | `/tasks` | List all tasks |
| `GET` | `/tasks/{id}` | Get task by ID |
| `DELETE` | `/tasks/{id}` | Cancel a task |
| `POST` | `/events` | Plugin event receiver (internal) |

**Create task:**
```json
{
  "prompt": "map the auth module",
  "agent": "explorer",
  "model": "ollama/qwen3-coder",
  "depends_on": []
}
```

`agent`, `model`, and `depends_on` are all optional. If `agent` is provided, harness validates it exists in OpenCode before accepting the task (returns `400` if not found). If omitted, OpenCode uses its default agent.

**Task response:**
```json
{
  "id": "uuid",
  "prompt": "...",
  "model": "...",
  "agent": "explorer",
  "status": { "type": "done" },
  "output": "accumulated tool output from the session",
  "created_at": "...",
  "updated_at": "..."
}
```

**Status shapes:**
```json
{ "type": "pending" | "running" | "done" }
{ "type": "failed", "message": "reason" }
```

**Error on bad agent — 400:**
```json
error: agent 'nonexistent' not found
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_PORT` | `4096` | OpenCode ACP port |
| `OPENCODE_SERVER_PASSWORD` | — | Basic auth password for OpenCode |
| `HARNESS_PORT` | `7837` | Harness HTTP port |
| `HARNESS_URL` | `http://localhost:7837` | URL the plugin posts events to |
| `HARNESS_BIN` | `openagent-harness` | Path to harness binary (plugin uses this) |
| `RUST_LOG` | `openagent_harness=info` | Log filter |

## Development

```sh
cargo build
cargo test       # 38 tests, no live services needed
cargo fmt
cargo clippy
```
