import { Check, ChevronLeft, ChevronRight, LayoutGrid, List, Plus, RotateCcw, Search, SlidersHorizontal, UserRound } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { ProgressBar } from "../components/tasks/ProgressBar";
import { StatusBadge } from "../components/tasks/StatusBadge";
import { TaskIcon } from "../components/tasks/TaskIcon";
import { filterTasks, relativeTime, STATUS_META, type TaskTimeFilter } from "../lib/task-utils";
import { useAppData } from "../state/AppDataContext";
import type { TaskStatus } from "../types/domain";

export function TasksPage() {
  const { tasks } = useAppData();
  const [params] = useSearchParams();
  const initialStatus = (params.get("status") as TaskStatus | null) ?? "all";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<TaskStatus | "all">(initialStatus);
  const [time, setTime] = useState<TaskTimeFilter>("all");
  const [view, setView] = useState<"list" | "board">("list");
  const filtered = useMemo(() => filterTasks(tasks, query, status, time), [query, status, tasks, time]);
  const statusCounts = useMemo(() => Object.keys(STATUS_META).map((key) => ({ status: key as TaskStatus, count: tasks.filter((task) => task.status === key).length })), [tasks]);

  const clear = () => { setQuery(""); setStatus("all"); setTime("all"); };

  return (
    <div className="page tasks-page">
      <div className="page-heading"><div><h1>任务</h1><p>查看 Agent 的全部任务、当前动作和等待原因。</p></div><Link to="/tasks/new" className="button button-primary"><Plus />新建任务</Link></div>
      <div className="tasks-layout">
        <div className="tasks-main">
          <div className="task-toolbar">
            <label className="search-field"><Search /><span className="sr-only">搜索任务</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、创建者或任务 ID" /></label>
            <label className="select-field"><span className="sr-only">状态筛选</span><select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus | "all")}><option value="all">全部状态</option>{Object.entries(STATUS_META).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}</select></label>
            <label className="select-field"><span className="sr-only">时间筛选</span><select value={time} onChange={(event) => setTime(event.target.value as TaskTimeFilter)}><option value="all">全部时间</option><option value="today">今天更新</option><option value="week">最近 7 天</option></select></label>
            <div className="view-toggle" aria-label="切换视图"><button className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List />列表</button><button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><LayoutGrid />看板</button></div>
          </div>

          {view === "list" ? (
            <div className="task-table-wrap">
              <table className="task-table">
                <thead><tr><th scope="col">任务名称</th><th scope="col">进度</th><th scope="col">状态</th><th scope="col">当前执行动作</th><th scope="col">等待 / 阻塞原因</th><th scope="col">更新时间</th></tr></thead>
                <tbody>{filtered.map((task) => (
                  <tr key={task.id}>
                    <td><Link to={`/tasks/${task.id}`} className="task-name-cell"><TaskIcon category={task.category} size="sm" /><span><strong>{task.title}</strong><small>由 {task.createdBy.name} 创建 · {task.id}</small></span></Link></td>
                    <td><ProgressBar value={task.progress} label={`${task.title}进度`} /></td>
                    <td><StatusBadge status={task.status} compact /></td>
                    <td>{task.currentAction ?? "等待 Agent 更新"}</td>
                    <td>{task.waitingReason ?? "无"}</td>
                    <td className="nowrap">{relativeTime(task.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
              {!filtered.length && <div className="table-empty"><Search /><h2>没有匹配任务</h2><p>调整筛选条件，或清空后查看全部任务。</p><button className="button button-secondary" onClick={clear}><RotateCcw />清空筛选</button></div>}
              <footer className="table-footer"><span>共 {filtered.length} 条任务</span><div><button className="icon-button" disabled aria-label="上一页"><ChevronLeft /></button><button className="page-number active">1</button><button className="page-number">2</button><button className="icon-button" aria-label="下一页"><ChevronRight /></button></div></footer>
            </div>
          ) : (
            <div className="task-board">{filtered.map((task) => <Link to={`/tasks/${task.id}`} className="task-board-card" key={task.id}><div><TaskIcon category={task.category} /><StatusBadge status={task.status} compact /></div><h2>{task.title}</h2><p>{task.currentAction}</p><ProgressBar value={task.progress} /><small>{task.completedSubtasks}/{task.totalSubtasks} 个子任务完成 · {relativeTime(task.updatedAt)}</small></Link>)}</div>
          )}
        </div>

        <aside className="tasks-rail">
          <section className="rail-card quick-filter"><header><h2>快速筛选</h2><AgentMascot mood="waiting" scene="filtering" size="sm" /></header>{statusCounts.filter(({ count }) => count > 0).map(({ status: value, count }) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}><span>{value === "completed" ? <Check /> : value === "waiting_approval" ? <UserRound /> : <SlidersHorizontal />}{STATUS_META[value].label}</span><b>{count}</b></button>)}<button className="clear-filter" onClick={clear}>清除筛选条件</button></section>
          <section className="rail-card status-overview"><h2>状态概览</h2><div className="donut" style={{ "--done": `${Math.round((tasks.filter((task) => task.status === "completed").length / tasks.length) * 100)}%` } as CSSProperties}><span><b>{tasks.length}</b>总任务</span></div><div className="donut-legend"><span><i className="legend-running" />执行中 <b>{tasks.filter((task) => task.status === "running").length}</b></span><span><i className="legend-waiting" />等待中 <b>{tasks.filter((task) => task.status.includes("waiting")).length}</b></span><span><i className="legend-completed" />已完成 <b>{tasks.filter((task) => task.status === "completed").length}</b></span></div></section>
          <section className="rail-card new-task-promo"><div><h2>需要创建新任务？</h2><p>用一句话说明目标，Agent 会拆解计划并持续跟进。</p><Link className="button button-primary" to="/tasks/new"><Plus />下发新任务</Link></div><AgentMascot mood="working" scene="create" size="md" /></section>
        </aside>
      </div>
    </div>
  );
}
