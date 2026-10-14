# OpenCode v2 plugin API notes

Source of truth: installed `@opencode/plugin@2.0.29` (and its dependency `@opencode/client@2.0.29`, `@opencode/schema`). Paths below are relative to `plugin/node_modules/`. Only the plugin package is a direct dependency; `@opencode/client` was **not** added (`ctx.session` is sufficient).

## Plugin.define and ctx

`@opencode/plugin/dist/promise/plugin.d.ts`, re-exported from the package root as namespace `Plugin`:

```ts
import { Plugin } from "@opencode/plugin";
export default Plugin.define({ id: string, setup(ctx: Plugin.Context): Promise<Cleanup|void> | Cleanup | void });
type Cleanup = () => Promise<void> | void;
```

`Plugin.Context` fields: `app {name, version, channel}`, `location` (`Location.Info`, `.directory`, `.project.{id,directory,canonical}`), `options`, `agent`, `aisdk`, `command`, `credential`, `event`, `experimental`, `integration`, `mcp`, `model`, `generate`, `permission`, `plugin`, `provider`, `reference`, `rpc`, `session`, `shell`, `skill`, `storage`, `tool`, `vcs`, `websearch`, `worktree`. No `client`, no `$`.

## ctx.session (`dist/promise/session.d.ts`)

`SessionDomain = Pick<SessionApi, "create"|"get"|"remove"|"switchAgent"|"switchModel"|"prompt"|"generate"|"command"|"compact"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context"> & { hook }`.
`SessionApi` is `@opencode/client/dist/promise/client.d.ts` `session`; input types in `@opencode/client/dist/promise/generated/types.d.ts`. All methods take one flat object, return the value directly (no `{data}` envelope) and throw on failure.

| Need | v2 API | HTTP (`@opencode/client/dist/chunks/contract-qfk0hgz0.js`) |
| --- | --- | --- |
| create | `create({ id?, parentID?, title?, agent?, model?: {id, providerID, variant?}, location?: {directory}, metadata?, permissions? }) -> SessionInfo` (id at `.id`) | `POST /api/session` |
| non-blocking send | `prompt({ sessionID, text, files?, agents?, skills?, metadata?, delivery?: "steer"\|"queue", resume? }) -> SessionInboxUser` (enqueue only; returns before the turn runs) | `POST /api/session/{id}/prompt` |
| abort | `interrupt({ sessionID, resume? }) -> { interrupted: boolean }` | `POST /api/session/{id}/interrupt` |
| delete | `remove({ sessionID }) -> void` | `DELETE /api/session/{id}` |
| set agent / model | `switchAgent({ sessionID, agent })`, `switchModel({ sessionID, model: {id, providerID, variant?} })` | `POST /api/session/{id}/agent`, `/model` |
| block until done | `wait({ sessionID })` (experimental; not used) | `POST /api/experimental/session/{id}/wait` |

`parentID` is supported on `create`.

### Differences from the research summary

- No `promptAsync` / `abort` / `delete` names: use `prompt` (already non-blocking), `interrupt`, `remove`. Paths are under `/api/...`, not `/session/{id}/prompt_async|abort`.
- `prompt` has **no `parts`, `model` or `agent`** params. Text is `text` (string). Model/agent are session state set on `create` or via `switchModel` / `switchAgent`.
- Model is an object `{ providerID, id, variant? }` (`id`, not `modelID`; variant is a separate field, not a `#` suffix). The string `provider/model#variant` form is only used by the `subagent` tool's `model` input (`Model.Ref.parse`, `@opencode/schema/dist/model.js`).

### Adapter decisions (`plugin/client.ts`)

- All helpers take `ctx.session` (type `SessionClient`, a `Pick` of the six used methods) instead of a client.
- `parseModel` is unchanged (`{providerID, modelID}`, no `#` handling). New `toModelRef` converts to the v2 shape and splits `#variant` at the first `#` after the provider slash (same rule as `Model.Ref.parse`); no `#` means no variant.
- `sendMessage` = `switchAgent` (if agent) -> `switchModel` (if model) -> `prompt({sessionID, text})`. Agent first, because switching agent can reset the model. Sessions are reused across fallback attempts, so the model must be applied per send. These are extra awaited requests but none wait for the turn.
- `abortSession` -> `interrupt`; returns `true` on any successful request (including `interrupted: false`), `false` on error.
- `deleteSession` -> `remove`. `createSession` reads `result.id`.
- `showToast(title, message, variant, duration?)` no longer takes a client and is a logged no-op (`console.info`).

## ctx.event (`dist/promise/event.d.ts`)

`ctx.event.subscribe(options?: { signal?: AbortSignal; onActivity?: () => void }) -> AsyncIterable<V2Event>` (async iterable, not a callback). `V2Event` = union in `@opencode/client/dist/promise/generated/types.d.ts`. Every event has `{ id, created, type, location?, data }`; payload is in **`event.data`**, not `event.properties`.

