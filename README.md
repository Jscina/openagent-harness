# openagent-harness

Deterministic agent harness for [OpenCode](https://opencode.ai). Control flow lives in Rust. OpenCode is a worker. The LLM never decides what runs next.

## How it works

```
OpenCode loads plugin  →  plugin checks harness health
                       →  if not running: spawns binary, waits for ready

orchestrator receives user request
  → spawns @planner (for coding tasks)
  → calls submit_workflow tool with planner's JSON output
  → harness creates all tasks atomically with UUID dependency graph
  → polls get_workflow_status until terminal
  → reports completion or failure

tick loop (500ms)
  → starts pending tasks whose deps are Done
  → sends prompt + agent to OpenCode session via ACP

plugin fires tool.execute.after  →  appends result to task.output
plugin fires session.idle        →  marks task Done, deletes ACP session
                                 →  updates workflow status if all tasks terminal
                                 →  starts next eligible task
```

## Quickstart

```sh
# 1. Build and install
cargo build --release
cp target/release/openagent-harness ~/.local/bin/

# 2. Install the bundled agent team
openagent-harness install

# 3. Install plugin deps
cd plugin && bun install && cd ..

# 4. Register the plugin in opencode.json:
#    { "plugins": ["./plugin/harness.ts"] }

# 5. Start OpenCode — plugin auto-starts the harness
opencode
```

## Agent team

| Agent | Mode | Model | Role |
|-------|------|-------|------|
| `orchestrator` | **primary** | `anthropic/claude-haiku-4-5` | Human-facing entry point — classifies requests, drives pipeline |
| `builder` | **primary** | `openai/gpt-5.2-codex` | Direct coding tasks, skip planning |
| `planner` | subagent | `anthropic/claude-opus-4-6` | Decomposes tasks into DAG JSON |
| `explorer` | subagent | `ollama/qwen3-coder` | Read-only codebase reconnaissance |
| `researcher` | subagent | `google/gemini-2.5-flash` | External docs and examples |
| `vision` | subagent | `google/gemini-2.5-flash` | Visual asset analysis |
| `builder-junior` | subagent | `ollama/qwen3-coder` | Narrow-scope coding worker |
| `consultant` | subagent | `openai/gpt-5.4` | Architecture advisor |
| `reviewer` | subagent | `anthropic/claude-opus-4-6` | Quality gate for plans and diffs |
| `debugger` | subagent | `google/gemini-2.5-flash` | Failure diagnosis |
| `docs-writer` | subagent | `openai/gpt-5-nano` | Documentation updates |

## Install subcommand

```sh
openagent-harness install           # skip agents that already exist
openagent-harness install --force   # overwrite existing agents
```

Writes 11 agent definitions to `~/.config/opencode/agents/`. Embedded in the binary — no separate asset directory.

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/workflows` | Submit planner output, create all tasks atomically |
| `GET` | `/workflows/{id}` | Get workflow status + task list |
| `POST` | `/tasks` | Create individual task |
| `GET` | `/tasks` | List all tasks |
| `GET` | `/tasks/{id}` | Get task by ID |
| `DELETE` | `/tasks/{id}` | Cancel task |
| `POST` | `/events` | Plugin event receiver (internal) |

**Submit workflow:**
```json
{
  "tasks": [
    { "agent": "explorer", "prompt": "map the auth module", "depends_on": [] },
    { "agent": "builder", "prompt": "implement OAuth routes", "depends_on": [0] }
  ]
}
```

`depends_on` uses zero-based indices into the `tasks` array. All agents are validated against OpenCode before the workflow is accepted. Returns 400 if an agent is not found; 500 for other errors.

**Workflow response:**
```json
{ "workflow_id": "uuid", "task_ids": ["uuid-0", "uuid-1"] }
```

**Workflow status:**
```json
{ "id": "uuid", "status": { "type": "running" }, "tasks": ["..."], ... }
{ "id": "uuid", "status": { "type": "done" }, "tasks": ["..."], ... }
{ "id": "uuid", "status": { "type": "failed", "task_id": "uuid", "reason": "..." }, ... }
```

**Plugin tools** (available inside OpenCode sessions):
- `submit_workflow(tasks)` — submit planner's tasks array, returns `{workflow_id, task_ids}`
- `get_workflow_status(workflow_id)` — poll current workflow state

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_PORT` | `4096` | OpenCode ACP port |
| `OPENCODE_SERVER_PASSWORD` | — | Basic auth password for OpenCode |
| `HARNESS_PORT` | `7837` | Harness HTTP port |
| `HARNESS_URL` | `http://localhost:7837` | URL the plugin posts events to |
| `HARNESS_BIN` | `openagent-harness` | Harness binary path (used by plugin) |
| `RUST_LOG` | `openagent_harness=info` | Log filter |

## Development

```sh
cargo build
cargo test       # 54 tests, no live services needed
cargo fmt
cargo clippy
```
