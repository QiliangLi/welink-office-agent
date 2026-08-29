export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_external"
  | "waiting_approval"
  | "paused"
  | "partial"
  | "failed"
  | "stopped"
  | "completed";

export type TaskCategory = "research" | "report" | "follow_up" | "travel" | "document";

export interface Person {
  id: string;
  name: string;
  department: string;
  initials: string;
}

export interface RunReceipt {
  steps: number;
  duration: string;
  tokens: string;
  cost: string;
}

export type PlanStepStatus = "pending" | "running" | "waiting" | "completed" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  summary?: string;
  owner?: Person;
  startedAt?: string;
  completedAt?: string;
  duration?: string;
  children?: PlanStep[];
}

export type ActivityKind = "message" | "file" | "status" | "approval" | "task";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  category: TaskCategory;
  currentAction?: string;
  blockedBy?: string;
  waitingReason?: string;
  progress: number;
  completedSubtasks: number;
  totalSubtasks: number;
  createdBy: Person;
  contacts: Person[];
  createdAt: string;
  updatedAt: string;
  nextAction?: string;
  nextCheckAt?: string;
  estimatedCompletion?: string;
  receipt?: RunReceipt;
  plan: PlanStep[];
  activity: ActivityEvent[];
}

export type ApprovalKind = "message" | "schedule" | "clarification";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited";

export interface MessageApprovalPayload {
  type: "message";
  target: string;
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
  placeholder: string;
}

export type ApprovalPayload = MessageApprovalPayload | ScheduleApprovalPayload | ClarificationPayload;

export interface Approval {
  id: string;
  taskId: string;
  kind: ApprovalKind;
  title: string;
  summary: string;
  reason: string;
  impact: string;
  evidenceLabel: string;
  evidenceTarget: string;
  createdAt: string;
  status: ApprovalStatus;
  payload: ApprovalPayload;
}

export interface NewTaskInput {
  description: string;
  priority: "low" | "normal" | "high" | "urgent";
  deadline: string;
  externalPolicy: "conservative" | "balanced" | "active";
  executionMode: "automatic" | "confirm";
}
