# AGENTS.md

Rust agent harness for OpenCode. The DAG state machine compiles to WASM and
runs directly inside the OpenCode TypeScript plugin — no separate binary or
HTTP server is required at runtime.

## Commands

```sh
cargo build             # build the native binary (install subcommand only)
cargo test              # 24 tests, all fast, no live services required
make wasm               # rebuild plugin/wasm/ from src/lib.rs (needs wasm-pack)
cargo run -- install    # install agent configs into ~/.config/opencode/agents/
```

No custom lint/fmt config — use `cargo fmt` and `cargo clippy` with defaults.

## Architecture

```
src/
  lib.rs      — DagEngine (pure Rust, always compiled)
              + AGENTS constant (embedded agent markdown files)
              + wasm module (wasm32-only: WasmDagEngine wrapper + get_agent_configs())
  install.rs  — native-only: write AGENTS to ~/.config/opencode/agents/
  main.rs     — native-only: `openagent-harness install [--force]` CLI

plugin/
  harness.ts  — OpenCode server plugin
  wasm/       — built artifacts from `make wasm` (committed to repo)
    openagent_harness.js       — JS/TS glue (ESM)
    openagent_harness.d.ts     — TypeScript types
    openagent_harness_bg.wasm  — WASM binary (~170 KB)
```

### Runtime data flow

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

No separate process. No port binding. No HTTP polling.

## Key facts

**WASM DAG (`src/lib.rs`)**: pure synchronous Rust — no tokio, no axum,
no reqwest. Only `serde_json`, `uuid` (with `js` feature for WASM entropy),
and `console_error_panic_hook`.

**Crate target split**: `wasm-bindgen`, `console_error_panic_hook`, and the
`uuid/js` feature are in `[target.'cfg(target_arch = "wasm32")'.dependencies]`
so they never pull in WASM runtime code during native tests or the install
binary build.

**WASM wrapper pattern**: `DagEngine` is a plain Rust struct (always compiled,
tested natively). A `WasmDagEngine` newtype in `src/lib.rs::wasm` wraps it and
is exported to JavaScript as `DagEngine` via `js_name`.

**Plugin WASM loading**: `initSync({ module: readFileSync(wasmPath) })` loads
the module synchronously before any hooks fire. `DagEngine` is then used as a
plain JavaScript object.

**Agent install on first boot**: `get_agent_configs()` is a WASM export that
returns all embedded agent markdown files as a JSON object.  `harness.ts` calls
it once on startup and writes any missing `.md` files to
`~/.config/opencode/agents/` so agents are available without running the native
binary separately.

**Task lifecycle**: setInterval tick (`500ms`) only *starts* tasks. Completion
is event-driven — OpenCode fires `session.idle` → `dag.process_event()` marks
`Done`. `Pending → Running` in tick; `Running → Done/Failed` in `process_event`.

**ACP send endpoint**: `POST /session/{id}/prompt_async` (fire-and-forget).
TypeScript `sendMessage()` in harness.ts handles this.

**Model string format**: `"provider/model"`, e.g. `"anthropic/claude-sonnet-4-20250514"`.
No slash → provider defaults to `"anthropic"`. Empty string → no model field sent.

**TaskStatus JSON**: `Failed` carries a message — `{"type":"failed","message":"..."}`.
Serde tag is `"type"`, content is `"message"`.

**Rust edition 2024**: `gen` is a reserved keyword — don't use it as an identifier.

**Plugin hooks**: session lifecycle uses a single `event` hook with discriminated
union (`event.type === "session.idle"`). Tool hooks (`tool.execute.before`,
`tool.execute.after`) are separate named hooks.

**Reentrancy guard**: the tick loop sets `ticking = true` before awaiting and
clears it in `finally` — prevents overlapping ticks if session creation is slow.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `OPENCODE_SERVER_PASSWORD` | unset | Basic auth password for OpenCode ACP (username is always `opencode`) |

## Building the WASM module

Requires [wasm-pack](https://rustwasm.github.io/wasm-pack/):

```sh
cargo install wasm-pack   # one-time setup
make wasm                 # rebuilds plugin/wasm/ from src/lib.rs
```

The built artifacts (`plugin/wasm/*.js`, `*.d.ts`, `*.wasm`) are committed to
the repository so that users who only install the plugin do not need a Rust
toolchain.

## Testing

All 24 Rust tests run without a live OpenCode instance.  They test `DagEngine`
(the plain Rust struct) directly through its public JSON API — no wasm_bindgen
involved in tests.

## Plugin registration

`plugin/harness.ts` must be registered in OpenCode's config (e.g. `opencode.json`):

```json
{
  "plugin": ["path/to/openagent-harness/plugin/harness.ts"]
}
```

The plugin is fire-and-forget — errors are logged, never propagated to OpenCode.

## State persistence

In-memory only. No database. All task state is lost on restart.
