import { ACTIVITY_KINDS, activityQuerySchema } from '../schemas/activity.mjs';
import { ApiError } from '../middleware/error-handler.mjs';

/**
 * Invalid kind / time / limit values share one 422 shape (design §5.4, §13).
 */
function invalidParam(message, field, extra = null) {
  return new ApiError(422, 'VALIDATION_ERROR', message, { details: { field, ...extra }, retryable: false });
}

export function register(register, context) {
  register('GET', '/api/v1/activity', async ({ reply, query, repeat }) => {
    const kinds = repeat('kind').filter(Boolean);
    for (const kind of kinds) {
      if (!ACTIVITY_KINDS.includes(kind)) {
        throw invalidParam(`不支持的活动类型 ${kind}。`, 'kind', { allowed: ACTIVITY_KINDS });
      }
    }

    const occurredFrom = query.occurredFrom ?? null;
    const occurredTo = query.occurredTo ?? null;
    if (occurredFrom && Number.isNaN(Date.parse(occurredFrom))) {
      throw invalidParam('occurredFrom 不是有效的时间。', 'occurredFrom');
    }
    if (occurredTo && Number.isNaN(Date.parse(occurredTo))) {
      throw invalidParam('occurredTo 不是有效的时间。', 'occurredTo');
    }
    // Compare as instants: ISO strings with timezone offsets or different
    // precision do not order lexicographically.
    if (occurredFrom && occurredTo && Date.parse(occurredFrom) > Date.parse(occurredTo)) {
      throw invalidParam('occurredFrom 不能晚于 occurredTo。', 'occurredFrom');
    }

    const limit = query.limit === undefined ? 30 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw invalidParam('limit 必须是 1 到 100 之间的整数。', 'limit');
    }

    const result = await context.activityReadService.listActivity({
      kinds: kinds.length ? kinds : null,
      taskId: query.taskId ?? null,
      q: query.q ?? '',
      occurredFrom,
      occurredTo,
      cursor: query.cursor ?? null,
      limit
    });
    reply(200, result);
  }, { querySchema: activityQuerySchema });
}
