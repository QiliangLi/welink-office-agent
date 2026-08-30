import { serializeTask, serializeTaskDetail } from '../serializers/task-dto.mjs';
import { buildActivity } from '../serializers/activity-dto.mjs';
import { notFoundError } from '../middleware/error-handler.mjs';

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

/**
 * Read model for the tasks list, task detail and merged activity timeline.
 * Cursor pagination is offset-based over the stable updatedAt ordering;
 * cursors are opaque to the client.
 */
export class TaskReadService {
  constructor(store) {
    this.store = store;
  }

  async listTasks({ q, statuses, updatedFrom, updatedTo, cursor, limit }) {
    const context = await this.readContext();
    const queuePositions = await this.queuePositions(context.tasks);

    const withDisplay = context.tasks.map((task) => ({
      task,
      dto: serializeTask(task, { ...context, queuePositions })
    }));

    const query = (q ?? '').trim().toLocaleLowerCase('zh-CN');
    const filtered = withDisplay.filter(({ task, dto }) => {
      if (statuses && !statuses.includes(dto.displayStatus)) return false;
      if (updatedFrom && String(task.updated_at) < updatedFrom) return false;
      if (updatedTo && String(task.updated_at) > updatedTo) return false;
      if (query) {
        const contactNames = (task.subtasks ?? [])
          .map((subtask) => (subtask.target_employee_number ? context.contactsConfig?.[subtask.target_employee_number]?.name ?? '' : ''))
          .join(' ');
        const haystack = [task.title, task.task_id, task.original_request ?? '', contactNames]
          .join(' ')
          .toLocaleLowerCase('zh-CN');
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    filtered.sort((left, right) =>
      String(right.task.updated_at ?? '').localeCompare(String(left.task.updated_at ?? '')) ||
      left.task.task_id.localeCompare(right.task.task_id)
    );

    const offset = decodeCursor(cursor);
    const page = filtered.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < filtered.length ? encodeCursor(nextOffset) : null;

    const totalsByStatus = {};
    for (const { dto } of withDisplay) {
      totalsByStatus[dto.displayStatus] = (totalsByStatus[dto.displayStatus] ?? 0) + 1;
    }

    return {
      items: page.map(({ dto }) => dto),
      nextCursor,
      total: filtered.length,
      totalsByStatus,
      snapshotAt: new Date().toISOString()
    };
  }

  async getTaskDetail(taskId, { activityLimit = 20 } = {}) {
    const context = await this.readContext();
    const task = context.tasks.find((entry) => entry.task_id === taskId);
    if (!task) throw notFoundError('TASK_NOT_FOUND', '任务不存在或已被删除。');
    const queuePositions = await this.queuePositions(context.tasks);
    const dto = serializeTaskDetail(task, { ...context, queuePositions });

    const [events, messages] = await Promise.all([
      this.store.readJsonlAll('events.jsonl'),
      this.store.readJsonlAll('messages.jsonl')
    ]);
    const activity = buildActivity({ events, messages, task, approvals: context.approvals, contactsConfig: context.contactsConfig, groupsConfig: context.groupsConfig });
    // Newest page first; same-batch order stays occurredAt ASC.
    const page = activity.slice(-activityLimit);
    const nextCursor = activity.length > page.length ? encodeCursor(activity.length - page.length) : null;

    return { task: dto, activity: page, activityNextCursor: nextCursor };
  }

  /** Load one earlier page of the merged timeline (docs §7.5). */
  async getTaskEvents(taskId, { cursor, limit = 30 }) {
    const context = await this.readContext();
    const task = context.tasks.find((entry) => entry.task_id === taskId);
    if (!task) throw notFoundError('TASK_NOT_FOUND', '任务不存在或已被删除。');
    const [events, messages] = await Promise.all([
      this.store.readJsonlAll('events.jsonl'),
      this.store.readJsonlAll('messages.jsonl')
    ]);
    const activity = buildActivity({ events, messages, task, approvals: context.approvals, contactsConfig: context.contactsConfig, groupsConfig: context.groupsConfig });
    const end = cursor ? Math.max(0, decodeCursor(cursor)) : activity.length;
    const page = activity.slice(Math.max(0, end - limit), end);
    const nextCursor = end - page.length > 0 ? encodeCursor(end - page.length) : null;
    return { items: page, nextCursor };
  }

  async readContext() {
    const { loadReadContext } = await import('./read-context.mjs');
    return loadReadContext(this.store);
  }

  async queuePositions(tasks) {
    const { computeQueuePositions } = await import('./read-context.mjs');
    return computeQueuePositions(this.store, tasks);
  }
}

export function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(parsed?.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}

export { PRIORITY_RANK };
