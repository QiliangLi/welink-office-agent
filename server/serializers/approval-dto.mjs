import { buildContactResolver } from './task-dto.mjs';

/**
 * Approval shell + payload per proposed_action kind (docs §5.3, §6.5).
 * decisionStatus (what the user chose) and executionStatus (what actually
 * happened outside) are reported separately on purpose.
 */

const EXECUTION_BY_ACTION = {
  executing: 'executing',
  succeeded: 'succeeded',
  dry_run: 'succeeded',
  failed: 'failed',
  unknown: 'unknown'
};

function excerpt(text, maxLength = 80) {
  const line = String(text ?? '').split('\n').filter((part => part.trim()))[0] ?? '';
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

function stripAgentFooter(content) {
  return String(content ?? '').split('\n\n——')[0];
}

function messageAudience(proposedAction, contactsConfig, groupsConfig) {
  if (proposedAction.audience_text) return proposedAction.audience_text;
  if (proposedAction.target_type === 'group') {
    const group = groupsConfig?.[proposedAction.target_id];
    return group?.name ?? `群 ${proposedAction.target_id}`;
  }
  const resolver = buildContactResolver(contactsConfig);
  return resolver.name(proposedAction.target_id);
}

function payloadFor(proposedAction, approval, context) {
  const { contactsConfig, groupsConfig } = context;
  if (!proposedAction) {
    // Legacy approvals only carry a question (and optional options).
    return {
      type: 'clarification',
      question: approval.question,
      placeholder: null,
      options: (approval.options ?? []).length
        ? approval.options.map((option, index) => ({ id: `option-${index + 1}`, label: option }))
        : []
    };
  }
  switch (proposedAction.type) {
    case 'send_message':
      return {
        type: 'message',
        target: proposedAction.display_target ?? messageAudience(proposedAction, contactsConfig, groupsConfig),
        targetType: proposedAction.target_type ?? null,
        audience: messageAudience(proposedAction, contactsConfig, groupsConfig),
        message: stripAgentFooter(proposedAction.content ?? '')
      };
    case 'schedule_meeting':
      return {
        type: 'schedule',
        options: (proposedAction.options ?? []).map((option) => ({
          id: option.option_id,
          label: option.label,
          attendance: option.attendance_text ?? '',
          tone: option.tone ?? 'good'
        }))
      };
    case 'clarification':
      return {
        type: 'clarification',
        question: proposedAction.question ?? approval.question,
        field: proposedAction.field ?? null,
        placeholder: proposedAction.placeholder ?? null
      };
    case 'scope_change':
      return {
        type: 'scope_change',
        itemId: proposedAction.item_id ?? approval.item_id,
        itemDescription: proposedAction.item_description ?? null,
        options: (proposedAction.options ?? []).map((option) => ({ value: option.value ?? option.option_id, label: option.label }))
      };
    default:
      return { type: 'clarification', question: approval.question, placeholder: null, options: [] };
  }
}

function shellMeta(proposedAction, approval) {
  const type = proposedAction?.type;
  if (type === 'send_message') {
    return {
      title: approval.question || `向「${proposedAction.display_target ?? '联系人'}」发送消息`,
      summary: excerpt(proposedAction.content),
      reason: approval.question && approval.question !== proposedAction.content ? approval.question : '该操作会向联系人或群组发出真实消息。',
      impact: '消息发出后无法撤回，群成员会立即看到。'
    };
  }
  if (type === 'schedule_meeting') {
    return {
      title: approval.question || '选择会议时间',
      summary: 'Agent 根据参会人情况整理了候选时段。',
      reason: '需要你确认一个时段，Agent 才会继续安排。',
      impact: '选定后将按所选时间发起邀请。'
    };
  }
  if (type === 'scope_change') {
    return {
      title: approval.question || '发现了超出当前范围的新事项',
      summary: excerpt(proposedAction.item_description),
      reason: '该事项可能扩展当前任务范围，需要你决定处理方式。',
      impact: '你的选择决定这个事项是否纳入当前任务或另开任务。'
    };
  }
  return {
    title: approval.question || 'Agent 需要你的补充信息',
    summary: excerpt(approval.question),
    reason: '缺少这个信息任务无法继续推进。',
    impact: '你的输入只会用于当前任务，不会直接发送外部消息。'
  };
}

export function serializeApproval(approval, context) {
  const proposedAction = approval.proposed_action;
  const payload = payloadFor(proposedAction, approval, context);
  const kind = payload.type;
  const meta = shellMeta(proposedAction, approval);

  const decisionStatus = {
    pending: 'pending',
    approved: 'approved',
    rejected: 'rejected',
    closed: 'rejected',
    returned: 'edited',
    modified: 'edited'
  }[approval.status] ?? 'pending';

  const relatedAction = (context.actions ?? [])
    .filter((action) => action.approval_id === approval.approval_id)
    .sort((left, right) => String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? '')))[0];
  const hasCommand = (context.commands ?? []).some(
    (command) => command.aggregate_type === 'approval' && command.aggregate_id === approval.approval_id
      && ['queued', 'claimed', 'waiting_agent'].includes(command.status)
  );

  let executionStatus = 'not_started';
  if (approval.status === 'pending') {
    executionStatus = 'not_started';
  } else if (approval.status === 'rejected' || approval.status === 'closed') {
    executionStatus = 'not_applicable';
  } else if (relatedAction) {
    executionStatus = EXECUTION_BY_ACTION[relatedAction.status] ?? 'not_started';
  } else if (hasCommand) {
    executionStatus = 'queued';
  } else if (approval.status === 'approved') {
    // No external action involved (e.g. an answered clarification applied
    // without a send): the decision itself is the completed outcome.
    executionStatus = proposedAction?.type === 'send_message' ? 'unknown' : 'succeeded';
  }

  return {
    id: approval.approval_id,
    revision: approval.revision ?? 1,
    taskId: approval.task_id,
    subtaskId: approval.subtask_id ?? null,
    kind,
    title: meta.title,
    summary: meta.summary,
    reason: meta.reason,
    impact: meta.impact,
    decisionStatus,
    executionStatus,
    decisionPayload: approval.decision_payload ?? null,
    payload,
    allowedDecisions: allowedDecisionsFor(payload),
    createdAt: approval.created_at,
    resolvedAt: approval.resolved_at ?? null
  };
}

export function allowedDecisionsFor(payload) {
  switch (payload.type) {
    case 'message':
      return ['approve', 'reject', 'edit'];
    case 'schedule':
    case 'scope_change':
      return ['select_option', 'reject'];
    case 'clarification':
    default:
      return ['submit_answer', 'reject'];
  }
}
