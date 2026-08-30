import type {
  ActivityEvent,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalListResponse,
  CommandDto,
  CreateTaskInput,
  CreateTaskResult,
  HealthDto,
  OverviewDto,
  SessionDto,
  TaskCommandInput,
  TaskCommandResult,
  TaskDetailDto,
  TaskEventsResponse,
  TaskListResponse,
} from "./contracts";
import { ApiError } from "./errors";

export interface TaskDetailResponse {
  task: TaskDetailDto;
  activity: ActivityEvent[];
  activityNextCursor: string | null;
}

export interface TaskListParams {
  q?: string;
  status?: string[];
  updatedFrom?: string;
  updatedTo?: string;
  cursor?: string | null;
  limit?: number;
}

export interface ApprovalListParams {
  status?: string[];
  taskId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface OverviewParams {
  taskLimit?: number;
  activityLimit?: number;
}

/**
 * The console talks to one local API through relative paths only; the Vite
 * dev server proxies /api to 127.0.0.1:4174 and production-style runs are
 * same-origin behind the Console API itself (docs §3.3, §11.1).
 */
export interface ConsoleClient {
  readonly kind: "api" | "mock";
  getSession(): Promise<SessionDto>;
  getHealth(): Promise<HealthDto>;
  getOverview(params?: OverviewParams): Promise<OverviewDto>;
  getTasks(params?: TaskListParams): Promise<TaskListResponse>;
  getTaskDetail(taskId: string): Promise<TaskDetailResponse>;
  getTaskEvents(taskId: string, cursor?: string | null): Promise<TaskEventsResponse>;
  createTask(input: CreateTaskInput): Promise<CreateTaskResult>;
  taskCommand(taskId: string, input: TaskCommandInput): Promise<TaskCommandResult>;
  requestReminder(taskId: string, subtaskId: string): Promise<{ command: { id: string; status: string } }>;
  getApprovals(params?: ApprovalListParams): Promise<ApprovalListResponse>;
  decide(approvalId: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult>;
  bulkDecisions(input: { approvalIds: string[]; decision: "mark_for_edit" }): Promise<{ changed: string[] }>;
  getCommand(commandId: string): Promise<CommandDto>;
}

export class HttpConsoleClient implements ConsoleClient {
  readonly kind = "api" as const;
  private csrfToken: string | null = null;
  private sessionPromise: Promise<SessionDto> | null = null;

  private async request<T>(method: string, path: string, options: {
    body?: unknown;
    idempotencyKey?: string;
    retryAfterSessionRefresh?: boolean;
  } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (method !== "GET") {
      headers["Idempotency-Key"] = options.idempotencyKey ?? newIdempotencyKey();
      const token = await this.ensureCsrfToken();
      if (token) headers["X-CSRF-Token"] = token;
    }

    const response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (response.status === 403 && !options.retryAfterSessionRefresh) {
      // The CSRF token dies with the API process: refresh once, retry once.
      this.sessionPromise = null;
      this.csrfToken = null;
      return this.request<T>(method, path, { ...options, retryAfterSessionRefresh: true });
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: never; retryable?: boolean } })?.error;
      throw new ApiError(
        response.status,
        error?.code ?? "INTERNAL_ERROR",
        error?.message ?? `请求失败（${response.status}）`,
        error?.details ?? null,
        Boolean(error?.retryable),
      );
    }
    return payload as T;
  }

  private async ensureCsrfToken(): Promise<string | null> {
    if (this.csrfToken) return this.csrfToken;
    const session = await this.getSession();
    this.csrfToken = session.csrfToken;
    return this.csrfToken;
  }

  getSession(): Promise<SessionDto> {
    if (!this.sessionPromise) {
      this.sessionPromise = fetch("/api/v1/session")
        .then(async (response) => {
          if (!response.ok) throw new ApiError(response.status, "SESSION_UNAVAILABLE", "无法连接控制台服务。");
          return response.json() as Promise<SessionDto>;
        })
        .catch((error) => {
          this.sessionPromise = null;
          throw error;
        });
    }
    return this.sessionPromise;
  }

  getHealth(): Promise<HealthDto> {
    return this.request("GET", "/health");
  }

  getOverview(params: OverviewParams = {}): Promise<OverviewDto> {
    const search = new URLSearchParams();
    if (params.taskLimit) search.set("taskLimit", String(params.taskLimit));
    if (params.activityLimit) search.set("activityLimit", String(params.activityLimit));
    const suffix = search.toString() ? `?${search}` : "";
    return this.request("GET", `/overview${suffix}`);
  }

  getTasks(params: TaskListParams = {}): Promise<TaskListResponse> {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    for (const status of params.status ?? []) search.append("status", status);
    if (params.updatedFrom) search.set("updatedFrom", params.updatedFrom);
    if (params.updatedTo) search.set("updatedTo", params.updatedTo);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search}` : "";
    return this.request("GET", `/tasks${suffix}`);
  }

  getTaskDetail(taskId: string): Promise<TaskDetailResponse> {
    return this.request<TaskDetailResponse>("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  getTaskEvents(taskId: string, cursor: string | null = null): Promise<TaskEventsResponse> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request("GET", `/tasks/${encodeURIComponent(taskId)}/events${suffix}`);
  }

  createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    return this.request("POST", "/tasks", { body: input });
  }

  taskCommand(taskId: string, input: TaskCommandInput): Promise<TaskCommandResult> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/commands`, { body: input });
  }

  requestReminder(taskId: string, subtaskId: string): Promise<{ command: { id: string; status: string } }> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/subtasks/${encodeURIComponent(subtaskId)}/reminders`, { body: {} });
  }

  getApprovals(params: ApprovalListParams = {}): Promise<ApprovalListResponse> {
    const search = new URLSearchParams();
    for (const status of params.status ?? []) search.append("status", status);
    if (params.taskId) search.set("taskId", params.taskId);
    if (params.cursor) search.set("cursor", params.cursor);
    if (params.limit) search.set("limit", String(params.limit));
    const suffix = search.toString() ? `?${search}` : "";
    return this.request("GET", `/approvals${suffix}`);
  }

  decide(approvalId: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    return this.request("POST", `/approvals/${encodeURIComponent(approvalId)}/decisions`, { body: input });
  }

  bulkDecisions(input: { approvalIds: string[]; decision: "mark_for_edit" }): Promise<{ changed: string[] }> {
    return this.request("POST", "/approvals/bulk-decisions", { body: input });
  }

  getCommand(commandId: string): Promise<CommandDto> {
    return this.request("GET", `/commands/${encodeURIComponent(commandId)}`);
  }
}

function newIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
