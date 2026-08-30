import { serializeApproval } from '../serializers/approval-dto.mjs';

/**
 * Read model for approvals. Default view is pending only; the decisions and
 * the external execution result stay separate fields.
 */
export class ApprovalReadService {
  constructor(store) {
    this.store = store;
  }

  async listApprovals({ taskId = null, statuses = ['pending'], limit = 50, cursor = null } = {}) {
    const { loadReadContext } = await import('./read-context.mjs');
    const context = await loadReadContext(this.store);
    let approvals = context.approvals;
    if (taskId) approvals = approvals.filter((approval) => approval.task_id === taskId);
    if (statuses && statuses.length > 0) approvals = approvals.filter((approval) => statuses.includes(approval.status));
    approvals.sort((left, right) =>
      String(left.created_at ?? '').localeCompare(String(right.created_at ?? '')) ||
      left.approval_id.localeCompare(right.approval_id)
    );

    const offset = decodeApprovalCursor(cursor);
    const page = approvals.slice(offset, offset + limit).map((approval) => serializeApproval(approval, context));
    const nextOffset = offset + page.length;
    return {
      items: page,
      nextCursor: nextOffset < approvals.length ? encodeApprovalCursor(nextOffset) : null,
      total: approvals.length,
      snapshotAt: new Date().toISOString()
    };
  }

  async getApproval(approvalId) {
    const { loadReadContext } = await import('./read-context.mjs');
    const context = await loadReadContext(this.store);
    const approval = context.approvals.find((entry) => entry.approval_id === approvalId);
    if (!approval) {
      const error = new Error('审批不存在。');
      error.code = 'APPROVAL_NOT_FOUND';
      throw error;
    }
    return serializeApproval(approval, context);
  }
}

export function encodeApprovalCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeApprovalCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(parsed?.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
}
