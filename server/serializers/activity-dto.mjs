import { buildContactResolver, initialsOf } from './task-dto.mjs';

/**
 * Merged read model over runtime/logs/events.jsonl + messages.jsonl. Only
 * safe fields are exposed: raw CLI output, w3account, command arguments,
 * agent marker hashes and local paths never reach the DTO (docs §7.5, §11.2).
 *
 * Ordering is stable via (occurredAt, sequence); sequence is the monotonic
 * runtime counter, never the random event id.
 */

const AGENT_FOOTER_MARK = '—— 此条消息来自';

function stripFooter(content) {
  const text = String(content ?? '');
  const index = text.indexOf(AGENT_FOOTER_MARK);
  return index === -1 ? text : text.slice(0, index).trim();
}

function excerpt(text, maxLength = 120) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
}

const STATUS_LABELS = {
  queued: '待执行',
  running: '执行中',
  waiting_owner: '等待确认',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已停止',
  failed: '异常',
  reopened: '已重新打开'
};

const ACTION_RESULTS = {
  succeeded: '发送成功',
  dry_run: '已生成发送预览（dry-run，未真实发送）',
  failed: '发送失败',
  unknown: '发送结果待核实'
};

function eventToActivity(event, context) {
  const resolver = buildContactResolver(context.contactsConfig);
  const base = {
    id: event.event_id,
    occurredAt: event.timestamp,
    sequence: event.sequence ?? 0,
    taskId: event.task_id ?? null,
    subtaskId: event.subtask_id ?? null,
    conversationId: event.conversation_id ?? null
  };
  switch (event.type) {
    case 'task_created':
      return { ...base, kind: 'task', title: '任务已创建', detail: excerpt(event.original_request) };
    case 'task_created_from_console':
      return { ...base, kind: 'task', title: '任务已创建，等待 Agent 处理', detail: excerpt(event.original_request) };
    case 'task_updated':
      return { ...base, kind: 'status', title: `任务状态更新为「${STATUS_LABELS[event.status] ?? event.status ?? '未知'}」` };
    case 'task_paused':
      return { ...base, kind: 'status', title: '任务已暂停，当前进度已保留' };
    case 'task_cancelled':
      return { ...base, kind: 'status', title: '任务已停止' };
    case 'task_completed':
      return { ...base, kind: 'status', title: '任务已完成' };
    case 'task_instruction_added':
      return { ...base, kind: 'task', title: '收到你的追加指令', detail: 'Agent 会在下一轮处理' };
    case 'subtask_created':
      return { ...base, kind: 'task', title: `新增子任务`, detail: subtaskTitle(context, event.subtask_id) };
    case 'subtask_updated':
      return { ...base, kind: 'status', title: `子任务状态更新`, detail: subtaskTitle(context, event.subtask_id) };
    case 'approval_created':
      return { ...base, kind: 'approval', title: '新增待确认事项', detail: approvalQuestion(context, event.approval_id) };
    case 'approval_resolved':
      return { ...base, kind: 'approval', title: '审批已处理', detail: event.decision ? `决定：${event.decision}` : null };
    case 'action_finished': {
      const label = ACTION_RESULTS[event.status] ?? '外部动作已更新';
      const target = event.target_id ? resolver.name(event.target_id) : null;
      return {
        ...base,
        kind: 'message',
        title: target ? `已向 ${target} 发送消息` : '外部动作已执行',
        detail: event.status === 'succeeded' ? '等待对方回复' : label
      };
    }
    case 'action_marked_unknown':
      return { ...base, kind: 'message', title: '发送结果待核实', detail: '需要先查询会话历史确认是否已发出' };
    case 'contact_slot_wait':
      return { ...base, kind: 'status', title: '进入联系人沟通队列', detail: event.position ? `当前排在第 ${event.position} 位` : null };
    case 'contact_slot_released':
      return { ...base, kind: 'status', title: '联系人沟通已结束，队列向前推进' };
    case 'contact_slot_acquired':
      return { ...base, kind: 'status', title: '获得联系人沟通槽位，准备开始沟通' };
    case 'message_attributed':
      return { ...base, kind: 'message', title: '收到回复并关联到任务' };
    case 'message_unattributed':
      return { ...base, kind: 'message', title: '收到一条未归属消息', detail: '等待 Agent 或人工判断归属' };
    default:
      return null;
  }
}

function subtaskTitle(context, subtaskId) {
  const task = context.task;
  const subtask = task?.subtasks?.find((entry) => entry.subtask_id === subtaskId);
  return subtask?.title ?? null;
}

function approvalQuestion(context, approvalId) {
  const approval = (context.approvals ?? []).find((entry) => entry.approval_id === approvalId);
  return approval ? excerpt(approval.question) : null;
}

function messageToActivity(entry, context) {
  const resolver = buildContactResolver(context.contactsConfig);
  const base = {
    id: entry.log_id,
    occurredAt: entry.timestamp,
    sequence: entry.sequence ?? 0,
    taskId: entry.task_id ?? null,
    subtaskId: entry.subtask_id ?? null,
    conversationId: entry.conversation_id ?? null
  };
  const name = entry.participant_type === 'group'
    ? context.groupsConfig?.[entry.participant_id]?.name ?? `群 ${entry.participant_id}`
    : resolver.name(entry.participant_id);
  if (entry.direction === 'outbound') {
    if (entry.status === 'failed' || entry.status === 'unknown') {
      return { ...base, kind: 'message', title: `向 ${name} 发送${entry.status === 'unknown' ? '结果待核实' : '失败'}` };
    }
    return { ...base, kind: 'message', title: `已向 ${name} 发送消息`, detail: excerpt(stripFooter(entry.content)) };
  }
  return { ...base, kind: 'message', title: `${name} 回复了消息`, detail: excerpt(stripFooter(entry.content)) };
}

/**
 * Merge both logs into one stable feed. When `task` is provided the feed is
 * filtered to that task; otherwise it is the global recent activity.
 * `limit: null` returns the whole merged feed so callers that paginate
 * themselves (activity-read-service) are not pre-truncated.
 */
export function buildActivity({ events, messages, task = null, approvals = [], contactsConfig = null, groupsConfig = null, limit = 50 }) {
  const context = { task, approvals, contactsConfig, groupsConfig };
  const items = [];
  for (const event of events) {
    const activity = eventToActivity(event, context);
    if (activity) items.push(activity);
  }
  for (const entry of messages) {
    const activity = messageToActivity(entry, context);
    if (activity) items.push(activity);
  }
  const filtered = task ? items.filter((item) => item.taskId === task.task_id) : items;
  filtered.sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence
  );
  return limit == null ? filtered : filtered.slice(-limit);
}

export { initialsOf };
