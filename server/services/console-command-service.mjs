import { TaskService } from '../../scripts/lib/task-service.mjs';
import { ApprovalService } from '../../scripts/lib/approval-service.mjs';
import { conflictError, notFoundError } from '../middleware/error-handler.mjs';

/**
 * Console-side writes. Routes never touch files and never spawn CLI
 * processes: deterministic changes happen immediately under lock and
 * revision checks, and everything needing Agent reasoning or WeLink sends
 * becomes a persisted command consumed by tick (docs §3.1, §7.6, §7.7).
 */
export class ConsoleCommandService {
  constructor(store, commandService) {
    this.store = store;
    this.commands = commandService;
    this.taskService = new TaskService(store, commandService);
    this.approvalService = new ApprovalService(store, commandService);
  }

  async createTaskFromConsole(input, { idempotencyKey, requestedBy }) {
    // Replay/conflict handling lives in the unified IdempotencyService; by
    // the time we get here the key is fresh. Still pass the key into the
    // command for traceability.
    // Deadline arrives timezone-aware from the client and is stored as full ISO.
    const task = await this.taskService.createTask({
      request: input.description,
      source: 'web_console',
      status: 'queued',
      createdBy: requestedBy,
      priority: input.priority ?? 'normal',
      deadlineAt: input.deadline ?? null,
      externalPolicy: input.externalPolicy ?? 'balanced',
      executionMode: input.executionMode ?? 'automatic',
      attachmentIds: input.attachmentIds ?? []
    });
    const { command } = await this.commands.create({
      type: 'task.create',
      aggregateType: 'task',
      aggregateId: task.task_id,
      payload: { description: input.description, priority: task.priority, source: 'web_console' },
      idempotencyKey,
      requestedBy
    });
    // Return the post-mutation snapshot so the response revision matches disk.
    const updatedTask = await this.store.mutateTask(task.task_id, undefined, (current) => {
      current.queued_command_id = command.command_id;
    });
    return { task: updatedTask, command };
  }

  async applyTaskCommand(taskId, { type, expectedRevision, text }) {
    const task = await this.store.loadTask(taskId).catch(() => null);
    if (!task) throw notFoundError('TASK_NOT_FOUND', '任务不存在或已被删除。');

    if (type === 'pause') {
      const record = await this.taskService.pause(taskId, expectedRevision);
      return { immediate: true, task: record };
    }
    if (type === 'cancel') {
      const { task: record } = await this.taskService.cancel(taskId, expectedRevision);
      return { immediate: true, task: record };
    }
    if (type === 'resume') {
      const { task: record, commandId } = await this.taskService.resume(taskId, expectedRevision);
      return { immediate: false, task: record, commandId };
    }
    if (type === 'instruction') {
      if (!text) throw conflictError('VALIDATION_ERROR', '追加指令需要填写内容。');
      const { task: record, commandId } = await this.taskService.addInstruction(taskId, text, expectedRevision);
      return { immediate: false, task: record, commandId };
    }
    if (type === 'retry') {
      if (!['failed', 'partial'].includes(task.status)) {
        throw conflictError('INVALID_STATE_TRANSITION', '只有失败的任务可以重试。');
      }
      const { command } = await this.commands.create({
        type: 'task.retry',
        aggregateType: 'task',
        aggregateId: taskId,
        parentTaskId: taskId,
        payload: {},
        requestedBy: task.created_by_employee_number
      });
      return { immediate: false, task, commandId: command.command_id };
    }
    throw conflictError('INVALID_STATE_TRANSITION', `不支持的任务命令：${type}`);
  }

  /**
   * Reminder policy is enforced server-side: contact, subtask state, next
   * reminder time, max reminders and uncertain actions (docs §7.8).
   */
  async requestReminder(taskId, subtaskId, { requestedBy } = {}) {
    const task = await this.store.loadTask(taskId).catch(() => null);
    if (!task) throw notFoundError('TASK_NOT_FOUND', '任务不存在或已被删除。');
    const subtask = (task.subtasks ?? []).find((entry) => entry.subtask_id === subtaskId);
    if (!subtask) throw notFoundError('TASK_NOT_FOUND', '子任务不存在。');
    if (task.status === 'paused' || task.status === 'cancelled') {
      throw conflictError('INVALID_STATE_TRANSITION', '任务已暂停或停止，不能催办。');
    }
    if (subtask.status !== 'waiting_reply') {
      throw conflictError('INVALID_STATE_TRANSITION', '该子任务当前不在等待回复状态。');
    }
    if (!subtask.target_employee_number) {
      throw conflictError('INVALID_STATE_TRANSITION', '该子任务没有可提醒的联系人。');
    }
    const policies = await this.store.loadConfig('policies').catch(() => ({}));
    const maxReminders = policies.follow_up?.max_reminders ?? 2;
    if ((subtask.communication?.reminder_count ?? 0) >= maxReminders) {
      throw conflictError('REMINDER_LIMIT_REACHED', '已达到该子任务的催办上限。');
    }
    const nextReminderAt = subtask.communication?.next_reminder_at ?? null;
    if (nextReminderAt && Date.parse(nextReminderAt) > Date.now()) {
      throw conflictError('REMINDER_NOT_DUE', '还没到催办时间。', { nextReminderAt });
    }
    const actions = await this.store.listActions();
    const uncertain = actions.some(
      (action) => action.task_id === taskId && ['executing', 'unknown'].includes(action.status)
    );
    if (uncertain) {
      throw conflictError('INVALID_STATE_TRANSITION', '存在待核实的外部发送，请先核实结果再催办。');
    }

    const { command } = await this.commands.create({
      type: 'subtask.remind',
      aggregateType: 'task',
      aggregateId: taskId,
      parentTaskId: taskId,
      payload: { task_id: taskId, subtask_id: subtaskId },
      requestedBy: requestedBy ?? task.created_by_employee_number
    });
    return { commandId: command.command_id };
  }

  async decideApproval(approvalId, { decision, expectedRevision, optionId, answer, editedContent }) {
    const result = await this.approvalService.recordDecision({
      approvalId,
      decision,
      expectedRevision,
      payload: { optionId, answer, editedContent }
    });
    return result;
  }

  /** Bulk limited to mark_for_edit; never bulk-approves external actions. */
  async bulkMarkForEdit(approvalIds) {
    const changed = [];
    for (const approvalId of approvalIds) {
      const approval = await this.store.loadApproval(approvalId).catch(() => null);
      if (!approval) continue;
      if (approval.status !== 'pending') continue;
      await this.store.mutateGroup(
        [
          { kind: 'approval', id: approvalId, expectedRevision: approval.revision },
          { kind: 'task', id: approval.task_id }
        ],
        {
          approval: (current) => {
            current.status = 'modified';
            current.decision_payload = { decision: 'mark_for_edit' };
            current.resolved_at = new Date().toISOString();
          },
          task: (task) => {
            task.pending_approval_ids = (task.pending_approval_ids ?? []).filter((id) => id !== approvalId);
            if (task.pending_approval_ids.length === 0 && task.status === 'waiting_owner') task.status = 'running';
          }
        }
      );
      await this.store.logEvent('approval_resolved', { task_id: approval.task_id, approval_id: approvalId, resolution: 'modified', decision: 'mark_for_edit' });
      changed.push(approvalId);
    }
    return { changed };
  }
}
