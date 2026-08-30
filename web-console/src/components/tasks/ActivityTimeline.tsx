import { CheckCircle2, FileText, ListChecks, MessageCircle, ShieldCheck } from "lucide-react";
import { formatDateTime } from "../../lib/task-utils";
import type { ActivityEvent, TaskStatus } from "../../types/domain";

const EVENT_ICONS = {
  message: MessageCircle,
  file: FileText,
  status: CheckCircle2,
  approval: ShieldCheck,
  task: ListChecks,
} satisfies Record<ActivityEvent["kind"], typeof MessageCircle>;

export function ActivityTimeline({ events, status }: { events: ActivityEvent[]; status: TaskStatus }) {
  if (events.length === 0) {
    return <p className="timeline-empty">任务开始后，进展会沿时间线显示在这里。</p>;
  }

  const orderedEvents = [...events].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const isFlowing = status === "running" && orderedEvents.length > 1;

  return (
    <div className={`timeline-list${isFlowing ? " timeline-list-flowing" : ""}`} aria-label="任务进展时间线">
      {orderedEvents.length > 1 && (
        <span className="timeline-spine" aria-hidden="true">
          {orderedEvents.slice(0, -1).map((event, index) => (
            <span
              className="timeline-arrow-cue"
              key={`${event.id}-arrow`}
              style={{ top: `${((index + 0.72) / (orderedEvents.length - 1)) * 100}%` }}
            />
          ))}
          {isFlowing && <span className="timeline-flow-marker" />}
        </span>
      )}
      {orderedEvents.map((event, index) => {
        const Icon = EVENT_ICONS[event.kind];
        const isCurrent = index === orderedEvents.length - 1;
        return (
          <article className={`timeline-entry timeline-entry-${event.kind}${isCurrent ? " is-current" : ""}`} key={event.id}>
            <time dateTime={event.at}>{formatDateTime(event.at).slice(-5)}</time>
            <span className="timeline-node" aria-hidden="true"><Icon /></span>
            <div className="timeline-copy">
              <div><strong>{event.title}</strong>{isCurrent && <span>当前</span>}</div>
              {event.detail && <p>{event.detail}</p>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
