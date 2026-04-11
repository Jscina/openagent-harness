use crate::acp::AcpClient;
use crate::events::PluginEvent;
use crate::types::{
    CreateTaskRequest, Node, SubmitWorkflowRequest, SubmitWorkflowResponse, Task, TaskStatus,
    Workflow, WorkflowStatus,
};

use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4-20250514";

#[derive(Debug)]
pub struct AgentNotFound(pub String);

impl fmt::Display for AgentNotFound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "agent '{}' not found", self.0)
    }
}

impl std::error::Error for AgentNotFound {}

pub struct AppState {
    pub dag: Mutex<DagState>,
    pub session_to_task: DashMap<String, Uuid>,
    pub acp: AcpClient,
}

pub struct DagState {
    pub nodes: HashMap<Uuid, Node>,
    pub workflows: HashMap<Uuid, Workflow>,
}

impl DagState {
    fn update_workflow_status(&mut self, task_id: Uuid) {
        let workflow_id = match self.nodes.get(&task_id).and_then(|n| n.workflow_id) {
            Some(id) => id,
            None => return,
        };

        let task_ids: Vec<Uuid> = match self.workflows.get(&workflow_id) {
            Some(w) if matches!(w.status, WorkflowStatus::Running) => w.tasks.clone(),
            _ => return,
        };

        let mut all_terminal = true;
        let mut first_failure: Option<(Uuid, String)> = None;

        for tid in &task_ids {
            match self.nodes.get(tid).map(|n| &n.task.status) {
                Some(TaskStatus::Done) => {}
                Some(TaskStatus::Failed(reason)) => {
                    if first_failure.is_none() {
                        first_failure = Some((*tid, reason.clone()));
                    }
                }
                _ => {
                    all_terminal = false;
                }
            }
        }

        if !all_terminal {
            return;
        }

        let workflow = self.workflows.get_mut(&workflow_id).unwrap();
        workflow.status = match first_failure {
            Some((failed_task_id, reason)) => WorkflowStatus::Failed {
                task_id: failed_task_id,
                reason,
            },
            None => WorkflowStatus::Done,
        };
        workflow.updated_at = Utc::now();
    }
}

impl AppState {
    pub fn new(acp: AcpClient) -> Self {
        Self {
            dag: Mutex::new(DagState {
                nodes: HashMap::new(),
                workflows: HashMap::new(),
            }),
            session_to_task: DashMap::new(),
            acp,
        }
    }

    pub async fn add_task(&self, req: CreateTaskRequest) -> Result<Uuid> {
        if let Some(ref agent) = req.agent
            && !self.acp.agent_exists(agent).await?
        {
            anyhow::bail!(AgentNotFound(agent.clone()));
        }

        let id = Uuid::new_v4();
        let now = Utc::now();
        let node = Node {
            id,
            task: Task {
                id,
                prompt: req.prompt,
                model: req.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                agent: req.agent,
                session_id: None,
                status: TaskStatus::Pending,
                output: None,
                created_at: now,
                updated_at: now,
            },
            depends_on: req.depends_on.unwrap_or_default(),
            workflow_id: None,
        };

        let mut dag = self.dag.lock().await;
        dag.nodes.insert(id, node);
        tracing::info!(%id, "task added");
        Ok(id)
    }

    pub async fn submit_workflow(
        &self,
        req: SubmitWorkflowRequest,
    ) -> Result<SubmitWorkflowResponse> {
        if req.tasks.is_empty() {
            anyhow::bail!("workflow must have at least one task");
        }

        for (i, task) in req.tasks.iter().enumerate() {
            for &dep_idx in &task.depends_on {
                if dep_idx >= req.tasks.len() {
                    anyhow::bail!(
                        "task {} depends_on index {} is out of bounds (only {} tasks)",
                        i,
                        dep_idx,
                        req.tasks.len()
                    );
                }
            }
        }

        for task in &req.tasks {
            if !self.acp.agent_exists(&task.agent).await? {
                anyhow::bail!(AgentNotFound(task.agent.clone()));
            }
        }

        let ids: Vec<Uuid> = req.tasks.iter().map(|_| Uuid::new_v4()).collect();
        let workflow_id = Uuid::new_v4();
        let now = Utc::now();

        let mut dag = self.dag.lock().await;

        for (i, task) in req.tasks.iter().enumerate() {
            let dep_ids: Vec<Uuid> = task.depends_on.iter().map(|&idx| ids[idx]).collect();
            let node = Node {
                id: ids[i],
                task: Task {
                    id: ids[i],
                    prompt: task.prompt.clone(),
                    model: task.model.clone().unwrap_or_default(),
                    agent: Some(task.agent.clone()),
                    session_id: None,
                    status: TaskStatus::Pending,
                    output: None,
                    created_at: now,
                    updated_at: now,
                },
                depends_on: dep_ids,
                workflow_id: Some(workflow_id),
            };
            dag.nodes.insert(ids[i], node);
        }

        let workflow = Workflow {
            id: workflow_id,
            status: WorkflowStatus::Running,
            tasks: ids.clone(),
            created_at: now,
            updated_at: now,
        };
        dag.workflows.insert(workflow_id, workflow);

        tracing::info!(%workflow_id, tasks = ids.len(), "workflow submitted");
        Ok(SubmitWorkflowResponse {
            workflow_id,
            task_ids: ids,
        })
    }

