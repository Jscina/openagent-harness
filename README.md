# openagent-harness

Deterministic agent harness for [OpenCode](https://opencode.ai). Control flow lives in Rust. OpenCode is a worker. The LLM never decides what runs next.

## How it works

```
POST /tasks  →  Rust schedules task  →  creates OpenCode session via ACP
                                     →  sends prompt (fire-and-forget)
                                     →  spawns tmux pane

plugin fires session.idle  →  Rust marks task Done  →  starts next eligible task
```

The TypeScript plugin (`plugin/harness.ts`) is a dumb event bridge — it hooks into OpenCode and POSTs lifecycle events back to the harness. No logic lives there.

## Quickstart

```sh
# 1. Install plugin deps
cd plugin && bun install && cd ..

# 2. Register the plugin in your OpenCode config (opencode.json):
#    { "plugins": ["./plugin/harness.ts"] }

# 3. Run (auto-starts OpenCode if not already running)
cargo run
```

Harness binds on `:7837`. OpenCode ACP is expected on `:4096`.

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
{ "prompt": "do something", "model": "anthropic/claude-sonnet-4-20250514", "depends_on": [] }
```
`model` and `depends_on` are optional. Tasks with unmet deps wait until all deps reach `Done`.

**Task status shape:**
```json
{ "type": "pending" | "running" | "idle" | "done" }
{ "type": "failed", "message": "reason" }
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCODE_PORT` | `4096` | OpenCode ACP port |
| `OPENCODE_SERVER_PASSWORD` | — | Basic auth password for OpenCode |
| `HARNESS_PORT` | `7837` | Harness HTTP port |
| `HARNESS_URL` | `http://localhost:7837` | URL the plugin posts events to |
| `RUST_LOG` | `openagent_harness=info` | Log filter |

## Development

```sh
cargo build
cargo test       # 25 tests, no live services needed
cargo fmt
cargo clippy
```