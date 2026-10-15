# openagent-harness

Deterministic multi-agent harness for [OpenCode](https://opencode.ai), built as a Rust DAG engine compiled to WebAssembly (WASM) and loaded in-process by the OpenCode plugin. No separate runtime service is required.

## Overview

`openagent-harness` coordinates agent workflows using a dependency-aware DAG engine. The Rust core owns workflow/task state transitions, while the TypeScript plugin handles OpenCode session wiring, async prompt dispatch, and runtime error classification.

The system is optimized for:

- predictable task orchestration
- explicit dependency handling
- plugin-local runtime (no external harness daemon)

## Architecture and runtime behavior

At startup, the plugin:

1. synchronously loads WASM with `initSync(readFileSync(...))`
2. calls `get_agent_configs()`
3. auto-installs missing embedded agent markdown files into `~/.config/opencode/agents/`

Core runtime behavior:

- The DAG state is **in-memory only** (restarts clear active workflow/task state).
- The plugin sends prompts asynchronously to OpenCode v2 via `ctx.session.prompt({ sessionID, text })` (enqueued only, non-blocking).
- Task progression is event-driven from `session.idle` / `session.status` / `session.execution.failed` events (via `ctx.event.subscribe()`) back into the DAG.
- Plans are persisted to `.opencode/plans`, while live workflow state stays in memory.
- After a task completes, the plugin may reuse its session for a downstream task (session reuse), avoiding a redundant `createSession` call.

### Orchestrator/planner workflow

For planned coding work, the flow is:

1. `orchestrator` delegates planning to `planner`.
2. `planner` may ask clarifying questions (requires a `question` allow rule in frontmatter `permissions:`), then builds the plan incrementally with `plan_task` (one call per task) and finalizes it with `save_plan`, which persists the artifact under `.opencode/plans`.
3. `planner` returns a `plan_id` and structured summary.
4. `orchestrator` asks the user for explicit approval (also requires the `question` allow rule).
5. On approval, `orchestrator` calls `submit_plan` with `native_dispatch: true`.

Execution modes:

- **Native dispatch** (recommended): the orchestrator uses `harness_dispatch_tasks` to poll for ready tasks, executes each as a visible `subagent` tool call, then calls `harness_task_complete` to register completion. The loop repeats until the workflow reaches `done`, `failed`, or `cancelled`.
- **Non-native dispatch**: the plugin uses its in-plugin 500ms tick loop (`dag.tick()`) to start ready tasks automatically (no visible subagent calls).

### Cancellation

Any agent may call `harness_cancel` to abort a workflow or single task:

- `harness_cancel({ workflow_id })` cancels all Pending/Running tasks in the workflow, marks them `Cancelled`, aborts their in-flight OpenCode sessions (cooperative via `ctx.session.interrupt()`), and transitions the workflow to `Cancelled` status.
- `harness_cancel({ task_id })` cancels the specified task and all its transitive dependents (tasks blocked on it). Cancelled tasks are permanently marked `Cancelled`.
- Late `session.idle` / `session.execution.failed` events for aborted sessions are dropped by the plugin, preventing race conditions.
- In native dispatch, `harness_dispatch_tasks` treats `cancelled` as a terminal status, exiting the poll loop.

### Task state machine

```
Pending
  ↓ tick() finds unblocked task
Running
  ├─→ Done          (session.idle received)
  ├─→ Failed        (session.execution.failed or fail_task() called)
  └─→ Cancelled     (harness_cancel() called, or dependent task cancelled)
```

## Installation

Requires **OpenCode v2.x**. This harness no longer supports OpenCode v1.

### Install a release (recommended)

Use the release installer script with a pinned tag:

```sh
curl -fsSL https://raw.githubusercontent.com/Jscina/openagent-harness/v0.3.2/install.sh | OPENAGENT_HARNESS_TAG=v0.3.2 bash
```

The installer configures OpenCode to use this harness, including:

- plugin wiring: registers the install directory (`~/.openagent-harness`, entrypoint `index.ts` → `harness.ts`) in the `plugins` config key
- remote MCP servers for Exa websearch, Context7, and grep.app
- disabling default OpenCode `build`, `plan`, and `general` agents in favor of harness-managed agents

### Local development setup

Install wasm-pack, rebuild WASM artifacts, and point OpenCode (v2) at the local plugin path. Run `npm --prefix plugin install` first so `@opencode/plugin` resolves:

```sh
cargo install wasm-pack
make wasm
```

**opencode.json** (v2 config):

```json
{
  "plugins": ["/path/to/openagent-harness/plugin"]
}
```

`plugins` entries must be directories (resolved via `<dir>/server` or `<dir>/index`, not `package.json` `exports`; `plugin/index.ts` re-exports `harness.ts`, and a directory without either is silently skipped); file paths are rejected with `configured plugin path must be a directory`. Entries may also be `{ "package": "...", "options": {} }`. Alternatively, symlink the plugin directory into `.opencode/plugins/` (project) or `~/.config/opencode/plugins/` (global) for auto-discovery.

### Migrating from OpenCode v1

If upgrading from v1:

1. Run `openagent-harness install --force` to overwrite all agent markdown files with v2 frontmatter.
2. Update your `opencode.json`:
   - Rename the `plugin` key to `plugins` (now an array).
   - Rename the `permission` key to `permissions` (object → array of rules).

Example:

```json
{
  "plugins": ["/path/to/openagent-harness/plugin"],
  "permissions": [
    { "action": "*", "resource": "*", "effect": "allow" }
  ]
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
| `consultant` | `anthropic/claude-sonnet-4-6` |
| `debugger` | `anthropic/claude-sonnet-4-6` |
| `docs-writer` | `anthropic/claude-haiku-4-5` |

The typical delivery flow is: `orchestrator` → `planner` → implementation agents such as `builder` and `docs-writer`, with `reviewer` and `consultant` acting as read-only quality/review agents, and `explorer`, `researcher`, `vision`, `builder-junior`, and `debugger` used as specialized subagents.

### Skills

Agents grant their skills with `skill` rules in frontmatter `permissions:` (OpenCode v2 has no per-agent `skills:` list in frontmatter); they are loaded on demand via the `skill` tool. Skills live at `~/.config/opencode/skills/`; built-in caveman skill is auto-installed by this repo, while external skills must be installed separately.

| Skill | Used by | Purpose |
| --- | --- | --- |
| `git-workflow` | `builder` | Manages worktree lifecycle for parallel junior workers |
| `git-worktree` | `builder-junior` | Enforces atomic seed-commit + autosquash-fixup pattern |
| `pr-workflow` | `orchestrator` | PR creation and lifecycle management |

## Model selection

When the plugin starts a task, it uses the task's `model` if set, otherwise `anthropic/claude-sonnet-4-6`. For native-dispatch `subagent` spawns, the orchestrator can pass `model` to the `subagent` tool call; if omitted, the spawned agent's frontmatter `model:` applies. Task failure is final — when a session error occurs, the task is marked `Failed` and does not retry.

## Memory (RAG)

A two-layer file-based investigation memory system, rooted at `<project>/.opencode/memory/`:

- **`system/`** (committed) — durable, long-term knowledge about the codebase: architecture, schemas, services, known behaviors
- **`issues/`** (mostly local) — per-investigation cards across their lifecycle: backlog (planned), active (under investigation), done (finished locally), archive (durable shared record)

Each card holds `context.md` (issue summary), `trace.md` (append-only investigation log), `benchmarks.md` (findings to promote), and `artifacts/` (code/DDL snippets). The system is modeled on the `rag` Claude plugin's card/trace/context/promote pattern, but reimplemented entirely in TypeScript (no CLI, no Rust counterpart) — a single coherent implementation rather than two separate ones.

### Memory is mandatory, but `card_id` is optional

The memory system is **enforced by gating**: every coding task's planning phase must call `memory_context` before spawning work. However, `card_id` is **optional**:

- **With a card** (user mentioned a ticket/ADO number): call `memory_context({ cardId: "ADO-123" })` to associate the workflow with that investigation card. The `card_id` flows through every task and is auto-traced on completion/failure.
- **No card** ("system-level" mode): call `memory_context({})` (no arguments) when the user did not supply a ticket ID. The workflow proceeds with system knowledge only. Use this for one-off refactorings, explorations, or operations with no associated bug/work item. `memory_promote` still works (writes system/ only; `benchmarksPath` is null).

Every task prompt is automatically prefixed with a `<memory-context>` preamble containing relevant prior findings and ruled-out hypotheses. This preamble is built on-the-fly for the task's card (or system knowledge if no card).

### Four memory tools

All exposed by the plugin and gated by agent permissions:

| Tool | `cardId` arg | Allowed agents | Purpose |
| --- | --- | --- | --- |
| `memory_card` | required | orchestrator, debugger | Create a new investigation card (active by default; pass `backlog: true` to park an idea). Auto-scaffolds the corpus on first use. |
| `memory_trace` | required | orchestrator, builder, debugger, consultant | Append a structured entry (finding/ruled-out/hypothesis/next-step) to an active card's trace.md. Append-only, never rewrites. |
| `memory_context` | optional | all agents (except builder-junior) | Assemble a focused markdown context payload from system/ knowledge and optionally a card (context.md/trace.md/benchmarks.md). Mode: `compact` (headings only, default) or `full` (complete record). Also satisfies the acknowledgement gate for `plan_task`, `submit_plan`, and `submit_workflow`. |
| `memory_promote` | optional | orchestrator, debugger, consultant | Promote a confirmed finding to durable `system/` knowledge (creates or appends to the target file). With `cardId`, also record a `promoted` entry in benchmarks.md. Never touches trace.md. Omit `cardId` for system-level findings. |

### Acknowledgement gate

`plan_task`, `submit_plan`, and `submit_workflow` are rejected until the calling session has invoked `memory_context` at least once. This gate:

- is **per-session** and **in-memory only** (lost on restart)
- is satisfied by calling `memory_context` with **or without** a `cardId` (either `memory_context({ cardId: "..." })` or `memory_context({})`)
- is never checked again for that session after the first successful call
- applies regardless of agent: planner, orchestrator, and even builder (if spawning nested workflows) must call it

For a simple "no card" workflow, call `memory_context({})` once at the start.

### Skills assignment and gating

Six memory skills are shipped and auto-installed:

| Skill | Router or specific | Agents | Purpose |
| --- | --- | --- | --- |
| `memory` | router | debugger | Load this first; it routes to the specific sub-skill. |
| `memory-card` | create card | orchestrator, debugger | Create investigation cards |
| `memory-trace` | log finding | orchestrator, builder, debugger, consultant | Log findings and hypotheses to trace.md while investigating |
| `memory-context` | assemble context | all except builder-junior | Retrieve prior analysis and system knowledge; satisfies ack gate |
| `memory-promote` | promote finding | orchestrator, debugger, consultant | Promote findings to system/ knowledge |

Note: `builder-junior` has **no memory tool access** — it receives memory findings through the auto-injected preamble instead, keeping it stateless.

### Auto-trace on task completion/failure

When a task completes or fails, the plugin attempts a best-effort trace:

- **With `card_id`**: the outcome (success or failure) is automatically logged to that card's `trace.md` as a `finding` entry.
- **Without `card_id`, failure only**: if exactly one card is active, a best-effort trace is attempted for failures (via single-active-card heuristic). If zero or multiple cards are active, the trace is silently skipped. Success outcomes without a card are never traced.
- Failures: any corpus or filesystem error during auto-trace is never fatal to the task-failure handling; tracing is best-effort only.

See `harness_task_complete` in `plugin/harness.ts` and `withAutoTrace` in `plugin/memory.ts` for implementation details.

### Auto-injected memory preamble

Every dispatched task prompt (both tick-loop and native-dispatch paths) is automatically prefixed with a `<memory-context>` block containing:

- Relevant prior findings from the task's card (if `card_id` is set)
- Ruled-out hypotheses from the trace
- Known system behaviors from `system/`

The preamble is built on-the-fly for each task and never changes the original prompt — agents should pass the prompt through unchanged after reading the preamble.

### Card ID on plan artifacts and workflows

When a planner builds a plan via `plan_task` calls and finalizes it with `save_plan`:

- Include `card_id` on every `plan_task` call if a card exists (same value on all calls; omit it entirely if no card).
- The plan artifact (`.opencode/plans/{plan_id}.json`) includes an optional top-level `card_id` field.
- When `submit_plan` loads and submits the plan, the `card_id` is bound to the workflow and all its tasks.
- Backward compatibility: old plan JSONs without `card_id` still load and execute (no card).

Snapshot view (`harness_state`) includes the workflow's `card_id` if set.

### Commit boundary: `.opencode/memory/.gitignore`

The corpus generates its own nested `.gitignore`, enforcing:

- **Ignored** (local working state): `issues/backlog/`, `issues/active/`, `issues/done/`, and all `trace.md` (even inside `issues/archive/`)
- **Committed**: `system/**` and `issues/archive/**` minus `trace.md` (i.e., `context.md`, `benchmarks.md`, `artifacts/`)

The harness repo itself ignores `.opencode/` wholesale (via root `.gitignore`), which is intentional and untouched. For **consumer projects** adopting the harness, if a root `.opencode/` ignore rule swallows the memory corpus, restore it with:

```gitignore
.opencode/*
!.opencode/memory/
```

The nested corpus `.gitignore` then still excludes local card state, yielding the intended boundary.

### Auto-trace-on-failure

When a task fails, the plugin attempts a best-effort trace: if there is **exactly one** active investigation card (unambiguous attribution), it logs the failure to that card's trace.md as a `finding` entry. If zero or multiple cards are active, the trace is silently skipped — there is no unambiguous card to attribute the failure to. This behavior is strictly additive: any corpus/filesystem failure is never fatal to the task-failure flow. See `harness_task_complete` in `plugin/harness.ts` (lines 711–730).

### Out of scope (by design)

Not included, deferred, or not planned:

- No CLI (rag-style `rag-new-card` / `rag-trace` / `rag-promote` scripts) — all operations are tool-driven
- No embeddings or semantic search — purely file-based, searchable via grep/browser
- No MCP server — memory is a plugin-local corpus, not a remote service
- No schema migration or versioning tooling — `.rag-meta.json` is informational only
- No changes to `src/dag.rs`, `src/lib.rs`, or WASM interface — memory is pure TypeScript

## Plugin tool exports

The following tools are exposed by the plugin to OpenCode agents:

| Tool | Description |
| --- | --- |
| `submit_workflow(tasks, parent_session_id?, card_id?)` | Submit a raw task array directly to the DAG (low-level). Optional `card_id` binds tasks to an investigation card. Requires prior `memory_context` call in this session. |
| `plan_task(agent, prompt, depends_on?, model?, plan_id?, card_id?)` | Planner appends one task to an in-progress plan draft; call once per task, threading the returned `plan_id` through subsequent calls. Optional `card_id` (same value on all calls, or omit entirely) binds the plan to a card. Requires prior `memory_context` call in this session. |
| `save_plan(plan_id, summary, recommendations?)` | Planner finalizes the accumulated plan draft (built via `plan_task`) into a persisted artifact under `.opencode/plans/`. The artifact includes the optional `card_id` if any `plan_task` call provided it. |
| `submit_plan(plan_id, native_dispatch?)` | Orchestrator loads a plan artifact by `plan_id` and submits its tasks to the DAG. The plan's optional `card_id` (if present) is bound to the workflow. Requires prior `memory_context` call in this session. |
| `harness_state(workflow_id?)` | Query workflow snapshot; lists all workflows if no ID given. Snapshot includes the workflow's `card_id` if set. |
| `harness_dispatch_tasks(workflow_id)` | Native dispatch: poll for ready tasks; blocks until at least one is ready. Task prompts include the auto-injected `<memory-context>` preamble. |
| `harness_task_complete(task_id, session_id, status)` | Native dispatch: register task completion after the `subagent` tool call returns. Returns `{ auto_traced: boolean }` indicating whether the outcome was auto-traced to the task's card. |
| `harness_cancel(workflow_id\|task_id)` | Cancel a pending/running workflow or task; aborts in-flight sessions and cascades to dependents. |
| `submit_review(task_id, review_json)` | Attach structured review feedback to a completed task. |
| `memory_card(cardId)` | Create a new investigation card (required `cardId`; optional `symptom`, `source`, `backlog` args). Auto-scaffolds the corpus on first use. |
| `memory_trace(cardId, type, body, session?)` | Append a structured entry (finding/ruled-out/hypothesis/next-step) to a card's trace.md. `cardId` is required. |
| `memory_context(cardId?, mode?, sections?)` | Assemble context from system/ knowledge and optionally a card (cardId is optional; omit for no-card / system-level mode). Also satisfies the acknowledgement gate for `plan_task`, `submit_plan`, and `submit_workflow`. Returns markdown context payload. |
| `memory_promote(cardId?, finding, targetPath, impact?, title?, sectionTitle?)` | Promote a finding to durable `system/` knowledge (with `cardId`, also record in card's benchmarks.md). `cardId` is optional; omit for system-level findings. |

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
- `src/agents.rs` — agent frontmatter parsing (`model`) and embedded agent content
- `src/install.rs` — installer for embedded agent markdown files
- `src/main.rs` — CLI entrypoint (`openagent-harness install`)
- `plugin/harness.ts` — plugin runtime loop, ACP integration, event mapping, and tool exports
- `plugin/errors.ts` — `extractErrorMessage` helper (flatten error object to string)
- `plugin/client.ts` — OpenCode ACP session management (`createSession`, `sendMessage`, `deleteSession`)
- `plugin/plans.ts` — plan artifact persistence (`savePlanArtifact`, `loadPlanArtifact`)
- `plugin/dag.ts` — DAG query helpers for TypeScript
- `plugin/wasm/` — generated WASM artifacts committed to the repo
- `agents/` — the 11 embedded agent markdown files

## Known limitations and gotchas

- **State is in-memory only.** Restarting OpenCode or the plugin clears all active workflow and task state. Plans in `.opencode/plans/` persist across restarts, but live workflow state does not.
- **Skills are not auto-installed.** Agent skills live at `~/.config/opencode/skills/` and must be installed separately. If a skill file is missing, any agent that declares it will be blocked when it tries to load the skill.
- **Model string format.** Models are parsed as `provider/model` (e.g., `anthropic/claude-sonnet-4-6`). If there is no `/`, the provider defaults to `anthropic`. An empty string omits the model override.
- **Rust 2024 edition.** The keyword `gen` is reserved — do not use it as an identifier.
- **`native_dispatch: true` is required for visible subagent execution.** Without it, tasks run through the invisible 500ms tick loop with no subagent calls in the conversation.
- **A `question` allow rule is required** in the `permissions:` list of `orchestrator` and `planner` (`{ action: question, resource: "*", effect: allow }`) to use the question tool for plan approval and clarification.
- **WASM artifacts are committed.** `plugin/wasm/` is generated by `make wasm` and checked into the repository. Rebuild and commit whenever `src/lib.rs` or the WASM interface changes.
