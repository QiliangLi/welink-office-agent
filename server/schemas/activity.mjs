/**
 * Query contract for the cross-task activity feed
 * (docs/sidebar-pages-design.md §5.4). Repeatable params (kind) and value
 * range checks are enforced in the route so repeated values get one
 * consistent 422 instead of a per-item error.
 */

export const ACTIVITY_KINDS = ['task', 'status', 'message', 'approval', 'file'];

// URL query params always arrive as strings; parse+range-check in the route.
export const activityQuerySchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', maxLength: 32 },
    taskId: { type: 'string', maxLength: 64 },
    q: { type: 'string', maxLength: 200 },
    occurredFrom: { type: 'string', maxLength: 64 },
    occurredTo: { type: 'string', maxLength: 64 },
    cursor: { type: 'string', maxLength: 512 },
    limit: { type: 'string', maxLength: 4 }
  }
};
