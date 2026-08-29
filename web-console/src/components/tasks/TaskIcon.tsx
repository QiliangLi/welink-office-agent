import { BarChart3, FileText, FolderKanban, Plane, Send } from "lucide-react";
import type { TaskCategory } from "../../types/domain";

const iconMap = {
  research: FolderKanban,
  report: BarChart3,
  follow_up: Send,
  travel: Plane,
  document: FileText,
} satisfies Record<TaskCategory, typeof FileText>;

export function TaskIcon({ category, size = "md" }: { category: TaskCategory; size?: "sm" | "md" }) {
  const Icon = iconMap[category];
  return (
    <span className={`task-icon task-icon-${category} ${size === "sm" ? "task-icon-sm" : ""}`}>
      <Icon aria-hidden="true" />
    </span>
  );
}
