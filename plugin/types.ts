// ─── Shared types ─────────────────────────────────────────────────────────────

export interface WorkflowTaskInput {
  agent: string;
  prompt: string;
  depends_on: number[];
  model?: string;
  /** Optional ticket/card id; absent in no-card (system-level) mode. */
  card_id?: string;
}

export interface PlanSaveInput {
  plan_id: string;
  summary: string[];
  recommendations?: string[];
  /** Plan-level card id; absent in no-card mode. */
  card_id?: string;
  tasks: WorkflowTaskInput[];
}

export interface PlanArtifact {
  id: string;
  created_at: string;
  summary: string[];
  recommendations?: string[];
  /** Plan-level card id; absent in no-card mode and in legacy artifacts. */
  card_id?: string;
  tasks: WorkflowTaskInput[];
}

export interface ToastNotification {
  type: "toast";
  title: string;
  message: string;
  variant: string;
  duration?: number;
}
export type Notification = ToastNotification;

export interface SessionReuse {
  session_id: string;
  next_task_id: string;
}

export interface EventResult {
  notifications: Notification[];
  delete_session: string | null;
  reuse_session?: SessionReuse;
}
