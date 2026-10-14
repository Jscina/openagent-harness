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
- `harness.ts` / `harness.test.ts` still import `@opencode-ai/plugin` and use the v1 client; migrated in the follow-up task.
