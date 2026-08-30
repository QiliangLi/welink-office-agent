/**
 * Page-facing domain types. The wire contract lives in api/contracts.ts and
 * is mirrored from server/schemas; these aliases keep component code
 * readable. `status` on tasks is the server-derived displayStatus — the
 * runtime status is only visible through sourceStatus for debugging.
 */
export type {
  ActivityEvent,
  ActivityKind,
  AllowedCommand,
  ApprovalDecision,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalDecisionStatus,
  ApprovalDto,
  ApprovalExecutionStatus,
  ApprovalKind,
  ApprovalPayload,
  ClarificationPayload,
  ContactDto,
  CreateTaskInput,
  CreateTaskResult,
  DisplayStatus,
  ExternalPolicy,
  ExecutionMode,
  HealthDto,
  MessageApprovalPayload,
  OverviewDto,
  PlanStep,
  PlanStepStatus,
  ScopeChangePayload,
  ScheduleApprovalPayload,
  ScheduleOption,
  SessionDto,
  TaskCategory,
  TaskCommandInput,
  TaskCommandResult,
  TaskDetailDto,
  TaskDto,
  TaskPriority,
  WaitingKind,
} from "../api/contracts";

import type { DisplayStatus } from "../api/contracts";

/** Display status is what every page renders; never re-derive it locally. */
export type TaskStatus = DisplayStatus;

export interface NewTaskInput {
  description: string;
  priority: "low" | "normal" | "high";
  deadline: string;
  externalPolicy: "conservative" | "balanced" | "active";
  executionMode: "automatic" | "confirm";
}
