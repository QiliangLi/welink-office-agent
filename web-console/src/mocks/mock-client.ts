import type {
  ActivityEvent,
  ActivityListResponse,
  ApprovalDecisionInput,
  ApprovalDecisionResult,
  ApprovalDto,
  ApprovalListResponse,
  CommandDto,
  ContactDto,
  CreateTaskInput,
  CreateTaskResult,
  HealthDto,
  OverviewDto,
  PlanStep,
  SessionDto,
  TaskCommandInput,
  TaskCommandResult,
  TaskDetailDto,
  TaskDto,
  TaskEventsResponse,
  TaskListResponse,
} from "../api/contracts";
import type { ActivityListParams, ApprovalListParams, ConsoleClient, OverviewParams, TaskListParams } from "../api/client";
import { initialActivity, initialApprovals, initialPlans, initialTasks, event } from "./data";

const nowIso = () => new Date().toISOString();

function encodeMockCursor(offset: number) {
  return btoa(JSON.stringify({ o: offset }));
}

function decodeMockCursor(cursor?: string | null) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(atob(cursor)) as { o?: unknown };
    return Number.isInteger(parsed?.o) && (parsed.o as number) >= 0 ? (parsed.o as number) : 0;
  } catch {
    return 0;
  }
}

const mockOwner: ContactDto = { id: "00000000", name: "齐亮", department: "产品部", initials: "QL" };

const mockHealth: HealthDto = {
  status: "ok",
  serverTime: nowIso(),
  timezone: "Asia/Shanghai",
  mode: "dry_run",
  agent: {
    state: "idle",
    lastSuccessfulTick: nowIso(),
    stale: false,
    queuedCommands: 0,
    uncertainActions: 0,
  },
  capabilities: {
    attachments: false,
    artifacts: false,
    liveSend: false,
    sse: true,
  },
};

const mockSession: SessionDto = {
  owner: { ...mockOwner, employeeNumber: mockOwner.id },
  timezone: "Asia/Shanghai",
  mode: "mock",
  csrfToken: "mock-csrf-token",
};

/**
 * In-memory ConsoleClient over the mock snapshots. It mirrors the HTTP
 * client semantics (202 creates, decision payloads, allowedCommands) so
 * pages and tests run against either backend (docs §13.1).
 */
export class MockConsoleClient implements ConsoleClient {
  readonly kind = "mock" as const;
  private tasks: TaskDto[];
  private plans: Record<string, PlanStep[]>;
  private activity: Record<string, ActivityEvent[]>;
  private approvals: ApprovalDto[];
  private commands: CommandDto[] = [];

  constructor() {
    this.tasks = structuredClone(initialTasks);
    this.plans = structuredClone(initialPlans);
    this.activity = structuredClone(initialActivity);
    this.approvals = structuredClone(initialApprovals);
  }

