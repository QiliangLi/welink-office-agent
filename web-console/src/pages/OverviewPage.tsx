import { AlertTriangle, ArrowRight, BellRing, CheckCircle2, Clock3, FileText, Inbox, ListTodo, LoaderCircle, ShieldQuestion } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { StatusBadge } from "../components/tasks/StatusBadge";
import { TaskIcon } from "../components/tasks/TaskIcon";
import { relativeTime } from "../lib/task-utils";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { DisplayStatus } from "../types/domain";

const SUMMARY_CARDS: { status: DisplayStatus; label: string; helper: string; icon: typeof LoaderCircle; tone: string }[] = [
  { status: "running", label: "执行中", helper: "任务正在稳步推进中", icon: LoaderCircle, tone: "blue" },
  { status: "queued", label: "待执行", helper: "已进入执行队列", icon: ListTodo, tone: "slate" },
  { status: "waiting_external", label: "等待外部", helper: "正在等待同事反馈", icon: Clock3, tone: "amber" },
  { status: "waiting_approval", label: "待我处理", helper: "需要你及时处理", icon: ShieldQuestion, tone: "violet" },
  { status: "failed", label: "异常", helper: "任务出现异常需关注", icon: AlertTriangle, tone: "red" },
];

export function OverviewPage() {
  const { client, decide } = useAppData();
  const navigate = useNavigate();
  const overviewQuery = useQuery(queryKeys.overview(), () => client.getOverview({ taskLimit: 6, activityLimit: 10 }));
  const overview = overviewQuery.data;

  if (overviewQuery.loading && !overview) {
    return <div className="page overview-page" aria-busy="true"><div className="summary-grid">{SUMMARY_CARDS.map((card) => <div className="summary-card skeleton-card" key={card.status} />)}</div><div className="overview-columns"><div className="panel skeleton-panel" /><div className="panel skeleton-panel" /><div className="panel skeleton-panel" /></div></div>;
  }
  if (overviewQuery.error && !overview) {
    return <div className="page overview-page"><div className="panel overview-error"><AlertTriangle /><h2>暂时无法加载总览</h2><p>{overviewQuery.error.message}</p><button className="button button-primary" onClick={overviewQuery.refetch}>重试</button></div></div>;
  }
  if (!overview) return null;

  const totals = overview.totalsByStatus;
  const pendingApprovals = overview.pendingApprovals;

  const resolveFromOverview = async (approvalId: string, revision: number, decision: "approve" | "reject") => {
    await decide(approvalId, { decision, expectedRevision: revision });
  };

  return (
    <div className="page overview-page">
      <div className="summary-grid">
        {SUMMARY_CARDS.map(({ status, label, helper, icon: Icon, tone }) => (
          <button key={status} className={`summary-card summary-${tone}`} onClick={() => navigate(`/tasks?status=${status}`)}>
            <span className="summary-icon"><Icon /></span>
            <span><strong>{label}</strong><b>{totals[status] ?? 0}</b><small>{helper}</small></span>
            <span className="summary-orbit" aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="overview-columns">
        <section className="panel current-work-panel">
          <header className="panel-header"><div><i className="live-dot" /><h2>当前任务</h2></div></header>
          <div className="compact-task-list">
            {overview.currentTasks.length === 0 && <p className="overview-empty">当前没有进行中的任务。</p>}
            {overview.currentTasks.map((task) => (
              <Link to={`/tasks/${task.id}`} className="compact-task" key={task.id}>
                <TaskIcon category={task.category ?? "follow_up"} size="sm" />
                <span><strong>{task.title}</strong><small>{task.currentAction ?? "等待 Agent 更新"}</small></span>
                <StatusBadge status={task.displayStatus} compact />
              </Link>
            ))}
          </div>
          <Link to="/tasks" className="panel-link">查看全部任务 <ArrowRight /></Link>
        </section>

        <section className="panel queued-work-panel">
          <header className="panel-header"><div><ListTodo /><h2>待执行队列</h2><span className="queue-count">{totals.queued ?? 0}</span></div></header>
          <div className="queued-task-list">
            {overview.queuedTasks.length === 0 && <p className="overview-empty">当前没有待执行任务。</p>}
            {overview.queuedTasks.slice(0, 3).map((task, index) => (
              <Link to={`/tasks/${task.id}`} className="queued-task" key={task.id}>
                <span className="queue-position" aria-label={`队列第 ${index + 1} 位`}>{task.queuePosition ?? index + 1}</span>
                <span><strong>{task.title}</strong><small>{task.waitingReason ?? task.currentAction}</small></span>
                <span className="queue-contact">{task.blockedByTaskId ? `前序：${task.blockedByTaskId}` : "待执行"}</span>
              </Link>
            ))}
          </div>
          <Link to="/tasks?status=queued" className="panel-link">查看待执行队列 <ArrowRight /></Link>
        </section>

        <section className="panel attention-panel">
          <header className="panel-header"><div><BellRing /><h2>需要你的处理</h2><span className="count-pill">{pendingApprovals.length}</span></div></header>
          <div className="mini-approval-list">
            {pendingApprovals.length === 0 && <p className="overview-empty">当前没有需要你确认的事项。</p>}
            {pendingApprovals.slice(0, 2).map((approval) => (
              <article className="mini-approval" key={approval.id}>
                <div><strong>{approval.title}</strong><time>{relativeTime(approval.createdAt)}</time></div>
                <p>{approval.impact}</p>
                <div className="mini-actions">
                  <Link to="/approvals" className="button button-quiet">查看</Link>
                  <button className="button button-success-outline" onClick={() => resolveFromOverview(approval.id, approval.revision, "approve")}>批准</button>
                  <button className="button button-danger-outline" onClick={() => resolveFromOverview(approval.id, approval.revision, "reject")}>拒绝</button>
                </div>
              </article>
            ))}
          </div>
          <Link to="/approvals" className="panel-link">查看全部待我处理 <ArrowRight /></Link>
        </section>

        <section className="panel completed-panel">
          <header className="panel-header"><div><CheckCircle2 /><h2>最近完成</h2></div></header>
          <div className="completed-list">
            {overview.recentCompleted.length === 0 && <p className="overview-empty"><Inbox />还没有已完成的任务。</p>}
            {overview.recentCompleted.map((task) => <Link to={`/tasks/${task.id}`} key={task.id}><CheckCircle2 /><span><strong>{task.title}</strong><small>{relativeTime(task.updatedAt)}</small></span></Link>)}
          </div>
          <Link to="/tasks?status=completed" className="panel-link">查看全部已完成 <ArrowRight /></Link>
        </section>
      </div>

      <section className="panel activity-panel">
        <div className="activity-main">
          <header className="panel-header"><div><LoaderCircle /><h2>Agent 最近动态</h2></div></header>
          <div className="activity-list">
            {overview.recentActivity.length === 0 && <p className="overview-empty">Agent 启动后，动态会显示在这里。</p>}
            {overview.recentActivity.map((item) => (
              <div key={item.id} className="activity-row">
                <span className={`activity-kind activity-${item.kind}`}>{item.kind === "file" ? <FileText /> : item.kind === "message" ? <BellRing /> : <CheckCircle2 />}</span>
                <span>{item.title}{item.detail ? ` · ${item.detail}` : ""}</span>
                <time>{relativeTime(item.occurredAt)}</time>
              </div>
            ))}
          </div>
        </div>
        <div className="activity-mascot"><AgentMascot mood="working" scene="monitoring" size="lg" /><p>我会持续盯住进度，遇到阻塞马上告诉你。</p></div>
      </section>
    </div>
  );
}
