export const queryKeys = {
  health: () => ["health"],
  session: () => ["session"],
  overview: () => ["overview"],
  tasks: (params?: unknown) => (params ? ["tasks", JSON.stringify(params)] : ["tasks"]),
  taskDetail: (taskId: string) => ["task", taskId],
  taskEvents: (taskId: string) => ["taskEvents", taskId],
  approvals: (status: string) => ["approvals", status],
  activity: (params?: unknown) => ["activity", params ? JSON.stringify(params) : "list"],
  contacts: () => ["contacts"],
};

/**
 * Invalidate prefixes for SSE events and mutations (docs §8, §13.1). Events
 * that append to the activity logs also invalidate the global feed; the
 * activity page decides whether to apply the refreshed page or surface the
 * "new activity" hint (docs/sidebar-pages-design.md §5.5).
 */
export function invalidationPlan(eventType: string): string[] {
  switch (eventType) {
    case "task.created":
    case "task.completed":
    case "task.updated":
      return ["overview", "tasks", "task", "taskEvents", "health", "activity"];
    case "task.queue.updated":
      return ["overview", "tasks", "task", "activity"];
    case "approval.created":
    case "approval.resolved":
      return ["approvals", "overview", "task", "health", "activity"];
    case "command.updated":
      return ["health", "task", "tasks"];
    case "action.updated":
      return ["task", "taskEvents", "overview", "activity"];
    case "message.received":
    case "message.attributed":
      return ["task", "taskEvents", "overview", "activity"];
    case "conversation.updated":
      return ["task", "overview", "activity"];
    case "agent.health":
      return ["health"];
    default:
      return [];
  }
}
