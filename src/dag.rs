use crate::acp::AcpClient;
use crate::events::PluginEvent;
use crate::types::{CreateTaskRequest, Node, Task, TaskStatus};

use anyhow::Result;
use chrono::Utc;
use dashmap::DashMap;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4-20250514";

pub struct AppState {
    pub dag: Mutex<DagState>,
    pub session_to_task: DashMap<String, Uuid>,
    pub acp: AcpClient,
}

pub struct DagState {
    pub nodes: HashMap<Uuid, Node>,
}

impl AppState {
    pub fn new(acp: AcpClient) -> Self {
        Self {
            dag: Mutex::new(DagState {
                nodes: HashMap::new(),
            }),
            session_to_task: DashMap::new(),
            acp,
        }
    }

    pub async fn add_task(&self, req: CreateTaskRequest) -> Uuid {
        let id = Uuid::new_v4();
        let now = Utc::now();
        let node = Node {
            id,
            task: Task {
                id,
                prompt: req.prompt,
                model: req.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                session_id: None,
                status: TaskStatus::Pending,
                output: None,
                created_at: now,
                updated_at: now,
            },
            depends_on: req.depends_on.unwrap_or_default(),
        };

        let mut dag = self.dag.lock().await;
        dag.nodes.insert(id, node);
        tracing::info!(%id, "task added");
        id
    }

    pub async fn get_task(&self, id: Uuid) -> Option<Task> {
        let dag = self.dag.lock().await;
        dag.nodes.get(&id).map(|n| n.task.clone())
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

                let mut dag = self.dag.lock().await;
                if let Some(node) = dag.nodes.get_mut(&task_id) {
                    if matches!(node.task.status, TaskStatus::Running) {
                        node.task.status = TaskStatus::Done;
                        node.task.updated_at = Utc::now();
                        tracing::info!(%task_id, "task done");
                    }
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

                let mut dag = self.dag.lock().await;
                if let Some(node) = dag.nodes.get_mut(&task_id) {
                    if matches!(node.task.status, TaskStatus::Running) {
                        node.task.status = TaskStatus::Failed(error_msg);
                        node.task.updated_at = Utc::now();
                        tracing::error!(%task_id, "task failed via session.error");
                    }
                }
            }

            "tool.execute.before" | "tool.execute.after" => {
                tracing::debug!(
                    event_type = %event.event_type,
                    session_id = %event.session_id,
                    "tool event"
                );
            }

            other => {
                tracing::warn!(event_type = %other, "unknown event type");
            }
        }
    }
}

pub async fn tick(state: &Arc<AppState>) {
    let ready_tasks: Vec<(Uuid, String, String)> = {
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
                result.push((id, node.task.prompt.clone(), node.task.model.clone()));
            }
        }
        result
    };

    for (task_id, prompt, model) in ready_tasks {
        let state = Arc::clone(state);
        tokio::spawn(async move {
            if let Err(e) = execute_task(&state, task_id, &prompt, &model).await {
                tracing::error!(%task_id, error = %e, "task execution failed");
                let mut dag = state.dag.lock().await;
                if let Some(node) = dag.nodes.get_mut(&task_id) {
                    node.task.status = TaskStatus::Failed(e.to_string());
                    node.task.updated_at = Utc::now();
                }
            }
        });
    }
}

async fn execute_task(
    state: &AppState,
    task_id: Uuid,
    prompt: &str,
    model: &str,
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

    state.acp.send_message(&session_id, prompt, model).await?;
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
    use crate::types::CreateTaskRequest;

    fn make_state() -> AppState {
        AppState::new(AcpClient::new(
            "http://localhost:1".to_string(),
            None,
        ))
    }

    #[tokio::test]
    async fn add_task_creates_pending() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "hello".to_string(),
                model: None,
                depends_on: None,
            })
            .await;

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.status, TaskStatus::Pending);
        assert_eq!(task.model, "anthropic/claude-sonnet-4-20250514");
        assert!(task.session_id.is_none());
    }

    #[tokio::test]
    async fn add_task_custom_model() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "test".to_string(),
                model: Some("openai/gpt-4o".to_string()),
                depends_on: None,
            })
            .await;

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.model, "openai/gpt-4o");
    }

    #[tokio::test]
    async fn session_idle_marks_running_task_done() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                depends_on: None,
            })
            .await;

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_test".to_string());
        }
        state.session_to_task.insert("ses_test".to_string(), id);

        let event = PluginEvent {
            event_type: "session.idle".to_string(),
            session_id: "ses_test".to_string(),
            payload: serde_json::Value::Null,
        };
        state.process_event(&event).await;

        assert_eq!(state.get_task(id).await.unwrap().status, TaskStatus::Done);
    }

    #[tokio::test]
    async fn session_error_marks_running_task_failed() {
        let state = make_state();
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "p".to_string(),
                model: None,
                depends_on: None,
            })
            .await;

        {
            let mut dag = state.dag.lock().await;
            let node = dag.nodes.get_mut(&id).unwrap();
            node.task.status = TaskStatus::Running;
            node.task.session_id = Some("ses_err".to_string());
        }
        state.session_to_task.insert("ses_err".to_string(), id);

        let event = PluginEvent {
            event_type: "session.error".to_string(),
            session_id: "ses_err".to_string(),
            payload: serde_json::json!({"error": "rate limit"}),
        };
        state.process_event(&event).await;

        let task = state.get_task(id).await.unwrap();
        assert_eq!(task.status, TaskStatus::Failed("rate limit".to_string()));
    }

    #[tokio::test]
    async fn session_idle_for_unknown_session_is_noop() {
        let state = make_state();
        let event = PluginEvent {
            event_type: "session.idle".to_string(),
            session_id: "ses_unknown".to_string(),
            payload: serde_json::Value::Null,
        };
        state.process_event(&event).await;
    }

    #[tokio::test]
    async fn tick_marks_no_dep_tasks_running() {
        let state = Arc::new(make_state());
        let id = state
            .add_task(CreateTaskRequest {
                prompt: "go".to_string(),
                model: None,
                depends_on: None,
            })
            .await;

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
                depends_on: None,
            })
            .await;

        let child_id = state
            .add_task(CreateTaskRequest {
                prompt: "child".to_string(),
                model: None,
                depends_on: Some(vec![dep_id]),
            })
            .await;

        {
            let dag = state.dag.lock().await;
            let dep_status = &dag.nodes[&dep_id].task.status;
            assert_eq!(*dep_status, TaskStatus::Pending);
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
                depends_on: None,
            })
            .await;
        state
            .add_task(CreateTaskRequest {
                prompt: "b".to_string(),
                model: None,
                depends_on: None,
            })
            .await;

        let tasks = state.list_tasks().await;
        assert_eq!(tasks.len(), 2);
    }

    #[tokio::test]
    async fn get_task_not_found_returns_none() {
        let state = make_state();
        assert!(state.get_task(Uuid::new_v4()).await.is_none());
    }
}
