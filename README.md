# openagent-harness

Deterministic agent harness for [OpenCode](https://opencode.ai). The DAG state machine compiles to WebAssembly (WASM) and runs directly inside the OpenCode TypeScript plugin. No separate native binary or HTTP server is required at runtime!

## How it works

```
OpenCode process
  └─ loads plugin/harness.ts
       └─ initSync(readFileSync("...wasm"))  → DagEngine (in-process)
       └─ get_agent_configs()               → install .md files on first boot
       └─ setInterval 500ms
            └─ dag.tick()          → ready tasks
            └─ POST /session        → create OpenCode session
            └─ POST /session/{id}/prompt_async
            └─ dag.task_started()
       └─ event hook (session.idle / session.error)
            └─ dag.process_event()  → notifications + session to delete
            └─ DELETE /session/{id}
            └─ POST /tui/show-toast (on workflow completion/failure)
```

1. The `orchestrator` agent receives a user request.
2. It spawns the `@planner` (for coding tasks).
3. The planner uses the `submit_workflow` tool with its JSON output.
4. The WASM `DagEngine` creates all tasks atomically in its in-memory DAG.
5. The 500ms tick loop automatically kicks off pending tasks when their dependencies finish.
6. The TS plugin listens for `session.idle` and `session.error` events and feeds them to the DAG to advance the workflow state.

## Quickstart

### Building the WASM plugin

You need [wasm-pack](https://rustwasm.github.io/wasm-pack/) installed.

```sh
cargo install wasm-pack
make wasm
```

This compiles the Rust DAG to `plugin/wasm/` and generates the JS/TS glue.

### Using the plugin

Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["/path/to/openagent-harness/plugin/harness.ts"]
}
```

The very first time the plugin loads, it automatically calls the WASM library to write 11 embedded agent `.md` files to `~/.config/opencode/agents/`.

## Install subcommand (Optional)

If you don't want to use the WASM auto-installer, you can build and use the native CLI to install the agent configs:

```sh
cargo run -- install           # skip agents that already exist
cargo run -- install --force   # overwrite existing agents
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

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_SERVER_PASSWORD` | — | Basic auth password for OpenCode ACP |

## Development

```sh
make wasm        # rebuild the WASM plugin module
cargo test       # 24 tests, no live services needed
cargo clippy
```