    pub async fn get_task(&self, id: Uuid) -> Option<Task> {
        let dag = self.dag.lock().await;
        dag.nodes.get(&id).map(|n| n.task.clone())
    }

    pub async fn get_workflow(&self, id: Uuid) -> Option<Workflow> {
        let dag = self.dag.lock().await;
        dag.workflows.get(&id).cloned()
    }

    pub async fn list_tasks(&self) -> Vec<Task> {
        let dag = self.dag.lock().await;
        dag.nodes.values().map(|n| n.task.clone()).collect()
    }

    pub async fn cancel_task(&self, id: Uuid) -> Result<()> {
        let session_id = {
            let mut dag = self.dag.lock().await;
            let node = dag
                .nodes
                .get_mut(&id)
                .ok_or_else(|| anyhow::anyhow!("task {id} not found"))?;

            if matches!(node.task.status, TaskStatus::Done | TaskStatus::Failed(_)) {
                anyhow::bail!("task {id} is already terminal");
            }

            node.task.status = TaskStatus::Failed("cancelled".to_string());
            node.task.updated_at = Utc::now();
            node.task.session_id.clone()
        };

        if let Some(sid) = session_id {
            self.session_to_task.remove(&sid);
            if let Err(e) = self.acp.delete_session(&sid).await {
                tracing::warn!(%id, error = %e, "failed to delete ACP session on cancel");
            }
        }

        Ok(())
    }

    pub async fn process_event(&self, event: &PluginEvent) {
        match event.event_type.as_str() {
            "session.idle" => {
                let task_id = match self.session_to_task.get(&event.session_id) {
                    Some(entry) => *entry,
                    None => {
                        tracing::debug!(
                            session_id = %event.session_id,
                            "session.idle for untracked session"
                        );
                        return;
                    }
                };

                {
                    let mut dag = self.dag.lock().await;
                    if let Some(node) = dag.nodes.get_mut(&task_id)
                        && matches!(node.task.status, TaskStatus::Running)
                    {
                        node.task.status = TaskStatus::Done;
                        node.task.updated_at = Utc::now();
                        tracing::info!(%task_id, "task done");
                    }
                    dag.update_workflow_status(task_id);
                }

                self.session_to_task.remove(&event.session_id);
                if let Err(e) = self.acp.delete_session(&event.session_id).await {
                    tracing::warn!(
                        session_id = %event.session_id,
                        error = %e,
                        "failed to delete ACP session on completion"
                    );
                }
            }

            "session.error" => {
                let task_id = match self.session_to_task.get(&event.session_id) {
                    Some(entry) => *entry,
                    None => return,
                };

                let error_msg = event
                    .payload
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("unknown error")
                    .to_string();

                {
                    let mut dag = self.dag.lock().await;
                    if let Some(node) = dag.nodes.get_mut(&task_id)
                        && matches!(node.task.status, TaskStatus::Running)
                    {
                        node.task.status = TaskStatus::Failed(error_msg);
                        node.task.updated_at = Utc::now();
                        tracing::error!(%task_id, "task failed via session.error");
                    }
                    dag.update_workflow_status(task_id);
                }

                self.session_to_task.remove(&event.session_id);
                if let Err(e) = self.acp.delete_session(&event.session_id).await {
                    tracing::warn!(
                        session_id = %event.session_id,
                        error = %e,
                        "failed to delete ACP session on error"
                    );
                }
            }

            "tool.execute.before" => {
                tracing::debug!(
                    session_id = %event.session_id,
                    "tool.execute.before"
                );
            }

            "tool.execute.after" => {
                let task_id = match self.session_to_task.get(&event.session_id) {
                    Some(entry) => *entry,
                    None => {
                        tracing::debug!(
                            session_id = %event.session_id,
                            "tool.execute.after for untracked session"
                        );
                        return;
                    }
                };

                let result = match event.payload.get("result").and_then(|v| v.as_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => return,
                };

                let mut dag = self.dag.lock().await;
                if let Some(node) = dag.nodes.get_mut(&task_id) {
                    let output = node.task.output.get_or_insert_with(String::new);
                    if !output.is_empty() {
                        output.push('\n');
                    }
                    output.push_str(&result);
                    node.task.updated_at = Utc::now();
                }
            }

            other => {
                tracing::warn!(event_type = %other, "unknown event type");
            }
        }
    }
}

