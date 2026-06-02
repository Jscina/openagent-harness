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
4. calls `agent_fallback_configs_json()` and registers per-agent fallback chains via `set_agent_fallbacks()`

Core runtime behavior:

- The DAG state is **in-memory only** (restarts clear active workflow/task state).
- The plugin sends prompts asynchronously to OpenCode ACP via `POST /session/{id}/prompt_async`.
- Task progression is event-driven from `session.idle` / `session.error` events back into the DAG.
- Plans are persisted to `.opencode/plans`, while live workflow state stays in memory.
- After a task completes, the plugin may reuse its session for a downstream task (session reuse), avoiding a redundant `createSession` call.

### Orchestrator/planner workflow

For planned coding work, the flow is:

1. `orchestrator` delegates planning to `planner`.
2. `planner` may ask clarifying questions (requires `permission: question: allow` in frontmatter), then saves a plan artifact under `.opencode/plans`.
3. `planner` returns a `plan_id` and structured summary.
4. `orchestrator` asks the user for explicit approval (also requires `permission: question: allow`).
5. On approval, `orchestrator` calls `submit_plan` with `native_dispatch: true`.

Execution modes:

- **Native dispatch** (recommended): the orchestrator uses `harness_dispatch_tasks` to poll for ready tasks, executes each as a visible `Task` tool call (subagent), then calls `harness_task_complete` to register completion. The loop repeats until the workflow reaches `done` or `failed`.
- **Non-native dispatch**: the plugin uses its in-plugin 500ms tick loop (`dag.tick()`) to start ready tasks automatically (no visible subagent calls).

### Task state machine

```
Pending
  ↓ tick() finds unblocked task
Running
  ├─→ Done          (session.idle received)
  ├─→ Pending       (try_fallback() succeeds — next model, re-queued)
  └─→ Failed        (session.error + no fallbacks, or fail_task() called)
```

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

The checked-in agent markdown files define model defaults and fallback chains in frontmatter:

| Agent | Model | Fallback |
| --- | --- | --- |
| `orchestrator` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-builder:latest` |
| `planner` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-builder:latest` |
| `explorer` | `anthropic/claude-haiku-4-5` | `ollama/qwen3-coder-builder:latest` |
| `researcher` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-builder:latest` |
| `vision` | `ollama/qwen2.5-vl-vision:latest` | `anthropic/claude-haiku-4-5` |
| `builder` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-builder:latest` |
| `builder-junior` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-junior:latest` |
| `reviewer` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-builder:latest` |
| `debugger` | `anthropic/claude-sonnet-4-6` | `ollama/qwen3-coder-builder:latest` |
| `docs-writer` | `anthropic/claude-haiku-4-5` | `ollama/qwen3-docs:latest` |

The typical delivery flow is: `orchestrator` → `planner` → implementation agents such as `builder`, `reviewer`, and `docs-writer`, with `explorer`, `researcher`, `vision`, `builder-junior`, and `debugger` used as specialized subagents.

### Skills

Agents declare skills in frontmatter; they are loaded on demand via the `skill` tool. Skills live at `~/.config/opencode/skills/` and are **not** auto-installed by this repo.

| Skill | Used by | Purpose |
| --- | --- | --- |
| `git-workflow` | `builder` | Manages worktree lifecycle for parallel junior workers |
| `git-worktree` | `builder-junior` | Enforces atomic seed-commit + autosquash-fixup pattern |
| `azure-workflow` | `builder`, `debugger` | Hard read-only constraint for Azure operations |
| `pr-workflow` | `orchestrator` | PR creation and lifecycle management |

## Fallback behavior

Fallbacks are configured per agent via frontmatter `fallback_models`, with optional task-level overrides.

### Sources and precedence

When selecting model fallback chains, precedence is:

1. task-level `fallback_models` passed with the task payload
2. agent frontmatter `fallback_models` loaded at startup via `set_agent_fallbacks()`
3. no fallback chain (task uses only its resolved primary model)

### How fallback decisions are made

- `classifyError` in `plugin/harness.ts` labels errors as retryable vs terminal.
- Retryable errors: 429 (rate limit), 5xx, timeouts — try next model in chain.
- Terminal errors: 401 (auth failure), content policy, invalid request — fail immediately.
- For retryable errors with remaining fallbacks, the plugin calls WASM `try_fallback()`.
- `try_fallback()` atomically advances to the next model and resets task state to `Pending` for re-queue.
- Terminal errors, or exhausted fallback chains, mark the task as failed.

