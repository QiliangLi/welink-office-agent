/**
 * Runtime status is execution fact; display status is the explanation users
 * see (docs/frontend-backend-integration.md §6). These pure helpers are used
 * by the Console API serializers; the frontend must never re-derive them.
 */

export const ROOT_STATUS_MAP = {
  queued: 'queued',
  waiting_owner: 'waiting_approval',
  paused: 'paused',
  completed: 'completed',
  cancelled: 'stopped',
  failed: 'failed'
};

const TERMINAL_SUBTASK_STATUSES = ['completed', 'cancelled', 'failed'];

export function waitingKindOf(subtask) {
  switch (subtask.status) {
    case 'waiting_reply':
      return 'reply';
    case 'waiting_followup':
      return 'followup_window';
    case 'waiting_contact_slot':
      return 'contact_slot';
    case 'waiting_owner':
      return 'owner';
    default:
      return subtask.waiting_kind ?? null;
  }
}

function requiredSubtasks(task) {
  return (task.subtasks ?? []).filter((subtask) => subtask.required !== false);
}

function isExecutable(subtask) {
  return !TERMINAL_SUBTASK_STATUSES.includes(subtask.status) && waitingKindOf(subtask) === null;
}

export function deriveProgress(task) {
  const required = requiredSubtasks(task);
  const completed = required.filter((subtask) => subtask.status === 'completed').length;
  if (required.length === 0) {
    return { progress: task.status === 'completed' ? 100 : 0, completedSubtasks: 0, totalSubtasks: 0 };
  }
  return {
    progress: Math.round((completed / required.length) * 100),
    completedSubtasks: completed,
    totalSubtasks: required.length
  };
}

function queueInfoOf(subtask) {
  return {
    waitingKind: 'contact_slot',
    queueEnteredAt: subtask.queue_entered_at ?? null,
    blockedByTaskId: subtask.blocked_by_task_id ?? null,
    blockedBySubtaskId: subtask.blocked_by_subtask_id ?? null,
    queuePosition: subtask.queue_position ?? null
  };
}

function earliestWaiting(list) {
  return [...list].sort((left, right) =>
    (left.queue_entered_at ?? left.updated_at ?? '').localeCompare(right.queue_entered_at ?? right.updated_at ?? '')
  )[0];
}

function executableTitle(task) {
  const subtask = requiredSubtasks(task).find((entry) => isExecutable(entry));
  return subtask ? subtask.title : null;
}

function contactLabel(employeeNumber, contactNames) {
  if (!employeeNumber) return null;
  return contactNames?.[employeeNumber] ?? employeeNumber;
}

function fallbackAction(displayStatus) {
  switch (displayStatus) {
    case 'queued':
      return '待执行，等待可用执行条件';
    case 'running':
      return 'Agent 正在推进任务';
    case 'waiting_approval':
      return '等待你的确认';
    case 'waiting_external':
      return '等待联系人回复';
    case 'paused':
      return '任务已暂停';
    case 'partial':
      return '存在需要处理的阻塞';
    case 'stopped':
      return '任务已停止';
    case 'failed':
      return '任务出现异常';
    case 'completed':
      return '任务已完成';
    default:
      return '等待 Agent 更新';
  }
}

/**
 * Derive the page view of one task.
 *
 * context:
 *   approvals        all approval snapshots (pending ones are matched by task)
 *   actions          all action snapshots (executing/unknown are matched by task)
 *   contactNames     { employeeNumber: displayName } for waiting reasons
 *   queuePositions   { `${taskId}:${subtaskId}`: position } from slot service
 */
export function deriveTaskView(task, context = {}) {
  const approvals = context.approvals ?? [];
  const actions = context.actions ?? [];
  const contactNames = context.contactNames ?? {};
  const queuePositions = context.queuePositions ?? {};

  const required = requiredSubtasks(task);
  const completedRequired = required.filter((subtask) => subtask.status === 'completed').length;
  const incompleteRequired = required.filter((subtask) => !TERMINAL_SUBTASK_STATUSES.includes(subtask.status));
  const failedRequired = required.filter((subtask) => TERMINAL_SUBTASK_STATUSES.includes(subtask.status) && subtask.status !== 'completed');
  const pendingApprovals = approvals.filter((approval) => approval.task_id === task.task_id && approval.status === 'pending');
  const uncertainActions = actions.filter((action) => action.task_id === task.task_id && ['executing', 'unknown'].includes(action.status));

  const progress = deriveProgress(task);
  const view = {
    sourceStatus: task.status,
    displayStatus: ROOT_STATUS_MAP[task.status] ?? null,
    waitingKind: null,
    waitingReason: null,
    queuePosition: null,
    blockedByTaskId: null,
    blockedBySubtaskId: null,
    queueEnteredAt: null,
    currentAction: null,
    ...progress
  };

  if (view.displayStatus && task.status !== 'reopened' && task.status !== 'running') {
    view.currentAction = task.final_summary ?? fallbackAction(view.displayStatus);
    if (task.status === 'queued' && required.length === 0) {
      view.currentAction = '等待 Agent 拆解任务';
    }
    return view;
  }

  // running / reopened: follow the documented derivation priority.
  if (pendingApprovals.length > 0) {
    view.displayStatus = 'waiting_approval';
    view.waitingKind = 'owner';
    view.currentAction = pendingApprovals[0].question;
    view.waitingReason = `等待确认：${pendingApprovals[0].question}`;
    return view;
  }

  if (uncertainActions.length > 0) {
    view.displayStatus = 'partial';
    view.waitingKind = 'recovery';
    view.currentAction = '发送结果待核实';
    view.waitingReason = '存在发送结果待核实的外部动作，请先核实后再继续';
    return view;
  }

  if (incompleteRequired.length > 0 && incompleteRequired.every((subtask) => waitingKindOf(subtask) === 'contact_slot')) {
    view.displayStatus = 'queued';
    const earliest = earliestWaiting(incompleteRequired);
    Object.assign(view, queueInfoOf(earliest));
    view.queuePosition = queuePositions[`${task.task_id}:${earliest.subtask_id}`] ?? null;
    view.currentAction = '等待联系人沟通槽位释放';
    view.waitingReason = earliest.waiting_reason ?? '等待与联系人的上一项沟通完成';
    return view;
  }

  if (incompleteRequired.some((subtask) => isExecutable(subtask))) {
    view.displayStatus = 'running';
    view.currentAction = executableTitle(task) ?? fallbackAction('running');
    return view;
  }

  const externalKinds = ['reply', 'followup_window'];
  if (incompleteRequired.length > 0 && incompleteRequired.every((subtask) => externalKinds.includes(waitingKindOf(subtask) ?? ''))) {
    view.displayStatus = 'waiting_external';
    const earliest = earliestWaiting(incompleteRequired);
    view.waitingKind = waitingKindOf(earliest);
    const name = contactLabel(earliest.target_employee_number, contactNames);
    view.currentAction = name ? `等待 ${name} 回复「${earliest.title}」` : `等待回复：${earliest.title}`;
    view.waitingReason = name
      ? `等待 ${name} 回复，等待内容：${earliest.title}`
      : `等待联系人回复，等待内容：${earliest.title}`;
    return view;
  }

  if (completedRequired > 0 && failedRequired.length > 0) {
    view.displayStatus = 'partial';
    view.waitingKind = 'recovery';
    view.currentAction = '部分工作未能完成';
    view.waitingReason = '存在未完成的必要子任务，需要处理后才能继续';
    return view;
  }

  view.displayStatus = 'running';
  view.currentAction = fallbackAction('running');
  return view;
}
