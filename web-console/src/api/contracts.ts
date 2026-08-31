/**
 * HTTP contract types mirrored from server/schemas/ (the server is the
 * single source of truth). Runtime snapshots use snake_case; everything the
 * browser sees is camelCase (docs/frontend-backend-integration.md §4.1).
 * Do not rename these fields ad hoc — update server/schemas + serializers
 * together.
 */

export type DisplayStatus =
  | "queued"
  | "running"
  | "waiting_external"
  | "waiting_approval"
  | "paused"
  | "partial"
  | "failed"
  | "stopped"
  | "completed";

export type WaitingKind = "reply" | "followup_window" | "contact_slot" | "owner" | "recovery";

export type TaskPriority = "low" | "normal" | "high";
export type ExternalPolicy = "conservative" | "balanced" | "active";
export type ExecutionMode = "automatic" | "confirm";
export type TaskCategory = "research" | "report" | "follow_up" | "travel" | "document";

export interface ContactDto {
  id: string;
  name: string;
  department: string;
  initials: string;
}

export interface TaskDto {
  id: string;
  revision: number;
  title: string;
  description: string;
  /** Debugging only: the runtime execution status. */
  sourceStatus: string;
  displayStatus: DisplayStatus;
  category: TaskCategory | null;
  priority: TaskPriority;
  currentAction: string | null;
  waitingReason: string | null;
  waitingKind: WaitingKind | null;
  queuePosition: number | null;
  blockedByTaskId: string | null;
  blockedBySubtaskId: string | null;
  queueEnteredAt: string | null;
  progress: number;
  completedSubtasks: number;
  totalSubtasks: number;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: ContactDto | null;
}

export type PlanStepStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  summary: string | null;
  owner: ContactDto | null;
  required: boolean;
  sequence: number | null;
  waitingKind: WaitingKind | null;
  conversationId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export type ActivityKind = "task" | "status" | "message" | "approval" | "file";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  occurredAt: string;
  sequence: number;
  taskId: string | null;
  subtaskId: string | null;
  conversationId: string | null;
}

export type AllowedCommand = "pause" | "resume" | "cancel" | "instruction" | "retry" | "verify_actions";

export interface TaskDetailDto extends TaskDto {
  originalRequest: string;
  externalPolicy: ExternalPolicy;
  externalPolicyLabel: string;
  executionMode: ExecutionMode;
  instructions: { text: string; createdAt: string; applied: boolean }[];
  workingSummary: {
    confirmedFacts: string[];
    openQuestions: string[];
    nextActions: string[];
  };
  finalSummary: string | null;
  contacts: ContactDto[];
  plan: PlanStep[];
  optionalSubtasks: PlanStep[];
  pendingApprovalIds: string[];
  uncertainActionIds: string[];
  allowedCommands: AllowedCommand[];
}

export interface TaskListResponse {
  items: TaskDto[];
  nextCursor: string | null;
  total: number;
  totalsByStatus: Partial<Record<DisplayStatus, number>>;
  snapshotAt: string;
}

export interface TaskEventsResponse {
  items: ActivityEvent[];
  nextCursor: string | null;
}

/** Cross-task feed: pages are newest-first within the merged stable order. */
export interface ActivityListResponse {
  items: ActivityEvent[];
  nextCursor: string | null;
  total: number;
  snapshotAt: string;
}

export type ApprovalKind = "message" | "schedule" | "clarification" | "scope_change";

export type ApprovalDecisionStatus = "pending" | "approved" | "rejected" | "edited";
export type ApprovalExecutionStatus =
  | "not_started"
  | "queued"
  | "executing"
  | "succeeded"
  | "failed"
  | "unknown"
  | "not_applicable";

export type ApprovalDecision = "approve" | "reject" | "edit" | "select_option" | "submit_answer";

export interface MessageApprovalPayload {
  type: "message";
  target: string;
  targetType: string | null;
  audience: string;
  message: string;
}

export interface ScheduleOption {
  id: string;
  label: string;
  attendance: string;
  tone: "good" | "warn";
}

export interface ScheduleApprovalPayload {
  type: "schedule";
  options: ScheduleOption[];
}

export interface ClarificationPayload {
  type: "clarification";
  question: string;
  field: string | null;
  placeholder: string | null;
}

export interface ScopeChangePayload {
  type: "scope_change";
  itemId: string | null;
  itemDescription: string | null;
  options: { value: string; label: string }[];
}

export type ApprovalPayload = MessageApprovalPayload | ScheduleApprovalPayload | ClarificationPayload | ScopeChangePayload;

export interface ApprovalDto {
  id: string;
  revision: number;
  taskId: string;
  subtaskId: string | null;
  kind: ApprovalKind;
  title: string;
  summary: string;
  reason: string;
  impact: string;
  decisionStatus: ApprovalDecisionStatus;
  executionStatus: ApprovalExecutionStatus;
  decisionPayload: {
    decision: string;
    option_id?: string | null;
    answer?: string | null;
    edited_content?: string | null;
  } | null;
  payload: ApprovalPayload;
  allowedDecisions: ApprovalDecision[];
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApprovalListResponse {
  items: ApprovalDto[];
  nextCursor: string | null;
  total: number;
  snapshotAt: string;
}

export interface HealthDto {
  status: "ok" | "degraded";
  serverTime: string;
  timezone: string;
  mode: "dry_run" | "live";
  agent: {
    state: string;
    lastSuccessfulTick: string | null;
    stale: boolean;
    queuedCommands: number;
    uncertainActions: number;
  };
  capabilities: {
    attachments: boolean;
    artifacts: boolean;
    liveSend: boolean;
    sse: boolean;
  };
}

export interface SessionDto {
  owner: {
    employeeNumber: string | null;
    name: string;
    initials: string;
  };
  timezone: string;
  mode: string;
  csrfToken: string;
}

export interface OverviewDto {
  totalsByStatus: Record<DisplayStatus, number>;
  currentTasks: TaskDto[];
  queuedTasks: TaskDto[];
  pendingApprovals: ApprovalDto[];
  recentCompleted: TaskDto[];
  recentActivity: ActivityEvent[];
  snapshotAt: string;
}

export interface CreateTaskInput {
  description: string;
  priority: TaskPriority;
  deadline?: string | null;
  timezone?: string;
  externalPolicy: ExternalPolicy;
  executionMode: ExecutionMode;
}

export interface CreateTaskResult {
  task: { id: string; revision: number; displayStatus: DisplayStatus };
  command: { id: string; status: string };
}

export type TaskCommandInput =
  | { type: "pause"; expectedRevision: number }
  | { type: "resume"; expectedRevision: number }
  | { type: "cancel"; expectedRevision: number }
  | { type: "instruction"; expectedRevision: number; text: string }
  | { type: "retry"; expectedRevision: number };

export interface TaskCommandResult {
  task: { id: string; revision: number; sourceStatus: string };
  command: { id: string; status: string } | null;
}

export interface ApprovalDecisionInput {
  decision: ApprovalDecision;
  expectedRevision: number;
  optionId?: string;
  answer?: string;
  editedContent?: string;
}

export interface ApprovalDecisionResult {
  approval: ApprovalDto;
  command: { id: string; status: string } | null;
}

export interface CommandDto {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  status: "queued" | "claimed" | "waiting_agent" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: { code: string; message: string; retryable?: boolean; position?: number } | null;
}
