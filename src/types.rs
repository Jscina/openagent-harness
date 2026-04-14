use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "message", rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Failed(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub agent: Option<String>,
    pub session_id: Option<String>,
    pub status: TaskStatus,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Node {
    pub id: String,
    pub task: Task,
    pub depends_on: Vec<String>,
    pub workflow_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowStatus {
    Running,
    Done,
    Failed { task_id: String, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub status: WorkflowStatus,
    pub tasks: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WorkflowTaskInput {
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<usize>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReadyTask {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub agent: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EventResult {
    pub notifications: Vec<Notification>,
    pub delete_session: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Notification {
    Toast {
        title: String,
        message: String,
        variant: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        duration: Option<u32>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_status_pending_roundtrip() {
        let s = serde_json::to_string(&TaskStatus::Pending).unwrap();
        assert_eq!(s, r#"{"type":"pending"}"#);
        assert_eq!(
            serde_json::from_str::<TaskStatus>(&s).unwrap(),
            TaskStatus::Pending
        );
    }

    #[test]
    fn task_status_failed_roundtrip() {
        let s = serde_json::to_string(&TaskStatus::Failed("boom".into())).unwrap();
        assert_eq!(s, r#"{"type":"failed","message":"boom"}"#);
        let back: TaskStatus = serde_json::from_str(&s).unwrap();
        assert_eq!(back, TaskStatus::Failed("boom".into()));
    }

    #[test]
    fn task_status_done_roundtrip() {
        let s = serde_json::to_string(&TaskStatus::Done).unwrap();
        assert_eq!(s, r#"{"type":"done"}"#);
    }

    #[test]
    fn workflow_status_roundtrips() {
        let s = serde_json::to_string(&WorkflowStatus::Running).unwrap();
        assert_eq!(s, r#"{"type":"running"}"#);

        let s = serde_json::to_string(&WorkflowStatus::Done).unwrap();
        assert_eq!(s, r#"{"type":"done"}"#);

        let v = serde_json::to_value(&WorkflowStatus::Failed {
            task_id: "tid-1".into(),
            reason: "oops".into(),
        })
        .unwrap();
        assert_eq!(v["type"], "failed");
        assert_eq!(v["task_id"], "tid-1");
        assert_eq!(v["reason"], "oops");
    }
}
