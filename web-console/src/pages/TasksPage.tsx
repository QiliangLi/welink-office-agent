import { Check, ChevronLeft, ChevronRight, LayoutGrid, List, Plus, RotateCcw, Search, SlidersHorizontal, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AgentMascot } from "../components/mascot/AgentMascot";
import { ProgressBar } from "../components/tasks/ProgressBar";
import { StatusBadge } from "../components/tasks/StatusBadge";
import { TaskIcon } from "../components/tasks/TaskIcon";
import { filterTasks, relativeTime, STATUS_META, type TaskTimeFilter } from "../lib/task-utils";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { DisplayStatus } from "../types/domain";

const STATUS_VALUES = Object.keys(STATUS_META) as DisplayStatus[];

export function TasksPage() {
  const { client } = useAppData();
  const [params, setParams] = useSearchParams();
  const urlStatus = params.get("status");
  const urlQuery = params.get("q") ?? "";
  const [queryInput, setQueryInput] = useState(urlQuery);
  const [time, setTime] = useState<TaskTimeFilter>("all");
  const [view, setView] = useState<"list" | "board">("list");
  const [pageCursors, setPageCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  const status = (STATUS_VALUES.includes(urlStatus as DisplayStatus) ? urlStatus : "all") as DisplayStatus | "all";
  const activeCursor = pageCursors[pageIndex] ?? null;

  // Debounced URL + server query sync; the server stays authoritative.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (queryInput.trim()) next.set("q", queryInput.trim());
      else next.delete("q");
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
      setPageCursors([null]);
      setPageIndex(0);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryInput]);

  const listKey = queryKeys.tasks({ q: urlQuery, status, cursor: activeCursor });
  const listQuery = useQuery(listKey, () =>
    client.getTasks({
      q: urlQuery || undefined,
      status: status === "all" ? undefined : [status],
      cursor: activeCursor,
      limit: 20,
    }),
  );
  const page = listQuery.data;

  const filtered = useMemo(
    () => (page ? filterTasks(page.items, queryInput, status, time) : []),
    [page, queryInput, status, time],
  );
  const statusCounts = useMemo(
    () => STATUS_VALUES.map((value) => ({ status: value, count: page?.totalsByStatus?.[value] ?? 0 })),
    [page],
  );

  const clear = () => { setQueryInput(""); setTime("all"); setParams(new URLSearchParams(), { replace: true }); setPageCursors([null]); setPageIndex(0); };
  const setStatus = (value: DisplayStatus | "all") => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("status");
    else next.set("status", value);
    setParams(next, { replace: true });
    setPageCursors([null]);
    setPageIndex(0);
  };

  const canPrev = pageIndex > 0;
  const canNext = Boolean(page?.nextCursor);

  return (
    <div className="page tasks-page">
      <div className="page-heading"><div><h1>任务</h1><p>查看 Agent 的全部任务、当前动作和等待原因。</p></div><Link to="/tasks/new" className="button button-primary"><Plus />新建任务</Link></div>
      <div className="tasks-layout">
        <div className="tasks-main">
          <div className="task-toolbar">
            <label className="search-field"><Search /><span className="sr-only">搜索任务</span><input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索任务、创建者或任务 ID" /></label>
            <label className="select-field"><span className="sr-only">状态筛选</span><select value={status} onChange={(event) => setStatus(event.target.value as DisplayStatus | "all")}><option value="all">全部状态</option>{STATUS_VALUES.map((value) => <option value={value} key={value}>{STATUS_META[value].label}</option>)}</select></label>
            <label className="select-field"><span className="sr-only">时间筛选</span><select value={time} onChange={(event) => setTime(event.target.value as TaskTimeFilter)}><option value="all">全部时间</option><option value="today">今天更新</option><option value="week">最近 7 天</option></select></label>
            <div className="view-toggle" aria-label="切换视图"><button className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List />列表</button><button className={view === "board" ? "active" : ""} onClick={() => setView("board")}><LayoutGrid />看板</button></div>
          </div>

          {listQuery.loading && !page ? (
            <div className="task-table-wrap" aria-busy="true"><div className="skeleton-panel" style={{ height: 240 }} /></div>
          ) : listQuery.error && !page ? (
            <div className="table-empty"><Search /><h2>无法加载任务</h2><p>{listQuery.error.message}</p><button className="button button-primary" onClick={listQuery.refetch}>重试</button></div>
          ) : view === "list" ? (
            <div className="task-table-wrap">
              <table className="task-table">
                <thead><tr><th scope="col">任务名称</th><th scope="col">进度</th><th scope="col">状态</th><th scope="col">当前执行动作</th><th scope="col">等待 / 阻塞原因</th><th scope="col">更新时间</th></tr></thead>
                <tbody>{filtered.map((task) => (
                  <tr key={task.id}>
                    <td><Link to={`/tasks/${task.id}`} className="task-name-cell"><TaskIcon category={task.category ?? "follow_up"} size="sm" /><span><strong>{task.title}</strong><small>由 {task.createdBy?.name ?? "—"} 创建 · {task.id}</small></span></Link></td>
                    <td><ProgressBar value={task.progress} label={`${task.title}进度`} /></td>
                    <td><StatusBadge status={task.displayStatus} compact /></td>
                    <td>{task.currentAction ?? "等待 Agent 更新"}</td>
                    <td>{task.waitingReason ?? "无"}</td>
                    <td className="nowrap">{relativeTime(task.updatedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
              {!filtered.length && <div className="table-empty"><Search /><h2>没有匹配任务</h2><p>调整筛选条件，或清空后查看全部任务。</p><button className="button button-secondary" onClick={clear}><RotateCcw />清空筛选</button></div>}
              <footer className="table-footer">
                <span>共 {page?.total ?? filtered.length} 条任务</span>
                <div>
                  <button className="icon-button" disabled={!canPrev} aria-label="上一页" onClick={() => setPageIndex((index) => Math.max(0, index - 1))}><ChevronLeft /></button>
                  <span className="page-number active">{pageIndex + 1}</span>
                  <button className="icon-button" disabled={!canNext} aria-label="下一页" onClick={() => { if (page?.nextCursor) { setPageCursors((cursors) => { const next = [...cursors]; next[pageIndex + 1] = page.nextCursor; return next; }); setPageIndex(pageIndex + 1); } }}><ChevronRight /></button>
                </div>
              </footer>
            </div>
          ) : (
            <div className="task-board">{filtered.map((task) => <Link to={`/tasks/${task.id}`} className="task-board-card" key={task.id}><div><TaskIcon category={task.category ?? "follow_up"} /><StatusBadge status={task.displayStatus} compact /></div><h2>{task.title}</h2><p>{task.currentAction}</p><ProgressBar value={task.progress} /><small>{task.completedSubtasks}/{task.totalSubtasks} 个子任务完成 · {relativeTime(task.updatedAt)}</small></Link>)}</div>
          )}
        </div>

        <aside className="tasks-rail">
          <section className="rail-card quick-filter"><header><h2>快速筛选</h2><AgentMascot mood="waiting" scene="filtering" size="sm" /></header>{statusCounts.filter(({ count }) => count > 0).map(({ status: value, count }) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}><span>{value === "completed" ? <Check /> : value === "waiting_approval" ? <UserRound /> : <SlidersHorizontal />}{STATUS_META[value].label}</span><b>{count}</b></button>)}<button className="clear-filter" onClick={clear}>清除筛选条件</button></section>
          <section className="rail-card status-overview"><h2>状态概览</h2><div className="donut" style={{ "--done": `${page ? Math.round(((page.totalsByStatus?.completed ?? 0) / Math.max(1, page.total)) * 100) : 0}%` } as React.CSSProperties}><span><b>{page?.total ?? 0}</b>当前任务</span></div><div className="donut-legend"><span><i className="legend-running" />执行中 <b>{page?.totalsByStatus?.running ?? 0}</b></span><span><i className="legend-waiting" />等待中 <b>{(page?.totalsByStatus?.waiting_external ?? 0) + (page?.totalsByStatus?.waiting_approval ?? 0)}</b></span><span><i className="legend-completed" />已完成 <b>{page?.totalsByStatus?.completed ?? 0}</b></span></div></section>
          <section className="rail-card new-task-promo"><div><h2>需要创建新任务？</h2><p>用一句话说明目标，Agent 会拆解计划并持续跟进。</p><Link className="button button-primary" to="/tasks/new"><Plus />下发新任务</Link></div><AgentMascot mood="working" scene="create" size="md" /></section>
        </aside>
      </div>
    </div>
  );
}
