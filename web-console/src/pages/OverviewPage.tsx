import { AlertTriangle, ArrowRight, BellRing, CheckCircle2, Clock3, FileText, ListTodo, LoaderCircle, ShieldQuestion } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { StatusBadge } from "../components/tasks/StatusBadge";
import { TaskIcon } from "../components/tasks/TaskIcon";
import { relativeTime } from "../lib/task-utils";
import { useAppData } from "../state/AppDataContext";

export function OverviewPage() {
  const { tasks, approvals, resolveApproval } = useAppData();
  const navigate = useNavigate();
  const running = tasks.filter((task) => task.status === "running");
  const queued = tasks.filter((task) => task.status === "queued");
  const waiting = tasks.filter((task) => task.status === "waiting_external");
  const failed = tasks.filter((task) => task.status === "failed");
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const completed = tasks.filter((task) => task.status === "completed").slice(0, 3);
  const current = tasks.filter((task) => ["running", "waiting_external"].includes(task.status)).slice(0, 3);
  const heroTask = tasks.find((task) => task.activity.length > 0) ?? tasks[0];

  const summaries = [
    { label: "执行中", count: running.length, helper: "任务正在稳步推进中", icon: LoaderCircle, tone: "blue", filter: "running" },
    { label: "待执行", count: queued.length, helper: "已进入执行队列", icon: ListTodo, tone: "slate", filter: "queued" },
    { label: "等待外部", count: waiting.length, helper: "正在等待同事反馈", icon: Clock3, tone: "amber", filter: "waiting_external" },
    { label: "待我处理", count: pendingApprovals.length, helper: "需要你及时处理", icon: ShieldQuestion, tone: "violet", filter: "waiting_approval" },
    { label: "异常", count: failed.length, helper: "任务出现异常需关注", icon: AlertTriangle, tone: "red", filter: "failed" },
  ];

  return (
    <div className="page overview-page">
      <div className="summary-grid">
        {summaries.map(({ label, count, helper, icon: Icon, tone, filter }) => (
          <button key={label} className={`summary-card summary-${tone}`} onClick={() => navigate(`/tasks?status=${filter}`)}>
            <span className="summary-icon"><Icon /></span>
            <span><strong>{label}</strong><b>{count}</b><small>{helper}</small></span>
            <span className="summary-orbit" aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="overview-columns">
        <section className="panel current-work-panel">
          <header className="panel-header"><div><i className="live-dot" /><h2>当前任务</h2></div></header>
          <div className="compact-task-list">
            {current.map((task) => (
              <Link to={`/tasks/${task.id}`} className="compact-task" key={task.id}>
                <TaskIcon category={task.category} size="sm" />
                <span><strong>{task.title}</strong><small>{task.currentAction}</small></span>
                <StatusBadge status={task.status} compact />
              </Link>
            ))}
          </div>
          <Link to="/tasks" className="panel-link">查看全部任务 <ArrowRight /></Link>
        </section>

        <section className="panel queued-work-panel">
          <header className="panel-header"><div><ListTodo /><h2>待执行队列</h2><span className="queue-count">{queued.length}</span></div></header>
          <div className="queued-task-list">
            {queued.length > 0 ? queued.slice(0, 3).map((task, index) => (
              <Link to={`/tasks/${task.id}`} className="queued-task" key={task.id}>
                <span className="queue-position" aria-label={`队列第 ${index + 1} 位`}>{index + 1}</span>
                <span><strong>{task.title}</strong><small>{task.waitingReason ?? task.currentAction}</small></span>
                <span className="queue-contact">{task.contacts[0]?.name ?? "待分配"}</span>
              </Link>
            )) : <p className="overview-empty">当前没有待执行任务。</p>}
          </div>
          <Link to="/tasks?status=queued" className="panel-link">查看待执行队列 <ArrowRight /></Link>
        </section>

        <section className="panel attention-panel">
          <header className="panel-header"><div><BellRing /><h2>需要你的处理</h2><span className="count-pill">{pendingApprovals.length}</span></div></header>
          <div className="mini-approval-list">
            {pendingApprovals.slice(0, 2).map((approval) => (
              <article className="mini-approval" key={approval.id}>
                <div><strong>{approval.title}</strong><time>{relativeTime(approval.createdAt)}</time></div>
                <p>{approval.impact}</p>
                <div className="mini-actions">
                  <Link to="/approvals" className="button button-quiet">查看</Link>
                  <button className="button button-success-outline" onClick={() => resolveApproval(approval.id, "approved")}>批准</button>
                  <button className="button button-danger-outline" onClick={() => resolveApproval(approval.id, "rejected")}>拒绝</button>
                </div>
              </article>
            ))}
          </div>
          <Link to="/approvals" className="panel-link">查看全部待我处理 <ArrowRight /></Link>
        </section>

        <section className="panel completed-panel">
          <header className="panel-header"><div><CheckCircle2 /><h2>最近完成</h2></div></header>
          <div className="completed-list">
            {completed.map((task) => <Link to={`/tasks/${task.id}`} key={task.id}><CheckCircle2 /><span><strong>{task.title}</strong><small>{relativeTime(task.updatedAt)}</small></span></Link>)}
          </div>
          <Link to="/tasks?status=completed" className="panel-link">查看全部已完成 <ArrowRight /></Link>
        </section>
      </div>

      <section className="panel activity-panel">
        <div className="activity-main">
          <header className="panel-header"><div><LoaderCircle /><h2>Agent 最近动态</h2></div></header>
          <div className="activity-list">
            {heroTask.activity.map((event) => (
              <div key={event.id} className="activity-row">
                <span className={`activity-kind activity-${event.kind}`}>{event.kind === "file" ? <FileText /> : event.kind === "message" ? <BellRing /> : <CheckCircle2 />}</span>
                <span>{event.title}{event.detail ? ` · ${event.detail}` : ""}</span>
                <time>{relativeTime(event.at)}</time>
              </div>
            ))}
          </div>
        </div>
        <div className="activity-mascot"><AgentMascot mood="working" scene="monitoring" size="lg" /><p>我会持续盯住进度，遇到阻塞马上告诉你。</p></div>
      </section>
    </div>
  );
}
