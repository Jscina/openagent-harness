use std::collections::HashMap;

use crate::types::*;

const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4-6";

/// Synchronous DAG state machine.
///
/// This struct contains the full logic and is always compiled.  On WASM
/// targets a thin `WasmDagEngine` newtype wraps it and exports the same
/// interface to JavaScript.
pub struct DagEngine {
    nodes: HashMap<String, Node>,
    workflows: HashMap<String, Workflow>,
    session_to_task: HashMap<String, String>,
}

impl Default for DagEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl DagEngine {
    pub fn new() -> Self {
        DagEngine {
            nodes: HashMap::new(),
            workflows: HashMap::new(),
            session_to_task: HashMap::new(),
        }
    }

    /// Submit a workflow.  Returns JSON `{workflow_id, task_ids}` or an error
    /// message string.
    pub fn submit_workflow(&mut self, tasks_json: &str) -> Result<String, String> {
        let tasks: Vec<WorkflowTaskInput> =
            serde_json::from_str(tasks_json).map_err(|e| format!("invalid tasks JSON: {e}"))?;

        if tasks.is_empty() {
            return Err("workflow must have at least one task".into());
        }

        for (i, task) in tasks.iter().enumerate() {
            for &dep in &task.depends_on {
                if dep >= tasks.len() {
                    return Err(format!(
                        "task {i} depends_on index {dep} is out of bounds (only {} tasks)",
                        tasks.len()
                    ));
                }
            }
        }

        let ids: Vec<String> = tasks
            .iter()
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect();
        let workflow_id = uuid::Uuid::new_v4().to_string();

        for (i, task) in tasks.iter().enumerate() {
            let dep_ids: Vec<String> = task
                .depends_on
                .iter()
                .map(|&idx| ids[idx].clone())
                .collect();
            let model = task
                .model
                .as_deref()
                .filter(|m| !m.is_empty())
                .unwrap_or(DEFAULT_MODEL)
                .to_string();
            self.nodes.insert(
                ids[i].clone(),
                Node {
                    id: ids[i].clone(),
                    task: Task {
                        id: ids[i].clone(),
                        prompt: task.prompt.clone(),
                        model,
                        agent: Some(task.agent.clone()),
                        session_id: None,
                        status: TaskStatus::Pending,
                        output: None,
                    },
                    depends_on: dep_ids,
                    workflow_id: Some(workflow_id.clone()),
                },
            );
        }

        self.workflows.insert(
            workflow_id.clone(),
            Workflow {
                id: workflow_id.clone(),
                status: WorkflowStatus::Running,
                tasks: ids.clone(),
            },
        );

        Ok(serde_json::json!({ "workflow_id": workflow_id, "task_ids": ids }).to_string())
    }

    /// Mark all unblocked Pending tasks as Running; return them as JSON.
    ///
    /// Returns JSON `[{id, prompt, model, agent}, ...]`.
    pub fn tick(&mut self) -> String {
        let ready_ids: Vec<String> = self
            .nodes
            .iter()
            .filter(|(_, n)| matches!(n.task.status, TaskStatus::Pending))
            .filter(|(_, n)| {
                n.depends_on.iter().all(|dep_id| {
                    self.nodes
                        .get(dep_id)
                        .is_some_and(|d| matches!(d.task.status, TaskStatus::Done))
                })
            })
            .map(|(id, _)| id.clone())
            .collect();

        let mut started: Vec<ReadyTask> = Vec::new();
        for id in ready_ids {
            if let Some(node) = self.nodes.get_mut(&id) {
                node.task.status = TaskStatus::Running;
                started.push(ReadyTask {
                    id: id.clone(),
                    prompt: node.task.prompt.clone(),
                    model: node.task.model.clone(),
                    agent: node.task.agent.clone(),
                });
            }
        }

        serde_json::to_string(&started).unwrap_or_else(|_| "[]".to_string())
    }

