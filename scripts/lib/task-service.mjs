import { makeId } from './ids.mjs';
import { releaseTaskConversations } from './contact-slots.mjs';
import { nowIso } from './utils.mjs';

/**
 * Deterministic task operations shared by the CLI and the Console API.
 * Console writes arrive with expectedRevision and are executed through
 * store.mutate* so a concurrent Skill/CLI edit can never be overwritten.
 * Agent-state changes always go through store.mutateState.
 */

export const TASK_STATUSES = ['queued', 'running', 'waiting_owner', 'paused', 'completed', 'cancelled', 'failed', 'reopened'];
export const PRIORITIES = ['low', 'normal', 'high'];
export const EXTERNAL_POLICIES = ['conservative', 'balanced', 'active'];
export const EXECUTION_MODES = ['automatic', 'confirm'];

export class TaskService {
  constructor(store, commandService) {
    this.store = store;
    this.commands = commandService;
  }

  async createTask(input) {
    const taskId = makeId('TASK');
    const now = nowIso();
    const task = {
      schema_version: 1,
      revision: 1,
      task_id: taskId,
      title: input.title || String(input.request).replace(/\s+/g, ' ').trim().slice(0, 50) || '新任务',
      original_request: input.request,
      description: input.description ?? null,
      status: input.status ?? 'running',
      created_by_employee_number: input.createdBy ?? null,
      source: input.source ?? 'skill',
      category: input.category ?? null,
      priority: input.priority ?? 'normal',
      deadline_at: input.deadlineAt ?? null,
      external_policy: input.externalPolicy ?? 'balanced',
      execution_mode: input.executionMode ?? 'automatic',
      attachment_ids: input.attachmentIds ?? [],
      queued_command_id: input.queuedCommandId ?? null,
      instructions: [],
      created_at: now,
      updated_at: now,
      completion_policy: {
        require_all_mandatory_subtasks: true,
        require_no_open_items: true,
        require_no_pending_approvals: true,
        require_no_unresolved_conflicts: true,
        require_no_waiting_replies: true,
        require_no_uncertain_actions: true
      },
      subtasks: [],
      open_item_ids: [],
      pending_approval_ids: [],
      conflicts: [],
      working_summary: {
        confirmed_facts: [],
        open_questions: [],
        active_subtasks: [],
        pending_approvals: [],
        next_actions: []
      },
      final_summary: null
    };
    await this.store.saveTask(task);
    await this.store.mutateState((state) => {
      state.active_task_ids = state.active_task_ids ?? [];
      if (!state.active_task_ids.includes(taskId)) state.active_task_ids.push(taskId);
    });
    await this.store.logEvent(input.source === 'web_console' ? 'task_created_from_console' : 'task_created', {
      task_id: taskId,
      original_request: input.request,
      source: task.source,
      priority: task.priority
    });
    return task;
  }

  /** Immediate deterministic status change used by pause/cancel/resume. */
  async changeStatus(taskId, status, expectedRevision = undefined) {
    const task = await this.store.mutateTask(taskId, expectedRevision, (current) => {
      current.status = status;
      if (status === 'cancelled') {
        current.cancelled_at = current.cancelled_at ?? nowIso();
      }
    });
    await this.store.logEvent('task_updated', { task_id: taskId, status });
    return task;
  }

  async pause(taskId, expectedRevision) {
    const task = await this.changeStatus(taskId, 'paused', expectedRevision);
    await this.store.logEvent('task_paused', { task_id: taskId });
    return task;
  }

