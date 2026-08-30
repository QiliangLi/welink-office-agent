#!/usr/bin/env node
import path from 'node:path';
import { CommandService } from './lib/commands.mjs';
import { ApprovalService } from './lib/approval-service.mjs';
import { MessageService } from './lib/message-service.mjs';
import { SendService } from './lib/send-service.mjs';
import { Store } from './lib/store.mjs';
import { TaskService } from './lib/task-service.mjs';
import { makeId } from './lib/ids.mjs';
import {
  boolArg,
  jsonOutput,
  nowIso,
  parseArgs,
  projectRootFromScript,
  readJsonFile,
  requireArg,
  splitList
} from './lib/utils.mjs';
import { runWelink } from './lib/welink.mjs';
import { releaseContactSlot } from './lib/contact-slots.mjs';

const rootDir = projectRootFromScript(import.meta.url);
const store = new Store(rootDir);
const commands = new CommandService(store);
const taskService = new TaskService(store, commands);
const approvalService = new ApprovalService(store, commands);
const sendService = new SendService(store);
const messageService = new MessageService(store);
const [command = 'help', ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

function usage() {
  return {
    project_root: rootDir,
    commands: {
      init: '初始化 config/*.json 和 runtime 目录',
      preflight: '检查 welink-cli 认证状态',
      'create-task': '--request <任务描述> [--title <标题>] [--status queued|running] [--priority high|normal|low] [--deadline <ISO>] [--external-policy ...] [--execution-mode ...] [--created-by <工号>] [--source skill|web_console]',
      'add-subtask': '--task-id <ID> --title <标题> --target-employee-number <工号> [--required-info a,b] [--dynamic true]',
      'update-subtask': '--task-id <ID> --subtask-id <ID> [--status <状态>] [--summary <摘要>] [--collected-file <json>] [--missing-info a,b] [--next-action <类型>]',
      'add-item': '--task-id <ID> --description <事项> [--source-message-id <ID>] [--source-employee-number <工号>] [--relation required_dependency|scope_extension] [--workload light|large|unknown]',
      'classify-item': '--item-id <ID> --decision auto_subtask|owner_approval|ignore|independent [其他参数]',
      'create-approval': '--task-id <ID> --question <问题> [--item-id <ID>] [--options a,b,c] [--proposed-action-file <json>]',
      'resolve-approval': '--approval-id <ID> --resolution approved|rejected|returned|closed|modified [--response <文本>]',
      'record-message': '--direction inbound|outbound --participant-type user|group --participant-id <工号或群号> --content <文本> [--task-id <ID>] [--subtask-id <ID>] [--external-message-id <ID>] [--reply-to-action-id <ID>] [--external-thread-id <ID>]',
      'set-cursor': '--participant-type user|group --participant-id <工号或群号> --message-id <ID> [--message-time <ISO>]',
      'update-task': '--task-id <ID> [--status <状态>] [--working-summary-file <json>]',
      'add-instruction': '--task-id <ID> --text <追加指令>',
      'send-user': '--employee-number <工号> --text <消息> [--task-id <ID>] [--subtask-id <ID>] [--type <类型>]',
      'send-group': '--group-id <群号> --text <消息> [--task-id <ID>] [--approval-id <ID>] [--type <类型>]',
      'query-history-user': '--employee-number <工号> [--count 20] [--message-id <ID>] [--direction 1]',
      'query-history-group': '--group-id <群号> [--count 20] [--message-id <ID>] [--direction 1]',
      'query-recent': '[--count 20]',
      tick: '[--max-commands 10] 消费 UI 命令队列并输出待 Agent 推理的分配',
      'complete-command': '--command-id <ID> [--status succeeded|failed] [--error-code <CODE>] [--error-message <文本>]',
      'ack-command': '--command-id <ID> 宿主 Agent 确认接手 waiting_agent assignment',
      'close-conversation': '--conversation-id <ID> [--reason <原因>] 释放联系人沟通槽并唤醒下一项',
      status: '[--task-id <ID>]',
      resume: '输出所有未完成任务、待确认事项和不确定动作',
      'complete-task': '--task-id <ID> [--summary <文本>] [--force true]',
      help: '显示帮助'
    }
  };
}

async function ensureInitialized() {
  await store.initialize();
}

function findSubtask(task, subtaskId) {
  const subtask = task.subtasks.find((entry) => entry.subtask_id === subtaskId);
  if (!subtask) throw new Error(`Subtask not found: ${subtaskId}`);
  return subtask;
}

/**
 * One deterministic tick: recover interrupted work, consume the persisted
 * command inbox, and hand reasoning work back to the host Agent. WeLink
 * queries stay in the host loop; this command never blocks on the CLI.
 */
async function runTick() {
  await ensureInitialized();
  const maxCommands = Math.max(1, Number(args['max-commands'] ?? 10) || 10);

  await store.mutateState((state) => {
    state.last_started_tick = nowIso();
    state.status = 'ticking';
  });

  const recoveredLeases = await commands.recoverExpiredLeases();

  // Actions stuck in executing (crash between pre-persist and completion)
  // become unknown; verification is a host-Agent assignment, never a resend.
  const STALE_EXECUTING_MS = 15 * 60_000;
  const recoveredActions = [];
  for (const action of await store.listActions()) {
    if (action.status !== 'executing') continue;
    const started = Date.parse(action.created_at);
    if (!Number.isFinite(started) || Date.now() - started <= STALE_EXECUTING_MS) continue;
    await store.mutateAction(action.action_id, (current) => {
      if (current.status !== 'executing') return; // Another process got there first.
      current.status = 'unknown';
      current.completed_at = nowIso();
    });
    await store.logEvent('action_marked_unknown', { action_id: action.action_id, task_id: action.task_id });
    recoveredActions.push(action.action_id);
  }
  const uncertainActions = (await store.listActions()).filter((action) => ['executing', 'unknown'].includes(action.status));

  const assignments = [];
  const executed = [];
  const skipCommandIds = new Set();
  const tasksCache = new Map();
  const loadTaskCached = async (taskId, refresh = false) => {
    if (refresh || !tasksCache.has(taskId)) tasksCache.set(taskId, await store.loadTask(taskId));
    return tasksCache.get(taskId);
  };

  for (let index = 0; index < maxCommands; index += 1) {
    const claimed = await commands.claimNext({ workerId: `tick:${process.pid}`, skipCommandIds: [...skipCommandIds] });
    if (!claimed) break;

    let taskId = claimed.aggregate_type === 'task' ? claimed.aggregate_id : claimed.payload?.task_id ?? null;
    if (claimed.type === 'approval.apply') {
      const approval = await store.loadApproval(claimed.aggregate_id);
      taskId = approval.task_id;
    }
    const task = taskId ? await loadTaskCached(taskId) : null;

    // Re-check aggregate state under the claim: paused/cancelled/completed
    // tasks hold their commands until the owner resumes or cancels them.
    // failed tasks may still consume cancel, retry and instructions.
    if (task) {
      const executableForStatus = {
        paused: ['task.cancel'],
        cancelled: [],
        completed: [],
        failed: ['task.cancel', 'task.retry', 'task.instruction']
      }[task.status];
      if (executableForStatus && !executableForStatus.includes(claimed.type)) {
        skipCommandIds.add(claimed.command_id);
        await commands.releaseClaim(claimed.command_id);
        continue;
      }
    }
    const taskStatusForAssignment = task?.status ?? null;

    if (claimed.type === 'task.create') {
      await commands.markWaitingAgent(claimed.command_id);
      assignments.push({
        kind: 'plan_task',
        command_id: claimed.command_id,
        task_id: claimed.aggregate_id,
        task_status: taskStatusForAssignment,
        description: task.original_request,
        priority: task.priority
      });
      continue;
    }

    if (claimed.type === 'task.instruction') {
      await commands.markWaitingAgent(claimed.command_id);
      assignments.push({ kind: 'handle_instruction', command_id: claimed.command_id, task_id: claimed.aggregate_id, task_status: taskStatusForAssignment, text: claimed.payload.text });
      continue;
    }

    if (claimed.type === 'task.resume') {
      await commands.markWaitingAgent(claimed.command_id);
      assignments.push({ kind: 'resume_task', command_id: claimed.command_id, task_id: claimed.aggregate_id, task_status: taskStatusForAssignment });
      continue;
    }

    if (claimed.type === 'task.cancel') {
      await commands.markWaitingAgent(claimed.command_id);
      assignments.push({ kind: 'cancel_task', command_id: claimed.command_id, task_id: claimed.aggregate_id, task_status: taskStatusForAssignment });
      continue;
    }

    if (claimed.type === 'task.retry') {
      await commands.markWaitingAgent(claimed.command_id);
      assignments.push({ kind: 'retry_task', command_id: claimed.command_id, task_id: claimed.aggregate_id, task_status: taskStatusForAssignment });
      continue;
    }

    if (claimed.type === 'approval.apply') {
      const approval = await store.loadApproval(claimed.aggregate_id);
      const payload = approval.decision_payload ?? {};
      const proposedAction = approval.proposed_action;
      // Re-verify at execution time: the task may have been cancelled after
      // this command was queued.
      if (task && ['paused', 'cancelled'].includes(task.status)) {
        skipCommandIds.add(claimed.command_id);
        await commands.releaseClaim(claimed.command_id);
        continue;
      }
      if (approval.status === 'approved' && proposedAction?.type === 'send_message' && !payload.edited_content) {
        let sendOutcome;
        try {
          sendOutcome = proposedAction.target_type === 'group'
            ? { queued: false, ...(await sendService.sendGroup({
                groupId: proposedAction.target_id,
                text: proposedAction.content,
                taskId: approval.task_id,
                subtaskId: approval.subtask_id,
                approvalId: approval.approval_id,
                type: 'approval'
              })) }
            : { queued: false, ...(await sendService.sendUser({
                employeeNumber: proposedAction.target_id,
                text: proposedAction.content,
                taskId: approval.task_id,
                subtaskId: approval.subtask_id,
                type: 'approval'
              })) };
        } catch (error) {
          sendOutcome = { error };
        }

        if (sendOutcome.error) {
          await commands.complete(claimed.command_id, {
            status: 'failed',
            error: { code: sendOutcome.error.code ?? 'SEND_FAILED', message: sendOutcome.error.message }
          });
          executed.push({ command_id: claimed.command_id, status: 'failed', error: sendOutcome.error.code ?? 'SEND_FAILED' });
          continue;
        }
        if (sendOutcome.queued) {
          if (claimed.attempts >= 5) {
            await commands.complete(claimed.command_id, {
              status: 'failed',
              error: { code: 'CONTACT_SLOT_QUEUED', message: '联系人沟通槽被占用，请稍后重试。', retryable: true }
            });
            executed.push({ command_id: claimed.command_id, status: 'failed', error: 'CONTACT_SLOT_QUEUED' });
          } else {
            await commands.releaseClaim(claimed.command_id);
            skipCommandIds.add(claimed.command_id);
          }
          continue;
        }
        const actionStatus = sendOutcome.action.status;
        if (actionStatus === 'succeeded' || actionStatus === 'dry_run') {
          await commands.complete(claimed.command_id, { status: 'succeeded' });
          executed.push({ command_id: claimed.command_id, status: 'succeeded', action_id: sendOutcome.action.action_id, action_status: actionStatus });
        } else if (actionStatus === 'unknown') {
          await commands.complete(claimed.command_id, {
            status: 'failed',
            error: { code: 'ACTION_UNKNOWN', message: '发送结果未知，需要先查询会话历史核实。', action_id: sendOutcome.action.action_id }
          });
          executed.push({ command_id: claimed.command_id, status: 'failed', error: 'ACTION_UNKNOWN' });
        } else {
          await commands.complete(claimed.command_id, {
            status: 'failed',
            error: { code: 'SEND_FAILED', message: '发送失败，可核实后重试。', action_id: sendOutcome.action.action_id }
          });
          executed.push({ command_id: claimed.command_id, status: 'failed', error: 'SEND_FAILED' });
        }
        continue;
      }
      await commands.markWaitingAgent(claimed.command_id);
      assignments.push({
        kind: 'apply_decision',
        command_id: claimed.command_id,
        approval_id: approval.approval_id,
        task_id: approval.task_id,
        task_status: taskStatusForAssignment,
        subtask_id: approval.subtask_id,
        decision_payload: payload,
        proposed_action: proposedAction
      });
      continue;
    }

    if (claimed.type === 'subtask.remind') {
      const policies = await store.loadConfig('policies');
      const reminder = policies.follow_up ?? {};
      const maxReminders = reminder.max_reminders ?? 2;
      const subtaskId = claimed.payload.subtask_id;
      const subtask = findSubtask(task, subtaskId);
      if (subtask.status !== 'waiting_reply') {
        await commands.complete(claimed.command_id, {
          status: 'failed',
          error: { code: 'INVALID_STATE', message: '子任务不在等待回复状态，不能催办。' }
        });
        executed.push({ command_id: claimed.command_id, status: 'failed', error: 'INVALID_STATE' });
        continue;
      }
      if (subtask.communication.reminder_count >= maxReminders) {
        await commands.complete(claimed.command_id, {
          status: 'failed',
          error: { code: 'REMINDER_LIMIT_REACHED', message: '已达到该子任务的催办上限。' }
        });
        executed.push({ command_id: claimed.command_id, status: 'failed', error: 'REMINDER_LIMIT_REACHED' });
        continue;
      }
      const missing = (subtask.missing_information ?? []).join('、');
      const text = `提醒：关于「${subtask.title}」，${missing ? `还需要这些信息：${missing}。` : '麻烦按之前的请求回复一下。'}方便时同步即可，谢谢！`;
      const outcome = await sendService.sendUser({
        employeeNumber: subtask.target_employee_number,
        text,
        taskId: task.task_id,
        subtaskId,
        type: 'reminder'
      });
      if (outcome.queued) {
        await commands.complete(claimed.command_id, {
          status: 'failed',
          error: { code: 'CONTACT_SLOT_QUEUED', message: '联系人沟通槽被占用，催办未发送。', retryable: true, position: outcome.position }
        });
        executed.push({ command_id: claimed.command_id, status: 'failed', error: 'CONTACT_SLOT_QUEUED' });
        continue;
      }
      const updatedTask = await loadTaskCached(task.task_id, true);
      const fresh = findSubtask(updatedTask, subtaskId);
      fresh.communication.reminder_count += 1;
      const intervalMs = (reminder.reminder_interval_hours ?? 4) * 3_600_000;
      fresh.communication.next_reminder_at = new Date(Date.now() + intervalMs).toISOString();
      await store.saveTask(updatedTask);
      await commands.complete(claimed.command_id, { status: 'succeeded' });
      executed.push({ command_id: claimed.command_id, status: 'succeeded', action_id: outcome.action.action_id, action_status: outcome.action.status });
      continue;
    }

    await commands.complete(claimed.command_id, {
      status: 'failed',
      error: { code: 'UNSUPPORTED_COMMAND', message: `tick 不支持处理命令类型：${claimed.type}` }
    });
  }

  // Deterministic follow-up scan for the host Agent (it drafts the text).
  const dueFollowups = [];
  const tasks = await store.listTasks();
  const policies = await store.loadConfig('policies');
  const maxReminders = policies.follow_up?.max_reminders ?? 2;
  const now = Date.now();
  for (const entry of tasks) {
    if (['completed', 'cancelled', 'failed', 'paused'].includes(entry.status)) continue;
    for (const subtask of entry.subtasks ?? []) {
      if (subtask.status !== 'waiting_reply') continue;
      if ((subtask.communication?.reminder_count ?? 0) >= maxReminders) continue;
      const due = subtask.communication?.next_reminder_at ? Date.parse(subtask.communication.next_reminder_at) : null;
      if (due === null || Number.isNaN(due) || due > now) continue;
      dueFollowups.push({
        task_id: entry.task_id,
        subtask_id: subtask.subtask_id,
        title: subtask.title,
        target_employee_number: subtask.target_employee_number,
        reminder_count: subtask.communication.reminder_count,
        next_reminder_at: subtask.communication.next_reminder_at
      });
    }
  }

  await store.mutateState((state) => {
    state.last_successful_tick = nowIso();
    state.status = 'idle';
  });

  return {
    ok: true,
    recovered_leases: recoveredLeases,
    recovered_actions: recoveredActions,
    uncertain_actions: uncertainActions.map((action) => ({
      action_id: action.action_id,
      task_id: action.task_id,
      status: action.status
    })),
    assignments,
    executed,
    due_followups: dueFollowups,
    next: '恢复不确定动作，处理 assignments（规划/指令/审批后续），再查询 WeLink 新消息。'
  };
}

async function main() {
  switch (command) {
    case 'help': {
      jsonOutput(usage());
      return;
    }

    case 'init': {
      const result = await store.initialize();
      jsonOutput({ ok: true, root_dir: rootDir, ...result, next: 'Edit config/*.json, keep dry_run=true for the first test.' });
      return;
    }

    case 'preflight': {
      await ensureInitialized();
      const result = await runWelink(['auth', 'status'], { timeoutMs: 30000, dryRun: false });
      await store.logEvent('preflight', { ok: result.ok, result });
      jsonOutput(result);
      return;
    }

    case 'create-task': {
      await ensureInitialized();
      const request = requireArg(args, 'request');
      const task = await taskService.createTask({
        request,
        title: args.title,
        status: args.status === 'queued' ? 'queued' : 'running',
        createdBy: args['created-by'] ?? null,
        source: args.source === 'web_console' ? 'web_console' : 'skill',
        category: args.category ?? null,
        priority: ['low', 'normal', 'high'].includes(args.priority) ? args.priority : 'normal',
        deadlineAt: args.deadline ?? null,
        externalPolicy: args['external-policy'] ?? 'balanced',
        executionMode: args['execution-mode'] ?? 'automatic',
        attachmentIds: []
      });
      jsonOutput({ ok: true, task });
      return;
    }

    case 'add-subtask': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const subtask = await taskService.addSubtask(taskId, {
        title: requireArg(args, 'title'),
        topic: args.topic ?? null,
        target_employee_number: args['target-employee-number'] ?? null,
        target_group_id: args['target-group-id'] ?? null,
        required: boolArg(args.required, true),
        required_information: splitList(args['required-info']),
        created_dynamically: boolArg(args.dynamic, false),
        created_from_item_id: args['source-item-id'] ?? null,
        status: args.status ?? 'ready_to_contact'
      });
      jsonOutput({ ok: true, task_id: taskId, subtask });
      return;
    }

    case 'update-subtask': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const subtaskId = requireArg(args, 'subtask-id');
      let collected;
      if (args['collected-file']) {
        collected = await readJsonFile(path.resolve(rootDir, args['collected-file']));
      }
      const subtask = await taskService.updateSubtask(taskId, subtaskId, {
        status: args.status,
        summary: args.summary,
        missing_information: args['missing-info'] !== undefined ? splitList(args['missing-info']) : undefined,
        collected_information: collected,
        next_action: args['next-action'] ? { type: args['next-action'] } : undefined,
        reply_received: args['reply-received'] ? true : undefined
      });
      jsonOutput({ ok: true, subtask });
      return;
    }

    case 'add-item': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const itemId = await store.locks.withLocks([`task:${taskId}`], async () => {
        const task = await store.loadTask(taskId);
        const id = makeId('ITEM');
        const item = {
          schema_version: 1,
          revision: 1,
          item_id: id,
          parent_task_id: taskId,
          parent_subtask_id: args['parent-subtask-id'] ?? null,
          source_message_id: args['source-message-id'] ?? null,
          source_employee_number: args['source-employee-number'] ?? null,
          description: requireArg(args, 'description'),
          relation: args.relation ?? 'unknown',
          workload: args.workload ?? 'unknown',
          status: 'detected',
          decision: null,
          linked_subtask_id: null,
          approval_id: null,
          created_at: nowIso(),
          updated_at: nowIso()
        };
        await store.saveItem(item);
        task.open_item_ids = task.open_item_ids ?? [];
        if (!task.open_item_ids.includes(id)) task.open_item_ids.push(id);
        await store.saveTask(task);
        await store.logEvent('dynamic_item_detected', { task_id: taskId, item_id: id, description: item.description });
        return id;
      });
      const item = await store.loadItem(itemId);
      jsonOutput({ ok: true, item });
      return;
    }

    case 'classify-item': {
      await ensureInitialized();
      const itemId = requireArg(args, 'item-id');
      const decision = requireArg(args, 'decision');
      const item = await store.loadItem(itemId);
      const task = await store.loadTask(item.parent_task_id);

      let linkedSubtaskId = null;
      if (decision === 'auto_subtask') {
        const subtask = await taskService.addSubtask(task.task_id, {
          title: args.title || item.description,
          topic: args.topic ?? null,
          target_employee_number: requireArg(args, 'target-employee-number'),
          required: boolArg(args.required, true),
          required_information: splitList(args['required-info']),
          created_dynamically: true,
          created_from_item_id: itemId,
          status: 'ready_to_contact'
        });
        linkedSubtaskId = subtask.subtask_id;
      }

      const targets = [{ kind: 'item', id: itemId }, { kind: 'task', id: task.task_id }];
      const updated = await store.mutateGroup(targets, {
        item: (current) => {
          current.decision = decision;
          if (decision === 'auto_subtask') {
            current.status = 'linked';
            current.linked_subtask_id = linkedSubtaskId;
          } else if (decision === 'owner_approval') {
            current.status = 'waiting_owner';
          } else if (decision === 'independent') {
            current.status = 'independent_pending';
          } else if (decision === 'ignore') {
            current.status = 'closed';
          } else {
            const error = new Error(`Unsupported item decision: ${decision}`);
            throw error;
          }
        },
        task: (current) => {
          if (decision === 'auto_subtask' || decision === 'ignore') {
            current.open_item_ids = (current.open_item_ids ?? []).filter((id) => id !== itemId);
          }
        }
      });
      await store.logEvent('dynamic_item_classified', { task_id: item.parent_task_id, item_id: itemId, decision });
      jsonOutput({ ok: true, item: updated.get(`item:${itemId}`) });
      return;
    }

    case 'create-approval': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const proposedAction = args['proposed-action-file']
        ? await readJsonFile(path.resolve(rootDir, args['proposed-action-file']))
        : null;
      const approval = await approvalService.createApproval({
        taskId,
        subtaskId: args['subtask-id'] ?? null,
        itemId: args['item-id'] ?? null,
        question: requireArg(args, 'question'),
        options: splitList(args.options),
        proposedAction
      });
      jsonOutput({ ok: true, approval });
      return;
    }

    case 'resolve-approval': {
      await ensureInitialized();
      const approvalId = requireArg(args, 'approval-id');
      const resolution = requireArg(args, 'resolution');
      const approval = await store.loadApproval(approvalId);

      const targets = [{ kind: 'approval', id: approvalId }, { kind: 'task', id: approval.task_id }];
      if (approval.item_id) targets.push({ kind: 'item', id: approval.item_id });
      const closeItem = ['rejected', 'returned', 'closed'].includes(resolution);
      const loaded = await store.mutateGroup(targets, {
        approval: (current) => {
          current.status = resolution;
          current.response = args.response ?? null;
          current.decision_payload = { decision: resolution, response: args.response ?? null };
          current.resolved_at = nowIso();
        },
        task: (current) => {
          current.pending_approval_ids = (current.pending_approval_ids ?? []).filter((id) => id !== approvalId);
          if (current.pending_approval_ids.length === 0 && current.status === 'waiting_owner') current.status = 'running';
          if (closeItem && approval.item_id) {
            current.open_item_ids = (current.open_item_ids ?? []).filter((id) => id !== approval.item_id);
          }
        },
        item: approval.item_id ? (current) => {
          if (closeItem) current.status = 'closed';
          else if (resolution === 'approved') current.status = 'approved';
          else current.status = 'modified';
        } : undefined
      });

      // Approved/modified decisions still owe the Agent an apply step.
      let commandId = null;
      if (['approved', 'modified'].includes(resolution)) {
        const { command } = await commands.create({
          type: 'approval.apply',
          aggregateType: 'approval',
          aggregateId: approvalId,
          payload: { approval_id: approvalId, source: 'skill' }
        });
        commandId = command.command_id;
      }
      await store.logEvent('approval_resolved', { task_id: approval.task_id, approval_id: approvalId, resolution, command_id: commandId });
      jsonOutput({ ok: true, approval: loaded.get(`approval:${approvalId}`), command_id: commandId });
      return;
    }

    case 'record-message': {
      await ensureInitialized();
      const direction = requireArg(args, 'direction');
      const participantType = requireArg(args, 'participant-type');
      const participantId = requireArg(args, 'participant-id');
      const content = requireArg(args, 'content');
      if (direction === 'inbound') {
        const { message, attribution } = await messageService.recordInbound({
          participantType,
          participantId,
          content,
          externalMessageId: args['external-message-id'] ?? null,
          replyToActionId: args['reply-to-action-id'] ?? null,
          externalThreadId: args['external-thread-id'] ?? null
        });
        jsonOutput({
          ok: true,
          message,
          attribution: {
            status: attribution.status,
            conversation_id: attribution.conversation?.conversation_id ?? null,
            task_id: attribution.conversation?.task_id ?? null,
            subtask_id: attribution.conversation?.subtask_id ?? null
          }
        });
        return;
      }
      const message = await messageService.recordManualOutbound({
        participantType,
        participantId,
        content,
        taskId: args['task-id'] ?? null,
        subtaskId: args['subtask-id'] ?? null,
        externalMessageId: args['external-message-id'] ?? null
      });
      jsonOutput({ ok: true, message });
      return;
    }

    case 'set-cursor': {
      await ensureInitialized();
      const participantType = requireArg(args, 'participant-type');
      const participantId = requireArg(args, 'participant-id');
      const messageId = requireArg(args, 'message-id');
      const key = `${participantType}:${participantId}`;
      await store.mutateState((state) => {
        state.cursors[key] = {
          last_message_id: messageId,
          last_message_time: args['message-time'] ?? null,
          updated_at: nowIso()
        };
      });
      const state = await store.loadState();
      jsonOutput({ ok: true, key, cursor: state.cursors[key] });
      return;
    }

    case 'update-task': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const task = await store.mutateTask(taskId, undefined, async (current) => {
        if (args.status) current.status = args.status;
        if (args['working-summary-file']) {
          current.working_summary = await readJsonFile(path.resolve(rootDir, args['working-summary-file']));
        }
      });
      await store.logEvent('task_updated', { task_id: taskId, status: task.status });
      jsonOutput({ ok: true, task });
      return;
    }

    case 'add-instruction': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const text = requireArg(args, 'text');
      const result = await taskService.addInstruction(taskId, text);
      jsonOutput({ ok: true, task_id: taskId, command_id: result.commandId });
      return;
    }

    case 'send-user': {
      await ensureInitialized();
      const employeeNumber = requireArg(args, 'employee-number');
      const outcome = await sendService.sendUser({
        employeeNumber,
        text: requireArg(args, 'text'),
        taskId: args['task-id'] ?? null,
        subtaskId: args['subtask-id'] ?? null,
        type: args.type ?? null
      });
      if (outcome.queued) {
        jsonOutput({ ok: true, queued: true, position: outcome.position, holder_task_id: outcome.holderTaskId, note: '该联系人已有进行中的沟通，子任务已进入沟通队列，未发送消息。' });
        return;
      }
      jsonOutput({ ok: outcome.result.ok, ...outcome });
      return;
    }

    case 'send-group': {
      await ensureInitialized();
      const groupId = requireArg(args, 'group-id');
      const outcome = await sendService.sendGroup({
        groupId,
        text: requireArg(args, 'text'),
        taskId: args['task-id'] ?? null,
        approvalId: args['approval-id'] ?? null,
        type: args.type ?? null
      });
      jsonOutput({ ok: outcome.result.ok, ...outcome });
      return;
    }

    case 'query-history-user': {
      await ensureInitialized();
      const employeeNumber = requireArg(args, 'employee-number');
      const contacts = await store.loadConfig('contacts');
      const contact = contacts[employeeNumber];
      if (!contact) throw new Error(`Employee number is not configured: ${employeeNumber}`);
      const cliArgs = ['im', 'query-history-message', '--user-account', contact.w3account, '--query-count', String(args.count ?? 20)];
      if (args['message-id']) cliArgs.push('--message-id', args['message-id']);
      if (args.direction) cliArgs.push('--query-direction', String(args.direction));
      const result = await runWelink(cliArgs, { timeoutMs: 60000, dryRun: false });
      const rawId = makeId('RAW');
      await store.writeJson(path.join(store.paths().raw, `${rawId}.json`), { type: 'history_user', employee_number: employeeNumber, result });
      jsonOutput({ raw_id: rawId, ...result });
      return;
    }

    case 'query-history-group': {
      await ensureInitialized();
      const groupId = requireArg(args, 'group-id');
      const cliArgs = ['im', 'query-history-message', '--group-id', groupId, '--query-count', String(args.count ?? 20)];
      if (args['message-id']) cliArgs.push('--message-id', args['message-id']);
      if (args.direction) cliArgs.push('--query-direction', String(args.direction));
      const result = await runWelink(cliArgs, { timeoutMs: 60000, dryRun: false });
      const rawId = makeId('RAW');
      await store.writeJson(path.join(store.paths().raw, `${rawId}.json`), { type: 'history_group', group_id: groupId, result });
      jsonOutput({ raw_id: rawId, ...result });
      return;
    }

    case 'query-recent': {
      await ensureInitialized();
      const result = await runWelink(['im', 'query-recent-conversation', '--count', String(args.count ?? 20)], { timeoutMs: 60000, dryRun: false });
      const rawId = makeId('RAW');
      await store.writeJson(path.join(store.paths().raw, `${rawId}.json`), { type: 'recent_conversation', result });
      jsonOutput({ raw_id: rawId, ...result });
      return;
    }

    case 'tick': {
      jsonOutput(await runTick());
      return;
    }

    case 'complete-command': {
      await ensureInitialized();
      const commandId = requireArg(args, 'command-id');
      const status = args.status === 'failed' ? 'failed' : 'succeeded';
      const completed = await commands.complete(commandId, {
        status,
        error: status === 'failed'
          ? { code: args['error-code'] ?? 'AGENT_ERROR', message: args['error-message'] ?? 'Agent 报告命令执行失败。' }
          : null
      });
      await store.logEvent('command_updated', { command_id: commandId, status: completed.status });
      jsonOutput({ ok: true, command: completed });
      return;
    }

    case 'ack-command': {
      await ensureInitialized();
      const commandId = requireArg(args, 'command-id');
      const acked = await commands.ackCommand(commandId);
      await store.logEvent('command_acknowledged', { command_id: commandId });
      jsonOutput({ ok: true, command: acked });
      return;
    }

    case 'close-conversation': {
      await ensureInitialized();
      const conversationId = requireArg(args, 'conversation-id');
      const conversation = await store.loadConversation(conversationId);
      const result = await releaseContactSlot(store, conversation, { reason: args.reason ?? 'closed' });
      await store.logEvent('conversation_closed', {
        conversation_id: conversationId,
        task_id: conversation.task_id,
        reason: args.reason ?? 'closed',
        promoted_task_id: result.promoted?.task_id ?? null
      });
      jsonOutput({ ok: true, ...result });
      return;
    }

    case 'status': {
      await ensureInitialized();
      if (args['task-id']) {
        const task = await store.loadTask(args['task-id']);
        const openSubtasks = task.subtasks.filter((s) => !['completed', 'cancelled', 'failed'].includes(s.status));
        jsonOutput({
          task_id: task.task_id,
          title: task.title,
          status: task.status,
          progress: {
            total: task.subtasks.length,
            completed: task.subtasks.filter((s) => s.status === 'completed').length,
            waiting_reply: task.subtasks.filter((s) => s.status === 'waiting_reply').length,
            waiting_owner: task.pending_approval_ids.length,
            open_items: task.open_item_ids.length
          },
          open_subtasks: openSubtasks,
          working_summary: task.working_summary
        });
      } else {
        const tasks = await store.listTasks();
        jsonOutput({
          tasks: tasks.map((task) => ({
            task_id: task.task_id,
            title: task.title,
            status: task.status,
            total_subtasks: task.subtasks.length,
            completed_subtasks: task.subtasks.filter((s) => s.status === 'completed').length,
            waiting_reply: task.subtasks.filter((s) => s.status === 'waiting_reply').length,
            pending_approvals: task.pending_approval_ids.length,
            open_items: task.open_item_ids.length,
            updated_at: task.updated_at
          }))
        });
      }
      return;
    }

    case 'resume': {
      await ensureInitialized();
      const [tasks, approvals, items, actions, state, pendingCommands] = await Promise.all([
        store.listTasks(),
        store.listApprovals(),
        store.listItems(),
        store.listActions(),
        store.loadState(),
        store.listCommands()
      ]);
      jsonOutput({
        agent_state: state,
        unfinished_tasks: tasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(task.status)),
        pending_approvals: approvals.filter((approval) => approval.status === 'pending'),
        open_items: items.filter((item) => !['closed', 'linked'].includes(item.status)),
        uncertain_actions: actions.filter((action) => ['executing', 'unknown'].includes(action.status)),
        pending_commands: pendingCommands.filter((entry) => ['queued', 'claimed', 'waiting_agent'].includes(entry.status)),
        instruction: 'Recover uncertain actions first, process pending commands (tick), then pending approvals and unfinished tasks.'
      });
      return;
    }

    case 'complete-task': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const result = await taskService.completeTask(taskId, {
        summary: args.summary,
        force: boolArg(args.force, false)
      });
      if (!result.ok) {
        jsonOutput(result);
        process.exitCode = 2;
        return;
      }
      jsonOutput({ ok: true, task: result.task });
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  jsonOutput({ ok: false, error: error.message, command });
  process.exitCode = 1;
});
