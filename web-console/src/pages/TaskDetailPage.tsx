import { Activity, ArrowLeft, Bot, ChevronRight, Clock3, FileText, Gauge, MoreHorizontal, Pause, Play, Send, Square, Users } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
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

  return (
    <div className="page task-detail-page">
      <div className="detail-header">
        <Link className="back-link" to="/tasks"><ArrowLeft />所有任务</Link>
        <div className="detail-title-row"><div><div><h1>{task.title}</h1><StatusBadge status={task.status} /></div><p>任务 ID：{task.id} · 创建时间：{formatDateTime(task.createdAt)} · 创建者：{task.createdBy.name}</p></div><div className="detail-actions"><button className="button button-primary" onClick={() => { updateTaskStatus(task.id, isPaused ? "running" : "paused"); setToast(isPaused ? "任务已继续，Agent 正在恢复执行。" : "任务已暂停，当前结果已保留。"); }}>{isPaused ? <Play /> : <Pause />}{isPaused ? "继续执行" : "暂停"}</button><button className="button button-danger-outline" onClick={() => setCancelOpen(true)}><Square />取消任务</button><button className="button button-secondary" onClick={() => setToast("新指令入口已准备，第一版暂不发送到 runtime。")}>给 Agent 新指令</button><button className="icon-button" aria-label="更多任务操作"><MoreHorizontal /></button></div></div>
        <nav className="detail-tabs" aria-label="任务详情导航"><button className="active">总览</button><button disabled>子任务</button><button disabled>消息 <span>12</span></button><button disabled>时间线</button><button disabled>产物 <span>5</span></button><button disabled>Debug</button></nav>
      </div>

      <div className="detail-grid">
        <div className="detail-main">
          <div className="detail-top-grid">
            <section className="panel objective-card"><header className="panel-header"><div><Gauge /><h2>任务目标</h2></div></header><p>{task.description}</p><ul><li>覆盖范围：市场、技术、财务三方核心评审人</li><li>交付要求：汇总三方意见，形成可执行建议</li><li>截止时间：{task.estimatedCompletion ? formatDateTime(task.estimatedCompletion) : "未设置"}</li><li>关联项目：智能办公 Q3 升级项目</li></ul></section>
            <section className="panel current-state-card"><header className="panel-header"><div><Clock3 /><h2>当前状态</h2></div></header><div className="state-highlight"><span>当前：</span><strong>{task.currentAction}</strong><span>已等待：</span><b>37 分钟</b><span>下一步：</span><p>{task.nextAction ?? "等待 Agent 更新"}</p></div><div className="state-stats"><span>执行中子任务 <b>{Math.max(0, task.totalSubtasks - task.completedSubtasks)}</b></span><span>已完成子任务 <b>{task.completedSubtasks}/{task.totalSubtasks}</b></span><span>预计完成时间 <b>{task.estimatedCompletion ? formatDateTime(task.estimatedCompletion) : "待评估"}</b></span></div></section>
          </div>

          <div className="detail-bottom-grid">
            <section className="panel plan-card"><header className="panel-header"><div><Activity /><h2>执行计划</h2><span>{task.totalSubtasks || task.plan.length} 步</span></div></header><TaskPlan steps={task.plan} /></section>
            <div className="detail-secondary-column">
              <section className="panel timeline-card"><header className="panel-header"><div><FileText /><h2>最近进展</h2></div><button>查看全部 <ChevronRight /></button></header><div className="timeline-list">{task.activity.map((event) => <div key={event.id}><time>{formatDateTime(event.at).slice(-5)}</time><span /><p><strong>{event.title}</strong>{event.detail}</p></div>)}</div></section>
              <section className="panel insights-card"><header className="panel-header"><div><Bot /><h2>提炼洞察</h2></div></header><p><i className="insight-market" />市场部重点关注用户价值、推广节奏和预算匹配。</p><p><i className="insight-tech" />技术部关注实现难度、中台复用和数据安全。</p><p><i className="insight-finance" />财务部关注 ROI 测算、成本结构和费用归属。</p></section>
            </div>
          </div>
        </div>

        <aside className="detail-rail">
          <section className="panel agent-follow-card"><AgentMascot mood={task.status === "failed" ? "waiting" : "working"} size="lg" /><h2>{task.status === "paused" ? "Agent 已暂停跟进" : "Agent 正在持续跟进"}</h2><p>我已向各评审人发送邀请，并会在收到回复后第一时间继续汇总。</p><ProgressBar value={task.progress} label="推进进度" /></section>
          <section className="panel key-info-card"><header className="panel-header"><div><Gauge /><h2>关键信息</h2></div></header><dl><div><dt>任务优先级</dt><dd className="danger-text">高</dd></div><div><dt>紧急程度</dt><dd className="warning-text">一般</dd></div><div><dt>任务耗时</dt><dd>{task.receipt?.duration ?? "待统计"}</dd></div><div><dt>预计用时</dt><dd>约 6 小时</dd></div></dl></section>
          <section className="panel contacts-card"><header className="panel-header"><div><Users /><h2>相关联系人</h2></div></header><div><span className="person-avatar">{task.createdBy.initials}</span><p><small>发起人</small><strong>{task.createdBy.name}（你）</strong></p></div>{task.contacts.map((person) => <div key={person.id}><span className="person-avatar">{person.initials}</span><p><small>{person === task.contacts[0] ? "当前等待人" : "评审人"}</small><strong>{person.name} · {person.department}</strong></p>{person === task.contacts[0] && <button className="button button-quiet" onClick={() => setToast(`已记录提醒 ${person.name}，mock 模式未实际发送。`)}><Send />催一下</button>}</div>)}</section>
        </aside>
      </div>
      <ConfirmDialog open={cancelOpen} title="确认取消这个任务？" description="Agent 会停止后续步骤，已收集的信息和产物会保留，但未执行的外部动作不会继续。" confirmLabel="取消任务" tone="danger" onConfirm={() => { updateTaskStatus(task.id, "stopped"); setToast("任务已取消，已有结果仍可查看。") }} onClose={() => setCancelOpen(false)} />
      {toast && <Toast message={toast} onClose={() => setToast("")} />}
    </div>
  );
}
