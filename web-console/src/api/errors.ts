export interface ApiErrorDetails {
  expectedRevision?: number;
  currentRevision?: number;
  nextReminderAt?: string;
  allowedCommands?: string[];
  field?: string;
  [key: string]: unknown;
}

/** Normalized API error matching docs/frontend-backend-integration.md §10. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorDetails | null;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, details: ApiErrorDetails | null = null, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }

  get isRevisionConflict() {
    return this.code === "REVISION_CONFLICT";
  }

  get isNotFound() {
    return this.status === 404;
  }
}

export const ERROR_PAGE_HINTS: Record<string, string> = {
  VALIDATION_ERROR: "输入内容需要调整。",
  TASK_NOT_FOUND: "任务不存在，可能已被删除。",
  REVISION_CONFLICT: "任务已被其他操作更新，请刷新后重试。",
  INVALID_STATE_TRANSITION: "当前状态不支持这个操作，请刷新后重试。",
  IDEMPOTENCY_CONFLICT: "请求已在处理中，请勿重复提交。",
  REMINDER_NOT_DUE: "还没到催办时间。",
  REMINDER_LIMIT_REACHED: "已达到催办上限。",
  APPROVAL_PAYLOAD_INVALID: "提交内容不完整，请检查后重试。",
  AGENT_UNAVAILABLE: "Agent 暂时不可用，命令已保留。",
  INTERNAL_ERROR: "服务出现错误，请稍后重试。",
};