- `session.idle`: `data: { sessionID }`
- `session.status`: `data: { sessionID, status: {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, next, action?} }`
- **There is no `session.error` event.** Failures are `session.execution.failed`: `data: { sessionID, error: { type, message, status?, response?: {body} } }`. Related: `session.execution.succeeded` (`data.sessionID`), `session.execution.interrupted` (`data: { sessionID, reason: "user"|"shutdown"|"superseded"|"inactivity" }`), `session.step.failed` (`data.error`, per step), `session.retry.scheduled` (`data: { sessionID, attempt, at, error }`), `session.deleted` (`data.sessionID`).
- `error` is a plain structured object (`message`, optional HTTP `status`), not v1's `{ name, data: {message} }`; `classifyError` must be adapted in the harness task.

## ctx.tool (`dist/promise/tool.d.ts`, `@opencode/schema/dist/tool.d.ts`)

```ts
ctx.tool.transform((editor) => editor.add({
  name: string,
  description: string,
  input: JsonSchema | Schema.Codec | StandardSchemaV1,   // plain JSON Schema object is accepted
  output?: ..., options?: { namespace?, permission?, codemode?, pinned? },
  execute: async (input, context) => ({ content?: string | Array<{type:"text",text}|{type:"file",uri,mime,name?}>, output?, metadata? }),
})): Promise<Registration>   // registration.dispose()
```

`context` (`ToolContext`): `{ sessionID, agent, messageID, id (call id), signal: AbortSignal, progress(update): Promise<void> }`. `editor` also has `list/get/namespace/update/remove`. `ctx.tool.hook("execute.before"|"execute.after", cb)` exposes `{tool, sessionID, agent, messageID, id, input}` (+ `result` / `error` after).
Differences: `content` is optional and may be a plain string; `output` is the structured result; there is no `{ title }`. Tool name is the explicit `name` field (previously the object key).

## Toast / TUI notifications

None on the server plugin ctx. `Toast.show()` exists only in the TUI plugin API (`@opencode/plugin/tui`, `dist/tui/context.d.ts`). `tui.toast.show` is an event type that appears in `V2Event`, not a call.

## Subagent tool (renamed from `task`)

Implemented in core, not in `node_modules`; this section is from `anomalyco/opencode` branch `v2`, `packages/core/src/tool/plugin/subagent.ts` and https://opencode.ai/v2/docs/tools/. Verify against the running opencode if behaviour matters.

- Name `subagent`; input `{ agent, description, prompt, model?: "provider/model[#variant]", sessionID?, background? }`. `sessionID` continues an existing child.
- Result (also reachable via `execute.after` hook `result`):
  - `metadata: { sessionID: <child id>, status: "completed" | "running" }`; `output: { sessionID, status, output }`.
  - completed `content`: `<subagent sessionID="ses_..." state="completed">\n<final text>\n</subagent>`.
  - background `content`: `The subagent is working in the background (sessionID: ses_...). ...`.
  - failure/cancel throws a ToolFailure: `Subagent failed (sessionID: ses_...): <error>` / `Subagent cancelled (sessionID: ses_...)`.
- v1 `task` printed `task_id: ses_...` plus `<task_result>`; that format is gone. The child id is also available earlier, as `session.created` events with `parentID`, and `context.progress({ sessionID, status: "running" })` when the child starts.
- Permission action is `subagent` with the agent id as resource; default nesting depth is 1.

## Tooling

- `typescript` resolved to `7.0.2`; `npm --prefix plugin run typecheck` runs `tsc --noEmit`. `skipLibCheck` was enabled in `plugin/tsconfig.json` (`json-schema` types missing from `@ai-sdk/provider`, duplicate `containSubset` in chai/vitest).

## harness.ts migration decisions

- **Entrypoint**: `Plugin.define({ id: "openagent-harness", setup(ctx) })`; `ctx.session` is passed to every `client.ts` helper. `setup` returns an async cleanup that clears the 500ms tick `setInterval`, aborts the `ctx.event.subscribe` signal, disposes the tool/hook registrations and frees the DAG. The v1 `process.on("exit"|"SIGTERM"|"SIGINT")` handlers were dropped (the host owns the lifecycle; a plugin must not `process.exit`). No `ctx.location.directory` use was needed: `harness.ts` never read a directory/worktree (`plans.ts`/`memory.ts` still use `process.cwd()`).
- **Tool names are NOT namespaced.** `editor.add({ name })` uses the explicit name and `options.namespace` is optional, so all 13 tools keep their v1 names. No agent/skill rename is required.
- **Tools** are registered in one `ctx.tool.transform` callback with plain JSON Schema inputs (`plugin/json-schema.ts`: closed objects, required unless `optional()`). `execute` returns `{ content: <string> }`. Agent gating uses `context.agent` (orchestrator: `submit_workflow`/`submit_plan`; planner: `plan_task`/`save_plan`).
- **Events** (payload in `event.data`; the Rust engine still receives the v1 names):
  - `session.idle` and `session.status` with `status.type === "idle"` -> `process_event("session.idle", sessionID, JSON(data))`. De-duplicated per session: a second idle within 2s with no `busy`/`retry` status in between is dropped (a busy/retry status resets the marker so reused sessions are never swallowed).
  - `session.execution.failed` -> `process_event("session.error", sessionID, {"sessionID", "error": <string>})`. The error string comes from `extractErrorMessage` in `errors.ts` (`<type|name>: <message> (HTTP <status>)`; also accepts the v1 `{ name, data: { message, statusCode } }` union). The Rust engine reads `payload.error` as a string, so passing a string (v1 passed an object) also fixes the old "unknown error" fallback.
  - `session.execution.interrupted` / `succeeded` / `retry.scheduled` are ignored.
  - `orphanedIdleEvents`, `orphanedErrorEvents` and the `cancelledSessions` guard are kept. The guard is applied after the idle de-dupe so the second idle signal of a cancelled session is not buffered as an orphan.