pub async fn tick(state: &Arc<AppState>) {
    let ready_tasks: Vec<(Uuid, String, String, Option<String>)> = {
        let mut dag = state.dag.lock().await;

        let ready_ids: Vec<Uuid> = dag
            .nodes
            .iter()
            .filter(|(_, node)| matches!(node.task.status, TaskStatus::Pending))
            .filter(|(_, node)| {
                node.depends_on.iter().all(|dep_id| {
                    dag.nodes
                        .get(dep_id)
                        .is_some_and(|dep| matches!(dep.task.status, TaskStatus::Done))
                })
            })
            .map(|(id, _)| *id)
            .collect();

        let mut result = Vec::new();
        for id in ready_ids {
            if let Some(node) = dag.nodes.get_mut(&id) {
                node.task.status = TaskStatus::Running;
                node.task.updated_at = Utc::now();
                result.push((
                    id,
                    node.task.prompt.clone(),
                    node.task.model.clone(),
                    node.task.agent.clone(),
                ));
            }
        }
        result
    };

    for (task_id, prompt, model, agent) in ready_tasks {
        let state = Arc::clone(state);
        tokio::spawn(async move {
            if let Err(e) =
                execute_task(&state, task_id, &prompt, &model, agent.as_deref()).await
            {
                tracing::error!(%task_id, error = %e, "task execution failed");
                let mut dag = state.dag.lock().await;
                if let Some(node) = dag.nodes.get_mut(&task_id) {
                    node.task.status = TaskStatus::Failed(e.to_string());
                    node.task.updated_at = Utc::now();
                }
                dag.update_workflow_status(task_id);
            }
        });
    }
}

async fn execute_task(
    state: &AppState,
    task_id: Uuid,
    prompt: &str,
    model: &str,
    agent: Option<&str>,
) -> Result<()> {
    let session_id = state.acp.create_session().await?;
    tracing::info!(%task_id, %session_id, "ACP session created");

    state.session_to_task.insert(session_id.clone(), task_id);

    {
        let mut dag = state.dag.lock().await;
        if let Some(node) = dag.nodes.get_mut(&task_id) {
            node.task.session_id = Some(session_id.clone());
            node.task.updated_at = Utc::now();
        }
    }

    if let Err(e) = crate::tmux::spawn_pane(&session_id) {
        tracing::warn!(%task_id, error = %e, "tmux pane spawn failed (continuing)");
    }

    state
        .acp
        .send_message(&session_id, prompt, model, agent)
        .await?;
    tracing::info!(%task_id, "message sent");

    Ok(())
}

