import { deriveTaskView } from '../../scripts/lib/task-status.mjs';

/**
 * Task snapshots (snake_case) become page DTOs (camelCase) here and only
 * here. The frontend never sees task_id, pending_approval_ids or local file
 * paths, and it never re-derives display status (docs §4.1, §6).
 */

const CATEGORY_LABELS = {
  research: 'research',
  report: 'report',
  follow_up: 'follow_up',
  travel: 'travel',
  document: 'document'
};

export function buildContactResolver(contactsConfig) {
  const byNumber = new Map(Object.entries(contactsConfig ?? {}));
  return {
    name(employeeNumber) {
      return byNumber.get(employeeNumber)?.name ?? employeeNumber;
    },
    person(employeeNumber) {
      const contact = byNumber.get(employeeNumber);
      const name = contact?.name ?? employeeNumber;
      return {
        id: employeeNumber,
        name,
        department: contact?.department ?? '',
        initials: contact?.avatar_initials ?? initialsOf(name)
      };
    }
  };
}

export function initialsOf(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '?';
  const ascii = trimmed.replace(/[^A-Za-z0-9]/g, '');
  if (ascii.length >= 2) return (ascii[0] + ascii[1]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

export function serializeTask(task, context) {
  const { approvals = [], actions = [], contactsConfig, queuePositions = {} } = context;
  const contactNames = {};
  for (const [employeeNumber] of Object.entries(contactsConfig ?? {})) {
    contactNames[employeeNumber] = contactsConfig[employeeNumber]?.name ?? employeeNumber;
  }
  const view = deriveTaskView(task, { approvals, actions, contactNames, queuePositions });

  return {
    id: task.task_id,
    revision: task.revision ?? 1,
    title: task.title,
    description: task.description ?? task.original_request ?? '',
    sourceStatus: view.sourceStatus,
    displayStatus: view.displayStatus,
    category: CATEGORY_LABELS[task.category] ?? null,
    priority: task.priority ?? 'normal',
    currentAction: view.currentAction ?? null,
    waitingReason: view.waitingReason ?? null,
    waitingKind: view.waitingKind ?? null,
    queuePosition: view.queuePosition ?? null,
    blockedByTaskId: view.blockedByTaskId ?? null,
    blockedBySubtaskId: view.blockedBySubtaskId ?? null,
    queueEnteredAt: view.queueEnteredAt ?? null,
    progress: view.progress,
    completedSubtasks: view.completedSubtasks,
    totalSubtasks: view.totalSubtasks,
    deadlineAt: task.deadline_at ?? null,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    createdBy: task.created_by_employee_number
      ? buildContactResolver(contactsConfig).person(task.created_by_employee_number)
      : null
  };
}

const PLAN_STATUS_MAP = {
  pending: 'pending',
  ready_to_contact: 'pending',
  waiting_contact_slot: 'waiting',
  waiting_reply: 'waiting',
  waiting_followup: 'waiting',
  waiting_owner: 'waiting',
  reply_received: 'running',
  completed: 'completed',
  cancelled: 'skipped',
  failed: 'failed'
};

export function serializePlan(task, contactResolver) {
  return (task.subtasks ?? [])
    .filter((subtask) => subtask.required !== false)
    .map((subtask) => ({
      id: subtask.subtask_id,
      title: subtask.title,
      status: PLAN_STATUS_MAP[subtask.status] ?? 'pending',
      summary: subtask.summary ?? subtask.waiting_reason ?? null,
      owner: subtask.target_employee_number ? contactResolver.person(subtask.target_employee_number) : null,
      required: subtask.required !== false,
      sequence: subtask.sequence ?? null,
      waitingKind: subtask.waiting_kind ?? null,
      conversationId: subtask.conversation_id ?? null,
      startedAt: subtask.communication?.first_contact_at ?? null,
      completedAt: subtask.status === 'completed' ? subtask.updated_at : null,
      updatedAt: subtask.updated_at
    }));
}

/** Optional subtasks are shown separately and never affect progress. */
export function serializeOptionalSubtasks(task, contactResolver) {
  return (task.subtasks ?? [])
    .filter((subtask) => subtask.required === false)
    .map((subtask) => ({
      id: subtask.subtask_id,
      title: subtask.title,
      status: PLAN_STATUS_MAP[subtask.status] ?? 'pending',
      summary: subtask.summary ?? null,
      owner: subtask.target_employee_number ? contactResolver.person(subtask.target_employee_number) : null
    }));
}

const POLICY_LABELS = {
  conservative: '保守：所有外部发送都需要确认',
  balanced: '平衡：低风险自动执行，高风险需要确认',
  active: '积极：多数操作自动执行，关键节点确认'
};

export function serializeTaskDetail(task, context) {
  const dto = serializeTask(task, context);
  const contactResolver = buildContactResolver(context.contactsConfig);
  const contactNumbers = [...new Set((task.subtasks ?? []).map((s) => s.target_employee_number).filter(Boolean))];
  const pendingApprovals = (context.approvals ?? []).filter(
    (approval) => approval.task_id === task.task_id && approval.status === 'pending'
  );
  const uncertainActions = (context.actions ?? []).filter(
    (action) => action.task_id === task.task_id && ['executing', 'unknown'].includes(action.status)
  );

  return {
    ...dto,
    originalRequest: task.original_request ?? '',
    externalPolicy: task.external_policy ?? 'balanced',
    externalPolicyLabel: POLICY_LABELS[task.external_policy ?? 'balanced'] ?? POLICY_LABELS.balanced,
    executionMode: task.execution_mode ?? 'automatic',
    instructions: (task.instructions ?? []).map((entry) => ({ text: entry.text, createdAt: entry.created_at, applied: Boolean(entry.applied) })),
    workingSummary: {
      confirmedFacts: task.working_summary?.confirmed_facts ?? [],
      openQuestions: task.working_summary?.open_questions ?? [],
      nextActions: task.working_summary?.next_actions ?? []
    },
    finalSummary: task.final_summary ?? null,
    contacts: contactNumbers.map((employeeNumber) => contactResolver.person(employeeNumber)),
    plan: serializePlan(task, contactResolver),
    optionalSubtasks: serializeOptionalSubtasks(task, contactResolver),
    pendingApprovalIds: pendingApprovals.map((approval) => approval.approval_id),
    uncertainActionIds: uncertainActions.map((action) => action.action_id),
    allowedCommands: allowedCommandsFor(task, pendingApprovals, uncertainActions)
  };
}

/**
 * The server decides which actions exist; the page only renders them. A
 * completed task cannot pause, and uncertain send actions forbid retry
 * until the conversation history has been verified (docs §7.5).
 */
export function allowedCommandsFor(task, pendingApprovals = [], uncertainActions = []) {
  if (pendingApprovals.length > 0) return ['instruction'];
  const uncertain = uncertainActions.length > 0;
  switch (task.status) {
    case 'queued':
      return uncertain ? ['cancel', 'verify_actions'] : ['pause', 'cancel', 'instruction'];
    case 'running':
    case 'reopened':
      return uncertain ? ['pause', 'cancel', 'instruction', 'verify_actions'] : ['pause', 'cancel', 'instruction'];
    case 'waiting_owner':
      return ['cancel', 'instruction'];
    case 'paused':
      return uncertain ? ['resume', 'cancel', 'instruction', 'verify_actions'] : ['resume', 'cancel', 'instruction'];
    case 'failed':
      return uncertain ? ['cancel', 'verify_actions'] : ['pause', 'cancel', 'instruction', 'retry'];
    case 'partial':
      return uncertain ? ['pause', 'cancel', 'instruction', 'verify_actions'] : ['pause', 'cancel', 'instruction', 'retry'];
    case 'completed':
      return [];
    case 'cancelled':
      return [];
    default:
      return [];
  }
}
