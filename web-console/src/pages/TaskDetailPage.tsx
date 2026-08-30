import { Activity, AlertTriangle, ArrowLeft, Bot, Clock3, FileText, Gauge, Pause, Play, Send, ShieldCheck, Square, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { ActivityTimeline } from "../components/tasks/ActivityTimeline";
import { ProgressBar } from "../components/tasks/ProgressBar";
import { StatusBadge } from "../components/tasks/StatusBadge";
import { TaskPlan } from "../components/tasks/TaskPlan";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { PromptDialog } from "../components/ui/PromptDialog";
import { Toast } from "../components/ui/Toast";
import { formatDateTime, relativeTime, STATUS_META } from "../lib/task-utils";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { ActivityEvent, AllowedCommand, TaskDetailDto } from "../types/domain";

export function TaskDetailPage() {
  const { taskId = "" } = useParams();
  const { client, taskCommand, requestReminder } = useAppData();
  const detailQuery = useQuery(
    queryKeys.taskDetail(taskId),
    () => client.getTaskDetail(taskId),
  );
  const [cancelOpen, setCancelOpen] = useState(false);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [olderEvents, setOlderEvents] = useState<ActivityEvent[]>([]);

  if (detailQuery.loading && !detailQuery.data) {
    return (
      <div className="page task-detail-page" aria-busy="true">
        <div className="detail-header"><div className="skeleton-panel" style={{ height: 120 }} /></div>
        <div className="detail-grid"><div className="panel skeleton-panel" style={{ height: 260 }} /><div className="panel skeleton-panel" style={{ height: 260 }} /></div>
      </div>
    );
  }
  if (detailQuery.error) {
    const notFound = detailQuery.error.isNotFound;
    return (
      <div className="page not-found">
        <h1>{notFound ? "没有找到这个任务" : "暂时无法加载任务"}</h1>
        <p>{detailQuery.error.message}</p>
        <div>
          {!notFound && <button className="button button-secondary" onClick={detailQuery.refetch}>重试</button>}
          <Link className="button button-primary" to="/tasks">返回任务列表</Link>
        </div>
      </div>
    );
  }
  const detail = detailQuery.data?.task;
  const mergedActivity = [...olderEvents, ...(detailQuery.data?.activity ?? [])];
  if (!detail) return null;

  type ImmediateCommand = Exclude<AllowedCommand, "instruction" | "verify_actions">;
  const runCommand = async (type: ImmediateCommand) => {
    setPendingCommand(type);
    setError("");
    try {
      const result = await taskCommand(detail.id, { type, expectedRevision: detail.revision });
      if (result.command) setToast("已提交，等待 Agent 处理。");
      if (type === "pause") setToast("任务已暂停，当前结果已保留。");
      if (type === "cancel") setToast("任务已停止，已有结果仍可查看。");
      if (type === "resume") setToast("任务已继续，Agent 正在恢复执行。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setPendingCommand(null);
    }
  };

  const loadOlder = async () => {
    const cursor = detailQuery.data?.activityNextCursor ?? null;
    if (!cursor) return;
    const older = await client.getTaskEvents(detail.id, cursor);
    setOlderEvents((current) => [...older.items, ...current]);
  };

  const submitInstruction = async (text: string) => {
    setInstructionOpen(false);
    setPendingCommand("instruction");
    setError("");
    try {
      await taskCommand(detail.id, { type: "instruction", expectedRevision: detail.revision, text });
      setToast("新指令已记录，Agent 会在下一轮处理。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
    } finally {
      setPendingCommand(null);
    }
  };

  const remind = async (subtaskId: string, contactName: string) => {
    setPendingCommand(`remind:${subtaskId}`);
    setError("");
    try {
      await requestReminder(detail.id, subtaskId);
      setToast(`已提交对 ${contactName} 的催办，Agent 会按策略发送。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "催办失败，请稍后重试。");
    } finally {
      setPendingCommand(null);
    }
  };

  const allowed = new Set<AllowedCommand>(detail.allowedCommands);
  const isPaused = detail.displayStatus === "paused";
  const followScene = detail.displayStatus === "failed" ? "blocked" : ["queued", "paused", "stopped", "waiting_external", "waiting_approval"].includes(detail.displayStatus) ? "waiting" : detail.displayStatus === "completed" ? "success" : "monitoring";
  const stateContext = detail.displayStatus === "queued"
    ? { label: "排队原因：", value: detail.waitingReason ?? "等待可用执行条件" }
    : ["waiting_external", "waiting_approval"].includes(detail.displayStatus)
      ? { label: "等待原因：", value: detail.waitingReason ?? "等待下一步输入" }
      : detail.displayStatus === "partial"
        ? { label: "阻塞情况：", value: detail.waitingReason ?? "存在需要处理的工作" }
        : { label: "执行进度：", value: `${detail.progress}%` };
  const followCopy = detail.displayStatus === "queued"
    ? { title: "Agent 已安排待执行", detail: `${detail.waitingReason ?? "正在等待执行条件"}。获得名额后会自动开始。` }
    : detail.displayStatus === "running"
      ? { title: "Agent 正在执行", detail: `${detail.currentAction ?? "正在推进执行计划"}，有新进展会立即记录到时间线。` }
      : detail.displayStatus === "waiting_external"
        ? { title: "Agent 正在等待回复", detail: `${detail.currentAction ?? "正在等待联系人回复"}，收到消息后会自动继续。` }
        : detail.displayStatus === "waiting_approval"
          ? { title: "Agent 正在等你确认", detail: detail.waitingReason ?? "确认后会继续执行后续步骤。" }
          : detail.displayStatus === "completed"
            ? { title: "Agent 已完成任务", detail: "执行记录和结果已经保留，可沿时间线回看。" }
            : detail.displayStatus === "failed"
              ? { title: "Agent 遇到阻塞", detail: detail.waitingReason ?? "需要处理异常后才能继续。" }
              : detail.displayStatus === "partial"
                ? { title: "任务部分完成", detail: detail.waitingReason ?? "已有可保留结果，但还有未完成的必要工作。" }
                : { title: "Agent 已暂停跟进", detail: "当前进度已经保留，恢复后会从原位置继续。" };

  const reminderSteps = detail.plan.filter((step) => step.owner && ["reply", "followup_window"].includes(step.waitingKind ?? ""));

  return (
    <div className="page task-detail-page">
      <div className="detail-header">
        <Link className="back-link" to="/tasks"><ArrowLeft />所有任务</Link>
        <div className="detail-title-row">
          <div>
            <div><h1>{detail.title}</h1><StatusBadge status={detail.displayStatus} /></div>
            <p>任务 ID：{detail.id} · 创建时间：{formatDateTime(detail.createdAt)} · 创建者：{detail.createdBy?.name ?? "—"}</p>
          </div>
          <div className="detail-actions">
            {allowed.has("pause") && (
              <button className="button button-primary" disabled={pendingCommand !== null} onClick={() => runCommand("pause")}><Pause />{isPaused ? "已暂停" : "暂停"}</button>
            )}
            {allowed.has("resume") && (
              <button className="button button-primary" disabled={pendingCommand !== null} onClick={() => runCommand("resume")}><Play />继续执行</button>
            )}
            {allowed.has("cancel") && (
              <button className="button button-danger-outline" disabled={pendingCommand !== null} onClick={() => setCancelOpen(true)}><Square />取消任务</button>
            )}
            {allowed.has("instruction") && (
              <button className="button button-secondary" disabled={pendingCommand !== null} onClick={() => setInstructionOpen(true)}>给 Agent 新指令</button>
            )}
            {allowed.has("retry") && (
              <button className="button button-secondary" disabled={pendingCommand !== null} onClick={() => runCommand("retry")}>重试失败步骤</button>
            )}
          </div>
        </div>
        {detail.uncertainActionIds.length > 0 && (
          <div className="app-banner app-banner-warn detail-recovery-hint" role="status">
            <AlertTriangle aria-hidden="true" />
            <span>存在待核实的外部发送结果。Agent 会先查询会话历史确认是否已发出，确认前不会重复发送。</span>
          </div>
        )}
        <nav className="detail-tabs" aria-label="任务详情导航"><button className="active">总览</button><button disabled>子任务</button><button disabled>消息</button><a href="#task-timeline">时间线 <span>{mergedActivity.length}</span></a><button disabled>产物</button><button disabled>Debug</button></nav>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="detail-top-grid">
            <section className="panel objective-card">
              <header className="panel-header"><div><Gauge /><h2>任务目标</h2></div></header>
              <p>{detail.originalRequest || detail.description}</p>
              <ul>
                <li>优先级：{{ low: "低", normal: "普通", high: "高" }[detail.priority]}</li>
                <li>截止时间：{detail.deadlineAt ? formatDateTime(detail.deadlineAt) : "未设置"}</li>
                <li>外部操作策略：{detail.externalPolicyLabel}</li>
                {detail.finalSummary && <li>任务结论：{detail.finalSummary}</li>}
              </ul>
            </section>
            <section className="panel current-state-card">
              <header className="panel-header"><div><Clock3 /><h2>当前状态</h2></div></header>
              <div className="state-highlight">
                <span>当前：</span><strong>{detail.currentAction ?? "等待 Agent 更新"}</strong>
                <span>{stateContext.label}</span><b>{stateContext.value}</b>
                <span>运行时状态：</span><p>{STATUS_META[detail.displayStatus].label}（runtime：{detail.sourceStatus}）</p>
              </div>
              <div className="state-stats">
                <span>未完成子任务 <b>{Math.max(0, detail.totalSubtasks - detail.completedSubtasks)}</b></span>
                <span>已完成子任务 <b>{detail.completedSubtasks}/{detail.totalSubtasks}</b></span>
                <span>待确认事项 <b>{detail.pendingApprovalIds.length}</b></span>
              </div>
            </section>
          </div>

          <div className="detail-bottom-grid">
            <section className="panel plan-card">
              <header className="panel-header"><div><Activity /><h2>执行计划</h2><span>{detail.plan.length} 步</span></div></header>
              <TaskPlan steps={detail.plan} />
            </section>
            <div className="detail-secondary-column">
              <section className="panel timeline-card" id="task-timeline">
                <header className="panel-header"><div><FileText /><h2>最近进展</h2></div><span className="timeline-direction">从过去到现在</span></header>
                <ActivityTimeline events={mergedActivity} status={detail.displayStatus} />
                {detailQuery.data?.activityNextCursor && (
                  <button className="button button-quiet timeline-more" onClick={() => loadOlder().catch(() => setError("加载更早记录失败。"))}>
                    加载更早的记录
                  </button>
                )}
              </section>
              {(detail.workingSummary.confirmedFacts.length > 0 || detail.workingSummary.openQuestions.length > 0) && (
                <section className="panel insights-card">
                  <header className="panel-header"><div><Bot /><h2>Agent 摘要</h2></div></header>
                  {detail.workingSummary.confirmedFacts.map((fact) => <p key={fact}><i className="insight-market" />{fact}</p>)}
                  {detail.workingSummary.openQuestions.map((question) => <p key={question}><i className="insight-tech" />待确认：{question}</p>)}
                </section>
              )}
            </div>
          </div>
        </div>

        <aside className="detail-rail">
          <section className="panel agent-follow-card">
            <AgentMascot mood={detail.displayStatus === "completed" ? "success" : ["queued", "paused", "failed", "stopped", "waiting_external", "waiting_approval"].includes(detail.displayStatus) ? "waiting" : "working"} scene={followScene} size="lg" />
            <h2>{followCopy.title}</h2>
            <p>{followCopy.detail}</p>
            <ProgressBar value={detail.progress} label="推进进度" />
          </section>
          <section className="panel key-info-card">
            <header className="panel-header"><div><ShieldCheck /><h2>关键信息</h2></div></header>
            <dl>
              <div><dt>优先级</dt><dd className={detail.priority === "high" ? "danger-text" : undefined}>{{ low: "低", normal: "普通", high: "高" }[detail.priority]}</dd></div>
              <div><dt>执行方式</dt><dd>{detail.executionMode === "automatic" ? "自动执行" : "外部动作需确认"}</dd></div>
              <div><dt>创建时间</dt><dd>{relativeTime(detail.createdAt)}</dd></div>
              <div><dt>最近更新</dt><dd>{relativeTime(detail.updatedAt)}</dd></div>
            </dl>
          </section>
          <section className="panel contacts-card">
            <header className="panel-header"><div><Users /><h2>相关联系人</h2></div></header>
            {(detail.contacts.length === 0) && <p className="overview-empty">任务拆解后会显示相关联系人。</p>}
            {detail.contacts.map((person, index) => {
              const waitingStep = reminderSteps.find((step) => step.owner?.id === person.id);
              const label = index === 0 && detail.displayStatus === "queued" ? "排队联系人" : waitingStep ? "等待回复中" : index === 0 ? "主要联系人" : "参与人";
              return (
                <div key={person.id}>
                  <span className="person-avatar">{person.initials}</span>
                  <p><small>{label}</small><strong>{person.name} · {person.department || "—"}</strong></p>
                  {waitingStep && (
                    <button
                      className="button button-quiet"
                      disabled={pendingCommand !== null}
                      onClick={() => remind(waitingStep.id, person.name)}
                    >
                      <Send />催一下
                    </button>
                  )}
                </div>
              );
            })}
          </section>
        </aside>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        title="确认取消这个任务？"
        description="Agent 会停止后续步骤并清理未执行的命令。已发送的消息、已记录的回复和产物会保留，但无法撤回已发出的消息。"
        confirmLabel="取消任务"
        tone="danger"
        onConfirm={() => runCommand("cancel")}
        onClose={() => setCancelOpen(false)}
      />
      <PromptDialog
        open={instructionOpen}
        title="给 Agent 新指令"
        description="指令会保存到任务并等待 Agent 处理；如果需要改变范围或产生新的外部动作，Agent 会先征求你的确认。"
        placeholder="例如：先暂停联系财务，只汇总市场和技术反馈。"
        confirmLabel="提交指令"
        onConfirm={submitInstruction}
        onClose={() => setInstructionOpen(false)}
      />
      {error && <Toast message={error} tone="danger" onClose={() => setError("")} />}
      {!error && toast && <Toast message={toast} onClose={() => setToast("")} />}
    </div>
  );
}

export type { TaskDetailDto };
