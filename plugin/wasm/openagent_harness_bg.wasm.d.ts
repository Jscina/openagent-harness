/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const get_agent_configs: () => [number, number];
export const __wbg_dagengine_free: (a: number, b: number) => void;
export const wasmdagengine_new: () => number;
export const wasmdagengine_submit_workflow: (a: number, b: number, c: number) => [number, number, number, number];
export const wasmdagengine_tick: (a: number) => [number, number];
export const wasmdagengine_task_started: (a: number, b: number, c: number, d: number, e: number) => void;
export const wasmdagengine_process_event: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
export const wasmdagengine_get_task: (a: number, b: number, c: number) => [number, number];
export const wasmdagengine_list_tasks: (a: number) => [number, number];
export const wasmdagengine_get_workflow: (a: number, b: number, c: number) => [number, number];
export const wasmdagengine_cancel_task: (a: number, b: number, c: number) => [number, number, number, number];
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
