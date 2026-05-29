// ─── Shared types ─────────────────────────────────────────────────────────────

export interface WorkflowTaskInput {
  agent: string;
  prompt: string;
  depends_on: number[];
  model?: string;
}

export interface PlanArtifact {
  id: string;
  created_at: string;
  summary: string[];
  recommendations?: string[];
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
  fallback_hint?: {
    task_id: string;
    error_message: string;
    has_fallbacks: boolean;
  };
  reuse_session?: SessionReuse;
}
