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
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub prompt: String,
    pub model: Option<String>,
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
    fn create_task_request_optional_fields() {
        let json = r#"{"prompt":"hello"}"#;
        let req: CreateTaskRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.prompt, "hello");
        assert!(req.model.is_none());
        assert!(req.depends_on.is_none());
    }
}
