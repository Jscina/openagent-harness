use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "message")]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Idle,
    Done,
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: Uuid,
    pub prompt: String,
    /// "provider/model", e.g. "anthropic/claude-sonnet-4-20250514"
    pub model: String,
    pub agent: Option<String>,
    pub session_id: Option<String>,
    pub status: TaskStatus,
    pub output: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: Uuid,
    pub task: Task,
    /// Empty vec = no deps, task is eligible to run immediately.
    pub depends_on: Vec<Uuid>,
    pub workflow_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    Running,
    Done,
    Failed { task_id: Uuid, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: Uuid,
    pub status: WorkflowStatus,
    pub tasks: Vec<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct WorkflowTask {
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<usize>,
    pub model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubmitWorkflowRequest {
    pub tasks: Vec<WorkflowTask>,
}

#[derive(Debug, Serialize)]
pub struct SubmitWorkflowResponse {
    pub workflow_id: Uuid,
    pub task_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub prompt: String,
    pub model: Option<String>,
    pub agent: Option<String>,
    pub depends_on: Option<Vec<Uuid>>,
}

#[derive(Debug, Serialize)]
pub struct CreateTaskResponse {
    pub id: Uuid,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_pending_roundtrip() {
        let s = TaskStatus::Pending;
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"type":"pending"}"#);
        let back: TaskStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn task_status_failed_roundtrip() {
        let s = TaskStatus::Failed("timeout".to_string());
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"type":"failed","message":"timeout"}"#);
        let back: TaskStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn task_status_done_roundtrip() {
        let s = TaskStatus::Done;
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"type":"done"}"#);
        let back: TaskStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn workflow_status_running_roundtrip() {
        let s = WorkflowStatus::Running;
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"type":"running"}"#);
        let back: WorkflowStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn workflow_status_done_roundtrip() {
        let s = WorkflowStatus::Done;
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"type":"done"}"#);
        let back: WorkflowStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn workflow_status_failed_roundtrip() {
        let id = Uuid::new_v4();
        let s = WorkflowStatus::Failed {
            task_id: id,
            reason: "timed out".to_string(),
        };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["type"], "failed");
        assert_eq!(json["task_id"], id.to_string());
        assert_eq!(json["reason"], "timed out");
        let back: WorkflowStatus = serde_json::from_value(json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn create_task_request_optional_fields() {
        let json = r#"{"prompt":"hello"}"#;
        let req: CreateTaskRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.prompt, "hello");
        assert!(req.model.is_none());
        assert!(req.agent.is_none());
        assert!(req.depends_on.is_none());
    }

    #[test]
    fn create_task_request_with_agent() {
        let json = r#"{"prompt":"map the codebase","agent":"explorer"}"#;
        let req: CreateTaskRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.agent.as_deref(), Some("explorer"));
    }

    #[test]
    fn submit_workflow_request_deserializes() {
        let json = r#"{
            "tasks": [
                {"agent": "explorer", "prompt": "map auth", "depends_on": []},
                {"agent": "builder", "prompt": "implement oauth", "depends_on": [0], "model": "anthropic/claude-opus-4-6"}
            ]
        }"#;
        let req: SubmitWorkflowRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.tasks.len(), 2);
        assert_eq!(req.tasks[0].agent, "explorer");
        assert_eq!(req.tasks[1].depends_on, vec![0usize]);
        assert_eq!(
            req.tasks[1].model.as_deref(),
            Some("anthropic/claude-opus-4-6")
        );
    }
}
