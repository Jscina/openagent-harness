/* tslint:disable */
/* eslint-disable */

/**
 * WASM-exported DAG engine.  JavaScript sees this as `DagEngine`.
 */
export class DagEngine {
    free(): void;
    [Symbol.dispose](): void;
    cancel_task(id: string): string;
    fail_task(id: string, reason: string): string;
    get_task(id: string): string;
    get_workflow(id: string): string;
    get_workflow_snapshot(id: string): string;
    list_tasks(): string;
    list_workflow_summaries(): string;
    constructor();
    process_event(event_type: string, session_id: string, payload_json: string): string;
    set_agent_fallbacks(json: string): void;
    submit_workflow(tasks_json: string, parent_session_id?: string | null): string;
    task_started(task_id: string, session_id: string): void;
    tick(): string;
    try_fallback(task_id: string, error_msg: string): string;
}

/**
 * Return all agent configs as a JSON object `{name: content, ...}`.
 *
 * The TypeScript plugin calls this on first boot and writes each file
 * to `~/.config/opencode/agents/`.
 */
export function get_agent_configs(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly get_agent_configs: () => [number, number];
    readonly __wbg_dagengine_free: (a: number, b: number) => void;
    readonly wasmdagengine_new: () => number;
    readonly wasmdagengine_submit_workflow: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmdagengine_tick: (a: number) => [number, number];
    readonly wasmdagengine_task_started: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly wasmdagengine_process_event: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly wasmdagengine_get_task: (a: number, b: number, c: number) => [number, number];
    readonly wasmdagengine_list_tasks: (a: number) => [number, number];
    readonly wasmdagengine_get_workflow: (a: number, b: number, c: number) => [number, number];
    readonly wasmdagengine_get_workflow_snapshot: (a: number, b: number, c: number) => [number, number];
    readonly wasmdagengine_list_workflow_summaries: (a: number) => [number, number];
    readonly wasmdagengine_fail_task: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wasmdagengine_cancel_task: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmdagengine_set_agent_fallbacks: (a: number, b: number, c: number) => void;
    readonly wasmdagengine_try_fallback: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
