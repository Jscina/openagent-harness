# openagent-harness

Deterministic multi-agent harness for [OpenCode](https://opencode.ai), built as a Rust DAG engine compiled to WebAssembly (WASM) and loaded in-process by the OpenCode plugin. No separate runtime service is required.

## Overview

`openagent-harness` coordinates agent workflows using a dependency-aware DAG engine. The Rust core owns workflow/task state transitions, while the TypeScript plugin handles OpenCode session wiring, async prompt dispatch, and runtime error classification.

The system is optimized for:

- predictable task orchestration
- explicit dependency handling
- robust model fallback behavior
- plugin-local runtime (no external harness daemon)

## Architecture and runtime behavior

At startup, the plugin:

1. synchronously loads WASM with `initSync(readFileSync(...))`
2. calls `get_agent_configs()`
3. auto-installs missing embedded agent markdown files into `~/.config/opencode/agents/`
4. loads agent fallback config JSON and registers it in the DAG

Core runtime behavior:

- The DAG state is **in-memory only** (restarts clear active workflow/task state).
- The plugin sends prompts asynchronously to OpenCode ACP via `POST /session/{id}/prompt_async`.
- Task progression is event-driven from `session.idle` / `session.error` events back into the DAG.
- Plans are persisted to `.opencode/plans`, while live workflow state stays in memory.

### Orchestrator/planner workflow

For planned coding work, the flow is:

1. `orchestrator` delegates planning to `planner`.
2. `planner` can ask clarifying questions, then saves a plan artifact under `.opencode/plans`.
3. `planner` returns a `plan_id` and structured summary.
4. `orchestrator` asks the user for explicit approval.
5. On approval, `orchestrator` calls `submit_plan`.

Execution modes:

- **Native dispatch**: the orchestrator/runner uses `harness_dispatch_tasks` to pull ready tasks, executes each as a visible subagent call, then confirms completion with `harness_task_complete`. This is the recommended execution mode for planner-created work.
- **Non-native dispatch**: the plugin uses its in-plugin 500ms tick loop (`dag.tick()`) to start ready tasks automatically.

## Installation

### Install a release (recommended)

Use the release installer script with a pinned tag:

```sh
curl -fsSL https://raw.githubusercontent.com/Jscina/openagent-harness/v0.3.2/install.sh | OPENAGENT_HARNESS_TAG=v0.3.2 bash
```

The installer configures OpenCode to use this harness, including:

- plugin wiring for `plugin/harness.ts`
- remote MCP servers for Exa websearch, Context7, and grep.app
- disabling default OpenCode `build`, `plan`, and `general` agents in favor of harness-managed agents

### Local development setup

Install wasm-pack, rebuild WASM artifacts, and point OpenCode at the local plugin path:

```sh
cargo install wasm-pack
make wasm
```

`opencode.json` example:

```json
{
  "plugin": ["/path/to/openagent-harness/plugin/harness.ts"]
}
```

### Optional native agent install commands

If you want to install or refresh embedded agent markdown files manually (instead of relying on first-boot auto-install):

```sh
cargo run -- install
cargo run -- install --force
openagent-harness install
```

## Agent system

The checked-in agent markdown files define model defaults in frontmatter:

| Agent | Model |
| --- | --- |
| `orchestrator` | `anthropic/claude-sonnet-4-6` |
| `planner` | `anthropic/claude-sonnet-4-6` |
| `explorer` | `anthropic/claude-haiku-4-5` |
| `researcher` | `anthropic/claude-sonnet-4-6` |
| `vision` | `ollama/qwen2.5-vl-vision:latest` |
| `builder` | `anthropic/claude-sonnet-4-6` |
| `builder-junior` | `anthropic/claude-sonnet-4-6` |
| `reviewer` | `anthropic/claude-sonnet-4-6` |
| `debugger` | `anthropic/claude-sonnet-4-6` |
| `docs-writer` | `anthropic/claude-haiku-4-5` |

The typical delivery flow is: `orchestrator` → `planner` → implementation agents such as `builder`, `reviewer`, and `docs-writer`, with `explorer`, `researcher`, `vision`, `builder-junior`, and `debugger` used as specialized subagents.

## Fallback behavior

Fallbacks are configured per agent via frontmatter `fallback_models`, with optional task-level overrides.

### Sources and precedence

When selecting model fallback chains, precedence is:

1. task-level `fallback_models` passed with the task payload
2. agent frontmatter `fallback_models` loaded at startup
3. no fallback chain (task uses only its resolved primary model)

### How fallback decisions are made

- `classifyError` in `plugin/harness.ts` labels errors as retryable vs terminal.
- For retryable errors and remaining models, the plugin calls WASM `try_fallback()`.
- `try_fallback()` atomically advances to the next model and resets task state to `Pending` for re-queue.
- Terminal errors, or exhausted fallback chains, mark the task as failed.

### Visibility in workflow snapshots

Workflow snapshots expose:

- `fallback_models` for each task
- `model_attempt` (0 = primary, 1 = first fallback, etc.)

This makes active model selection and fallback history observable during execution.

## Environment

| Variable | Description |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` | Basic auth password for the OpenCode ACP server. |

## Development

Common commands:

```sh
make wasm
cargo test
cargo fmt && cargo clippy
cargo run -- install
cargo run -- install --force
```

## Repository layout

- `src/lib.rs` — WASM exports, engine wrapper, and embedded agent config access
- `src/dag.rs` — DAG engine state machine and task/workflow transition logic
- `src/agents.rs` — agent frontmatter parsing (`model`, `fallback_models`)
- `src/install.rs` — installer for embedded agent markdown files
- `src/main.rs` — CLI entrypoint (`openagent-harness install`)
- `plugin/harness.ts` — plugin runtime loop, ACP integration, and error classification
- `plugin/wasm/` — generated WASM artifacts committed to the repo