  private touch(taskId: string, status?: TaskDto["displayStatus"]) {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) return;
    task.revision += 1;
    task.updatedAt = nowIso();
    if (status) {
      task.displayStatus = status;
      task.sourceStatus = status;
    }
  }

  private recordActivity(taskId: string, kind: ActivityEvent["kind"], title: string, detail: string | null = null) {
    this.activity[taskId] = [
      ...(this.activity[taskId] ?? []),
      event(kind, title, detail, nowIso(), taskId),
    ];
  }

  getSession(): Promise<SessionDto> {
    return Promise.resolve(mockSession);
  }

  getHealth(): Promise<HealthDto> {
    return Promise.resolve({ ...mockHealth, agent: { ...mockHealth.agent, queuedCommands: this.commands.filter((c) => c.status === "queued").length } });
  }

  getOverview(params: OverviewParams = {}): Promise<OverviewDto> {
    const totals = this.tasks.reduce<OverviewDto["totalsByStatus"]>((acc, task) => {
      acc[task.displayStatus] = (acc[task.displayStatus] ?? 0) + 1;
      return acc;
    }, {} as OverviewDto["totalsByStatus"]);
    const pending = this.approvals.filter((approval) => approval.decisionStatus === "pending");
    const recentActivity = Object.values(this.activity)
      .flat()
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence)
      .slice(-(params.activityLimit ?? 12));
    return Promise.resolve({
      totalsByStatus: totals as OverviewDto["totalsByStatus"],
      currentTasks: this.tasks.filter((task) => ["running", "waiting_external"].includes(task.displayStatus)),
      queuedTasks: [...this.tasks]
        .filter((task) => task.displayStatus === "queued")
        .sort((left, right) => (left.queueEnteredAt ?? "").localeCompare(right.queueEnteredAt ?? "")),
      pendingApprovals: pending,
      recentCompleted: this.tasks.filter((task) => task.displayStatus === "completed"),
      recentActivity,
      snapshotAt: nowIso(),
    });
  }

  getTasks(params: TaskListParams = {}): Promise<TaskListResponse> {
    const query = (params.q ?? "").trim().toLocaleLowerCase("zh-CN");
    const statuses = params.status ?? [];
    const filtered = this.tasks
      .filter((task) => statuses.length === 0 || statuses.includes(task.displayStatus))
      .filter((task) => !query || [task.title, task.id, task.description].join(" ").toLocaleLowerCase("zh-CN").includes(query))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const totals = this.tasks.reduce<Partial<TaskListResponse["totalsByStatus"]>>((acc, task) => {
      acc[task.displayStatus] = (acc[task.displayStatus] ?? 0) + 1;
      return acc;
    }, {});
    return Promise.resolve({
      items: filtered.slice(0, params.limit ?? 20),
      nextCursor: null,
      total: filtered.length,
      totalsByStatus: totals,
      snapshotAt: nowIso(),
    });
  }

  getTaskDetail(taskId: string): Promise<{ task: TaskDetailDto; activity: ActivityEvent[]; activityNextCursor: string | null }> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) return Promise.reject(new Error("任务不存在"));
    const detail: TaskDetailDto = {
      ...task,
      originalRequest: task.description,
      externalPolicy: "balanced",
      externalPolicyLabel: "平衡：低风险自动执行，高风险需要确认",
      executionMode: "automatic",
      instructions: [],
      workingSummary: { confirmedFacts: [], openQuestions: [], nextActions: [] },
      finalSummary: null,
      contacts: [mockOwner],
      plan: this.plans[taskId] ?? [],
      optionalSubtasks: [],
      pendingApprovalIds: this.approvals.filter((a) => a.taskId === taskId && a.decisionStatus === "pending").map((a) => a.id),
      uncertainActionIds: [],
      allowedCommands:
        task.displayStatus === "completed" || task.displayStatus === "stopped"
          ? []
          : task.displayStatus === "paused"
            ? ["resume", "cancel", "instruction"]
            : ["pause", "cancel", "instruction"],
    };
    return Promise.resolve({
      task: detail,
      activity: this.activity[taskId] ?? [],
      activityNextCursor: null,
    });
  }

  getTaskEvents(taskId: string): Promise<TaskEventsResponse> {
    return Promise.resolve({ items: this.activity[taskId] ?? [], nextCursor: null });
  }

  getActivity(params: ActivityListParams = {}): Promise<ActivityListResponse> {
    const kinds = params.kind ?? [];
    const query = (params.q ?? "").trim().toLocaleLowerCase("zh-CN");
    const cutoff = params.occurredFrom ? Date.parse(params.occurredFrom) : null;
    const newestFirst = Object.values(this.activity)
      .flat()
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.sequence - left.sequence);
    const filtered = newestFirst
      .filter((item) => kinds.length === 0 || kinds.includes(item.kind))
      .filter((item) => !params.taskId || item.taskId === params.taskId)
      .filter((item) => cutoff === null || Date.parse(item.occurredAt) >= cutoff)
      .filter((item) => !query || [item.title, item.detail ?? "", item.taskId ?? ""].join(" ").toLocaleLowerCase("zh-CN").includes(query));
    const offset = decodeMockCursor(params.cursor);
    const limit = params.limit ?? 30;
    const page = filtered.slice(offset, offset + limit);
    const nextCursor = offset + page.length < filtered.length ? encodeMockCursor(offset + page.length) : null;
    return Promise.resolve({ items: page, nextCursor, total: filtered.length, snapshotAt: nowIso() });
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const id = `TASK-MOCK-${String(this.tasks.length + 1).padStart(4, "0")}`;
    const task: TaskDto = {
      id,
      revision: 1,
      title: input.description.split(/[。！？\n]/)[0].slice(0, 32) || "新任务",
      description: input.description,
      sourceStatus: "queued",
      displayStatus: "queued",
      category: "follow_up",
      priority: input.priority,
      currentAction: "等待 Agent 拆解任务",
      waitingReason: null,
      waitingKind: null,
      queuePosition: null,
      blockedByTaskId: null,
      blockedBySubtaskId: null,
      queueEnteredAt: null,
      progress: 0,
      completedSubtasks: 0,
      totalSubtasks: 0,
      deadlineAt: input.deadline ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      createdBy: mockOwner,
    };
    this.tasks.unshift(task);
    this.recordActivity(id, "task", "任务已创建，等待 Agent 处理", input.description.slice(0, 40));
    const commandId = `CMD-MOCK-${this.commands.length + 1}`;
    this.commands.push({
      id: commandId,
      type: "task.create",
      aggregateType: "task",
      aggregateId: id,
      status: "queued",
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      error: null,
    });
    return { task: { id, revision: 1, displayStatus: "queued" }, command: { id: commandId, status: "queued" } };
  }

  async taskCommand(taskId: string, input: TaskCommandInput): Promise<TaskCommandResult> {
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) throw new Error("任务不存在");
    if (input.expectedRevision !== task.revision) {
      throw Object.assign(new Error("任务已被其他操作更新，请刷新后重试。"), { code: "REVISION_CONFLICT" });
    }
    if (input.type === "pause") this.touch(taskId, "paused");
    if (input.type === "resume") this.touch(taskId, "running");
    if (input.type === "cancel") this.touch(taskId, "stopped");
    if (input.type === "instruction") this.recordActivity(taskId, "task", "收到你的追加指令", input.text);
    this.touch(taskId);
    return {
      task: { id: taskId, revision: task.revision, sourceStatus: task.sourceStatus },
      command: input.type === "pause" || input.type === "cancel" ? null : { id: `CMD-MOCK-${this.commands.length + 1}`, status: "queued" },
    };
  }

  async requestReminder(taskId: string, subtaskId: string) {
    this.recordActivity(taskId, "message", "已提交催办请求", `子任务 ${subtaskId}`);
    return { command: { id: `CMD-MOCK-${this.commands.length + 1}`, status: "queued" } };
  }

  getApprovals(params: ApprovalListParams = {}): Promise<ApprovalListResponse> {
    const statuses = params.status ?? ["pending"];
    const filtered = this.approvals
      .filter((approval) => statuses.includes(approval.decisionStatus))
      .filter((approval) => !params.taskId || approval.taskId === params.taskId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return Promise.resolve({ items: filtered, nextCursor: null, total: filtered.length, snapshotAt: nowIso() });
  }

  async decide(approvalId: string, input: ApprovalDecisionInput): Promise<ApprovalDecisionResult> {
    const approval = this.approvals.find((entry) => entry.id === approvalId);
    if (!approval) throw new Error("审批不存在");
    if (input.expectedRevision !== approval.revision) {
      throw Object.assign(new Error("审批已被处理，请刷新。"), { code: "REVISION_CONFLICT" });
    }
    approval.revision += 1;
    approval.decisionPayload = {
      decision: input.decision,
      option_id: input.optionId ?? null,
      answer: input.answer ?? null,
      edited_content: input.editedContent ?? null,
    };
    approval.decisionStatus =
      input.decision === "reject" ? "rejected" : input.decision === "edit" ? "edited" : "approved";
    approval.resolvedAt = nowIso();
    this.touch(approval.taskId);
    this.recordActivity(approval.taskId, "approval", "审批已处理", `决定：${input.decision}`);
    return { approval, command: { id: `CMD-MOCK-${this.commands.length + 1}`, status: "queued" } };
  }

  async bulkDecisions(input: { approvalIds: string[]; decision: "mark_for_edit" }) {
    const changed: string[] = [];
    for (const id of input.approvalIds) {
      const approval = this.approvals.find((entry) => entry.id === id);
      if (approval && approval.decisionStatus === "pending") {
        approval.decisionStatus = "edited";
        approval.resolvedAt = nowIso();
        changed.push(id);
      }
    }
    return { changed };
  }

  getCommand(commandId: string): Promise<CommandDto> {
    const command = this.commands.find((entry) => entry.id === commandId);
    if (!command) return Promise.reject(new Error("命令不存在"));
    return Promise.resolve(command);
  }
}
