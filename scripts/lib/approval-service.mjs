import { makeId } from './ids.mjs';
import { nowIso } from './utils.mjs';

export const PROPOSED_ACTION_TYPES = ['send_message', 'schedule_meeting', 'clarification', 'scope_change'];
export const APPROVAL_DECISIONS = ['approve', 'reject', 'edit', 'select_option', 'submit_answer'];

/**
 * Approvals keep a stable shell plus a typed proposed_action union so the
 * console can render one card per kind (docs §5.3). A decision records what
 * the user actually chose in decision_payload — a bare status cannot be
 * replayed by the Agent — and schedules an approval.apply command that the
 * tick consumes to perform the follow-up work.
 *
 * Approval, task and related item are updated inside one mutateGroup lock
 * window so a concurrent Agent write to the same task can never be lost.
 */
export class ApprovalService {
  constructor(store, commandService) {
    this.store = store;
    this.commands = commandService;
  }

  validateProposedAction(proposedAction) {
    if (!proposedAction) return null;
    if (!PROPOSED_ACTION_TYPES.includes(proposedAction.type)) {
      throw new Error(`Unsupported proposed action type: ${proposedAction.type}`);
    }
    return proposedAction;
  }

  async createApproval({ taskId, subtaskId = null, itemId = null, question, options = [], proposedAction = null }) {
    const approvalId = makeId('AP');
    const approval = {
      schema_version: 1,
      revision: 1,
      approval_id: approvalId,
      task_id: taskId,
      subtask_id: subtaskId,
      item_id: itemId,
      status: 'pending',
      question,
      options,
      proposed_action: this.validateProposedAction(proposedAction),
      decision_payload: null,
      response: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      resolved_at: null
    };
    await this.store.saveApproval(approval);

    const targets = [{ kind: 'task', id: taskId }];
    if (itemId) targets.push({ kind: 'item', id: itemId });
    await this.store.mutateGroup(targets, {
      task: (task) => {
        task.pending_approval_ids = task.pending_approval_ids ?? [];
        if (!task.pending_approval_ids.includes(approvalId)) task.pending_approval_ids.push(approvalId);
        task.status = 'waiting_owner';
      },
      item: itemId ? (item) => {
        item.status = 'waiting_owner';
        item.approval_id = approvalId;
      } : undefined
    });

    await this.store.logEvent('approval_created', { task_id: taskId, approval_id: approvalId, item_id: itemId });
    return approval;
  }

  /**
   * Stage 1 of the two-phase decision flow: persist the exact decision, then
   * queue approval.apply. External sends return 202 and only count as done
   * when the related action succeeds (docs §7.9).
   */
  async recordDecision({ approvalId, decision, expectedRevision, payload = {} }) {
    if (!APPROVAL_DECISIONS.includes(decision)) {
      throw new Error(`Unsupported approval decision: ${decision}`);
    }

    // Read-only pre-read for routing; the mutation re-loads under locks.
    const current = await this.store.loadApproval(approvalId);
    if (current.status !== 'pending') {
      const error = new Error(`Approval is not pending: ${approvalId}`);
      error.code = 'INVALID_STATE_TRANSITION';
      throw error;
    }

    const targets = [
      { kind: 'approval', id: approvalId, expectedRevision },
      { kind: 'task', id: current.task_id }
    ];
    if (current.item_id) targets.push({ kind: 'item', id: current.item_id });
    const closeItem = decision === 'reject';
    const loaded = await this.store.mutateGroup(targets, {
      approval: (approval) => {
        switch (decision) {
          case 'approve':
          case 'select_option':
          case 'submit_answer':
            approval.status = 'approved';
            break;
          case 'reject':
            approval.status = 'rejected';
            break;
          case 'edit':
            approval.status = 'modified';
            break;
          default:
            break;
        }
        approval.decision_payload = {
          decision,
          option_id: payload.optionId ?? null,
          answer: payload.answer ?? null,
          edited_content: payload.editedContent ?? null
        };
        approval.resolved_at = nowIso();
        if (decision === 'submit_answer') approval.response = payload.answer ?? null;
      },
      task: (task) => {
        task.pending_approval_ids = (task.pending_approval_ids ?? []).filter((id) => id !== approvalId);
        if (task.pending_approval_ids.length === 0 && task.status === 'waiting_owner') task.status = 'running';
        if (closeItem && current.item_id) {
          task.open_item_ids = (task.open_item_ids ?? []).filter((id) => id !== current.item_id);
        }
      },
      item: current.item_id ? (item) => {
        if (closeItem) item.status = 'closed';
        else if (decision === 'edit') item.status = 'modified';
        else item.status = 'approved';
      } : undefined
    });

    const approval = loaded.get(`approval:${approvalId}`);

    let commandId = null;
    if (decision !== 'reject') {
      const { command } = await this.commands.create({
        type: 'approval.apply',
        aggregateType: 'approval',
        aggregateId: approvalId,
        payload: { approval_id: approvalId },
        requestedBy: null
      });
      commandId = command.command_id;
    }

    await this.store.logEvent('approval_resolved', {
      task_id: approval.task_id,
      approval_id: approvalId,
      resolution: approval.status,
      decision,
      command_id: commandId
    });
    return { approval, commandId };
  }
}
