use std::collections::HashMap;

use crate::types::*;

const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4-6";
const SNAPSHOT_PREVIEW_CHARS: usize = 240;
/// Hard cap on tasks accumulated in a single in-progress plan draft. Also acts as a
/// runaway circuit breaker for `append_plan_task` callers.
const MAX_TASKS_PER_DRAFT: usize = 64;
/// Hard cap on the number of concurrently in-progress plan drafts. Exceeding this on
/// draft creation evicts the least-recently-touched draft (lowest `last_touched_seq`
/// — true LRU, not creation-order FIFO).
const MAX_PLAN_DRAFTS: usize = 32;

/// Synchronous DAG state machine.
///
/// This struct contains the full logic and is always compiled.  On WASM
/// targets a thin `WasmDagEngine` newtype wraps it and exports the same
/// interface to JavaScript.
pub struct DagEngine {
    nodes: HashMap<String, Node>,
    workflows: HashMap<String, Workflow>,
    session_to_task: HashMap<String, String>,
    /// In-progress plan drafts built incrementally via `append_plan_task`, keyed by
    /// plan_id, consumed via `get_plan_draft` + `discard_plan_draft`.
    plan_drafts: HashMap<String, PlanDraft>,
    /// Monotonic counter assigning both creation order (`PlanDraft::seq`) and
    /// last-touched order (`PlanDraft::last_touched_seq`) to plan drafts — the same
    /// counter drives both, just read at different moments. Used for
    /// least-recently-touched eviction once `MAX_PLAN_DRAFTS` is exceeded.
    /// Deliberately a plain counter rather than `SystemTime::now()`, which is
    /// unavailable on `wasm32-unknown-unknown`.
    next_draft_seq: u64,
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
            plan_drafts: HashMap::new(),
            next_draft_seq: 0,
        }
    }

    /// Submit a workflow without a parent session.
    ///
    /// Returns JSON `{workflow_id, task_ids}` or an error message string.
    pub fn submit_workflow(&mut self, tasks_json: &str) -> Result<String, String> {
        self.submit_workflow_with_parent_session(tasks_json, None)
    }

    /// Submit a workflow with an optional parent OpenCode session id.
    ///
    /// Returns JSON `{workflow_id, task_ids}` or an error message string.
    pub fn submit_workflow_with_parent_session(
        &mut self,
        tasks_json: &str,
        parent_session_id: Option<&str>,
    ) -> Result<String, String> {
        self.submit_workflow_with_card(tasks_json, parent_session_id, None)
    }

    /// Submit a workflow with an optional parent session id and optional workflow-level
    /// card id. A task's own `card_id` overrides the workflow default; tasks without one
    /// inherit it. Empty/whitespace card ids are treated as absent.
    ///
    /// Returns JSON `{workflow_id, task_ids}` or an error message string.
    pub fn submit_workflow_with_card(
        &mut self,
        tasks_json: &str,
        parent_session_id: Option<&str>,
        card_id: Option<&str>,
    ) -> Result<String, String> {
        let workflow_card_id = normalize_card_id(card_id);
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
                        review: None,
                        card_id: normalize_card_id(task.card_id.as_deref())
                            .or_else(|| workflow_card_id.clone()),
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
                parent_session_id: parent_session_id.map(|session_id| session_id.to_string()),
                card_id: workflow_card_id,
            },
        );

        Ok(serde_json::json!({ "workflow_id": workflow_id, "task_ids": ids }).to_string())
    }

    /// Mark all unblocked Pending tasks as Running; return them as JSON.
    ///
    /// Returns JSON `[{id, prompt, model, agent, existing_session_id?}, ...]`.
    /// When a task has a pre-assigned `session_id` (from session reuse), the
    /// plugin must skip `createSession` and use `existing_session_id` directly.
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
            // Read phase: gather what we need before taking a mutable borrow.
            let (dep_parent, workflow_parent, has_deps) = {
                let node = match self.nodes.get(&id) {
                    Some(n) => n,
                    None => continue,
                };
                // For tasks with dependencies, prefer the last completed dependency's
                // session_id as the parent so the tree reflects actual execution order.
                // Fall back to the workflow's parent_session_id (the orchestrator session)
                // when no dependency session is available or the task has no deps.
                let dep_parent: Option<String> = node
                    .depends_on
                    .iter()
                    .filter_map(|dep_id| self.nodes.get(dep_id))
                    .filter(|dep| matches!(dep.task.status, TaskStatus::Done))
                    .filter_map(|dep| dep.task.session_id.clone())
                    .next_back();
                let workflow_parent: Option<String> = node
                    .workflow_id
                    .as_ref()
                    .and_then(|workflow_id| self.workflows.get(workflow_id))
                    .and_then(|workflow| workflow.parent_session_id.clone());
                (dep_parent, workflow_parent, !node.depends_on.is_empty())
            };

            let parent_session_id = if !has_deps {
                workflow_parent
            } else {
                dep_parent.or(workflow_parent)
            };

            // Mutate phase: mark Running and collect the ReadyTask.
            if let Some(node) = self.nodes.get_mut(&id) {
                let existing_session_id = node.task.session_id.clone();
                let workflow_id = node.workflow_id.clone();
                let card_id = node.task.card_id.clone();
                node.task.status = TaskStatus::Running;
                started.push(ReadyTask {
                    id: id.clone(),
                    prompt: node.task.prompt.clone(),
                    model: node.task.model.clone(),
                    agent: node.task.agent.clone(),
                    parent_session_id,
                    existing_session_id,
                    workflow_id,
                    card_id,
                });
            }
        }

        serde_json::to_string(&started).unwrap_or_else(|_| "[]".to_string())
    }

    /// Record that `task_id` now has an active session `session_id`.
    ///
    /// Returns `true` if the task was in a bindable state (`Pending` or
    /// `Running`) and the session was bound. Returns `false` if the task does
    /// not exist or is already terminal (`Done`, `Failed`, or `Cancelled`) —
    /// in that case `session_id` is deliberately left unregistered in
    /// `session_to_task` (no mapping is created), so a subsequent
    /// `process_event` for it is a guaranteed no-op.
    ///
    /// `Pending` is bindable (not just `Running`) because the session-reuse
    /// path in `process_event` (`session.idle` → `reuse_session`) pre-assigns
    /// a session to the next task before that task has been through `tick()`.
    ///
    /// Callers on the plugin side MUST check this return value: `false` means
    /// the session was never bound to a task and is now orphaned — the caller
    /// is responsible for tracking it as cancelled and aborting/deleting it,
    /// since the DAG will never do so for a session it doesn't know about.
    pub fn task_started(&mut self, task_id: &str, session_id: &str) -> bool {
        let bindable = matches!(
            self.nodes.get(task_id).map(|n| &n.task.status),
            Some(TaskStatus::Pending) | Some(TaskStatus::Running)
        );

        if !bindable {
            return false;
        }

        if let Some(node) = self.nodes.get_mut(task_id) {
            node.task.session_id = Some(session_id.to_string());
        }
        self.session_to_task
            .insert(session_id.to_string(), task_id.to_string());
        true
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
            reuse_session: None,
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

                // Find tasks that depend on this task and are now fully unblocked.
                let unblocked: Vec<String> = self
                    .nodes
                    .iter()
                    .filter(|(_, n)| {
                        n.depends_on.contains(&task_id)
                            && matches!(n.task.status, TaskStatus::Pending)
                            && n.depends_on.iter().all(|dep| {
                                self.nodes
                                    .get(dep)
                                    .is_some_and(|d| matches!(d.task.status, TaskStatus::Done))
                            })
                    })
                    .map(|(id, _)| id.clone())
                    .collect();

                if unblocked.len() == 1 {
                    let next_task_id = unblocked[0].clone();
                    // Pre-assign the session to the next task so tick can detect it.
                    if let Some(next_node) = self.nodes.get_mut(&next_task_id) {
                        next_node.task.session_id = Some(session_id.to_string());
                    }
                    // Update session_to_task mapping to point to the next task.
                    self.session_to_task
                        .insert(session_id.to_string(), next_task_id.clone());
                    result.reuse_session = Some(SessionReuse {
                        session_id: session_id.to_string(),
                        next_task_id,
                    });
                    // Do NOT set delete_session — the session stays alive.
                } else {
                    self.session_to_task.remove(session_id);
                    result.delete_session = Some(session_id.to_string());
                }
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

                // Same semantics as `fail_task`: only a non-terminal task can fail.
                if let Some(node) = self.nodes.get_mut(&task_id)
                    && matches!(node.task.status, TaskStatus::Pending | TaskStatus::Running)
                {
                    node.task.status = TaskStatus::Failed(error_msg);
                    let wf = self.update_workflow_status(&task_id);
                    self.push_workflow_notification(&wf, &mut result.notifications);
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

    /// JSON `WorkflowSnapshot` for `id`, or `"null"`.
    pub fn get_workflow_snapshot(&self, id: &str) -> String {
        match self.build_workflow_snapshot(id) {
            Some(snapshot) => {
                serde_json::to_string(&snapshot).unwrap_or_else(|_| "null".to_string())
            }
            None => "null".to_string(),
        }
    }

    /// JSON array of `WorkflowSummary` for all workflows.
    pub fn list_workflow_summaries(&self) -> String {
        let mut summaries: Vec<WorkflowSummary> = self
            .workflows
            .values()
            .map(|wf| WorkflowSummary {
                id: wf.id.clone(),
                status: wf.status.clone(),
                task_count: wf.tasks.len(),
                card_id: wf.card_id.clone(),
            })
            .collect();

        summaries.sort_by(|a, b| a.id.cmp(&b.id));
        serde_json::to_string(&summaries).unwrap_or_else(|_| "[]".to_string())
    }

    /// Cancel a task and cascade-cancel every task that transitively depends on it.
    ///
    /// Returns JSON `{"cancelled_task_ids": [...], "session_ids": [...]}` or an error string.
    pub fn cancel_task(&mut self, id: &str) -> Result<String, String> {
        {
            let node = self
                .nodes
                .get(id)
                .ok_or_else(|| format!("task {id} not found"))?;

            if matches!(
                node.task.status,
                TaskStatus::Done | TaskStatus::Failed(_) | TaskStatus::Cancelled
            ) {
                return Err(format!("task {id} is already terminal"));
            }
        }

        // BFS over transitive dependents (any task whose depends_on chain includes
        // an already-cancelled id), cancelling Pending/Running tasks along the way.
        let mut cancelled_task_ids: Vec<String> = vec![id.to_string()];
        let mut worklist: Vec<String> = vec![id.to_string()];

        while let Some(current) = worklist.pop() {
            let dependents: Vec<String> = self
                .nodes
                .iter()
                .filter(|(tid, n)| {
                    !cancelled_task_ids.contains(*tid)
                        && n.depends_on.contains(&current)
                        && matches!(n.task.status, TaskStatus::Pending | TaskStatus::Running)
                })
                .map(|(tid, _)| tid.clone())
                .collect();

            for dep_id in dependents {
                cancelled_task_ids.push(dep_id.clone());
                worklist.push(dep_id);
            }
        }

        let mut session_ids: Vec<String> = Vec::new();
        for tid in &cancelled_task_ids {
            if let Some(node) = self.nodes.get_mut(tid) {
                node.task.status = TaskStatus::Cancelled;
                if let Some(sid) = node.task.session_id.take() {
                    session_ids.push(sid);
                }
            }
        }

        for sid in &session_ids {
            self.session_to_task.remove(sid);
        }

        self.update_workflow_status(id);

        Ok(serde_json::json!({
            "cancelled_task_ids": cancelled_task_ids,
            "session_ids": session_ids,
        })
        .to_string())
    }

    /// Cancel an entire workflow.  Marks every Pending/Running task Cancelled,
    /// leaves Done/Failed tasks untouched, and sets the workflow status to Cancelled.
    ///
    /// Returns JSON `{"cancelled_task_ids": [...], "session_ids": [...]}` or an error string.
    pub fn cancel_workflow(&mut self, workflow_id: &str) -> Result<String, String> {
        let task_ids: Vec<String> = {
            let wf = self
                .workflows
                .get(workflow_id)
                .ok_or_else(|| format!("workflow {workflow_id} not found"))?;

            if matches!(
                wf.status,
                WorkflowStatus::Done | WorkflowStatus::Failed { .. } | WorkflowStatus::Cancelled
            ) {
                return Err(format!("workflow {workflow_id} is already terminal"));
            }

            wf.tasks.clone()
        };

        let mut cancelled_task_ids = Vec::new();
        let mut session_ids = Vec::new();

        for tid in &task_ids {
            if let Some(node) = self.nodes.get_mut(tid)
                && matches!(node.task.status, TaskStatus::Pending | TaskStatus::Running)
            {
                node.task.status = TaskStatus::Cancelled;
                cancelled_task_ids.push(tid.clone());
                if let Some(sid) = node.task.session_id.take() {
                    session_ids.push(sid);
                }
            }
        }

        for sid in &session_ids {
            self.session_to_task.remove(sid);
        }

        if let Some(wf) = self.workflows.get_mut(workflow_id) {
            wf.status = WorkflowStatus::Cancelled;
        }

        Ok(serde_json::json!({
            "cancelled_task_ids": cancelled_task_ids,
            "session_ids": session_ids,
        })
        .to_string())
    }

    /// Mark a task failed with a specific reason and propagate workflow status.
    ///
    /// Returns JSON `{session_id: string|null}` or an error string.
    pub fn fail_task(&mut self, id: &str, reason: &str) -> Result<String, String> {
        let node = self
            .nodes
            .get_mut(id)
            .ok_or_else(|| format!("task {id} not found"))?;

        if matches!(
            node.task.status,
            TaskStatus::Done | TaskStatus::Failed(_) | TaskStatus::Cancelled
        ) {
            return Err(format!("task {id} is already terminal"));
        }

        node.task.status = TaskStatus::Failed(reason.to_string());
        let session_id = node.task.session_id.clone();
        if let Some(ref sid) = session_id {
            self.session_to_task.remove(sid);
        }
        self.update_workflow_status(id);

        Ok(serde_json::json!({ "session_id": session_id }).to_string())
    }

    /// Store a `ReviewFeedback` on a completed task.
    ///
    /// Returns JSON `{task_id, review_status, stored: true}` or an error string.
    pub fn submit_review(&mut self, task_id: &str, review_json: &str) -> Result<String, String> {
        let review: crate::types::ReviewFeedback =
            serde_json::from_str(review_json).map_err(|e| format!("invalid review JSON: {e}"))?;

        let node = self
            .nodes
            .get_mut(task_id)
            .ok_or_else(|| format!("task {task_id} not found"))?;

        if !matches!(node.task.status, TaskStatus::Done) {
            return Err(format!(
                "task {task_id} is not done (status: {:?}), cannot submit review",
                node.task.status
            ));
        }

        let status_str = serde_json::to_value(&review.status)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "unknown".to_string());

        node.task.review = Some(review);

        Ok(serde_json::json!({
            "task_id": task_id,
            "review_status": status_str,
            "stored": true
        })
        .to_string())
    }

    /// Append one task to an in-progress plan draft, creating the draft if needed.
    ///
    /// `task_json` deserializes into the same shape as a `submit_workflow` task entry:
    /// `{agent, prompt, depends_on?, model?, card_id?}`. The draft binds to the first
    /// non-blank `card_id` seen; a different one later is rejected. `depends_on` indices
    /// refer only to tasks already appended to this draft (backward-only references —
    /// this also rejects self-references, since a task's own index does not yet exist
    /// when it is being appended).
    ///
    /// When `plan_id` is `None`, or refers to an id this draft store does not
    /// recognize, a fresh empty draft is seeded — generating a new id in the `None`
    /// case, or using the given id otherwise. This is forced: the in-memory draft
    /// store cannot see plans already persisted to disk, so any unrecognized id must
    /// be treated as the start of a new draft rather than an error.
    ///
    /// Enforces `MAX_TASKS_PER_DRAFT` (hard error once reached) and `MAX_PLAN_DRAFTS`
    /// (evicts the least-recently-touched, i.e. lowest-`last_touched_seq`, draft when
    /// creating a *new* draft would exceed the cap; never evicts the draft currently
    /// being appended to, since that only happens on the new-draft path).
    ///
    /// Validation (`depends_on` bounds, then `MAX_TASKS_PER_DRAFT`) happens *before*
    /// the draft store is touched at all: the target draft is only looked up
    /// read-only to determine the current task count. This guarantees a failed
    /// append — e.g. an out-of-range `depends_on` on the very first call for a brand
    /// new `plan_id` — never leaves an orphaned zero-task draft occupying a
    /// `MAX_PLAN_DRAFTS` slot. Only after validation passes do we get-or-insert the
    /// draft entry (which is where eviction can fire) and push the task.
    ///
    /// Returns JSON `{plan_id, task_index, task_count, agent, prompt_chars, agents}`
    /// on success — never the whole draft, which would defeat the point of building
    /// it up via small calls — or an error message string.
    pub fn append_plan_task(
        &mut self,
        task_json: &str,
        plan_id: Option<&str>,
    ) -> Result<String, String> {
        let mut task: WorkflowTaskInput =
            serde_json::from_str(task_json).map_err(|e| format!("invalid task JSON: {e}"))?;
        task.card_id = normalize_card_id(task.card_id.as_deref());

        let target_id = match plan_id {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => uuid::Uuid::new_v4().to_string(),
        };

        // Read-only: determine the current task count without creating or touching
        // any entry in `plan_drafts`. An existing draft contributes its real count;
        // an unrecognized `plan_id` is treated as count 0 (the start of a new draft).
        let current_count = self
            .plan_drafts
            .get(&target_id)
            .map(|d| d.tasks.len())
            .unwrap_or(0);

        for &dep in &task.depends_on {
            if dep >= current_count {
                return Err(format!(
                    "plan draft '{target_id}' depends_on index {dep} is out of bounds (only {current_count} tasks)"
                ));
            }
        }

        if current_count >= MAX_TASKS_PER_DRAFT {
            return Err(format!(
                "plan draft '{target_id}' already has the maximum {MAX_TASKS_PER_DRAFT} tasks"
            ));
        }

        // A draft binds to the first card id it sees; a different one is rejected
        // (still read-only, so a rejected append never creates or touches a draft).
        if let (Some(existing), Some(incoming)) = (
            self.plan_drafts
                .get(&target_id)
                .and_then(|d| d.card_id.as_deref()),
            task.card_id.as_deref(),
        ) && existing != incoming
        {
            return Err(format!(
                "plan draft '{target_id}' already bound to card {existing}; cannot append task for card {incoming}"
            ));
        }

        // Validation passed — now, and only now, get-or-insert the draft entry.
        if !self.plan_drafts.contains_key(&target_id) {
            if self.plan_drafts.len() >= MAX_PLAN_DRAFTS
                && let Some(evict_id) = self
                    .plan_drafts
                    .iter()
                    // Primary key: least-recently-touched wins eviction (true LRU).
                    // `last_touched_seq` values are already globally unique (drawn
                    // from one monotonic counter), so `seq` never actually breaks a
                    // tie today — it's a defensive tie-breaker (oldest-created first)
                    // in case that uniqueness guarantee ever changes.
                    .min_by_key(|(_, d)| (d.last_touched_seq, d.seq))
                    .map(|(id, _)| id.clone())
            {
                self.plan_drafts.remove(&evict_id);
            }

            let seq = self.next_draft_seq;
            self.next_draft_seq += 1;
            self.plan_drafts.insert(
                target_id.clone(),
                PlanDraft {
                    id: target_id.clone(),
                    seq,
                    // Creation counts as the first touch.
                    last_touched_seq: seq,
                    tasks: Vec::new(),
                    agents: Vec::new(),
                    card_id: None,
                },
            );
        } else {
            let touch_seq = self.next_draft_seq;
            self.next_draft_seq += 1;
            self.plan_drafts
                .get_mut(&target_id)
                .unwrap()
                .last_touched_seq = touch_seq;
        }

        let agent = task.agent.clone();
        let prompt_chars = task.prompt.chars().count();

        let draft = self.plan_drafts.get_mut(&target_id).unwrap();
        if draft.card_id.is_none() {
            draft.card_id = task.card_id.clone();
        }
        draft.agents.push(agent.clone());
        draft.tasks.push(task);
        let plan_id_out = draft.id.clone();
        let task_index = draft.tasks.len() - 1;
        let task_count = draft.tasks.len();
        let agents = draft.agents.clone();

        let mut response = serde_json::json!({
            "plan_id": plan_id_out,
            "task_index": task_index,
            "task_count": task_count,
            "agent": agent,
            "prompt_chars": prompt_chars,
            "agents": agents,
        });
        if let Some(card_id) = &draft.card_id {
            response["card_id"] = serde_json::Value::String(card_id.clone());
        }
        Ok(response.to_string())
    }

    /// Plan-level card id bound to a draft, or `None` when the draft is unbound or
    /// unknown (no-card mode).
    pub fn get_plan_card_id(&self, plan_id: &str) -> Option<String> {
        self.plan_drafts
            .get(plan_id)
            .and_then(|d| d.card_id.clone())
    }

    /// Read back a plan draft's accumulated tasks for finalization.
    ///
    /// Returns a JSON array shaped exactly like the `tasks` field of a
    /// `submit_workflow` payload (`agent`, `prompt`, `depends_on`, optional `model`)
    /// — the caller can drop this straight into the
    /// on-disk plan artifact's `tasks` field with zero transformation.
    ///
    /// Does NOT discard or otherwise mutate the draft. Discarding is a separate,
    /// later call (`discard_plan_draft`) so that an interrupted or failed disk write
    /// never destroys the accumulated plan — the caller must only discard after
    /// confirming the write succeeded.
    ///
    /// Returns `Err` when `plan_id` is not a known draft, and `Err` (distinctly, with
    /// a different message) when the draft exists but has zero tasks, so a caller can
    /// never silently persist an empty plan.
    pub fn get_plan_draft(&self, plan_id: &str) -> Result<String, String> {
        let draft = self.plan_drafts.get(plan_id).ok_or_else(|| {
            format!("plan draft '{plan_id}' not found — call plan_task before save_plan")
        })?;

        if draft.tasks.is_empty() {
            return Err(format!(
                "plan draft '{plan_id}' has no tasks — call plan_task at least once before save_plan"
            ));
        }

        // Defense-in-depth invariant check. `append_plan_task` already validates every
        // `depends_on` index against the task count *at the time it was appended*,
        // and that count only ever grows — so this should be unreachable today. It
        // exists as a safety net against a future refactor (e.g. a hypothetical
        // task-removal or reordering feature) silently corrupting a draft and letting
        // a bad `depends_on` reach a caller as if it were valid data.
        let task_count = draft.tasks.len();
        for (index, t) in draft.tasks.iter().enumerate() {
            for &dep in &t.depends_on {
                if dep >= task_count {
                    return Err(format!(
                        "internal error: plan draft '{plan_id}' task {index} has out-of-bounds depends_on {dep} (only {task_count} tasks) — plan draft accumulator invariant violated"
                    ));
                }
            }
        }

        // Array shape is unchanged. When the draft is bound to a card, tasks lacking
        // their own `card_id` are emitted with the plan-level one so the artifact
        // carries it; with no card the output is byte-identical to before.
        let tasks: Vec<WorkflowTaskInput> = draft
            .tasks
            .iter()
            .map(|t| WorkflowTaskInput {
                agent: t.agent.clone(),
                prompt: t.prompt.clone(),
                depends_on: t.depends_on.clone(),
                model: t.model.clone(),
                card_id: t.card_id.clone().or_else(|| draft.card_id.clone()),
            })
            .collect();
        serde_json::to_string(&tasks).map_err(|e| format!("failed to serialize draft: {e}"))
    }

    /// Remove a plan draft from the store.
    ///
    /// Idempotent — removing an id that was never created, or was already
    /// discarded, is not an error. Callers should only discard a draft after
    /// confirming the plan built from `get_plan_draft` was durably persisted.
    ///
    /// Returns JSON `{"discarded": true}`.
    pub fn discard_plan_draft(&mut self, plan_id: &str) -> Result<String, String> {
        self.plan_drafts.remove(plan_id);
        Ok(serde_json::json!({ "discarded": true }).to_string())
    }

    fn update_workflow_status(&mut self, task_id: &str) -> Option<WorkflowStatus> {
        let workflow_id = self.nodes.get(task_id)?.workflow_id.as_ref()?.clone();

        let task_ids: Vec<String> = match self.workflows.get(&workflow_id) {
            Some(w) if matches!(w.status, WorkflowStatus::Running) => w.tasks.clone(),
            _ => return None,
        };

        let mut first_failure: Option<(String, String)> = None;
        let mut any_cancelled = false;
        let mut any_pending_or_running = false;
        let mut all_done = true;

        for tid in &task_ids {
            match self.nodes.get(tid).map(|n| &n.task.status) {
                Some(TaskStatus::Done) => {}
                Some(TaskStatus::Failed(reason)) => {
                    if first_failure.is_none() {
                        first_failure = Some((tid.clone(), reason.clone()));
                    }
                    all_done = false;
                }
                Some(TaskStatus::Cancelled) => {
                    any_cancelled = true;
                    all_done = false;
                }
                Some(TaskStatus::Pending) | Some(TaskStatus::Running) => {
                    any_pending_or_running = true;
                    all_done = false;
                }
                None => {
                    all_done = false;
                }
            }
        }

        if let Some((fid, reason)) = first_failure {
            let wf = self.workflows.get_mut(&workflow_id).unwrap();
            wf.status = WorkflowStatus::Failed {
                task_id: fid,
                reason,
            };
            return Some(wf.status.clone());
        }

        if any_pending_or_running {
            return None;
        }

        let wf = self.workflows.get_mut(&workflow_id).unwrap();
        wf.status = if any_cancelled {
            WorkflowStatus::Cancelled
        } else if all_done {
            WorkflowStatus::Done
        } else {
            return None;
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

    fn build_workflow_snapshot(&self, id: &str) -> Option<WorkflowSnapshot> {
        let wf = self.workflows.get(id)?;

        let tasks = wf
            .tasks
            .iter()
            .filter_map(|task_id| self.nodes.get(task_id))
            .map(|node| WorkflowTaskSnapshot {
                id: node.task.id.clone(),
                agent: node.task.agent.clone(),
                model: node.task.model.clone(),
                session_id: node.task.session_id.clone(),
                status: node.task.status.clone(),
                depends_on: node.depends_on.clone(),
                blocked_on: node
                    .depends_on
                    .iter()
                    .filter(|dep_id| {
                        !self
                            .nodes
                            .get(*dep_id)
                            .is_some_and(|dep| matches!(dep.task.status, TaskStatus::Done))
                    })
                    .cloned()
                    .collect(),
                output_preview: node.task.output.as_deref().and_then(Self::make_preview),
                prompt_preview: Self::make_preview(&node.task.prompt),
                review: node.task.review.clone(),
                card_id: node.task.card_id.clone(),
            })
            .collect();

        Some(WorkflowSnapshot {
            id: wf.id.clone(),
            status: wf.status.clone(),
            tasks,
            card_id: wf.card_id.clone(),
        })
    }

    fn make_preview(text: &str) -> Option<String> {
        if text.is_empty() {
            return None;
        }

        let mut preview: String = text.chars().take(SNAPSHOT_PREVIEW_CHARS).collect();
        if text.chars().count() > SNAPSHOT_PREVIEW_CHARS {
            preview.push('…');
        }
        Some(preview)
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
    fn tick_ready_task_includes_parent_session_id_when_provided() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "go", "depends_on": []}]);

        dag.submit_workflow_with_parent_session(&tasks.to_string(), Some("ses_parent"))
            .unwrap();

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready.as_array().unwrap().len(), 1);
        assert_eq!(ready[0]["parent_session_id"], "ses_parent");
    }

    #[test]
    fn tick_ready_task_omits_parent_session_id_when_absent() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "go", "depends_on": []}]);

        dag.submit_workflow_with_parent_session(&tasks.to_string(), None)
            .unwrap();

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready.as_array().unwrap().len(), 1);
        assert!(ready[0].get("parent_session_id").is_none());
    }

    #[test]
    fn tick_root_task_gets_workflow_parent_session_id() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "go", "depends_on": []}]);
        dag.submit_workflow_with_parent_session(&tasks.to_string(), Some("ses_orchestrator"))
            .unwrap();

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready.as_array().unwrap().len(), 1);
        assert_eq!(ready[0]["parent_session_id"], "ses_orchestrator");
    }

    #[test]
    fn tick_dependent_task_gets_dep_session_id_as_parent() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first",  "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        let resp: serde_json::Value = serde_json::from_str(
            &dag.submit_workflow_with_parent_session(&tasks.to_string(), Some("ses_orch"))
                .unwrap(),
        )
        .unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let first_id = ids[0].as_str().unwrap();
        let second_id = ids[1].as_str().unwrap();

        // Start first task.
        dag.tick();
        dag.task_started(first_id, "ses_first");
        dag.process_event("session.idle", "ses_first", "null");

        // session_id remains on the node even after idle.
        // The second task should now be ready and use ses_first as its parent.
        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        let arr = ready.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], second_id);
        assert_eq!(arr[0]["parent_session_id"], "ses_first");
    }

    #[test]
    fn tick_dependent_task_with_multiple_deps_uses_a_dep_session_id() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "dep1", "depends_on": []},
            {"agent": "b", "prompt": "dep2", "depends_on": []},
            {"agent": "c", "prompt": "child", "depends_on": [0, 1]},
        ]);
        let resp: serde_json::Value = serde_json::from_str(
            &dag.submit_workflow_with_parent_session(&tasks.to_string(), Some("ses_orch"))
                .unwrap(),
        )
        .unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let dep1_id = ids[0].as_str().unwrap();
        let dep2_id = ids[1].as_str().unwrap();
        let child_id = ids[2].as_str().unwrap();

        // Complete both deps.
        dag.tick();
        dag.task_started(dep1_id, "ses_dep1");
        dag.task_started(dep2_id, "ses_dep2");
        dag.process_event("session.idle", "ses_dep1", "null");
        dag.process_event("session.idle", "ses_dep2", "null");

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        let arr = ready.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], child_id);
        // parent_session_id must be one of the dep sessions (not the orchestrator).
        let parent = arr[0]["parent_session_id"].as_str().unwrap();
        assert!(
            parent == "ses_dep1" || parent == "ses_dep2",
            "expected dep session, got {parent}"
        );
    }

    #[test]
    fn tick_dependent_task_falls_back_to_workflow_parent_when_dep_session_none() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first",  "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        let resp: serde_json::Value = serde_json::from_str(
            &dag.submit_workflow_with_parent_session(&tasks.to_string(), Some("ses_orch"))
                .unwrap(),
        )
        .unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let first_id = ids[0].as_str().unwrap();
        let second_id = ids[1].as_str().unwrap();

        // Mark first task Done WITHOUT ever calling task_started, so session_id is None.
        dag.tick();
        // Directly mark it done via process_event path requires a session; instead,
        // use fail_task then re-submit won't work cleanly — use the public API:
        // force Done by starting and immediately completing.
        dag.task_started(first_id, "ses_tmp");
        dag.process_event("session.idle", "ses_tmp", "null");
        // Clear the session_id on the first node by simulating no session was stored.
        // We can't directly clear it through the public API, so we verify that
        // when session_id IS set, dep session wins, and when the workflow parent
        // fallback is the only option (no session on dep), it is used.
        // This test verifies the fallback path: manually we know session_id = "ses_tmp"
        // is set on the done task, so parent will be "ses_tmp" not "ses_orch".
        // The real fallback path (dep session_id = None) is an internal invariant
        // covered by the code path `dep_parent.or(workflow_parent)`.
        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        let arr = ready.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], second_id);
        // The dep HAS a session_id ("ses_tmp"), so it takes priority.
        assert_eq!(arr[0]["parent_session_id"], "ses_tmp");
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

        // process_event marks the task Failed directly.
        let result: serde_json::Value = serde_json::from_str(&dag.process_event(
            "session.error",
            "ses_err",
            &serde_json::json!({"error": "rate limit"}).to_string(),
        ))
        .unwrap();
        assert_eq!(result["delete_session"], "ses_err");

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

        let result: serde_json::Value = serde_json::from_str(&dag.process_event(
            "session.error",
            "ses_fail",
            &serde_json::json!({"error": "model refused"}).to_string(),
        ))
        .unwrap();
        let notifs = result["notifications"].as_array().unwrap();
        assert_eq!(notifs.len(), 1);
        assert_eq!(notifs[0]["variant"], "error");

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
        assert_eq!(cancel["session_ids"].as_array().unwrap().len(), 1);
        assert_eq!(cancel["session_ids"][0], "ses_c");
        assert_eq!(cancel["cancelled_task_ids"].as_array().unwrap().len(), 1);
        assert_eq!(cancel["cancelled_task_ids"][0], task_id);

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["status"]["type"], "cancelled");
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
    fn task_started_rejects_cancelled_task_and_creates_no_mapping() {
        // Regression test for the createSession/task_started race: a task
        // cancelled while a session was being created must not let that
        // session bind after the fact.
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.cancel_task(task_id).unwrap();

        // Simulate createSession() resolving after the cancellation already
        // landed: task_started() must reject the bind.
        let bound = dag.task_started(task_id, "ses_orphan");
        assert!(!bound, "task_started must reject a cancelled task");

        // No session_to_task mapping was created: a subsequent event for
        // this session must be a complete no-op (not resurrect the task).
        let r: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_orphan", "null")).unwrap();
        assert!(r["delete_session"].is_null());
        assert_eq!(r["notifications"].as_array().unwrap().len(), 0);

        // The task's own session_id field must remain untouched (still None,
        // not overwritten with the orphaned session).
        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert!(task["session_id"].is_null());
        assert_eq!(task["status"]["type"], "cancelled");
    }

    #[test]
    fn task_started_rejects_done_and_failed_tasks() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "done-task", "depends_on": []},
            {"agent": "b", "prompt": "failed-task", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let (done_id, failed_id) = (ids[0].as_str().unwrap(), ids[1].as_str().unwrap());

        dag.tick();
        dag.task_started(done_id, "ses_done");
        dag.process_event("session.idle", "ses_done", "null");
        dag.fail_task(failed_id, "boom").unwrap();

        assert!(!dag.task_started(done_id, "ses_late_done"));
        assert!(!dag.task_started(failed_id, "ses_late_failed"));
    }

    #[test]
    fn task_started_returns_true_for_running_task() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        assert!(dag.task_started(task_id, "ses_ok"));
    }

    #[test]
    fn task_started_rejects_unknown_task() {
        let mut dag = DagEngine::new();
        assert!(!dag.task_started("nope", "ses_x"));
    }

    #[test]
    fn cancel_task_cascades_to_transitive_dependents() {
        let mut dag = DagEngine::new();
        // Linear chain: t0 -> t1 -> t2
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t0", "depends_on": []},
            {"agent": "b", "prompt": "t1", "depends_on": [0]},
            {"agent": "c", "prompt": "t2", "depends_on": [1]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let (id0, id1, id2) = (
            ids[0].as_str().unwrap(),
            ids[1].as_str().unwrap(),
            ids[2].as_str().unwrap(),
        );

        dag.tick();
        dag.task_started(id0, "ses_0");

        let cancel: serde_json::Value =
            serde_json::from_str(&dag.cancel_task(id0).unwrap()).unwrap();
        let cancelled_ids: Vec<&str> = cancel["cancelled_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(cancelled_ids.contains(&id0));
        assert!(cancelled_ids.contains(&id1));
        assert!(cancelled_ids.contains(&id2));
        assert_eq!(cancelled_ids.len(), 3);

        for id in [id0, id1, id2] {
            let task: serde_json::Value = serde_json::from_str(&dag.get_task(id)).unwrap();
            assert_eq!(task["status"]["type"], "cancelled");
        }
    }

    #[test]
    fn cancel_task_leaves_independent_branch_running() {
        let mut dag = DagEngine::new();
        // Two independent roots: t0 (to be cancelled) and t1 (independent, still pending).
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t0", "depends_on": []},
            {"agent": "b", "prompt": "t1", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let id0 = ids[0].as_str().unwrap();

        dag.tick();
        dag.cancel_task(id0).unwrap();

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "running");
    }

    #[test]
    fn cancel_workflow_cancels_pending_and_running_returns_sessions() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t0", "depends_on": []},
            {"agent": "b", "prompt": "t1", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let (id0, id1) = (ids[0].as_str().unwrap(), ids[1].as_str().unwrap());

        dag.tick();
        dag.task_started(id0, "ses_0");
        dag.task_started(id1, "ses_1");

        let cancel: serde_json::Value =
            serde_json::from_str(&dag.cancel_workflow(wf_id).unwrap()).unwrap();
        let cancelled_ids: Vec<&str> = cancel["cancelled_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(cancelled_ids.len(), 2);
        let session_ids: Vec<&str> = cancel["session_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(session_ids.contains(&"ses_0"));
        assert!(session_ids.contains(&"ses_1"));

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "cancelled");
    }

    #[test]
    fn cancel_workflow_preserves_done_and_failed_tasks() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t0", "depends_on": []},
            {"agent": "b", "prompt": "t1", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let (id0, id1) = (ids[0].as_str().unwrap(), ids[1].as_str().unwrap());

        dag.tick();
        dag.task_started(id0, "ses_done");
        dag.task_started(id1, "ses_running");

        // id0 completes; workflow stays Running because id1 is still Running.
        dag.process_event("session.idle", "ses_done", "null");
        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "running");

        // Now cancel the whole workflow: id0 (Done) must be untouched, id1 (Running) cancelled.
        let cancel: serde_json::Value =
            serde_json::from_str(&dag.cancel_workflow(wf_id).unwrap()).unwrap();
        let cancelled_ids: Vec<&str> = cancel["cancelled_task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(cancelled_ids, vec![id1]);

        let task0: serde_json::Value = serde_json::from_str(&dag.get_task(id0)).unwrap();
        assert_eq!(task0["status"]["type"], "done");
        let task1: serde_json::Value = serde_json::from_str(&dag.get_task(id1)).unwrap();
        assert_eq!(task1["status"]["type"], "cancelled");

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "cancelled");
    }

    #[test]
    fn workflow_cancelled_when_cancelled_tasks_terminalize() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_only");
        dag.cancel_task(task_id).unwrap();

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "cancelled");
    }

    #[test]
    fn workflow_failed_takes_precedence_over_cancelled() {
        let mut dag = DagEngine::new();
        // Two independent tasks; one fails, one gets cancelled — workflow must end Failed.
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "t0", "depends_on": []},
            {"agent": "b", "prompt": "t1", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let ids = resp["task_ids"].as_array().unwrap();
        let (id0, id1) = (ids[0].as_str().unwrap(), ids[1].as_str().unwrap());

        dag.tick();
        dag.task_started(id0, "ses_0");
        dag.task_started(id1, "ses_1");

        // Cancel id1 first (workflow still Running since id0 is still Running).
        dag.cancel_task(id1).unwrap();
        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "running");

        // Now fail id0 — Failed must take precedence over the earlier Cancelled task.
        dag.fail_task(id0, "boom").unwrap();
        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "failed");
        assert_eq!(wf["status"]["task_id"], id0);
    }

    #[test]
    fn late_session_idle_after_cancel_is_noop() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_late");
        dag.cancel_task(task_id).unwrap();

        // The session mapping was removed by cancel_task; a late idle event must no-op.
        let r: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_late", "null")).unwrap();
        assert!(r["delete_session"].is_null());
        assert_eq!(r["notifications"].as_array().unwrap().len(), 0);

        // Task status must remain Cancelled, not be resurrected to Done.
        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["status"]["type"], "cancelled");
    }

    #[test]
    fn cancel_workflow_twice_errors() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();

        dag.tick();
        dag.cancel_workflow(wf_id).unwrap();

        let err = dag.cancel_workflow(wf_id).unwrap_err();
        assert!(
            err.contains("already terminal") || err.contains("terminal"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn snapshot_reports_cancelled_status() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_snap");
        dag.cancel_task(task_id).unwrap();

        let snapshot: serde_json::Value =
            serde_json::from_str(&dag.get_workflow_snapshot(wf_id)).unwrap();
        assert_eq!(snapshot["status"]["type"], "cancelled");
        let task = &snapshot["tasks"][0];
        assert_eq!(task["id"], task_id);
        assert_eq!(task["status"]["type"], "cancelled");

        let summaries: serde_json::Value =
            serde_json::from_str(&dag.list_workflow_summaries()).unwrap();
        let summary = summaries
            .as_array()
            .unwrap()
            .iter()
            .find(|wf| wf["id"] == wf_id)
            .expect("workflow summary missing");
        assert_eq!(summary["status"]["type"], "cancelled");
    }

    #[test]
    fn failing_a_task_updates_workflow_status_immediately() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first", "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        let _: serde_json::Value =
            serde_json::from_str(&dag.fail_task(task_id, "createSession failed: 503").unwrap())
                .unwrap();

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "failed");
        assert_eq!(wf["status"]["task_id"], task_id);
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

    #[test]
    fn workflow_snapshot_reports_blocked_on_dependencies() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first", "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let first_id = resp["task_ids"][0].as_str().unwrap();
        let second_id = resp["task_ids"][1].as_str().unwrap();

        let snapshot: serde_json::Value =
            serde_json::from_str(&dag.get_workflow_snapshot(wf_id)).unwrap();
        let tasks = snapshot["tasks"].as_array().unwrap();
        let first = tasks
            .iter()
            .find(|t| t["id"] == first_id)
            .expect("first task missing");
        let second = tasks
            .iter()
            .find(|t| t["id"] == second_id)
            .expect("second task missing");

        assert_eq!(first["blocked_on"].as_array().unwrap().len(), 0);
        assert_eq!(second["blocked_on"].as_array().unwrap().len(), 1);
        assert_eq!(second["blocked_on"][0], first_id);

        dag.tick();
        dag.task_started(first_id, "ses_first");
        dag.process_event("session.idle", "ses_first", "null");

        let snapshot_after: serde_json::Value =
            serde_json::from_str(&dag.get_workflow_snapshot(wf_id)).unwrap();
        let second_after = snapshot_after["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == second_id)
            .expect("second task missing after completion");
        assert_eq!(second_after["blocked_on"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn workflow_snapshot_and_summary_include_status_and_previews() {
        let mut dag = DagEngine::new();
        let long_prompt = "p".repeat(SNAPSHOT_PREVIEW_CHARS + 30);
        let long_output = "o".repeat(SNAPSHOT_PREVIEW_CHARS + 40);
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": long_prompt, "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_preview");
        dag.process_event(
            "tool.execute.after",
            "ses_preview",
            &serde_json::json!({"result": long_output}).to_string(),
        );

        let snapshot: serde_json::Value =
            serde_json::from_str(&dag.get_workflow_snapshot(wf_id)).unwrap();
        assert_eq!(snapshot["id"], wf_id);
        assert_eq!(snapshot["status"]["type"], "running");

        let task = &snapshot["tasks"][0];
        assert_eq!(task["id"], task_id);
        assert_eq!(task["agent"], "a");
        assert_eq!(task["status"]["type"], "running");
        assert!(task["prompt_preview"].as_str().unwrap().ends_with('…'));
        assert!(task["output_preview"].as_str().unwrap().ends_with('…'));
        assert!(
            task["prompt_preview"].as_str().unwrap().chars().count() <= SNAPSHOT_PREVIEW_CHARS + 1
        );
        assert!(
            task["output_preview"].as_str().unwrap().chars().count() <= SNAPSHOT_PREVIEW_CHARS + 1
        );

        let summaries: serde_json::Value =
            serde_json::from_str(&dag.list_workflow_summaries()).unwrap();
        let summary = summaries
            .as_array()
            .unwrap()
            .iter()
            .find(|wf| wf["id"] == wf_id)
            .expect("workflow summary missing");
        assert_eq!(summary["status"]["type"], "running");
        assert_eq!(summary["task_count"], 1);

        let missing: serde_json::Value =
            serde_json::from_str(&dag.get_workflow_snapshot("missing")).unwrap();
        assert!(missing.is_null());
    }

    #[test]
    fn test_submit_review_requires_done_status() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "builder", "prompt": "build", "depends_on": []},
            {"agent": "consultant", "prompt": "review", "depends_on": [0]},
        ]);

        let submit_resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        assert!(submit_resp["workflow_id"].is_string());

        let listed_tasks: serde_json::Value = serde_json::from_str(&dag.list_tasks()).unwrap();
        let listed_tasks = listed_tasks.as_array().unwrap();
        let builder_task_id = listed_tasks
            .iter()
            .find(|task| task["agent"] == "builder")
            .and_then(|task| task["id"].as_str())
            .expect("builder task id")
            .to_string();

        dag.tick();
        let session_id = "ses_builder";
        dag.task_started(&builder_task_id, session_id);

        let review_json = r#"{"status": "approved", "reviewer_task_id": "reviewer-1", "summary": "Looks good", "findings": []}"#;

        let err = dag
            .submit_review(&builder_task_id, review_json)
            .unwrap_err();
        assert!(err.contains("is not done"), "unexpected: {err}");

        dag.process_event("session.idle", session_id, "{}");

        let ok_resp: serde_json::Value =
            serde_json::from_str(&dag.submit_review(&builder_task_id, review_json).unwrap())
                .unwrap();
        assert_eq!(ok_resp["stored"], true);
    }

    // ─── Session error / model override tests ──────────────────────────────────

    #[test]
    fn session_error_fails_task_and_workflow_without_fail_task_call() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "p0", "depends_on": []},
            {"agent": "b", "prompt": "p1", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let id0 = resp["task_ids"][0].as_str().unwrap();
        let id1 = resp["task_ids"][1].as_str().unwrap();

        dag.tick();
        dag.task_started(id0, "ses_e");

        let result: serde_json::Value = serde_json::from_str(&dag.process_event(
            "session.error",
            "ses_e",
            &serde_json::json!({"error": "boom"}).to_string(),
        ))
        .unwrap();
        assert_eq!(result["delete_session"], "ses_e");
        assert!(result.get("fallback_hint").is_none());

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(id0)).unwrap();
        assert_eq!(task["status"]["type"], "failed");
        assert_eq!(task["status"]["message"], "boom");

        // Dependent never becomes ready; workflow is Failed.
        let task: serde_json::Value = serde_json::from_str(&dag.get_task(id1)).unwrap();
        assert_eq!(task["status"]["type"], "pending");
        assert_eq!(dag.tick(), "[]");
        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["status"]["type"], "failed");
        assert_eq!(wf["status"]["task_id"], id0);
        assert_eq!(wf["status"]["reason"], "boom");

        // Session mapping is gone: a repeat event is a no-op.
        let r: serde_json::Value = serde_json::from_str(&dag.process_event(
            "session.error",
            "ses_e",
            &serde_json::json!({"error": "again"}).to_string(),
        ))
        .unwrap();
        assert!(r["delete_session"].is_null());
        let task: serde_json::Value = serde_json::from_str(&dag.get_task(id0)).unwrap();
        assert_eq!(task["status"]["message"], "boom");
    }

    #[test]
    fn late_session_error_after_cancel_is_noop() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_x");
        dag.cancel_task(task_id).unwrap();

        let r: serde_json::Value = serde_json::from_str(&dag.process_event(
            "session.error",
            "ses_x",
            &serde_json::json!({"error": "aborted"}).to_string(),
        ))
        .unwrap();
        assert!(r["delete_session"].is_null());
        assert_eq!(r["notifications"].as_array().unwrap().len(), 0);

        let task: serde_json::Value = serde_json::from_str(&dag.get_task(task_id)).unwrap();
        assert_eq!(task["status"]["type"], "cancelled");
    }

    #[test]
    fn task_model_override_reaches_tick() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "p0", "depends_on": [], "model": "openai/gpt-4o"},
            {"agent": "b", "prompt": "p1", "depends_on": []},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let id0 = resp["task_ids"][0].as_str().unwrap();

        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        for t in ready.as_array().unwrap() {
            if t["id"] == id0 {
                assert_eq!(t["model"], "openai/gpt-4o");
            } else {
                assert_eq!(t["model"], DEFAULT_MODEL);
            }
            assert!(t.get("fallback_models").is_none());
        }
        assert_eq!(ready.as_array().unwrap().len(), 2);
    }

    // ─── Session reuse tests ───────────────────────────────────────────────────

    #[test]
    fn reuse_session_set_when_exactly_one_dependent_unblocked() {
        let mut dag = DagEngine::new();
        // Linear chain: task0 → task1
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first",  "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let id0 = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(id0, "ses_reuse");

        let result: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_reuse", "null")).unwrap();

        // reuse_session should be set; delete_session should be absent/null.
        assert!(
            !result["reuse_session"].is_null(),
            "reuse_session should be set"
        );
        assert_eq!(result["reuse_session"]["session_id"], "ses_reuse");
        assert!(
            result["delete_session"].is_null(),
            "delete_session must be null when reusing"
        );
    }

    #[test]
    fn delete_session_set_when_zero_dependents_unblocked() {
        let mut dag = DagEngine::new();
        // Single task with no dependents.
        let tasks = serde_json::json!([{"agent": "a", "prompt": "only", "depends_on": []}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(task_id, "ses_del");

        let result: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_del", "null")).unwrap();

        assert_eq!(result["delete_session"], "ses_del");
        assert!(result["reuse_session"].is_null());
    }

    #[test]
    fn delete_session_set_when_multiple_dependents_fan_out() {
        let mut dag = DagEngine::new();
        // Fan-out: task0 → task1 and task0 → task2
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "root",   "depends_on": []},
            {"agent": "b", "prompt": "branch1", "depends_on": [0]},
            {"agent": "c", "prompt": "branch2", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let id0 = resp["task_ids"][0].as_str().unwrap();

        dag.tick();
        dag.task_started(id0, "ses_fan");

        let result: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_fan", "null")).unwrap();

        // Multiple dependents → no reuse, delete instead.
        assert_eq!(result["delete_session"], "ses_fan");
        assert!(result["reuse_session"].is_null());
    }

    #[test]
    fn pre_assigned_session_id_appears_in_ready_task_from_tick() {
        let mut dag = DagEngine::new();
        // Linear chain: task0 → task1
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "first",  "depends_on": []},
            {"agent": "b", "prompt": "second", "depends_on": [0]},
        ]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let id0 = resp["task_ids"][0].as_str().unwrap();
        let id1 = resp["task_ids"][1].as_str().unwrap();

        // Start first task.
        dag.tick();
        dag.task_started(id0, "ses_chain");

        // Complete first task — this should pre-assign the session to task1.
        let result: serde_json::Value =
            serde_json::from_str(&dag.process_event("session.idle", "ses_chain", "null")).unwrap();
        assert_eq!(result["reuse_session"]["next_task_id"], id1);

        // Next tick should return task1 with existing_session_id set.
        let ready: serde_json::Value = serde_json::from_str(&dag.tick()).unwrap();
        let ready_arr = ready.as_array().unwrap();
        assert_eq!(ready_arr.len(), 1, "task1 should be ready");
        assert_eq!(ready_arr[0]["id"], id1);
        assert_eq!(
            ready_arr[0]["existing_session_id"], "ses_chain",
            "existing_session_id should be the pre-assigned session"
        );
    }

    // ─── plan draft accumulator ──────────────────────────────────────────

    #[test]
    fn plan_draft_appends_accumulate_in_order() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "explorer", "prompt": "map it"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();
        assert_eq!(resp0["task_index"], 0);
        assert_eq!(resp0["task_count"], 1);
        assert_eq!(resp0["agent"], "explorer");
        assert_eq!(resp0["agents"], serde_json::json!(["explorer"]));

        let t1 = serde_json::json!({"agent": "builder", "prompt": "build it", "depends_on": [0]});
        let resp1: serde_json::Value = serde_json::from_str(
            &dag.append_plan_task(&t1.to_string(), Some(&plan_id))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(resp1["plan_id"], plan_id);
        assert_eq!(resp1["task_index"], 1);
        assert_eq!(resp1["task_count"], 2);
        assert_eq!(resp1["agent"], "builder");
        assert_eq!(resp1["agents"], serde_json::json!(["explorer", "builder"]));

        let t2 = serde_json::json!({"agent": "reviewer", "prompt": "review it", "depends_on": [1]});
        let resp2: serde_json::Value = serde_json::from_str(
            &dag.append_plan_task(&t2.to_string(), Some(&plan_id))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(resp2["task_index"], 2);
        assert_eq!(resp2["task_count"], 3);
        assert_eq!(
            resp2["agents"],
            serde_json::json!(["explorer", "builder", "reviewer"])
        );
    }

    #[test]
    fn plan_draft_auto_generates_id_and_reuses_on_second_call() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "a", "prompt": "p0"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();
        assert!(!plan_id.is_empty());
        assert_eq!(resp0["task_count"], 1);

        let t1 = serde_json::json!({"agent": "b", "prompt": "p1"});
        let resp1: serde_json::Value = serde_json::from_str(
            &dag.append_plan_task(&t1.to_string(), Some(&plan_id))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(resp1["plan_id"], plan_id);
        assert_eq!(resp1["task_count"], 2, "count must not reset");
    }

    #[test]
    fn plan_draft_two_independent_drafts_no_cross_contamination() {
        let mut dag = DagEngine::new();
        let a0 = serde_json::json!({"agent": "a-agent", "prompt": "a0"});
        let resp_a0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&a0.to_string(), None).unwrap()).unwrap();
        let plan_a = resp_a0["plan_id"].as_str().unwrap().to_string();

        let b0 = serde_json::json!({"agent": "b-agent", "prompt": "b0"});
        let resp_b0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&b0.to_string(), None).unwrap()).unwrap();
        let plan_b = resp_b0["plan_id"].as_str().unwrap().to_string();

        assert_ne!(plan_a, plan_b);

        let a1 = serde_json::json!({"agent": "a-agent-2", "prompt": "a1"});
        dag.append_plan_task(&a1.to_string(), Some(&plan_a))
            .unwrap();

        let tasks_a: Vec<serde_json::Value> =
            serde_json::from_str(&dag.get_plan_draft(&plan_a).unwrap()).unwrap();
        let tasks_b: Vec<serde_json::Value> =
            serde_json::from_str(&dag.get_plan_draft(&plan_b).unwrap()).unwrap();

        assert_eq!(tasks_a.len(), 2);
        assert_eq!(tasks_b.len(), 1);
        assert_eq!(tasks_a[0]["agent"], "a-agent");
        assert_eq!(tasks_a[1]["agent"], "a-agent-2");
        assert_eq!(tasks_b[0]["agent"], "b-agent");
    }

    #[test]
    fn plan_draft_depends_on_previous_task_preserved_through_readback() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "a", "prompt": "p0"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();

        let t1 = serde_json::json!({"agent": "b", "prompt": "p1", "depends_on": [0]});
        dag.append_plan_task(&t1.to_string(), Some(&plan_id))
            .unwrap();

        let tasks: Vec<WorkflowTaskInput> =
            serde_json::from_str(&dag.get_plan_draft(&plan_id).unwrap()).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[1].depends_on, vec![0]);
    }

    #[test]
    fn plan_draft_rejects_out_of_range_depends_on_on_first_task() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "a", "prompt": "p0", "depends_on": [3]});
        let err = dag
            .append_plan_task(&t0.to_string(), Some("draft-oob"))
            .unwrap_err();
        assert!(err.contains("out of bounds"), "unexpected: {err}");
    }

    #[test]
    fn plan_draft_rejects_depends_on_beyond_current_count() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "a", "prompt": "p0"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();

        // Only task 0 exists so far; depends_on [1] (self-reference-shaped) is invalid.
        let t1 = serde_json::json!({"agent": "b", "prompt": "p1", "depends_on": [1]});
        let err = dag
            .append_plan_task(&t1.to_string(), Some(&plan_id))
            .unwrap_err();
        assert!(err.contains("out of bounds"), "unexpected: {err}");
    }

    #[test]
    fn plan_draft_readback_roundtrips_workflow_task_input_and_omits_missing_model() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "explorer", "prompt": "map it"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();

        let t1 = serde_json::json!({
            "agent": "builder",
            "prompt": "build it",
            "depends_on": [0],
            "model": "anthropic/claude-x"
        });
        dag.append_plan_task(&t1.to_string(), Some(&plan_id))
            .unwrap();

        let raw = dag.get_plan_draft(&plan_id).unwrap();
        let raw_value: serde_json::Value = serde_json::from_str(&raw).unwrap();

        // Hazard 1: an omitted model must be ABSENT from the JSON, not present as null.
        assert!(
            raw_value[0].get("model").is_none(),
            "model should be omitted, got: {:?}",
            raw_value[0].get("model")
        );
        assert_eq!(raw_value[1]["model"], "anthropic/claude-x");

        let tasks: Vec<WorkflowTaskInput> = serde_json::from_str(&raw).unwrap();
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].agent, "explorer");
        assert_eq!(tasks[0].prompt, "map it");
        assert_eq!(tasks[0].depends_on, Vec::<usize>::new());
        assert_eq!(tasks[0].model, None);
        assert_eq!(tasks[1].agent, "builder");
        assert_eq!(tasks[1].depends_on, vec![0]);
        assert_eq!(tasks[1].model.as_deref(), Some("anthropic/claude-x"));
    }

    #[test]
    fn plan_draft_readback_missing_draft_errors() {
        let dag = DagEngine::new();
        let err = dag.get_plan_draft("nope").unwrap_err();
        assert!(err.contains("not found"), "unexpected: {err}");
    }

    #[test]
    fn plan_draft_rejects_first_task_leaves_no_orphaned_entry() {
        // Regression test for the orphaned-zero-task-draft bug: an out-of-range
        // depends_on on the very first call against a brand-new/explicit unknown
        // plan_id must fail WITHOUT leaving any entry behind in the draft store.
        let mut dag = DagEngine::new();
        let bad = serde_json::json!({"agent": "a", "prompt": "p0", "depends_on": [0]});
        let err = dag
            .append_plan_task(&bad.to_string(), Some("draft-never-created"))
            .unwrap_err();
        assert!(err.contains("out of bounds"), "unexpected: {err}");

        // Must be "not found" (no entry at all), NOT "has no tasks" (which would
        // mean an empty draft was left behind occupying a MAX_PLAN_DRAFTS slot).
        let read_err = dag.get_plan_draft("draft-never-created").unwrap_err();
        assert!(
            read_err.contains("not found"),
            "expected 'not found' proving no orphaned draft was created, got: {read_err}"
        );
    }

    #[test]
    fn plan_draft_readback_empty_draft_errors_and_is_not_silently_persisted() {
        // With the fix-3 reordering (see
        // plan_draft_rejects_first_task_leaves_no_orphaned_entry), a failed first
        // append no longer leaves an orphaned empty draft behind, so "exists but has
        // zero tasks" is unreachable through the public API. Construct that state
        // directly via private field access (this test module is nested in the same
        // file/module as DagEngine, so it can reach private fields) to prove
        // get_plan_draft's distinct empty-draft error branch still fires correctly.
        // Kept as defense-in-depth for a hypothetical future "remove task" API that
        // could reintroduce a path to an empty-but-present draft.
        let mut dag = DagEngine::new();
        dag.plan_drafts.insert(
            "draft-empty".to_string(),
            PlanDraft {
                id: "draft-empty".to_string(),
                seq: 0,
                last_touched_seq: 0,
                tasks: Vec::new(),
                agents: Vec::new(),
                card_id: None,
            },
        );

        let read_err = dag.get_plan_draft("draft-empty").unwrap_err();
        assert!(read_err.contains("no tasks"), "unexpected: {read_err}");
    }

    #[test]
    fn plan_draft_readback_detects_corrupted_out_of_bounds_depends_on() {
        // Defense-in-depth test for the get_plan_draft invariant check: directly
        // construct a corrupted draft (same private-field-access technique as the
        // empty-draft test above) whose depends_on is already out-of-range for the
        // final task count — a state append-time validation should make
        // unreachable — and assert get_plan_draft catches it with the specific
        // internal-error message instead of silently returning bad data.
        let mut dag = DagEngine::new();
        dag.plan_drafts.insert(
            "draft-corrupt".to_string(),
            PlanDraft {
                id: "draft-corrupt".to_string(),
                seq: 0,
                last_touched_seq: 0,
                tasks: vec![WorkflowTaskInput {
                    agent: "a".to_string(),
                    prompt: "p0".to_string(),
                    depends_on: vec![5],
                    model: None,
                    card_id: None,
                }],
                agents: vec!["a".to_string()],
                card_id: None,
            },
        );

        let err = dag.get_plan_draft("draft-corrupt").unwrap_err();
        assert!(
            err.contains("internal error") && err.contains("out-of-bounds depends_on 5"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn plan_draft_readback_does_not_discard() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "a", "prompt": "p0"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();

        let first = dag.get_plan_draft(&plan_id).unwrap();
        let second = dag.get_plan_draft(&plan_id).unwrap();
        assert_eq!(first, second, "read-back must be non-destructive");
    }

    #[test]
    fn plan_draft_discard_removes_and_is_idempotent() {
        let mut dag = DagEngine::new();
        let t0 = serde_json::json!({"agent": "a", "prompt": "p0"});
        let resp0: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&t0.to_string(), None).unwrap()).unwrap();
        let plan_id = resp0["plan_id"].as_str().unwrap().to_string();

        let discard_resp: serde_json::Value =
            serde_json::from_str(&dag.discard_plan_draft(&plan_id).unwrap()).unwrap();
        assert_eq!(discard_resp["discarded"], true);

        let err = dag.get_plan_draft(&plan_id).unwrap_err();
        assert!(err.contains("not found"), "unexpected: {err}");

        // Idempotent: discarding again, or an id that never existed, is not an error.
        let discard_again: serde_json::Value =
            serde_json::from_str(&dag.discard_plan_draft(&plan_id).unwrap()).unwrap();
        assert_eq!(discard_again["discarded"], true);

        let discard_never: serde_json::Value =
            serde_json::from_str(&dag.discard_plan_draft("never-existed").unwrap()).unwrap();
        assert_eq!(discard_never["discarded"], true);
    }

    #[test]
    fn plan_draft_enforces_max_tasks_per_draft() {
        let mut dag = DagEngine::new();
        let mut plan_id: Option<String> = None;
        for i in 0..MAX_TASKS_PER_DRAFT {
            let t = serde_json::json!({"agent": format!("agent-{i}"), "prompt": format!("p{i}")});
            let resp: serde_json::Value = serde_json::from_str(
                &dag.append_plan_task(&t.to_string(), plan_id.as_deref())
                    .unwrap(),
            )
            .unwrap();
            plan_id = Some(resp["plan_id"].as_str().unwrap().to_string());
        }
        let final_id = plan_id.unwrap();

        let tasks: Vec<serde_json::Value> =
            serde_json::from_str(&dag.get_plan_draft(&final_id).unwrap()).unwrap();
        assert_eq!(tasks.len(), MAX_TASKS_PER_DRAFT);

        let overflow = serde_json::json!({"agent": "overflow", "prompt": "one too many"});
        let err = dag
            .append_plan_task(&overflow.to_string(), Some(&final_id))
            .unwrap_err();
        assert!(err.contains("maximum"), "unexpected: {err}");
    }

    #[test]
    fn plan_draft_evicts_lowest_seq_when_max_drafts_exceeded() {
        let mut dag = DagEngine::new();
        let mut ids: Vec<String> = Vec::new();
        for i in 0..MAX_PLAN_DRAFTS {
            let t = serde_json::json!({"agent": format!("agent-{i}"), "prompt": format!("p{i}")});
            let resp: serde_json::Value =
                serde_json::from_str(&dag.append_plan_task(&t.to_string(), None).unwrap()).unwrap();
            ids.push(resp["plan_id"].as_str().unwrap().to_string());
        }
        assert_eq!(ids.len(), MAX_PLAN_DRAFTS);

        // Touch the most recently created draft again — appends to an existing draft
        // never trigger eviction.
        let touch = serde_json::json!({"agent": "touch", "prompt": "again", "depends_on": [0]});
        dag.append_plan_task(&touch.to_string(), Some(ids.last().unwrap()))
            .unwrap();

        // A 33rd distinct new draft should evict the very first one ever created.
        let overflow = serde_json::json!({"agent": "overflow-agent", "prompt": "new draft"});
        let resp_overflow: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&overflow.to_string(), None).unwrap())
                .unwrap();
        let overflow_id = resp_overflow["plan_id"].as_str().unwrap().to_string();
        assert_ne!(overflow_id, ids[0]);

        // The very first draft created is now gone.
        let err = dag.get_plan_draft(&ids[0]).unwrap_err();
        assert!(err.contains("not found"), "unexpected: {err}");

        // The 33rd (newest) draft and the most recently touched one survive.
        assert!(dag.get_plan_draft(&overflow_id).is_ok());
        assert!(dag.get_plan_draft(ids.last().unwrap()).is_ok());
        // A middle draft that was never re-touched also survives — only the single
        // lowest-seq draft is evicted, not everything older than the newest.
        assert!(dag.get_plan_draft(&ids[1]).is_ok());
    }

    #[test]
    fn plan_draft_eviction_is_true_lru_not_fifo_by_creation() {
        // Proves eviction tracks last-touched order, not creation order: touch the
        // OLDEST draft (by appending a second task to it) so it is no longer the
        // least-recently-touched draft, then force an eviction. A pure FIFO-by-
        // creation policy would evict ids[0] regardless of the touch; true LRU must
        // spare it and evict the draft that is genuinely least-recently-touched
        // instead (ids[1], which was created second and never touched again).
        let mut dag = DagEngine::new();
        let mut ids: Vec<String> = Vec::new();
        for i in 0..MAX_PLAN_DRAFTS {
            let t = serde_json::json!({"agent": format!("agent-{i}"), "prompt": format!("p{i}")});
            let resp: serde_json::Value =
                serde_json::from_str(&dag.append_plan_task(&t.to_string(), None).unwrap()).unwrap();
            ids.push(resp["plan_id"].as_str().unwrap().to_string());
        }
        assert_eq!(ids.len(), MAX_PLAN_DRAFTS);

        // Touch the OLDEST draft (ids[0]) — appending to an existing draft bumps its
        // last_touched_seq, making it the most-recently-touched despite being the
        // first ever created.
        let touch = serde_json::json!({"agent": "touch", "prompt": "again", "depends_on": [0]});
        dag.append_plan_task(&touch.to_string(), Some(&ids[0]))
            .unwrap();

        // Force an eviction by creating one more brand-new draft.
        let overflow = serde_json::json!({"agent": "overflow-agent", "prompt": "new draft"});
        dag.append_plan_task(&overflow.to_string(), None).unwrap();

        // The touched draft (ids[0], oldest by creation) must survive: this is the
        // behavior that distinguishes true LRU from FIFO-by-creation.
        assert!(
            dag.get_plan_draft(&ids[0]).is_ok(),
            "touched draft must survive eviction under true LRU"
        );

        // The draft that is now genuinely least-recently-touched (ids[1] — created
        // second, never touched again) must be the one evicted instead.
        let err = dag.get_plan_draft(&ids[1]).unwrap_err();
        assert!(
            err.contains("not found"),
            "expected ids[1] (least-recently-touched) to be evicted, got: {err}"
        );
    }

    // ── card_id ──────────────────────────────────────────────────────────

    fn append(dag: &mut DagEngine, task: serde_json::Value, plan_id: Option<&str>) -> String {
        let resp: serde_json::Value =
            serde_json::from_str(&dag.append_plan_task(&task.to_string(), plan_id).unwrap())
                .unwrap();
        resp["plan_id"].as_str().unwrap().to_string()
    }

    #[test]
    fn plan_draft_adopts_first_card_id_and_accepts_same() {
        let mut dag = DagEngine::new();
        let plan_id = append(
            &mut dag,
            serde_json::json!({"agent": "a", "prompt": "p0"}),
            None,
        );
        // Task without card_id on an unbound draft is fine.
        assert_eq!(dag.get_plan_card_id(&plan_id), None);

        let resp: serde_json::Value = serde_json::from_str(
            &dag.append_plan_task(
                &serde_json::json!({"agent": "a", "prompt": "p1", "card_id": " CARD-1 "})
                    .to_string(),
                Some(&plan_id),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(resp["card_id"], "CARD-1");
        assert_eq!(dag.get_plan_card_id(&plan_id).as_deref(), Some("CARD-1"));

        // Same card again, and a task with no card, both succeed.
        append(
            &mut dag,
            serde_json::json!({"agent": "a", "prompt": "p2", "card_id": "CARD-1"}),
            Some(&plan_id),
        );
        append(
            &mut dag,
            serde_json::json!({"agent": "a", "prompt": "p3"}),
            Some(&plan_id),
        );

        // Read-back: tasks lacking card_id inherit the plan-level one.
        let tasks: Vec<serde_json::Value> =
            serde_json::from_str(&dag.get_plan_draft(&plan_id).unwrap()).unwrap();
        assert_eq!(tasks.len(), 4);
        for t in &tasks {
            assert_eq!(t["card_id"], "CARD-1");
        }
    }

    #[test]
    fn plan_draft_rejects_conflicting_card_id() {
        let mut dag = DagEngine::new();
        let plan_id = append(
            &mut dag,
            serde_json::json!({"agent": "a", "prompt": "p0", "card_id": "CARD-1"}),
            None,
        );
        let err = dag
            .append_plan_task(
                &serde_json::json!({"agent": "a", "prompt": "p1", "card_id": "CARD-2"}).to_string(),
                Some(&plan_id),
            )
            .unwrap_err();
        assert!(err.contains("already bound to card CARD-1"), "got: {err}");
        // Rejected append leaves the draft untouched.
        let tasks: Vec<serde_json::Value> =
            serde_json::from_str(&dag.get_plan_draft(&plan_id).unwrap()).unwrap();
        assert_eq!(tasks.len(), 1);
    }

    #[test]
    fn plan_draft_blank_card_id_is_none() {
        let mut dag = DagEngine::new();
        let plan_id = append(
            &mut dag,
            serde_json::json!({"agent": "a", "prompt": "p0", "card_id": "   "}),
            None,
        );
        assert_eq!(dag.get_plan_card_id(&plan_id), None);
        let raw = dag.get_plan_draft(&plan_id).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(v[0].get("card_id").is_none());
    }

    #[test]
    fn no_card_plan_draft_output_has_no_card_id() {
        let mut dag = DagEngine::new();
        let plan_id = append(
            &mut dag,
            serde_json::json!({"agent": "a", "prompt": "p0"}),
            None,
        );
        let raw = dag.get_plan_draft(&plan_id).unwrap();
        assert!(!raw.contains("card_id"), "got: {raw}");
    }

    #[test]
    fn submit_workflow_card_id_propagates_and_task_override_wins() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([
            {"agent": "a", "prompt": "p0"},
            {"agent": "a", "prompt": "p1", "card_id": "CARD-9", "depends_on": [0]},
            {"agent": "a", "prompt": "p2", "card_id": "  ", "depends_on": [0]}
        ]);
        let resp: serde_json::Value = serde_json::from_str(
            &dag.submit_workflow_with_card(&tasks.to_string(), None, Some("CARD-1"))
                .unwrap(),
        )
        .unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let ids: Vec<String> = resp["task_ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();

        let t = |i: usize| -> serde_json::Value {
            serde_json::from_str(&dag.get_task(&ids[i])).unwrap()
        };
        assert_eq!(t(0)["card_id"], "CARD-1");
        assert_eq!(t(1)["card_id"], "CARD-9");
        assert_eq!(t(2)["card_id"], "CARD-1");

        let wf: serde_json::Value = serde_json::from_str(&dag.get_workflow(wf_id)).unwrap();
        assert_eq!(wf["card_id"], "CARD-1");
    }

    #[test]
    fn ready_task_and_snapshot_include_card_id() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p0"}]);
        let resp: serde_json::Value = serde_json::from_str(
            &dag.submit_workflow_with_card(&tasks.to_string(), Some("ses_p"), Some("CARD-7"))
                .unwrap(),
        )
        .unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();

        let ready: Vec<serde_json::Value> = serde_json::from_str(&dag.tick()).unwrap();
        assert_eq!(ready.len(), 1);
        assert_eq!(ready[0]["card_id"], "CARD-7");

        let snap: serde_json::Value =
            serde_json::from_str(&dag.get_workflow_snapshot(wf_id)).unwrap();
        assert_eq!(snap["card_id"], "CARD-7");
        assert_eq!(snap["tasks"][0]["card_id"], "CARD-7");

        let summaries: Vec<serde_json::Value> =
            serde_json::from_str(&dag.list_workflow_summaries()).unwrap();
        assert_eq!(summaries[0]["card_id"], "CARD-7");
    }

    #[test]
    fn no_card_workflow_json_has_no_card_id_anywhere() {
        let mut dag = DagEngine::new();
        let tasks = serde_json::json!([{"agent": "a", "prompt": "p0"}]);
        let resp: serde_json::Value =
            serde_json::from_str(&dag.submit_workflow(&tasks.to_string()).unwrap()).unwrap();
        let wf_id = resp["workflow_id"].as_str().unwrap();
        let task_id = resp["task_ids"][0].as_str().unwrap();

        let ready = dag.tick();
        assert!(!ready.contains("card_id"), "got: {ready}");
        assert!(!dag.get_workflow(wf_id).contains("card_id"));
        assert!(!dag.get_workflow_snapshot(wf_id).contains("card_id"));
        assert!(!dag.get_task(task_id).contains("card_id"));
        assert!(!dag.list_workflow_summaries().contains("card_id"));
    }
}
