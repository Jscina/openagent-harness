use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "message", rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Failed(String),
}

/// Classifies an error as retryable or terminal to decide whether a fallback should be attempted.
///
/// Produced by `classifyError` in `plugin/harness.ts` and used by the plugin to decide
/// whether to call `try_fallback` or immediately fail the task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "message", rename_all = "snake_case")]
pub enum ErrorClass {
    /// Provider unavailable, rate-limited, or timeout — may be retried.
    Retryable(String),
    /// Auth failure, invalid request, or content policy — cannot be retried.
    Terminal(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    Approved,
    Blocked,
    RequestedChanges,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewFinding {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewFeedback {
    pub status: ReviewStatus,
    pub reviewer_task_id: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub findings: Vec<ReviewFinding>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewFeedback>,
    /// Ordered fallback model chain for this task.
    #[serde(default)]
    pub fallback_models: Vec<String>,
    /// Index into `fallback_models` currently in use (0 = primary model).
    #[serde(default)]
    pub model_attempt: usize,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowTaskSnapshot {
    pub id: String,
    pub agent: Option<String>,
    pub model: String,
    pub session_id: Option<String>,
    pub status: TaskStatus,
    pub depends_on: Vec<String>,
    pub blocked_on: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewFeedback>,
    /// Which index in the fallback chain is currently active (0 = primary).
    pub model_attempt: usize,
    /// Full fallback model chain for observability.
    pub fallback_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowSnapshot {
    pub id: String,
    pub status: WorkflowStatus,
    pub tasks: Vec<WorkflowTaskSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowSummary {
    pub id: String,
    pub status: WorkflowStatus,
    pub task_count: usize,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WorkflowTaskInput {
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<usize>,
    pub model: Option<String>,
    /// Task-level override for the fallback model chain.
    #[serde(default)]
    pub fallback_models: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReadyTask {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Full fallback model chain so the plugin knows the complete chain.
    pub fallback_models: Vec<String>,
    /// Pre-assigned session_id from a previous task's session reuse.
    /// When set, the plugin must skip `createSession` and use this directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_session_id: Option<String>,
}

/// Returned inside `EventResult` on a `session.error` event, telling the plugin
/// whether the failed task has remaining fallback models to try.
///
/// The plugin uses `has_fallbacks` together with `classifyError` to decide whether
/// to call `try_fallback` or immediately fail the task.
#[derive(Debug, Serialize)]
pub struct FallbackHint {
    /// ID of the task that produced the error.
    pub task_id: String,
    /// The raw error message from the session event payload.
    pub error_message: String,
    /// `true` when at least one fallback model remains in the task's chain.
    pub has_fallbacks: bool,
}

/// Instructs the plugin to reuse a completed task's session for a downstream task
/// instead of deleting the session and creating a new one.
#[derive(Debug, Serialize)]
pub struct SessionReuse {
    /// The session_id to reuse (from the just-completed task).
    pub session_id: String,
    /// The task_id that should be pre-assigned this session.
    pub next_task_id: String,
}

#[derive(Debug, Serialize)]
pub struct EventResult {
    pub notifications: Vec<Notification>,
    pub delete_session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_hint: Option<FallbackHint>,
    /// When set, the plugin should pre-assign the session to the next task
    /// instead of deleting it.  Mutually exclusive with `delete_session`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reuse_session: Option<SessionReuse>,
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

    #[test]
    fn error_class_retryable_roundtrip() {
        let e = ErrorClass::Retryable("rate limit hit".into());
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"type":"retryable","message":"rate limit hit"}"#);
        let back: ErrorClass = serde_json::from_str(&s).unwrap();
        assert_eq!(back, ErrorClass::Retryable("rate limit hit".into()));
    }

    #[test]
    fn error_class_terminal_roundtrip() {
        let e = ErrorClass::Terminal("auth failure".into());
        let s = serde_json::to_string(&e).unwrap();
        assert_eq!(s, r#"{"type":"terminal","message":"auth failure"}"#);
        let back: ErrorClass = serde_json::from_str(&s).unwrap();
        assert_eq!(back, ErrorClass::Terminal("auth failure".into()));
    }

    #[test]
    fn review_status_roundtrip() {
        let s = serde_json::to_string(&ReviewStatus::Approved).unwrap();
        assert_eq!(s, r#""approved""#);
        let s = serde_json::to_string(&ReviewStatus::Blocked).unwrap();
        assert_eq!(s, r#""blocked""#);
        let s = serde_json::to_string(&ReviewStatus::RequestedChanges).unwrap();
        assert_eq!(s, r#""requested_changes""#);
    }

    #[test]
    fn review_feedback_roundtrip() {
        let fb = ReviewFeedback {
            status: ReviewStatus::Blocked,
            reviewer_task_id: "rev-1".into(),
            summary: "Missing error handling".into(),
            findings: vec![ReviewFinding {
                message: "No error handling in parse()".into(),
                file: Some("src/lib.rs".into()),
                line: Some(42),
                severity: Some("high".into()),
            }],
        };
        let json = serde_json::to_string(&fb).unwrap();
        let back: ReviewFeedback = serde_json::from_str(&json).unwrap();
        assert_eq!(back.status, ReviewStatus::Blocked);
        assert_eq!(back.findings.len(), 1);
        assert_eq!(back.findings[0].file.as_deref(), Some("src/lib.rs"));
    }

    #[test]
    fn review_feedback_empty_findings_omits_field() {
        let fb = ReviewFeedback {
            status: ReviewStatus::Approved,
            reviewer_task_id: "rev-2".into(),
            summary: "LGTM".into(),
            findings: vec![],
        };
        let val = serde_json::to_value(&fb).unwrap();
        assert!(val.get("findings").is_none());
    }
}