  /** Cancel: deterministic status change plus cancelling unclaimed commands. */
  async cancel(taskId, expectedRevision) {
    const task = await this.changeStatus(taskId, 'cancelled', expectedRevision);
    const cancelledCommands = await this.commands.cancelQueuedForAggregate('task', taskId);
    await this.store.mutateState((state) => {
      state.active_task_ids = (state.active_task_ids ?? []).filter((id) => id !== taskId);
    });
    // A conversation opened while the task was running must not keep
    // blocking later tasks for the same contact (U-01/V-01 family).
    await releaseTaskConversations(this.store, taskId, { reason: 'task_cancelled' });
    await this.store.logEvent('task_cancelled', { task_id: taskId, cancelled_commands: cancelledCommands.length });
    return { task, cancelledCommands };
  }

  async resume(taskId, expectedRevision) {
    const task = await this.changeStatus(taskId, 'running', expectedRevision);
    const { command } = await this.commands.create({
      type: 'task.resume',
      aggregateType: 'task',
      aggregateId: taskId,
      parentTaskId: taskId,
      requestedBy: task.created_by_employee_number
    });
    return { task, commandId: command.command_id };
  }

  async addInstruction(taskId, text, expectedRevision = undefined) {
    const task = await this.store.mutateTask(taskId, expectedRevision, (current) => {
      current.instructions = current.instructions ?? [];
      current.instructions.push({ text, created_at: nowIso(), applied: false });
    });
    const { command } = await this.commands.create({
      type: 'task.instruction',
      aggregateType: 'task',
      aggregateId: taskId,
      parentTaskId: taskId,
      payload: { text },
      requestedBy: task.created_by_employee_number
    });
    await this.store.logEvent('task_instruction_added', { task_id: taskId, command_id: command.command_id });
    return { task, commandId: command.command_id };
  }

  createSubtask(task, input) {
    const sequence = (task.subtasks ?? []).length + 1;
    const subtask = {
      subtask_id: makeId('SUB'),
      parent_subtask_id: input.parentSubtaskId ?? null,
      sequence,
      revision: 1,
      title: input.title,
      topic: input.topic ?? null,
      target_employee_number: input.target_employee_number ?? null,
      target_group_id: input.target_group_id ?? null,
      required: input.required ?? true,
      status: input.status ?? 'ready_to_contact',
      required_information: input.required_information ?? [],
      collected_information: input.collected_information ?? {},
      missing_information: input.required_information ?? [],
      summary: null,
      waiting_kind: null,
      waiting_reason: null,
      estimated_completion_at: input.estimated_completion_at ?? null,
      contact_key: input.target_employee_number ? `employee:${input.target_employee_number}` : (input.target_group_id ? `group:${input.target_group_id}` : null),
      conversation_id: null,
      blocked_by_task_id: null,
      blocked_by_subtask_id: null,
      queue_entered_at: null,
      created_dynamically: input.created_dynamically ?? false,
      created_from_item_id: input.created_from_item_id ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      communication: {
        round: 0,
        first_contact_at: null,
        last_contact_at: null,
        last_reply_at: null,
        reminder_count: 0,
        next_reminder_at: null
      },
      next_action: null
    };
    task.subtasks = task.subtasks ?? [];
    task.subtasks.push(subtask);
    return subtask;
  }

  async addSubtask(taskId, input, expectedRevision = undefined) {
    let subtaskId = null;
    const task = await this.store.mutateTask(taskId, expectedRevision, (current) => {
      const subtask = this.createSubtask(current, input);
      subtaskId = subtask.subtask_id;
    });
    const subtask = task.subtasks.find((entry) => entry.subtask_id === subtaskId);
    if (!subtask) throw new Error(`Subtask not found after creation: ${subtaskId}`);
    await this.store.logEvent('subtask_created', {
      task_id: taskId,
      subtask_id: subtask.subtask_id,
      dynamic: subtask.created_dynamically,
      target_employee_number: subtask.target_employee_number
    });
    return subtask;
  }

