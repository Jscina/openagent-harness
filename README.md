# openagent-harness

Deterministic agent harness for [OpenCode](https://opencode.ai). Control flow lives in Rust. OpenCode is a worker. The LLM never decides what runs next.

## How it works

```
OpenCode loads plugin  →  plugin checks harness health
                       →  if not running: spawns `cargo run`, waits for ready
                       →  if already running: attaches

POST /tasks  →  Rust schedules task  →  creates OpenCode session via ACP
                                     →  sends prompt (fire-and-forget)
                                     →  spawns tmux pane

plugin fires tool.execute.after  →  Rust appends result to task.output
plugin fires session.idle        →  Rust snapshots accumulated output
                                 →  marks task Done
                                 →  deletes ACP session
                                 →  starts next eligible task
```

The TypeScript plugin (`plugin/harness.ts`) owns the harness process lifecycle — it spawns and destroys the Rust harness automatically. No manual `cargo run` needed.

## Quickstart

```sh
# 1. Build the harness (plugin will start it on demand, but pre-building is faster)
cargo build

# 2. Install plugin deps
cd plugin && bun install && cd ..

# 3. Register the plugin in your OpenCode config (opencode.json):
#    { "plugins": ["./plugin/harness.ts"] }

# 4. Start OpenCode — the plugin auto-starts the harness on :7837
opencode
```

Harness binds on `:7837`. OpenCode ACP is expected on `:4096`. Both are auto-started if not already running.

## API

| Method   | Path          | Description                      |
| -------- | ------------- | -------------------------------- |
| `POST`   | `/tasks`      | Create a task                    |
| `GET`    | `/tasks`      | List all tasks                   |
| `GET`    | `/tasks/{id}` | Get task by ID                   |
| `DELETE` | `/tasks/{id}` | Cancel a task                    |
| `POST`   | `/events`     | Plugin event receiver (internal) |

**Create task:**

```json
{
  "prompt": "do something",
  "model": "anthropic/claude-sonnet-4-6",
  "depends_on": []
}
```

`model` and `depends_on` are optional. Tasks with unmet deps wait until all deps reach `Done`.

**Task response:**

```json
{
  "id": "uuid",
  "prompt": "...",
  "model": "...",
  "status": { "type": "done" },
  "output": "accumulated tool output from the session",
  "created_at": "...",
  "updated_at": "..."
}
```

**Status shapes:**

```json
{ "type": "pending" | "running" | "done" }
{ "type": "failed", "message": "reason" }
```

**Task output** is accumulated from every `tool.execute.after` event fired during the session, joined by newlines. It is snapshotted at `session.idle` and preserved in the final task record.

## Environment variables

| Variable                   | Default                  | Description                      |
| -------------------------- | ------------------------ | -------------------------------- |
| `OPENCODE_PORT`            | `4096`                   | OpenCode ACP port                |
| `OPENCODE_SERVER_PASSWORD` | —                        | Basic auth password for OpenCode |
| `HARNESS_PORT`             | `7837`                   | Harness HTTP port                |
| `HARNESS_URL`              | `http://localhost:7837`  | URL the plugin posts events to   |
| `RUST_LOG`                 | `openagent_harness=info` | Log filter                       |

## Development

```sh
cargo build
cargo test
cargo fmt
cargo clippy
```
