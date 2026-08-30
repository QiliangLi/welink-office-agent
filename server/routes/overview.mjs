import { serializeTask } from '../serializers/task-dto.mjs';
import { serializeApproval } from '../serializers/approval-dto.mjs';
import { buildActivity } from '../serializers/activity-dto.mjs';
import { loadReadContext, computeQueuePositions } from '../services/read-context.mjs';

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const ALL_STATUSES = ['queued', 'running', 'waiting_external', 'waiting_approval', 'paused', 'partial', 'failed', 'stopped', 'completed'];

export function register(register) {
  register('GET', '/api/v1/overview', async ({ reply, query, context }) => {
    const { store } = context;
    const ctx = await loadReadContext(store);
    const queuePositions = await computeQueuePositions(store, ctx.tasks);

    const taskLimit = clamp(Number(query.taskLimit ?? 6), 1, 20);
    const activityLimit = clamp(Number(query.activityLimit ?? 12), 1, 50);

    const dtos = ctx.tasks.map((task) => serializeTask(task, { ...ctx, queuePositions }));
    const totalsByStatus = { ...Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) };
    for (const dto of dtos) totalsByStatus[dto.displayStatus] += 1;

    const byUpdatedDesc = (left, right) =>
      String(right.updatedAt).localeCompare(String(left.updatedAt)) || left.id.localeCompare(right.id);

    // Two independent collections: current work and the execution queue.
    const currentTasks = dtos
      .filter((dto) => ['running', 'waiting_external'].includes(dto.displayStatus))
      .sort(byUpdatedDesc)
      .slice(0, taskLimit);
    const queuedTasks = dtos
      .filter((dto) => dto.displayStatus === 'queued')
      .sort((left, right) =>
        (PRIORITY_RANK[left.priority] ?? 1) - (PRIORITY_RANK[right.priority] ?? 1) ||
        String(left.queueEnteredAt ?? left.createdAt).localeCompare(String(right.queueEnteredAt ?? right.createdAt)) ||
        left.id.localeCompare(right.id)
      )
      .slice(0, taskLimit);

    const pendingApprovals = ctx.approvals
      .filter((approval) => approval.status === 'pending')
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .slice(0, 10)
      .map((approval) => serializeApproval(approval, ctx));

    const recentCompleted = dtos
      .filter((dto) => dto.displayStatus === 'completed')
      .sort(byUpdatedDesc)
      .slice(0, 3);

    const [events, messages] = await Promise.all([
      store.readJsonlAll('events.jsonl'),
      store.readJsonlAll('messages.jsonl')
    ]);
    const recentActivity = buildActivity({
      events,
      messages,
      approvals: ctx.approvals,
      contactsConfig: ctx.contactsConfig,
      groupsConfig: ctx.groupsConfig,
      limit: activityLimit
    });

    reply(200, {
      totalsByStatus,
      currentTasks,
      queuedTasks,
      pendingApprovals,
      recentCompleted,
      recentActivity,
      snapshotAt: new Date().toISOString()
    });
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
