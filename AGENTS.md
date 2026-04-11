# AGENTS.md

Rust agent harness for OpenCode. Rust process owns all control flow; OpenCode is a worker driven over HTTP.

## Commands

```sh
cargo build
cargo test          # 25 tests, all fast, no live services required
cargo run           # auto-starts opencode if not reachable; binds :7837
RUST_LOG=openagent_harness=debug cargo run
```

No custom lint/fmt config — use `cargo fmt` and `cargo clippy` with defaults.

## Architecture

```
src/types.rs    — Task, Node, TaskStatus, request/response DTOs
src/events.rs   — PluginEvent (inbound from TS plugin)
src/acp.rs      — ACP HTTP client (reqwest)
src/tmux.rs     — spawn_pane() shells out to tmux, best-effort
src/dag.rs      — AppState + DagState + tick loop + state machine
src/server.rs   — axum router; handlers delegate to AppState methods
src/main.rs     — boot: health-check → maybe spawn opencode → serve
plugin/harness.ts — OpenCode TS plugin; POSTs events to :7837
```

All shared mutable state is in `dag::AppState`, not in handlers. `server.rs` is thin.

## Key facts

**Shared state**: `Arc<AppState>` passed to axum via `.with_state()`. `AppState` is not `Clone`; clone the `Arc`. Inner `dag: tokio::sync::Mutex<DagState>` — never hold across `.await` (lock-copy-unlock pattern). `session_to_task: DashMap<String, Uuid>` is lock-free.

**Task lifecycle**: tick loop (`500ms`) only *starts* tasks. Completion is event-driven — plugin fires `session.idle` → `process_event` marks `Done`. Pending → Running happens in tick; Running → Done/Failed happens in `process_event`.

**ACP send endpoint**: `POST /session/{id}/prompt_async` (returns 204, fire-and-forget). If your OpenCode build doesn't have `prompt_async`, fall back to `/session/{id}/message` in `acp.rs:93`.

**Model string format**: `"provider/model"`, e.g. `"anthropic/claude-sonnet-4-20250514"`. No slash → provider defaults to `"anthropic"`. Empty string → no model field sent (OpenCode picks default).

**axum 0.8 path params**: `{id}` syntax, not `:id`. Wrong syntax silently 404s.

**uuid crate**: needs both `v4` and `serde` features. Missing `serde` causes compile error on `Path<Uuid>` extraction.

**TaskStatus JSON**: `Failed` carries a message — `{"type":"failed","message":"..."}`. Serde tag is `"type"`, content is `"message"`.

**Rust edition 2024**: `gen` is a reserved keyword — don't use it as an identifier anywhere.

**Plugin hooks**: session lifecycle uses a single `event` hook with discriminated union (`event.type === "session.idle"`), not separate named hooks per event. Tool hooks (`tool.execute.before`, `tool.execute.after`) are separate named hooks.

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `OPENCODE_PORT` | `4096` | OpenCode ACP port |
| `OPENCODE_SERVER_PASSWORD` | unset | Basic auth password (username is always `opencode`) |
| `HARNESS_PORT` | `7837` | Harness HTTP server port |
| `HARNESS_URL` | `http://localhost:7837` | Plugin → harness URL (set in OpenCode plugin env) |
| `RUST_LOG` | `openagent_harness=info` | Tracing filter |

## Testing

All 25 tests run without a live OpenCode instance. `AcpClient` in tests is pointed at `http://localhost:1` (unreachable); only pure state logic is exercised.

Server handler tests use `tower::ServiceExt::oneshot` (dev-dep). Read body with `axum::body::to_bytes(resp.into_body(), usize::MAX)`.

To test `execute_task` / `tick` end-to-end, a real OpenCode instance on `:4096` is required — no such test exists yet.

## Plugin registration

`plugin/harness.ts` must be registered in OpenCode's config (e.g. `opencode.json`) before it fires events. The plugin is fire-and-forget — errors are logged, never propagated to OpenCode.

## State persistence

In-memory only. No database. All task state is lost on restart.
