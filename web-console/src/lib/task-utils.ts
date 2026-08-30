import type { Task, TaskStatus } from "../types/domain";

export const STATUS_META: Record<
  TaskStatus,
  { label: string; shortLabel: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" | "info" }
> = {
  queued: { label: "待执行", shortLabel: "待执行", tone: "neutral" },
  running: { label: "执行中", shortLabel: "执行中", tone: "success" },
  waiting_external: { label: "等待外部", shortLabel: "等外部", tone: "warning" },
  waiting_approval: { label: "待我处理", shortLabel: "待处理", tone: "primary" },
  paused: { label: "已暂停", shortLabel: "暂停", tone: "neutral" },
  partial: { label: "部分完成", shortLabel: "部分完成", tone: "warning" },
  failed: { label: "异常", shortLabel: "异常", tone: "danger" },
  stopped: { label: "已停止", shortLabel: "已停止", tone: "neutral" },
  completed: { label: "已完成", shortLabel: "完成", tone: "success" },
};

export type TaskTimeFilter = "all" | "today" | "week";

export function filterTasks(tasks: Task[], query: string, status: TaskStatus | "all", time: TaskTimeFilter) {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  const base = Date.parse("2026-08-30T23:59:59+08:00");
  const cutoff = time === "today" ? base - 24 * 60 * 60 * 1000 : time === "week" ? base - 7 * 24 * 60 * 60 * 1000 : 0;

  return tasks.filter((task) => {
    const matchesQuery =
      !normalized ||
      [task.title, task.id, task.createdBy.name, task.description]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(normalized);
    const matchesStatus = status === "all" || task.status === status;
    const matchesTime = time === "all" || Date.parse(task.updatedAt) >= cutoff;
    return matchesQuery && matchesStatus && matchesTime;
  });
}

export function relativeTime(iso: string) {
  const now = Date.parse("2026-08-30T12:00:00+08:00");
  const diff = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function formatDateTime(iso: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
