import { AlertTriangle, Check, CirclePause, CircleStop, Clock3, LoaderCircle, ShieldQuestion } from "lucide-react";
import { STATUS_META } from "../../lib/task-utils";
import type { TaskStatus } from "../../types/domain";

const icons = {
  queued: Clock3,
  running: LoaderCircle,
  waiting_external: Clock3,
  waiting_approval: ShieldQuestion,
  paused: CirclePause,
  partial: AlertTriangle,
  failed: AlertTriangle,
  stopped: CircleStop,
  completed: Check,
} satisfies Record<TaskStatus, typeof Clock3>;

export function StatusBadge({ status, compact = false }: { status: TaskStatus; compact?: boolean }) {
  const meta = STATUS_META[status];
  const Icon = icons[status];
  return (
    <span className={`status-badge status-${meta.tone}`}>
      <Icon className={status === "running" ? "status-running-icon" : ""} aria-hidden="true" />
      {compact ? meta.shortLabel : meta.label}
    </span>
  );
}
