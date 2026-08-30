export const queryKeys = {
  health: () => ["health"],
  session: () => ["session"],
  overview: () => ["overview"],
  tasks: (params?: unknown) => (params ? ["tasks", JSON.stringify(params)] : ["tasks"]),
  taskDetail: (taskId: string) => ["task", taskId],
  taskEvents: (taskId: string) => ["taskEvents", taskId],
  approvals: (status: string) => ["approvals", status],
};

/** Invalidate prefixes for SSE events and mutations (docs §8, §13.1). */
export function invalidationPlan(eventType: string): string[] {
  switch (eventType) {
    case "task.created":
    case "task.completed":
    case "task.updated":
      return ["overview", "tasks", "task", "taskEvents", "health"];
    case "task.queue.updated":
      return ["overview", "tasks", "task"];
    case "approval.created":
    case "approval.resolved":
      return ["approvals", "overview", "task", "health"];
    case "command.updated":
      return ["health", "task", "tasks"];
    case "action.updated":
      return ["task", "taskEvents", "overview"];
    case "message.received":
    case "message.attributed":
      return ["task", "taskEvents", "overview"];
    case "conversation.updated":
      return ["task", "overview"];
    case "agent.health":
      return ["health"];
    default:
      return [];
  }
}
