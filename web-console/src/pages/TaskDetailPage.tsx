import { Activity, ArrowLeft, Bot, Clock3, FileText, Gauge, MoreHorizontal, Pause, Play, Send, Square, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { ActivityTimeline } from "../components/tasks/ActivityTimeline";
import { ProgressBar } from "../components/tasks/ProgressBar";
import { StatusBadge } from "../components/tasks/StatusBadge";
import { TaskPlan } from "../components/tasks/TaskPlan";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Toast } from "../components/ui/Toast";
import { formatDateTime } from "../lib/task-utils";
import { useAppData } from "../state/AppDataContext";

export function TaskDetailPage() {
  const { taskId = "" } = useParams();
  const { tasks, updateTaskStatus } = useAppData();
  const task = tasks.find((item) => item.id === taskId);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [toast, setToast] = useState("");

  if (!task) return <div className="page not-found"><h1>没有找到这个任务</h1><p>任务可能尚未同步，或链接已失效。</p><Link className="button button-primary" to="/tasks">返回任务列表</Link></div>;
  const isPaused = task.status === "paused";
  const followScene = task.status === "failed" ? "blocked" : ["queued", "paused", "stopped", "waiting_external", "waiting_approval"].includes(task.status) ? "waiting" : task.status === "completed" ? "success" : "monitoring";
  const stateContext = task.status === "queued"
    ? { label: "排队原因：", value: task.waitingReason ?? "等待可用执行名额" }
    : task.status === "running"
      ? { label: "执行进度：", value: `${task.progress}%` }
      : ["waiting_external", "waiting_approval"].includes(task.status)
        ? { label: "等待原因：", value: task.waitingReason ?? task.blockedBy ?? "等待下一步输入" }
        : { label: "任务结果：", value: task.status === "completed" ? "已完成" : task.waitingReason ?? "状态已更新" };
  const followCopy = task.status === "queued"
    ? { title: "Agent 已安排待执行", detail: `${task.waitingReason ?? "正在等待执行名额"}。${task.nextAction ?? "获得名额后会自动开始"}。` }
    : task.status === "running"
      ? { title: "Agent 正在执行", detail: `${task.currentAction ?? "正在推进执行计划"}，有新进展会立即记录到时间线。` }
      : task.status === "waiting_external"
        ? { title: "Agent 正在等待回复", detail: `${task.currentAction ?? "正在等待联系人回复"}，收到消息后会自动继续。` }
        : task.status === "waiting_approval"
          ? { title: "Agent 正在等你确认", detail: task.waitingReason ?? "确认后会继续执行后续步骤。" }
          : task.status === "completed"
            ? { title: "Agent 已完成任务", detail: "执行记录和结果已经保留，可沿时间线回看。" }
            : task.status === "failed"
              ? { title: "Agent 遇到阻塞", detail: task.waitingReason ?? "需要处理异常后才能继续。" }
              : { title: "Agent 已暂停跟进", detail: "当前进度已经保留，恢复后会从原位置继续。" };

  return (
    <div className="page task-detail-page">
      <div className="detail-header">
        <Link className="back-link" to="/tasks"><ArrowLeft />所有任务</Link>
        <div className="detail-title-row"><div><div><h1>{task.title}</h1><StatusBadge status={task.status} /></div><p>任务 ID：{task.id} · 创建时间：{formatDateTime(task.createdAt)} · 创建者：{task.createdBy.name}</p></div><div className="detail-actions"><button className="button button-primary" onClick={() => { updateTaskStatus(task.id, isPaused ? "running" : "paused"); setToast(isPaused ? "任务已继续，Agent 正在恢复执行。" : "任务已暂停，当前结果已保留。"); }}>{isPaused ? <Play /> : <Pause />}{isPaused ? "继续执行" : "暂停"}</button><button className="button button-danger-outline" onClick={() => setCancelOpen(true)}><Square />取消任务</button><button className="button button-secondary" onClick={() => setToast("新指令入口已准备，第一版暂不发送到 runtime。")}>给 Agent 新指令</button><button className="icon-button" aria-label="更多任务操作"><MoreHorizontal /></button></div></div>
        <nav className="detail-tabs" aria-label="任务详情导航"><button className="active">总览</button><button disabled>子任务</button><button disabled>消息 <span>12</span></button><a href="#task-timeline">时间线 <span>{task.activity.length}</span></a><button disabled>产物 <span>5</span></button><button disabled>Debug</button></nav>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="detail-top-grid">
            <section className="panel objective-card"><header className="panel-header"><div><Gauge /><h2>任务目标</h2></div></header><p>{task.description}</p><ul><li>覆盖范围：市场、技术、财务三方核心评审人</li><li>交付要求：汇总三方意见，形成可执行建议</li><li>截止时间：{task.estimatedCompletion ? formatDateTime(task.estimatedCompletion) : "未设置"}</li><li>关联项目：智能办公 Q3 升级项目</li></ul></section>
            <section className="panel current-state-card"><header className="panel-header"><div><Clock3 /><h2>当前状态</h2></div></header><div className="state-highlight"><span>当前：</span><strong>{task.currentAction ?? "等待 Agent 更新"}</strong><span>{stateContext.label}</span><b>{stateContext.value}</b><span>下一步：</span><p>{task.nextAction ?? "等待 Agent 更新"}</p></div><div className="state-stats"><span>执行中子任务 <b>{task.status === "queued" ? 0 : Math.max(0, task.totalSubtasks - task.completedSubtasks)}</b></span><span>已完成子任务 <b>{task.completedSubtasks}/{task.totalSubtasks}</b></span><span>预计完成时间 <b>{task.estimatedCompletion ? formatDateTime(task.estimatedCompletion) : "待评估"}</b></span></div></section>
          </div>

          <div className="detail-bottom-grid">
            <section className="panel plan-card"><header className="panel-header"><div><Activity /><h2>执行计划</h2><span>{task.totalSubtasks || task.plan.length} 步</span></div></header><TaskPlan steps={task.plan} /></section>
            <div className="detail-secondary-column">
              <section className="panel timeline-card" id="task-timeline"><header className="panel-header"><div><FileText /><h2>最近进展</h2></div><span className="timeline-direction">从过去到现在</span></header><ActivityTimeline events={task.activity} status={task.status} /></section>
              <section className="panel insights-card"><header className="panel-header"><div><Bot /><h2>提炼洞察</h2></div></header><p><i className="insight-market" />市场部重点关注用户价值、推广节奏和预算匹配。</p><p><i className="insight-tech" />技术部关注实现难度、中台复用和数据安全。</p><p><i className="insight-finance" />财务部关注 ROI 测算、成本结构和费用归属。</p></section>
            </div>
          </div>
        </div>

        <aside className="detail-rail">
          <section className="panel agent-follow-card"><AgentMascot mood={task.status === "completed" ? "success" : ["queued", "paused", "failed", "stopped", "waiting_external", "waiting_approval"].includes(task.status) ? "waiting" : "working"} scene={followScene} size="lg" /><h2>{followCopy.title}</h2><p>{followCopy.detail}</p><ProgressBar value={task.progress} label="推进进度" /></section>
          <section className="panel key-info-card"><header className="panel-header"><div><Gauge /><h2>关键信息</h2></div></header><dl><div><dt>任务优先级</dt><dd className="danger-text">高</dd></div><div><dt>紧急程度</dt><dd className="warning-text">一般</dd></div><div><dt>任务耗时</dt><dd>{task.receipt?.duration ?? "待统计"}</dd></div><div><dt>预计用时</dt><dd>约 6 小时</dd></div></dl></section>
          <section className="panel contacts-card"><header className="panel-header"><div><Users /><h2>相关联系人</h2></div></header><div><span className="person-avatar">{task.createdBy.initials}</span><p><small>发起人</small><strong>{task.createdBy.name}（你）</strong></p></div>{task.contacts.map((person) => <div key={person.id}><span className="person-avatar">{person.initials}</span><p><small>{person === task.contacts[0] ? task.status === "queued" ? "排队联系人" : task.status === "waiting_external" ? "当前等待人" : "主要联系人" : "评审人"}</small><strong>{person.name} · {person.department}</strong></p>{person === task.contacts[0] && task.status === "waiting_external" && <button className="button button-quiet" onClick={() => setToast(`已记录提醒 ${person.name}，mock 模式未实际发送。`)}><Send />催一下</button>}</div>)}</section>
        </aside>
      </div>
      <ConfirmDialog open={cancelOpen} title="确认取消这个任务？" description="Agent 会停止后续步骤，已收集的信息和产物会保留，但未执行的外部动作不会继续。" confirmLabel="取消任务" tone="danger" onConfirm={() => { updateTaskStatus(task.id, "stopped"); setToast("任务已取消，已有结果仍可查看。") }} onClose={() => setCancelOpen(false)} />
      {toast && <Toast message={toast} onClose={() => setToast("")} />}
    </div>
  );
}