- **Error classification** (`classifyError`): terminal patterns (`ProviderAuthError`, `ContextOverflowError`, `MessageAbortedError`, content policy/filter, invalid API key, `HTTP 401/403`) are checked before retryable ones. Retryable also matches `HTTP 5xx`.
- **tool.execute.after** -> `ctx.tool.hook("execute.after", ...)`; forwards `{ tool, callID: event.id, args: event.input, result }` where `result` is the string flattened from `result.content` (string, or joined text parts) falling back to a string `result.output`; no result for `status: "error"`. `tool.execute.before` was an empty no-op and is dropped.
- **Native dispatch** text now names the `subagent` tool (`agent`, `description`, `prompt`) and tells the orchestrator to read the child id from `<subagent sessionID="ses_..." state="completed">` or `Subagent failed (sessionID: ses_...)`. `agents/orchestrator.md` already described this format. Fallback model for a re-spawned native task can now be passed as the `subagent` tool's `model` input.
- **Rust/WASM**: untouched (`src/*.rs`, `plugin/wasm/`).

## Agent frontmatter and install (v2)

Sources: https://opencode.ai/v2/docs/{agents,permissions,skills}, `@opencode/schema` `config/agent.d.ts` (`ConfigAgent.Info`), and `https://opencode.ai/config.json`. The published `config.json` still describes the **v1** schema (`agent`, `permission`, `prompt`, `disable`); the installed `@opencode/schema` and the v2 docs are authoritative.

- v2 agent fields (`ConfigAgent.Info`): `model`, `request`, `system`, `description`, `mode` (`primary|subagent|all`), `hidden`, `color`, `steps`, `disabled`, `permissions`. The Markdown body is `system`. Legacy `permission`, `tools`, `prompt`, `disable`, `temperature`, `top_p`, `maxSteps` are not valid for new v2 agents.
- **Per-agent `mcp:` and `skills:` lists are NOT valid v2 frontmatter.** `mcp` (server definitions) and `skills` (extra source paths) exist only at the top level of the config, with different meaning. v2 equivalents are all `permissions` rules:
  - MCP grant: `{ action: <server>_*, resource: "*", effect: allow }` (MCP actions are `<server>_<tool>`). Server definitions stay in the user's `opencode.json` `mcp` (see `install.sh`).
  - Skill grant: `{ action: skill, resource: <skill-id>, effect: allow }`.
  - Plugin tools (`plan_task`, `save_plan`, `harness_cancel`): `{ action: <tool>, resource: "*", effect: allow }`.
- The base policy is `* * allow` and the last matching rule wins, so these allow rules are explicit grants, not an allowlist. Planner's `subagent` rules keep the broad deny first, then explorer/researcher/vision allows. A true "only plan_task/save_plan" tool allowlist would need a leading `* * deny`, which was not added because it would also block the read/glob/grep tools the agents use. Verify against a running opencode before tightening.
- Model: `provider/model[#variant]`. `fallback_models` is harness-specific (not an opencode field), read only by `src/agents.rs`; confirm opencode tolerates the unknown frontmatter key.
- `parse_agent_frontmatter` reads only column-0 `model:` / `fallback_models:` keys, so the `permissions:` list is ignored. It keeps `#variant` (`#` starts a comment only after whitespace), strips quotes and trailing comments, and accepts flow lists. The plugin's `parseModel` does not split `#variant`; `toModelRef` in `plugin/client.ts` does.
- Discovery paths unchanged: `~/.config/opencode/agents/<name>.md` and `~/.config/opencode/skills/<id>/SKILL.md` (project `.opencode/...`; `~/.claude/skills` and `~/.agents/skills` are compatibility sources).
- Stale v1 agents: `src/install.rs` `is_stale_v1_agent` (top-level `permission:` key in frontmatter) makes `install` overwrite an existing file without `--force`. The plugin-side equivalent in `harness.ts` `installAgentsIfNeeded` is a TODO.
- Body references: the `task` tool is now `subagent`; the child session id is the `sessionID` attribute of `<subagent sessionID="..." state="completed">`, not a `task_id:` prefix.
