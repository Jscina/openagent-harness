use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "message", rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Running,
    Done,
    Failed(String),
    Cancelled,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
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
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub status: WorkflowStatus,
    pub tasks: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowSnapshot {
    pub id: String,
    pub status: WorkflowStatus,
    pub tasks: Vec<WorkflowTaskSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowSummary {
    pub id: String,
    pub status: WorkflowStatus,
    pub task_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct WorkflowTaskInput {
    pub agent: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional ticket/card id; absent outside work context ("no-card" mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
}

/// Normalize a card id: trim, and treat empty/whitespace as absent.
pub(crate) fn normalize_card_id(card_id: Option<&str>) -> Option<String> {
    card_id
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
}

/// An in-progress plan draft accumulated via repeated `append_plan_task` calls, so a
/// planner can build a workflow definition through many small tool calls instead of one
/// large `save_plan` invocation carrying the entire tasks array.
#[derive(Debug)]
pub(crate) struct PlanDraft {
    pub id: String,
    /// Monotonically increasing creation order. Assigned once at creation and never
    /// updated on later appends, so this reflects draft *age* only. Eviction is keyed
    /// primarily on `last_touched_seq`, not this field; `seq` only serves as a
    /// defensive secondary tie-breaker (see `append_plan_task`'s eviction logic).
    pub seq: u64,
    /// Monotonically increasing "last touched" order, drawn from the same counter as
    /// `seq`. Set at creation (creation counts as the first touch) and refreshed on
    /// every subsequent successful append. Eviction under `MAX_PLAN_DRAFTS` picks the
    /// draft with the lowest `last_touched_seq` (true LRU), not the lowest `seq`
    /// (which would be FIFO-by-creation and could evict a draft still actively being
    /// built just because an older, untouched draft happened to be created first).
    pub last_touched_seq: u64,
    /// Ordered task entries, reusing the exact `WorkflowTaskInput` shape used by
    /// `submit_workflow` so read-back requires zero transformation by the caller.
    pub tasks: Vec<WorkflowTaskInput>,
    /// Agent name per task, mirrored 1:1 with `tasks` and maintained incrementally
    /// (one push per successful append) so `append_plan_task`'s response can include
    /// the `agents` array in O(1) amortized time instead of remapping all of `tasks`
    /// on every call.
    pub agents: Vec<String>,
    /// Plan-level card id, adopted from the first appended task that carries one.
    pub card_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ReadyTask {
    pub id: String,
    pub prompt: String,
    pub model: String,
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Pre-assigned session_id from a previous task's session reuse.
    /// When set, the plugin must skip `createSession` and use this directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_session_id: Option<String>,
    /// The workflow this task belongs to.
    /// Used by the plugin to route tasks to native-dispatch vs. plugin-dispatch workflows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_id: Option<String>,
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
    fn task_status_cancelled_roundtrip() {
        let s = serde_json::to_string(&TaskStatus::Cancelled).unwrap();
        assert_eq!(s, r#"{"type":"cancelled"}"#);
        assert_eq!(
            serde_json::from_str::<TaskStatus>(&s).unwrap(),
            TaskStatus::Cancelled
        );
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
    fn workflow_status_cancelled_roundtrip() {
        let s = serde_json::to_string(&WorkflowStatus::Cancelled).unwrap();
        assert_eq!(s, r#"{"type":"cancelled"}"#);
        assert_eq!(
            serde_json::from_str::<WorkflowStatus>(&s).unwrap(),
            WorkflowStatus::Cancelled
        );
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

    #[test]
    fn legacy_task_input_without_card_id_deserializes() {
        let t: WorkflowTaskInput =
            serde_json::from_str(r#"{"agent":"a","prompt":"p","depends_on":[0]}"#).unwrap();
        assert_eq!(t.card_id, None);
        assert_eq!(t.depends_on, vec![0]);
    }

    #[test]
    fn legacy_task_without_card_id_deserializes() {
        let t: Task = serde_json::from_str(
            r#"{"id":"1","prompt":"p","model":"m","agent":null,"session_id":null,
                "status":{"type":"pending"},"output":null}"#,
        )
        .unwrap();
        assert_eq!(t.card_id, None);
    }

    #[test]
    fn card_id_omitted_when_none_and_present_when_set() {
        let mut input = WorkflowTaskInput {
            agent: "a".into(),
            prompt: "p".into(),
            depends_on: vec![],
            model: None,
            card_id: None,
        };
        let v = serde_json::to_value(&input).unwrap();
        assert!(v.get("card_id").is_none());
        input.card_id = Some("CARD-1".into());
        let v = serde_json::to_value(&input).unwrap();
        assert_eq!(v["card_id"], "CARD-1");
    }

    #[test]
    fn normalize_card_id_trims_and_drops_blank() {
        assert_eq!(normalize_card_id(None), None);
        assert_eq!(normalize_card_id(Some("")), None);
        assert_eq!(normalize_card_id(Some("  \t")), None);
        assert_eq!(normalize_card_id(Some(" C-1 ")).as_deref(), Some("C-1"));
    }
}