    /// Record that `task_id` now has an active session `session_id`.
    pub fn task_started(&mut self, task_id: &str, session_id: &str) {
        if let Some(node) = self.nodes.get_mut(task_id) {
            node.task.session_id = Some(session_id.to_string());
        }
        self.session_to_task
            .insert(session_id.to_string(), task_id.to_string());
    }

    /// Handle a session event; returns `{notifications, delete_session}` JSON.
    pub fn process_event(
        &mut self,
        event_type: &str,
        session_id: &str,
        payload_json: &str,
    ) -> String {
        let payload: serde_json::Value =
            serde_json::from_str(payload_json).unwrap_or(serde_json::Value::Null);

        let mut result = EventResult {
            notifications: vec![],
            delete_session: None,
        };

        match event_type {
            "session.idle" => {
                let task_id = match self.session_to_task.get(session_id) {
                    Some(id) => id.clone(),
                    None => return Self::encode(&result),
                };

                if let Some(node) = self.nodes.get_mut(&task_id)
                    && matches!(node.task.status, TaskStatus::Running)
                {
                    node.task.status = TaskStatus::Done;
                }

                let wf = self.update_workflow_status(&task_id);
                self.push_workflow_notification(&wf, &mut result.notifications);
                self.session_to_task.remove(session_id);
                result.delete_session = Some(session_id.to_string());
            }

            "session.error" => {
                let task_id = match self.session_to_task.get(session_id) {
                    Some(id) => id.clone(),
                    None => return Self::encode(&result),
                };

                let error_msg = payload
                    .get("error")
                    .or_else(|| payload.get("message"))
                    .or_else(|| payload.get("reason"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error")
                    .to_string();

                let is_workflow = self
                    .nodes
                    .get(&task_id)
                    .and_then(|n| n.workflow_id.as_ref())
                    .is_some();

                if let Some(node) = self.nodes.get_mut(&task_id)
                    && matches!(node.task.status, TaskStatus::Running)
                {
                    node.task.status = TaskStatus::Failed(error_msg.clone());
                }

                let wf = self.update_workflow_status(&task_id);
                if wf.is_some() {
                    self.push_workflow_notification(&wf, &mut result.notifications);
                } else if !is_workflow {
                    let short: String = error_msg.chars().take(80).collect();
                    result.notifications.push(Notification::Toast {
                        title: "Task failed".to_string(),
                        message: short,
                        variant: "error".to_string(),
                        duration: Some(12_000),
                    });
                }

                self.session_to_task.remove(session_id);
                result.delete_session = Some(session_id.to_string());
            }

            "tool.execute.after" => {
                let task_id = match self.session_to_task.get(session_id) {
                    Some(id) => id.clone(),
                    None => return Self::encode(&result),
                };

                let tool_result = match payload.get("result").and_then(|v| v.as_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => return Self::encode(&result),
                };

                if let Some(node) = self.nodes.get_mut(&task_id) {
                    let out = node.task.output.get_or_insert_with(String::new);
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(&tool_result);
                }
            }

            _ => {}
        }

        Self::encode(&result)
    }

    /// JSON `Task` for `id`, or `"null"`.
    pub fn get_task(&self, id: &str) -> String {
        match self.nodes.get(id) {
            Some(n) => serde_json::to_string(&n.task).unwrap_or_else(|_| "null".to_string()),
            None => "null".to_string(),
        }
    }

    /// JSON array of all tasks.
    pub fn list_tasks(&self) -> String {
        let tasks: Vec<&Task> = self.nodes.values().map(|n| &n.task).collect();
        serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string())
    }

    /// JSON `Workflow` for `id`, or `"null"`.
    pub fn get_workflow(&self, id: &str) -> String {
        match self.workflows.get(id) {
            Some(wf) => serde_json::to_string(wf).unwrap_or_else(|_| "null".to_string()),
            None => "null".to_string(),
        }
    }

    /// Cancel a task.  Returns JSON `{session_id: string|null}` or an error string.
    pub fn cancel_task(&mut self, id: &str) -> Result<String, String> {
        let node = self
            .nodes
            .get_mut(id)
            .ok_or_else(|| format!("task {id} not found"))?;

        if matches!(node.task.status, TaskStatus::Done | TaskStatus::Failed(_)) {
            return Err(format!("task {id} is already terminal"));
        }

        node.task.status = TaskStatus::Failed("cancelled".to_string());
        let session_id = node.task.session_id.clone();
        if let Some(ref sid) = session_id {
            self.session_to_task.remove(sid);
        }

        Ok(serde_json::json!({ "session_id": session_id }).to_string())
    }

    fn update_workflow_status(&mut self, task_id: &str) -> Option<WorkflowStatus> {
        let workflow_id = self.nodes.get(task_id)?.workflow_id.as_ref()?.clone();

        let task_ids: Vec<String> = match self.workflows.get(&workflow_id) {
            Some(w) if matches!(w.status, WorkflowStatus::Running) => w.tasks.clone(),
            _ => return None,
        };

        let mut all_terminal = true;
        let mut first_failure: Option<(String, String)> = None;

        for tid in &task_ids {
            match self.nodes.get(tid).map(|n| &n.task.status) {
                Some(TaskStatus::Done) => {}
                Some(TaskStatus::Failed(reason)) => {
                    if first_failure.is_none() {
                        first_failure = Some((tid.clone(), reason.clone()));
                    }
                }
                _ => {
                    all_terminal = false;
                }
            }
        }

        if !all_terminal {
            return None;
        }

        let wf = self.workflows.get_mut(&workflow_id).unwrap();
        wf.status = match first_failure {
            Some((fid, reason)) => WorkflowStatus::Failed {
                task_id: fid,
                reason,
            },
            None => WorkflowStatus::Done,
        };
        Some(wf.status.clone())
    }

    fn push_workflow_notification(
        &self,
        wf_status: &Option<WorkflowStatus>,
        notifications: &mut Vec<Notification>,
    ) {
        match wf_status {
            Some(WorkflowStatus::Done) => notifications.push(Notification::Toast {
                title: "Workflow complete".to_string(),
                message: "All tasks finished successfully".to_string(),
                variant: "success".to_string(),
                duration: None,
            }),
            Some(WorkflowStatus::Failed { reason, .. }) => {
                let short: String = reason.chars().take(80).collect();
                notifications.push(Notification::Toast {
                    title: "Workflow failed".to_string(),
                    message: short,
                    variant: "error".to_string(),
                    duration: Some(12_000),
                });
            }
            _ => {}
        }
    }

    #[inline]
    fn encode(result: &EventResult) -> String {
        serde_json::to_string(result)
            .unwrap_or_else(|_| r#"{"notifications":[],"delete_session":null}"#.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_workflow_rejects_empty() {
        let mut dag = DagEngine::new();
        assert!(dag.submit_workflow("[]").is_err());
    }

    #[test]
    fn submit_workflow_rejects_out_of_bounds_dep() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "b", "prompt": "p", "depends_on": [5]}]);
        let err = dag.submit_workflow(&tasks.to_string()).unwrap_err();
        assert!(err.contains("out of bounds"), "unexpected: {err}");
    }

    #[test]
    fn submit_workflow_creates_pending_tasks() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "explorer", "prompt": "map it", "depends_on": []},
            {"agent": "builder", "prompt": "build it", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        assert!(resp["workflow_id"].is_string());
        assert_eq!(resp["task_ids"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn submit_workflow_uses_default_model_when_empty() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "explorer", "prompt": "p", "depends_on": [], "model": ""}
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let id = resp["task_ids"][0].as_str().unwrap();
        let task: serde_json::Value = serde_json::from_str(&dag.get_task(id)).unwrap();
        assert_eq!(task["model"], DEFAULT_MODEL);
    }

    #[test]
    fn tick_starts_no_dep_task() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "go", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let id = resp["task_ids"][0].as_str().unwrap();

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready.as_array().unwrap().len(), 1);
        assert_eq!(ready[0]["id"], id);
    }

    #[test]
    fn tick_blocks_task_with_unmet_dep() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first",  "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        dag.submit_workflow(&tasks.to_string()).unwrap();

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready.as_array().unwrap().len(), 1);
        assert_eq!(ready[0]["prompt"], "first");

        let ready2: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready2.as_array().unwrap().len(), 0);
    }

    #[test]
    fn session_idle_marks_task_done() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_1");

        let result: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_1", "null")).unwrap();
        assert_eq!(result["delete_session"], "ses_1");

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["status"]["type"], "done");
    }

    #[test]
    fn session_idle_unknown_is_noop() {
        let mut dag = DagEngine::new();
        let r: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ghost", "null")).unwrap();
        assert!(r["delete_session"].is_null());
        assert_eq!(r["notifications"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn session_error_marks_task_failed() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_err");

        dag.process_event(
            "session.error",
            "ses_err",
            &serde_json::json!({"error": "rate limit"}).to_string(),
        );

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["status"]["type"], "failed");
        assert_eq!(task["status"]["message"], "rate limit");
    }

    #[test]
    fn tool_after_appends_output() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_t");
        dag.process_event(
            "tool.execute.after",
            "ses_t",
            &serde_json::json!({"result": "line 1"}).to_string(),
        );
        dag.process_event(
            "tool.execute.after",
            "ses_t",
            &serde_json::json!({"result": "line 2"}).to_string(),
        );

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["output"], "line 1\nline 2");
    }

    #[test]
    fn tool_after_ignores_empty_result() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_empty");
        dag.process_event(
            "tool.execute.after",
            "ses_empty",
            &serde_json::json!({"result": ""}).to_string(),
        );

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert!(task["output"].is_null());
    }

    #[test]
    fn workflow_done_when_all_tasks_complete() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t1", "depends_on": []},
            {"agent": "b", "prompt": "t2", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let (id0, id1) = (ids[0].as_str().unwrap(), ids[1].as_str().unwrap());

        dag.tick();
        dag.task_started(id0, "s0");
        dag.task_started(id1, "s1");

        dag.process_event("session.idle", "s0", "null");
        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "running");

        let result: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "s1", "null")).unwrap();
        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "done");
        let notifs = result["notifications"].as_array().unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0]["variant"], "success");
    }

    #[test]
    fn workflow_failed_when_task_errors() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_fail");

        dag.process_event(
            "session.error",
            "ses_fail",
            &serde_json::json!({"error": "model refused"}).to_string(),
        );

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "failed");
        assert_eq!(wf["status"]["reason"], "model refused");
    }

    #[test]
    fn workflow_stays_running_while_tasks_pending() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t1", "depends_on": []},
            {"agent": "b", "prompt": "t2", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let id0 = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(id0, "s0");
        dag.process_event("session.idle", "s0", "null");

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "running");
    }

    #[test]
    fn cancel_running_task_returns_session_id() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_c");

        let cancel: serde_json::Value =
            serde_json::from_str(&dag.cancel_task(task_id).unwrap()).unwrap();
        assert_eq!(cancel["session_id"], "ses_c");

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["status"]["type"], "failed");
        assert_eq!(task["status"]["message"], "cancelled");
    }

    #[test]
    fn cancel_done_task_errors() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_d");
        dag.process_event("session.idle", "ses_d", "null");

        assert!(dag.cancel_task(task_id).is_err());
    }

    #[test]
    fn cancel_unknown_task_errors() {
        let mut dag = DagEngine::new();
        assert!(dag.cancel_task("nope").is_err());
    }

    #[test]
    fn session_mapping_removed_after_idle() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_clean");
        dag.process_event("session.idle", "ses_clean", "null");

        // A second idle for the same session is a no-op.
        let r: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_clean", "null")).unwrap();
        assert!(r["delete_session"].is_null());
    }
}