### Visibility in workflow snapshots

Workflow snapshots expose:

- `fallback_models` for each task
- `model_attempt` (0 = primary, 1 = first fallback, etc.)

This makes active model selection and fallback history observable during execution.

## Plugin tool exports

The following tools are exposed by the plugin to OpenCode agents:

| Tool | Description |
| --- | --- |
| `submit_workflow(tasks)` | Submit a raw task array directly to the DAG (low-level) |
| `save_plan(tasks, summary, recommendations)` | Planner saves a plan artifact to `.opencode/plans/` |
| `submit_plan(plan_id, native_dispatch)` | Orchestrator loads a plan artifact and submits it to the DAG |
| `harness_state(workflow_id?)` | Query workflow snapshot; lists all workflows if no ID given |
| `harness_dispatch_tasks(workflow_id)` | Native dispatch: poll for ready tasks; blocks until at least one is ready |
| `harness_task_complete(task_id, session_id, status)` | Native dispatch: register task completion after Task tool call returns |
| `submit_review(task_id, review_json)` | Attach structured review feedback to a completed task |

## Environment

| Variable | Description |
| --- | --- |
| `OPENCODE_SERVER_PASSWORD` | Basic auth password for the OpenCode ACP server. |

## Development

Common commands:

```sh
make wasm                     # rebuild plugin/wasm/ from src/lib.rs (requires wasm-pack)
cargo test                    # fast unit tests for DagEngine
cargo fmt && cargo clippy     # format and lint (clippy -D warnings in CI)
cargo run -- install          # install embedded agents into ~/.config/opencode/agents/
cargo run -- install --force  # overwrite existing installed agent markdown
npm --prefix plugin test      # run TypeScript/vitest plugin tests
```

## Repository layout

- `src/lib.rs` — WASM exports, engine wrapper, and embedded agent config access
- `src/dag.rs` — DAG engine state machine and task/workflow transition logic
- `src/types.rs` — shared data structures: `Task`, `Workflow`, `TaskStatus`, `EventResult`, etc.
- `src/agents.rs` — agent frontmatter parsing (`model`, `fallback_models`) and embedded agent content
- `src/install.rs` — installer for embedded agent markdown files
- `src/main.rs` — CLI entrypoint (`openagent-harness install`)
- `plugin/harness.ts` — plugin runtime loop, ACP integration, error classification, and tool exports
- `plugin/errors.ts` — `classifyError` implementation (retryable vs terminal)
- `plugin/client.ts` — OpenCode ACP session management (`createSession`, `sendMessage`, `deleteSession`)
- `plugin/plans.ts` — plan artifact persistence (`savePlanArtifact`, `loadPlanArtifact`)
- `plugin/dag.ts` — DAG query helpers for TypeScript
- `plugin/wasm/` — generated WASM artifacts committed to the repo
- `agents/` — the 10 embedded agent markdown files

## Known limitations and gotchas

- **State is in-memory only.** Restarting OpenCode or the plugin clears all active workflow and task state. Plans in `.opencode/plans/` persist across restarts, but live workflow state does not.
- **Skills are not auto-installed.** Agent skills live at `~/.config/opencode/skills/` and must be installed separately. If a skill file is missing, any agent that declares it will be blocked when it tries to load the skill.
- **Model string format.** Models are parsed as `provider/model` (e.g., `anthropic/claude-sonnet-4-6`). If there is no `/`, the provider defaults to `anthropic`. An empty string omits the model override.
- **Rust 2024 edition.** The keyword `gen` is reserved — do not use it as an identifier.
- **`native_dispatch: true` is required for visible subagent execution.** Without it, tasks run through the invisible 500ms tick loop with no subagent calls in the conversation.
- **`permission: question: allow` is required** for `orchestrator` and `planner` to use the question tool for plan approval and clarification. Without this in the agent frontmatter, question tool calls will be denied.
- **WASM artifacts are committed.** `plugin/wasm/` is generated by `make wasm` and checked into the repository. Rebuild and commit whenever `src/lib.rs` or the WASM interface changes.
