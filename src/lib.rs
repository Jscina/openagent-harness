//! openagent-harness — WASM DAG state machine + embedded agent configs.
//!
//! # Crate layout
//!
//! ```text
//! src/lib.rs        — Entry point, re-exports modules, declares WASM bindings
//! src/agents.rs     — Embedded AGENTS constant and configs
//! src/types.rs      — Task, Node, Workflow, Status enums, and request/response structs
//! src/dag.rs        — core DagEngine (pure Rust, always compiled)
//! src/install.rs    — native-only: write agent files to disk
//! src/main.rs       — native-only: install subcommand CLI
//! ```

#[cfg(not(target_arch = "wasm32"))]
pub mod install;

pub mod agents;
pub mod dag;
pub mod types;

pub use agents::AGENTS;
pub use dag::DagEngine;

// ─── WASM bindings (wasm32-only) ──────────────────────────────────────────────
//
// `WasmDagEngine` is a newtype wrapper around `DagEngine`.  It is exported to
// JavaScript as `DagEngine` via `js_name`.  Errors are converted from `String`
// to `JsValue` at the boundary.

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    /// Return all agent configs as a JSON object `{name: content, ...}`.
    ///
    /// The TypeScript plugin calls this on first boot and writes each file
    /// to `~/.config/opencode/agents/`.
    #[wasm_bindgen]
    pub fn get_agent_configs() -> String {
        crate::agents::agent_configs_json()
    }

    /// WASM-exported DAG engine.  JavaScript sees this as `DagEngine`.
    #[wasm_bindgen(js_name = "DagEngine")]
    pub struct WasmDagEngine(crate::dag::DagEngine);

    impl Default for WasmDagEngine {
        fn default() -> Self {
            Self::new()
        }
    }

    #[wasm_bindgen]
    impl WasmDagEngine {
        #[wasm_bindgen(constructor)]
        pub fn new() -> WasmDagEngine {
            console_error_panic_hook::set_once();
            WasmDagEngine(crate::dag::DagEngine::new())
        }

        pub fn submit_workflow(
            &mut self,
            tasks_json: &str,
            parent_session_id: Option<String>,
        ) -> Result<String, JsValue> {
            self.0
                .submit_workflow_with_parent_session(tasks_json, parent_session_id.as_deref())
                .map_err(|e| JsValue::from_str(&e))
        }

        pub fn tick(&mut self) -> String {
            self.0.tick()
        }

        pub fn task_started(&mut self, task_id: &str, session_id: &str) {
            self.0.task_started(task_id, session_id);
        }

        pub fn process_event(
            &mut self,
            event_type: &str,
            session_id: &str,
            payload_json: &str,
        ) -> String {
            self.0.process_event(event_type, session_id, payload_json)
        }

        pub fn get_task(&self, id: &str) -> String {
            self.0.get_task(id)
        }

        pub fn list_tasks(&self) -> String {
            self.0.list_tasks()
        }

        pub fn get_workflow(&self, id: &str) -> String {
            self.0.get_workflow(id)
        }

        pub fn get_workflow_snapshot(&self, id: &str) -> String {
            self.0.get_workflow_snapshot(id)
        }

        pub fn list_workflow_summaries(&self) -> String {
            self.0.list_workflow_summaries()
        }

        pub fn fail_task(&mut self, id: &str, reason: &str) -> Result<String, JsValue> {
            self.0
                .fail_task(id, reason)
                .map_err(|e| JsValue::from_str(&e))
        }

        pub fn cancel_task(&mut self, id: &str) -> Result<String, JsValue> {
            self.0.cancel_task(id).map_err(|e| JsValue::from_str(&e))
        }

        pub fn set_agent_fallbacks(&mut self, json: &str) {
            self.0.set_agent_fallbacks(json);
        }

        pub fn try_fallback(&mut self, task_id: &str, error_msg: &str) -> Result<String, JsValue> {
            self.0
                .try_fallback(task_id, error_msg)
                .map_err(|e| JsValue::from_str(&e))
        }

        pub fn submit_review(
            &mut self,
            task_id: &str,
            review_json: &str,
        ) -> Result<String, JsValue> {
            self.0
                .submit_review(task_id, review_json)
                .map_err(|e| JsValue::from_str(&e))
        }
    }
}
