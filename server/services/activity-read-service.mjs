import { buildActivity } from '../serializers/activity-dto.mjs';
import { loadReadContext } from './read-context.mjs';
import { encodeCursor, decodeCursor } from './task-read-service.mjs';

/**
 * Cross-task activity read model (docs/sidebar-pages-design.md §5.4). The
 * merged ActivityEvent feed comes from the shared serializer — this service
 * only adds filtering and cursor pagination, never a second interpretation
 * of the raw logs. Cursor offsets are absolute indexes over the ascending
 * (occurredAt, sequence) feed; both logs are append-only, so older pages
 * stay valid while new records arrive.
 */
export class ActivityReadService {
  constructor(store) {
    this.store = store;
  }

  async listActivity({ kinds = null, taskId = null, q = '', occurredFrom = null, occurredTo = null, cursor = null, limit = 30 }) {
    const context = await loadReadContext(this.store);
    const [events, messages] = await Promise.all([
      this.store.readJsonlAll('events.jsonl'),
      this.store.readJsonlAll('messages.jsonl')
    ]);
    const feed = buildActivity({
      events,
      messages,
      approvals: context.approvals,
      contactsConfig: context.contactsConfig,
      groupsConfig: context.groupsConfig,
      limit: null
    });

    const taskTitles = new Map(context.tasks.map((task) => [task.task_id, task.title]));
    // Time windows compare as instants: ISO strings with timezone offsets
    // or mixed precision must not be compared lexicographically.
    const fromMs = occurredFrom ? Date.parse(occurredFrom) : null;
    const toMs = occurredTo ? Date.parse(occurredTo) : null;
    let filtered = feed;
    if (kinds && kinds.length) {
      const allowed = new Set(kinds);
      filtered = filtered.filter((item) => allowed.has(item.kind));
    }
    if (taskId) filtered = filtered.filter((item) => item.taskId === taskId);
    if (fromMs !== null) filtered = filtered.filter((item) => Date.parse(item.occurredAt) >= fromMs);
    if (toMs !== null) filtered = filtered.filter((item) => Date.parse(item.occurredAt) <= toMs);

    const query = String(q ?? '').trim().toLocaleLowerCase('zh-CN');
    if (query) {
      filtered = filtered.filter((item) => [item.title, item.detail ?? '', item.taskId ?? '', item.taskId ? taskTitles.get(item.taskId) ?? '' : '']
        .join(' ')
        .toLocaleLowerCase('zh-CN')
        .includes(query));
    }

    // Newest-first pages over an ascending feed: page out of [end-limit, end)
    // and reverse, mirroring getTaskEvents pagination (docs §7.5).
    const end = cursor ? Math.max(0, decodeCursor(cursor)) : filtered.length;
    const page = filtered.slice(Math.max(0, end - limit), end);
    const nextCursor = end - page.length > 0 ? encodeCursor(end - page.length) : null;

    return {
      items: [...page].reverse(),
      nextCursor,
      total: filtered.length,
      snapshotAt: new Date().toISOString()
    };
  }
}
