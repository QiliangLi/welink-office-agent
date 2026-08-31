import { RefreshCw, RotateCcw, Search, AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ACTIVITY_KIND_ICONS } from "../components/tasks/ActivityTimeline";
import { formatDateTime } from "../lib/task-utils";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { ActivityEvent } from "../types/domain";

const KIND_OPTIONS = [
  { value: "all", label: "全部类型" },
  { value: "task", label: "任务" },
  { value: "status", label: "状态" },
  { value: "message", label: "消息" },
  { value: "approval", label: "审批" },
  { value: "file", label: "文件" },
] as const;

const RANGE_OPTIONS = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "week", label: "最近 7 天" },
] as const;

type ActivityRange = (typeof RANGE_OPTIONS)[number]["value"];

const PAGE_LIMIT = 30;

function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今天";
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(date);
}

export function ActivityPage() {
  const { client } = useAppData();
  const [params, setParams] = useSearchParams();
  const kind = KIND_OPTIONS.some((option) => option.value === params.get("kind")) ? params.get("kind")! : "all";
  const range = (RANGE_OPTIONS.some((option) => option.value === params.get("range")) ? params.get("range") : "all") as ActivityRange;
  const taskQueryText = params.get("q") ?? "";
  const [taskInput, setTaskInput] = useState(taskQueryText);

  // Stabilized per filter set: recomputed only when the range changes.
  const occurredFrom = useMemo(() => {
    if (range === "all") return undefined;
    const hours = range === "today" ? 24 : 7 * 24;
    return new Date(Date.now() - hours * 3_600_000).toISOString();
  }, [range]);

  // Debounce the task keyword into the URL; the server stays authoritative.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (taskInput.trim()) next.set("q", taskInput.trim());
      else next.delete("q");
      if (next.toString() !== params.toString()) setParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskInput]);

  const listKey = queryKeys.activity({ kind, q: taskQueryText, occurredFrom: occurredFrom ?? null });
  const feedQuery = useQuery(listKey, () =>
    client.getActivity({
      kind: kind === "all" ? undefined : [kind],
      q: taskQueryText || undefined,
      occurredFrom,
      limit: PAGE_LIMIT,
    }),
  );

  // Displayed items are the applied first page plus explicitly loaded older
  // pages. SSE-driven background refetches do not replace the view; they only
  // raise the "new activity" hint so the user decides when to refresh (docs/
  // sidebar-pages-design.md §5.5). Older pages stay appended — the user is
  // never pulled back to the first page.
  const [appliedFirstPage, setAppliedFirstPage] = useState<ActivityEvent[] | null>(null);
  const [olderPages, setOlderPages] = useState<ActivityEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNew, setHasNew] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const appliedKeyRef = useRef("");
  const appliedNewestIdRef = useRef<string | null>(null);
  const adoptNextRef = useRef(false);

  const filterKey = listKey.join("::");
  useEffect(() => {
    const data = feedQuery.data;
    if (!data) return;
    const newestId = data.items[0]?.id ?? null;
    if (appliedKeyRef.current !== filterKey || adoptNextRef.current) {
      adoptNextRef.current = false;
      appliedKeyRef.current = filterKey;
      appliedNewestIdRef.current = newestId;
      setAppliedFirstPage(data.items);
      setOlderPages([]);
      setNextCursor(data.nextCursor);
      setHasNew(false);
      setLoadMoreError(false);
      return;
    }
    if (newestId !== appliedNewestIdRef.current) {
      setHasNew(true);
      appliedNewestIdRef.current = newestId;
    }
  }, [feedQuery.data, filterKey]);

  const refresh = () => {
    adoptNextRef.current = true;
    feedQuery.refetch();
  };

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const older = await client.getActivity({
        kind: kind === "all" ? undefined : [kind],
        q: taskQueryText || undefined,
        occurredFrom,
        cursor: nextCursor,
        limit: PAGE_LIMIT,
      });
      setOlderPages((current) => [...current, ...older.items]);
      setNextCursor(older.nextCursor);
    } catch {
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const setFilter = (key: "kind" | "range", value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const clearFilters = () => {
    setTaskInput("");
    setParams(new URLSearchParams(), { replace: true });
  };

  const hasActiveFilters = kind !== "all" || range !== "all" || taskQueryText.trim() !== "";
  const items = useMemo(
    () => [...(appliedFirstPage ?? []), ...olderPages],
    [appliedFirstPage, olderPages],
  );

  const dayGroups = useMemo(() => {
    const byDay = new Map<string, ActivityEvent[]>();
    for (const item of items) {
      const key = new Date(item.occurredAt).toDateString();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(item);
    }
    return [...byDay.entries()];
  }, [items]);

  return (
    <div className="page activity-page">
      <div className="page-heading">
        <div>
          <h1>动态</h1>
          <p>查看 Agent 在全部任务中的最近动作。</p>
        </div>
        <button className="button button-secondary" onClick={refresh} disabled={feedQuery.loading}>
          <RefreshCw aria-hidden="true" />刷新
        </button>
      </div>

      <div className="activity-toolbar">
        <label className="select-field">
          <span className="filter-label">类型</span>
          <select value={kind} onChange={(event) => setFilter("kind", event.target.value)}>
            {KIND_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="filter-label">任务</span>
          <input
            value={taskInput}
            onChange={(event) => setTaskInput(event.target.value)}
            placeholder="输入任务 ID 或标题关键词"
          />
        </label>
        <label className="select-field">
          <span className="filter-label">时间</span>
          <select value={range} onChange={(event) => setFilter("range", event.target.value)}>
            {RANGE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button className="button button-quiet" onClick={clearFilters} disabled={!hasActiveFilters}>
          <RotateCcw aria-hidden="true" />清除筛选
        </button>
      </div>

      {feedQuery.error && appliedFirstPage !== null && (
        <div className="app-banner app-banner-danger page-banner activity-error-banner" role="alert">
          <AlertTriangle aria-hidden="true" />
          <span>动态加载失败，正在显示最近一次的数据：{feedQuery.error.message}</span>
          <button className="button button-secondary" onClick={refresh}>重试</button>
        </div>
      )}
      {hasNew && (
        <div className="app-banner app-banner-warn page-banner activity-new-banner" role="status">
          <span>有新动态</span>
          <button className="button button-secondary" onClick={refresh}>点击刷新</button>
        </div>
      )}

      <section className="panel activity-feed-panel" aria-label="跨任务动态时间线">
        {feedQuery.loading && appliedFirstPage === null ? (
          <div className="activity-skeleton" aria-busy="true" aria-label="正在加载动态">
            {Array.from({ length: 6 }, (_, index) => <div className="activity-row-skeleton" key={index} />)}
          </div>
        ) : feedQuery.error && appliedFirstPage === null ? (
          <div className="table-empty">
            <AlertTriangle aria-hidden="true" />
            <h2>无法加载动态</h2>
            <p>{feedQuery.error.message}</p>
            <button className="button button-secondary" onClick={refresh}>重试</button>
          </div>
        ) : items.length === 0 ? (
          hasActiveFilters ? (
            <div className="table-empty">
              <Search aria-hidden="true" />
              <h2>当前筛选条件下没有动态</h2>
              <p>换个类型、任务关键词或时间范围试试。</p>
              <button className="button button-secondary" onClick={clearFilters}>清除全部筛选</button>
            </div>
          ) : (
            <div className="table-empty">
              <h2>还没有任何动态</h2>
              <p>Agent 开始执行任务后，动作和消息会记录在这里。</p>
              <Link className="button button-secondary" to="/tasks">查看任务</Link>
            </div>
          )
        ) : (
          <>
            {dayGroups.map(([dayKey, dayItems]) => (
              <div className="activity-day-group" key={dayKey}>
                <h2 className="activity-day-heading">{dayLabel(dayItems[0].occurredAt)}</h2>
                <ol className="activity-feed">
                  {dayItems.map((item) => {
                    const Icon = ACTIVITY_KIND_ICONS[item.kind];
                    const rowContent = (
                      <>
                        <time dateTime={item.occurredAt}>{formatDateTime(item.occurredAt).slice(-5)}</time>
                        <span className="timeline-node" aria-hidden="true"><Icon /></span>
                        <div className="timeline-copy">
                          <div><strong>{item.title}</strong></div>
                          {item.detail && <p>{item.detail}</p>}
                          {item.taskId && <small className="activity-task-ref">任务 {item.taskId}</small>}
                        </div>
                      </>
                    );
                    return (
                      <li key={item.id}>
                        {item.taskId ? (
                          <Link className={`timeline-entry timeline-entry-${item.kind} activity-entry`} to={`/tasks/${item.taskId}`}>
                            {rowContent}
                          </Link>
                        ) : (
                          <div className={`timeline-entry timeline-entry-${item.kind} activity-entry`}>{rowContent}</div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
            {loadMoreError && (
              <div className="activity-more-error" role="alert">
                <span>加载更多动态失败，已显示的记录不受影响。</span>
                <button className="button button-quiet" onClick={() => void loadMore()}>重试加载更多</button>
              </div>
            )}
            {nextCursor && !loadMoreError && (
              <button className="button button-quiet activity-more" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "正在加载…" : "加载更多"}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