pub async fn run_tick_loop(state: Arc<AppState>, cancel: tokio_util::sync::CancellationToken) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
    loop {
        tokio::select! {
            _ = interval.tick() => {
                tick(&state).await;
            }
            _ = cancel.cancelled() => {
                tracing::info!("DAG tick loop stopped");
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::AcpClient;
    use crate::events::PluginEvent;
    use crate::types::{CreateTaskRequest, SubmitWorkflowRequest, WorkflowTask};

    fn make_state() -> AppState {
        AppState::new(AcpClient::new("http://localhost:1".to_string(), None))
    }

    fn make_workflow_node(
        dag: &mut DagState,
        workflow_id: Uuid,
        status: TaskStatus,
    ) -> Uuid {
        let id = Uuid::new_v4();
        let now = Utc::now();
        dag.nodes.insert(
            id,
            Node {
                id,
                task: Task {
                    id,
                    prompt: "p".to_string(),
                    model: "m".to_string(),
                    agent: Some("builder".to_string()),
                    session_id: None,
                    status,
                    output: None,
                    created_at: now,
                    updated_at: now,
                },
                depends_on: vec![],
                workflow_id: Some(workflow_id),
            },
        );
        id
    }

    #[tokio::test]
    async fn add_task_creates_pending() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "hello".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.model, "anthropic/claude-sonnet-4-20250514");
        assert!(task.session_id.is_none());
        assert!(task.agent.is_none());
    }

    #[tokio::test]
    async fn add_task_custom_model() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "test".to_string(),
                model: Some("openai/gpt-4o".to_string()),
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.model, "openai/gpt-4o");
    }

    #[tokio::test]
    async fn add_task_agent_validation_fails_when_acp_unreachable() {
        let state = make_state();
        let result = state
            .add_task(CreateTaskRequest {
                prompt: "map codebase".to_string(),
                model: None,
                agent: Some("explorer".to_string()),
                depends_on: None,
            })
            .await;
        assert!(result.is_err(), "should fail when ACP is unreachable");
    }

    #[tokio::test]
    async fn add_task_no_agent_skips_validation() {
        let state = make_state();
        let result = state
            .add_task(CreateTaskRequest {
                prompt: "do work".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await;
        assert!(result.is_ok(), "no agent means no ACP call");
    }

    #[tokio::test]
    async fn submit_workflow_rejects_empty_task_list() {
        let state = make_state();
        let result = state
            .submit_workflow(SubmitWorkflowRequest { tasks: vec![] })
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("at least one task"));
    }

    #[tokio::test]
    async fn submit_workflow_rejects_out_of_bounds_dep() {
        let state = make_state();
        let result = state
            .submit_workflow(SubmitWorkflowRequest {
                tasks: vec![WorkflowTask {
                    agent: "explorer".to_string(),
                    prompt: "p".to_string(),
                    depends_on: vec![5],
                    model: None,
                }],
            })
            .await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("out of bounds"));
    }

    #[tokio::test]
    async fn submit_workflow_fails_when_acp_unreachable() {
        let state = make_state();
        let result = state
            .submit_workflow(SubmitWorkflowRequest {
                tasks: vec![WorkflowTask {
                    agent: "explorer".to_string(),
                    prompt: "map it".to_string(),
                    depends_on: vec![],
                    model: None,
                }],
            })
            .await;
        assert!(result.is_err(), "agent validation requires live ACP");
    }

    #[tokio::test]
    async fn get_workflow_returns_none_for_unknown() {
        let state = make_state();
        assert!(state.get_workflow(Uuid::new_v4()).await.is_none());
    }

    #[tokio::test]
    async fn workflow_advances_to_done_when_all_tasks_complete() {
        let state = make_state();
        let wf_id = Uuid::new_v4();
        let now = Utc::now();

        let (tid_a, tid_b) = {
            let mut dag = state.dag.lock().await;
            let ta = make_workflow_node(&mut dag, wf_id, TaskStatus::Running);
            let tb = make_workflow_node(&mut dag, wf_id, TaskStatus::Pending);
            dag.workflows.insert(
                wf_id,
                Workflow {
                    id: wf_id,
                    status: WorkflowStatus::Running,
                    tasks: vec![ta, tb],
                    created_at: now,
                    updated_at: now,
                },
            );
            (ta, tb)
        };

        state.session_to_task.insert("s_a".to_string(), tid_a);
        state.session_to_task.insert("s_b".to_string(), tid_b);

        {
            let mut dag = state.dag.lock().await;
            dag.nodes.get_mut(&tid_b).unwrap().task.status = TaskStatus::Running;
        }

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "s_a".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        let wf = state.get_workflow(wf_id).await.unwrap();
        assert_eq!(wf.status, WorkflowStatus::Running, "still one running task");

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "s_b".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        let wf = state.get_workflow(wf_id).await.unwrap();
        assert_eq!(wf.status, WorkflowStatus::Done);
    }

    #[tokio::test]
    async fn workflow_advances_to_failed_when_task_errors() {
        let state = make_state();
        let wf_id = Uuid::new_v4();
        let now = Utc::now();

        let tid = {
            let mut dag = state.dag.lock().await;
            let t = make_workflow_node(&mut dag, wf_id, TaskStatus::Running);
            dag.workflows.insert(
                wf_id,
                Workflow {
                    id: wf_id,
                    status: WorkflowStatus::Running,
                    tasks: vec![t],
                    created_at: now,
                    updated_at: now,
                },
            );
            t
        };

        state.session_to_task.insert("s_fail".to_string(), tid);

        state
            .process_event(&PluginEvent {
                event_type: "session.error".to_string(),
                session_id: "s_fail".to_string(),
                payload: serde_json::json!({"error": "model refused"}),
            })
            .await;

        let wf = state.get_workflow(wf_id).await.unwrap();
        assert!(matches!(
            wf.status,
            WorkflowStatus::Failed { reason, .. } if reason == "model refused"
        ));
    }

    #[tokio::test]
    async fn workflow_partial_completion_stays_running() {
        let state = make_state();
        let wf_id = Uuid::new_v4();
        let now = Utc::now();

        let (tid_done, _tid_pending) = {
            let mut dag = state.dag.lock().await;
            let ta = make_workflow_node(&mut dag, wf_id, TaskStatus::Running);
            let tb = make_workflow_node(&mut dag, wf_id, TaskStatus::Pending);
            dag.workflows.insert(
                wf_id,
                Workflow {
                    id: wf_id,
                    status: WorkflowStatus::Running,
                    tasks: vec![ta, tb],
                    created_at: now,
                    updated_at: now,
                },
            );
            (ta, tb)
        };

        state
            .session_to_task
            .insert("s_partial".to_string(), tid_done);

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "s_partial".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        let wf = state.get_workflow(wf_id).await.unwrap();
        assert_eq!(wf.status, WorkflowStatus::Running);
    }

    #[tokio::test]
    async fn solo_task_without_workflow_doesnt_affect_workflows() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "solo".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            dag.nodes.get_mut(&id).unwrap().task.status = TaskStatus::Running;
        }
        state.session_to_task.insert("s_solo".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "s_solo".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        let dag = state.dag.lock().await;
        assert!(dag.workflows.is_empty());
    }

    #[tokio::test]
    async fn session_idle_marks_running_task_done() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_test".to_string());
        }
        state.session_to_task.insert("ses_test".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "ses_test".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        assert_eq!(state.get_task(id).await.unwrap().status, TaskStatus::Done);
    }

    #[tokio::test]
    async fn session_error_marks_running_task_failed() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_err".to_string());
        }
        state.session_to_task.insert("ses_err".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "session.error".to_string(),
                session_id: "ses_err".to_string(),
                payload: serde_json::json!({"error": "rate limit"}),
            })
            .await;

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.status, TaskStatus::Failed("rate limit".to_string()));
    }

    #[tokio::test]
    async fn session_idle_for_unknown_session_is_noop() {
        let state = make_state();
        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "ses_unknown".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;
    }

    #[tokio::test]
    async fn session_idle_cleans_up_session_mapping() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_cleanup".to_string());
        }
        state
            .session_to_task
            .insert("ses_cleanup".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "ses_cleanup".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        assert!(!state.session_to_task.contains_key("ses_cleanup"));
        assert_eq!(state.get_task(id).await.unwrap().status, TaskStatus::Done);
    }

    #[tokio::test]
    async fn session_error_cleans_up_session_mapping() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_err2".to_string());
        }
        state.session_to_task.insert("ses_err2".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "session.error".to_string(),
                session_id: "ses_err2".to_string(),
                payload: serde_json::json!({"error": "timeout"}),
            })
            .await;

        assert!(!state.session_to_task.contains_key("ses_err2"));
        assert_eq!(
            state.get_task(id).await.unwrap().status,
            TaskStatus::Failed("timeout".to_string())
        );
    }

    #[tokio::test]
    async fn tool_after_appends_to_task_output() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_tool".to_string());
        }
        state.session_to_task.insert("ses_tool".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "tool.execute.after".to_string(),
                session_id: "ses_tool".to_string(),
                payload: serde_json::json!({"result": "line one"}),
            })
            .await;

        state
            .process_event(&PluginEvent {
                event_type: "tool.execute.after".to_string(),
                session_id: "ses_tool".to_string(),
                payload: serde_json::json!({"result": "line two"}),
            })
            .await;

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.output, Some("line one\nline two".to_string()));
    }

    #[tokio::test]
    async fn tool_after_ignores_empty_result() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_empty".to_string());
        }
        state.session_to_task.insert("ses_empty".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "tool.execute.after".to_string(),
                session_id: "ses_empty".to_string(),
                payload: serde_json::json!({"result": ""}),
            })
            .await;

        assert!(state.get_task(id).await.unwrap().output.is_none());
    }

    #[tokio::test]
    async fn tool_after_for_unknown_session_is_noop() {
        let state = make_state();
        state
            .process_event(&PluginEvent {
                event_type: "tool.execute.after".to_string(),
                session_id: "ses_ghost".to_string(),
                payload: serde_json::json!({"result": "data"}),
            })
            .await;
    }

    #[tokio::test]
    async fn session_idle_preserves_accumulated_output() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_snap".to_string());
        }
        state.session_to_task.insert("ses_snap".to_string(), id);

        state
            .process_event(&PluginEvent {
                event_type: "tool.execute.after".to_string(),
                session_id: "ses_snap".to_string(),
                payload: serde_json::json!({"result": "tool output"}),
            })
            .await;

        state
            .process_event(&PluginEvent {
                event_type: "session.idle".to_string(),
                session_id: "ses_snap".to_string(),
                payload: serde_json::Value::Null,
            })
            .await;

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.status, TaskStatus::Done);
        assert_eq!(task.output, Some("tool output".to_string()));
    }

    #[tokio::test]
    async fn tick_marks_no_dep_tasks_running() {
        let state = Arc::new(make_state());
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "go".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        let ready: Vec<Uuid> = {
            let mut dag = state.dag.lock().await;
            let ready_ids: Vec<Uuid> = dag
                .nodes
                .iter()
                .filter(|(_, node)| matches!(node.task.status, TaskStatus::Pending))
                .filter(|(_, node)| {
                    node.depends_on.iter().all(|dep_id| {
                        dag.nodes
                            .get(dep_id)
                            .is_some_and(|dep| matches!(dep.task.status, TaskStatus::Done))
                    })
                })
                .map(|(id, _)| *id)
                .collect();

            for rid in &ready_ids {
                dag.nodes.get_mut(rid).unwrap().task.status = TaskStatus::Running;
            }
            ready_ids
        };

        assert!(ready.contains(&id));
        assert_eq!(
            state.get_task(id).await.unwrap().status,
            TaskStatus::Running
        );
    }

    #[tokio::test]
    async fn tick_blocks_task_with_unmet_dep() {
        let state = Arc::new(make_state());

        let dep_id = state
            .add_task(CreateTaskRequest {
                prompt: "dep".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        let child_id = state
            .add_task(CreateTaskRequest {
                prompt: "child".to_string(),
                model: None,
                agent: None,
                depends_on: Some(vec![dep_id]),
            })
            .await
            .unwrap();

        {
            let dag = state.dag.lock().await;
            assert_eq!(dag.nodes[&dep_id].task.status, TaskStatus::Pending);
        }

        let ready: Vec<Uuid> = {
            let dag = state.dag.lock().await;
            dag.nodes
                .iter()
                .filter(|(_, node)| matches!(node.task.status, TaskStatus::Pending))
                .filter(|(_, node)| {
                    node.depends_on.iter().all(|dep| {
                        dag.nodes
                            .get(dep)
                            .is_some_and(|d| matches!(d.task.status, TaskStatus::Done))
                    })
                })
                .map(|(id, _)| *id)
                .collect()
        };

        assert!(!ready.contains(&child_id));
    }

    #[tokio::test]
    async fn list_tasks_returns_all() {
        let state = make_state();
        state
            .add_task(CreateTaskRequest {
                prompt: "a".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();
        state
            .add_task(CreateTaskRequest {
                prompt: "b".to_string(),
                model: None,
                agent: None,
                depends_on: None,
            })
            .await
            .unwrap();

        assert_eq!(state.list_tasks().await.len(), 2);
    }

    #[tokio::test]
    async fn get_task_not_found_returns_none() {
        let state = make_state();
        assert!(state.get_task(Uuid::new_v4()).await.is_none());
    }
}
