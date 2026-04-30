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
3. The planner may ask clarifying questions, then saves the generated plan under `.opencode/plans` and returns a plan object to the orchestrator.
4. The orchestrator presents the plan to the user and asks for approval via the `question` tool.
5. If approved, the orchestrator submits the plan via `submit_plan` using the returned `plan_id`, then immediately calls `wait_for_workflow`.
6. The WASM `DagEngine` creates all tasks atomically in its in-memory DAG.
7. The 500ms tick loop automatically kicks off pending tasks when their dependencies finish.
8. The TS plugin listens for `session.idle` and `session.error` events and feeds them to the DAG to advance the workflow state.
9. When the workflow completes (or fails), `wait_for_workflow` returns and the orchestrator reports results to the user.

## Quickstart

### Install a tagged release

Install a pinned release tag (not `latest`) with the installer script:

```sh
curl -fsSL https://raw.githubusercontent.com/Jscina/openagent-harness/v0.3.2/install.sh | OPENAGENT_HARNESS_TAG=v0.3.2 bash
```

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
| `orchestrator` | `anthropic/claude-sonnet-4-6` | Human-facing entry point. Classifies requests, drives the planner pipeline for complex tasks, presents plans for user approval, waits for workflow completion, and reports results. |
| `builder` | `openai/gpt-5.4` | Senior engineer. Owns execution quality for a subtask end-to-end. Spawns `@explorer`, `@researcher`, and `@vision` in parallel to gather context. Breaks the subtask into atomic units. Spawns `@builder-junior` workers in parallel for each unit. Reviews their output, escalates to `@consultant` for design decisions and `@debugger` for failures. Delivers a completed result. |

### Subagents

| Agent | Model | Role |
|-------|-------|------|
| `planner` | `openai/gpt-5.4` | Planning subagent spawned by `@orchestrator`. Gathers context from `@explorer` and `@researcher`, asks clarifying questions when needed, saves a generated plan under `.opencode/plans`, and returns a structured plan summary object for approval. |
| `explorer` | `openai/gpt-5.3-codex` | Read-only codebase reconnaissance. Maps files, traces call chains, identifies interfaces and patterns. Never modifies anything. |
| `researcher` | `anthropic/claude-sonnet-4-6` | External knowledge retrieval. Searches web, fetches library docs, reads GitHub examples. No local file access. |
| `vision` | `anthropic/claude-sonnet-4-6` | Analyzes visual assets — screenshots, wireframes, UI mockups, PDFs — and returns a structured description. Never writes code. |
| `builder-junior` | `openai/gpt-5.3-codex` | Executes one narrowly scoped coding task given an exact spec by builder. Executes the spec exactly, does not explore or plan. Reports every file modified and expected outcome. |
| `consultant` | `anthropic/claude-sonnet-4-6` | Architecture advisor. Consulted by builder mid-task for design decisions with real tradeoffs. Returns a structured recommendation with rationale, tradeoffs, and risks. Read-only. |
| `reviewer` | `anthropic/claude-sonnet-4-6` | Quality gate. Reviews planner output before execution and builder output after. Returns approved or a list of blocking issues. Read-only. |
| `debugger` | `anthropic/claude-sonnet-4-6` | Failure investigation specialist. Diagnoses test failures and runtime errors. Returns root cause and a fix approach. Never makes code changes. |
| `docs-writer` | `openai/gpt-5.4` | Documentation only. Writes READMEs, inline doc comments, API docs, and changelogs based on builder's completed diff. Never touches code files. |

## Fallback model chains

Each agent can declare an ordered list of fallback models in its `.md` frontmatter. When a task fails with a transient provider error (429, 5xx, timeout, etc.) the harness automatically re-queues it with the next model in the chain rather than immediately failing the workflow.

### Why fallbacks exist

Provider outages and rate limits are common at inference scale. Without fallbacks a single rate-limit on one provider fails the entire workflow. With a chain, the harness silently retries on the next provider and the workflow completes with no user intervention needed.

### Configuring fallbacks in agent frontmatter

Add a `fallback_models` list beneath the `model` field in any agent `.md` file:

```yaml
---
model: anthropic/claude-sonnet-4-6
fallback_models:
  - openai/gpt-5.4
  - ollama/qwen3.5:9b
---
```

Model strings follow the same `provider/model` syntax as the `model` field. These fallbacks are loaded at startup and applied to every task that runs under this agent.

### Resolution priority

When a task is dispatched, its model is chosen in this order:

1. **Task-level `fallback_models`** — an explicit list in the `submit_workflow` JSON payload overrides everything.
2. **Agent's frontmatter `fallback_models`** — loaded from the `.md` file at startup via `set_agent_fallbacks()`.
3. **Global `DEFAULT_MODEL`** — `anthropic/claude-sonnet-4-6`, used when no model is specified at all.

### Error classification and fallback triggers

Error classification runs in the TypeScript plugin (`classifyError` in `plugin/harness.ts`). Errors are classified as either **retryable** or **terminal**:

- **Retryable** — HTTP 429, 5xx, `rate limit`, `overloaded`, `timeout`, `service unavailable`, connection errors. A retryable error with remaining fallbacks triggers `try_fallback()` and re-queues the task.
- **Terminal** — auth failures, content policy violations, invalid requests, model-not-found. These fail the task immediately regardless of remaining fallbacks.

A task is only marked `Failed` after all models in its chain are exhausted or a terminal error is received.

### Observing fallback activity

The plugin logs every fallback transition with the `[harness-plugin]` prefix:

```
[harness-plugin] error classified as retryable: rate limit hit (429)
[harness-plugin] task <id> falling back to openai/gpt-5.4 (attempt 1)
```

Workflow snapshots (via the `harness_state` tool) include `model_attempt` and `fallback_models` on each task, showing exactly which model in the chain is currently active.

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