  async updateSubtask(taskId, subtaskId, patch, expectedRevision = undefined) {
    const task = await this.store.mutateTask(taskId, expectedRevision, (current) => {
      const subtask = current.subtasks.find((entry) => entry.subtask_id === subtaskId);
      if (!subtask) throw new Error(`Subtask not found: ${subtaskId}`);
      if (patch.status !== undefined) subtask.status = patch.status;
      if (patch.summary !== undefined) subtask.summary = patch.summary;
      if (patch.missing_information !== undefined) subtask.missing_information = patch.missing_information;
      if (patch.collected_information !== undefined) {
        subtask.collected_information = { ...subtask.collected_information, ...patch.collected_information };
      }
      if (patch.estimated_completion_at !== undefined) subtask.estimated_completion_at = patch.estimated_completion_at;
      if (patch.next_action !== undefined) subtask.next_action = patch.next_action;
      if (patch.reply_received) subtask.communication.last_reply_at = nowIso();
      subtask.updated_at = nowIso();
    });
    const subtask = task.subtasks.find((entry) => entry.subtask_id === subtaskId);
    await this.store.logEvent('subtask_updated', { task_id: taskId, subtask_id: subtaskId, status: subtask.status });
    return subtask;
  }

  /**
   * Unified completion check: every completion_policy declaration must be
   * enforced, including waiting replies and uncertain actions (docs §阶段三.6).
   */
  completionBlockers(task, { actions = [] } = {}) {
    const policy = task.completion_policy ?? {};
    const blockers = {};
    if (policy.require_all_mandatory_subtasks !== false) {
      blockers.mandatory_subtasks = (task.subtasks ?? [])
        .filter((subtask) => subtask.required !== false && subtask.status !== 'completed')
        .map((subtask) => subtask.subtask_id);
    }
    if (policy.require_no_open_items !== false) blockers.open_items = [...(task.open_item_ids ?? [])];
    if (policy.require_no_pending_approvals !== false) blockers.pending_approvals = [...(task.pending_approval_ids ?? [])];
    if (policy.require_no_unresolved_conflicts !== false) {
      blockers.conflicts = (task.conflicts ?? []).filter((conflict) => conflict.status !== 'resolved');
    }
    if (policy.require_no_waiting_replies !== false) {
      blockers.waiting_replies = (task.subtasks ?? [])
        .filter((subtask) => subtask.status === 'waiting_reply')
        .map((subtask) => subtask.subtask_id);
    }
    if (policy.require_no_uncertain_actions !== false) {
      blockers.uncertain_actions = actions
        .filter((action) => action.task_id === task.task_id && ['executing', 'unknown'].includes(action.status))
        .map((action) => action.action_id);
    }
    return blockers;
  }

  async completeTask(taskId, { summary, force = false, expectedRevision = undefined } = {}) {
    // Blockers are re-evaluated INSIDE the task lock against the freshest
    // snapshot, and the actions listing is re-read within the same window:
    // work that lands concurrently (pending approval, instruction, send in
    // flight) reliably blocks completion no matter which write wins the lock.
    let rejection = null;
    const completed = await this.store.mutateTask(taskId, expectedRevision, async (current) => {
      const freshActions = await this.store.listActions();
      const blocking = this.completionBlockers(current, { actions: freshActions });
      const hasBlocking = Object.values(blocking).some((entries) => (Array.isArray(entries) ? entries.length > 0 : entries));
      if (hasBlocking && !force) {
        rejection = { ok: false, reason: 'Task still has blocking work.', blocking };
        return;
      }
      current.status = 'completed';
      current.final_summary = summary ?? current.final_summary;
      current.completed_at = nowIso();
    });
    if (rejection) return rejection;
    await this.store.mutateState((state) => {
      state.active_task_ids = (state.active_task_ids ?? []).filter((id) => id !== taskId);
    });
    // A conversation opened while the task was running must not keep
    // blocking later tasks for the same contact (U-01/V-01 family).
    await releaseTaskConversations(this.store, taskId, { reason: 'task_completed' });
    await this.store.logEvent('task_completed', { task_id: taskId });
    return { ok: true, task: completed };
  }
}
