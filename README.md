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

### Primary agents

| Agent | Model | Role |
|-------|-------|------|
| `orchestrator` | `anthropic/claude-haiku-4-5` | Human-facing entry point. Classifies requests (ambiguous, direct question, codebase query, or coding task), drives the planner pipeline for complex tasks, answers simple questions directly. Workflow completion arrives as a toast — no polling needed. |
| `builder` | `openai/gpt-5.4` | Senior engineer. Owns execution quality for a subtask end-to-end. Spawns `@explorer`, `@researcher`, and `@vision` in parallel to gather context. Breaks the subtask into atomic units. Spawns `@builder-junior` workers in parallel for each unit. Reviews their output, escalates to `@consultant` for design decisions and `@debugger` for failures. Delivers a completed result. |
| `planner` | `anthropic/claude-opus-4-6` | Receives a raw task, gathers context from `@explorer` and `@researcher` in parallel, then produces a machine-readable DAG of subtasks. Output is JSON only — no preamble, no explanation. |

### Subagents

| Agent | Model | Role |
|-------|-------|------|
| `explorer` | `google/gemini-2.5-flash` | Read-only codebase reconnaissance. Maps files, traces call chains, identifies interfaces and patterns. Never modifies anything. |
| `researcher` | `google/gemini-2.5-flash` | External knowledge retrieval. Searches web, fetches library docs, reads GitHub examples. No local file access. |
| `vision` | `google/gemini-2.5-flash-image` | Analyzes visual assets — screenshots, wireframes, UI mockups, PDFs — and returns a structured description. Never writes code. |
| `builder-junior` | `openai/gpt-5.3-codex` | Executes one narrowly scoped coding task given an exact spec by builder. Executes the spec exactly, does not explore or plan. Reports every file modified and expected outcome. |
| `consultant` | `google/gemini-3.1-pro-preview` | Architecture advisor. Consulted by builder mid-task for design decisions with real tradeoffs. Returns a structured recommendation with rationale, tradeoffs, and risks. Read-only. |
| `reviewer` | `anthropic/claude-sonnet-4-6` | Quality gate. Reviews planner output before execution and builder output after. Returns approved or a list of blocking issues. Read-only. |
| `debugger` | `anthropic/claude-sonnet-4-6` | Failure investigation specialist. Diagnoses test failures and runtime errors. Returns root cause and a fix approach. Never makes code changes. |
| `docs-writer` | `google/gemini-2.5-flash` | Documentation only. Writes READMEs, inline doc comments, API docs, and changelogs based on builder's completed diff. Never touches code files. |

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
