#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from './lib/store.mjs';
import { hashText, makeId } from './lib/ids.mjs';
import {
  boolArg,
  compactText,
  jsonOutput,
  nowIso,
  parseArgs,
  projectRootFromScript,
  readJsonFile,
  requireArg,
  splitList
} from './lib/utils.mjs';
import { runWelink } from './lib/welink.mjs';

const rootDir = projectRootFromScript(import.meta.url);
const store = new Store(rootDir);
const [command = 'help', ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

function usage() {
  return {
    project_root: rootDir,
    commands: {
      init: '初始化 config/*.json 和 runtime 目录',
      preflight: '检查 welink-cli 认证状态',
      'create-task': '--request <任务描述> [--title <标题>]',
      'add-subtask': '--task-id <ID> --title <标题> --target-employee-number <工号> [--required-info a,b] [--dynamic true]',
      'update-subtask': '--task-id <ID> --subtask-id <ID> [--status <状态>] [--summary <摘要>] [--collected-file <json>] [--missing-info a,b]',
      'add-item': '--task-id <ID> --description <事项> [--source-message-id <ID>] [--source-employee-number <工号>] [--relation required_dependency|scope_extension] [--workload light|large|unknown]',
      'classify-item': '--item-id <ID> --decision auto_subtask|owner_approval|ignore|independent [其他参数]',
      'create-approval': '--task-id <ID> --question <问题> [--item-id <ID>] [--options a,b,c] [--proposed-action-file <json>]',
      'resolve-approval': '--approval-id <ID> --resolution approved|rejected|returned|closed|modified [--response <文本>]',
      'record-message': '--direction inbound|outbound --participant-type user|group --participant-id <工号或群号> --content <文本> [--task-id <ID>] [--subtask-id <ID>] [--external-message-id <ID>]',
      'set-cursor': '--participant-type user|group --participant-id <工号或群号> --message-id <ID> [--message-time <ISO>]',
      'update-task': '--task-id <ID> [--status <状态>] [--working-summary-file <json>]',
      'send-user': '--employee-number <工号> --text <消息> [--task-id <ID>] [--subtask-id <ID>] [--type <类型>]',
      'send-group': '--group-id <群号> --text <消息> [--task-id <ID>] [--approval-id <ID>] [--type <类型>]',
      'query-history-user': '--employee-number <工号> [--count 20] [--message-id <ID>] [--direction 1]',
      'query-history-group': '--group-id <群号> [--count 20] [--message-id <ID>] [--direction 1]',
      'query-recent': '[--count 20]',
      status: '[--task-id <ID>]',
      resume: '输出所有未完成任务、待确认事项和不确定动作',
      'complete-task': '--task-id <ID> [--summary <文本>]',
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

async function createSubtask(task, input) {
  const subtask = {
    subtask_id: makeId('SUB'),
    title: input.title,
    topic: input.topic ?? null,
    target_employee_number: input.target_employee_number ?? null,
    target_group_id: input.target_group_id ?? null,
    required: input.required ?? true,
    status: input.status ?? 'ready_to_contact',
    required_information: input.required_information ?? [],
    collected_information: {},
    missing_information: input.required_information ?? [],
    summary: null,
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
  task.subtasks.push(subtask);
  await store.saveTask(task);
  await store.logEvent('subtask_created', {
    task_id: task.task_id,
    subtask_id: subtask.subtask_id,
    dynamic: subtask.created_dynamically,
    target_employee_number: subtask.target_employee_number
  });
  return subtask;
}

function agentSuffix(policies, metadata = {}) {
  const meta = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`)
    .join(' ');
  const marker = meta
    ? policies.agent_marker.replace(/\]$/, ` ${meta}]`)
    : policies.agent_marker;
  return `${policies.agent_footer_text}\n${marker}`;
}

function withAgentFooter(text, policies, metadata) {
  const trimmed = String(text).trim();
  if (trimmed.includes('[WELINK_AGENT_MESSAGE')) return trimmed;
  return `${trimmed}\n\n${agentSuffix(policies, metadata)}`;
}

async function executeSend({ actionType, targetType, targetId, cliArgs, content, taskId, subtaskId, approvalId, messageType }) {
  const policies = await store.loadConfig('policies');
  const actionId = makeId('ACT');
  const action = {
    action_id: actionId,
    task_id: taskId ?? null,
    subtask_id: subtaskId ?? null,
    approval_id: approvalId ?? null,
    type: actionType,
    target_type: targetType,
    target_id: targetId,
    content,
    content_hash: hashText(content),
    status: 'executing',
    created_at: nowIso(),
    updated_at: nowIso()
  };
  await store.saveAction(action);
  await store.logEvent('action_started', {
    action_id: actionId,
    task_id: taskId ?? null,
    action_type: actionType,
    target_id: targetId
  });

  const result = await runWelink(cliArgs, { dryRun: policies.dry_run === true });
  action.external_result = result;
  action.status = result.ok ? (result.dry_run ? 'dry_run' : 'succeeded') : (result.timed_out ? 'unknown' : 'failed');
  action.completed_at = nowIso();
  await store.saveAction(action);

  await store.logMessage({
    direction: 'outbound',
    participant_type: targetType,
    participant_id: targetId,
    task_id: taskId ?? null,
    subtask_id: subtaskId ?? null,
    approval_id: approvalId ?? null,
    message_type: messageType ?? 'message',
    content,
    action_id: actionId,
    status: action.status,
    raw_result: result
  });
  await store.logEvent('action_finished', {
    action_id: actionId,
    task_id: taskId ?? null,
    status: action.status
  });

  if (taskId && subtaskId) {
    const task = await store.loadTask(taskId);
    const subtask = findSubtask(task, subtaskId);
    if (result.ok) {
      subtask.status = 'waiting_reply';
      subtask.communication.round += 1;
      subtask.communication.first_contact_at ??= nowIso();
      subtask.communication.last_contact_at = nowIso();
      subtask.next_action = { type: 'wait_reply' };
      await store.saveTask(task);
    }
  }

  return { action, result };
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
      const taskId = makeId('TASK');
      const task = {
        schema_version: 1,
        task_id: taskId,
        title: args.title || compactText(request, 50),
        original_request: request,
        status: 'running',
        created_at: nowIso(),
        updated_at: nowIso(),
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
      await store.saveTask(task);
      const state = await store.loadState();
      if (!state.active_task_ids.includes(taskId)) state.active_task_ids.push(taskId);
      await store.saveState(state);
      await store.logEvent('task_created', { task_id: taskId, original_request: request });
      jsonOutput({ ok: true, task });
      return;
    }

    case 'add-subtask': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const task = await store.loadTask(taskId);
      const subtask = await createSubtask(task, {
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
      const task = await store.loadTask(taskId);
      const subtask = findSubtask(task, subtaskId);
      if (args.status) subtask.status = args.status;
      if (args.summary) subtask.summary = args.summary;
      if (args['missing-info'] !== undefined) subtask.missing_information = splitList(args['missing-info']);
      if (args['collected-file']) {
        const collected = await readJsonFile(path.resolve(rootDir, args['collected-file']));
        subtask.collected_information = { ...subtask.collected_information, ...collected };
      }
      if (args['reply-received']) {
        subtask.communication.last_reply_at = nowIso();
      }
      if (args['next-action']) {
        subtask.next_action = { type: args['next-action'] };
      }
      subtask.updated_at = nowIso();
      await store.saveTask(task);
      await store.logEvent('subtask_updated', { task_id: taskId, subtask_id: subtaskId, status: subtask.status });
      jsonOutput({ ok: true, subtask });
      return;
    }

    case 'add-item': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const task = await store.loadTask(taskId);
      const itemId = makeId('ITEM');
      const item = {
        item_id: itemId,
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
      if (!task.open_item_ids.includes(itemId)) task.open_item_ids.push(itemId);
      await store.saveTask(task);
      await store.logEvent('dynamic_item_detected', { task_id: taskId, item_id: itemId, description: item.description });
      jsonOutput({ ok: true, item });
      return;
    }

    case 'classify-item': {
      await ensureInitialized();
      const itemId = requireArg(args, 'item-id');
      const decision = requireArg(args, 'decision');
      const item = await store.loadItem(itemId);
      const task = await store.loadTask(item.parent_task_id);
      item.decision = decision;

      if (decision === 'auto_subtask') {
        const subtask = await createSubtask(task, {
          title: args.title || item.description,
          topic: args.topic ?? null,
          target_employee_number: requireArg(args, 'target-employee-number'),
          required: boolArg(args.required, true),
          required_information: splitList(args['required-info']),
          created_dynamically: true,
          created_from_item_id: itemId,
          status: 'ready_to_contact'
        });
        item.status = 'linked';
        item.linked_subtask_id = subtask.subtask_id;
        task.open_item_ids = task.open_item_ids.filter((id) => id !== itemId);
        await store.saveTask(task);
      } else if (decision === 'owner_approval') {
        item.status = 'waiting_owner';
      } else if (decision === 'independent') {
        item.status = 'independent_pending';
      } else if (decision === 'ignore') {
        item.status = 'closed';
        task.open_item_ids = task.open_item_ids.filter((id) => id !== itemId);
        await store.saveTask(task);
      } else {
        throw new Error(`Unsupported item decision: ${decision}`);
      }
      await store.saveItem(item);
      await store.logEvent('dynamic_item_classified', { task_id: item.parent_task_id, item_id: itemId, decision });
      jsonOutput({ ok: true, item });
      return;
    }

    case 'create-approval': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const task = await store.loadTask(taskId);
      const approvalId = makeId('AP');
      const proposedAction = args['proposed-action-file']
        ? await readJsonFile(path.resolve(rootDir, args['proposed-action-file']))
        : null;
      const approval = {
        approval_id: approvalId,
        task_id: taskId,
        subtask_id: args['subtask-id'] ?? null,
        item_id: args['item-id'] ?? null,
        status: 'pending',
        question: requireArg(args, 'question'),
        options: splitList(args.options),
        proposed_action: proposedAction,
        response: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        resolved_at: null
      };
      await store.saveApproval(approval);
      if (!task.pending_approval_ids.includes(approvalId)) task.pending_approval_ids.push(approvalId);
      if (approval.item_id) {
        const item = await store.loadItem(approval.item_id);
        item.status = 'waiting_owner';
        item.approval_id = approvalId;
        await store.saveItem(item);
      }
      task.status = 'waiting_owner';
      await store.saveTask(task);
      await store.logEvent('approval_created', { task_id: taskId, approval_id: approvalId, item_id: approval.item_id });
      jsonOutput({ ok: true, approval });
      return;
    }

    case 'resolve-approval': {
      await ensureInitialized();
      const approvalId = requireArg(args, 'approval-id');
      const resolution = requireArg(args, 'resolution');
      const approval = await store.loadApproval(approvalId);
      approval.status = resolution;
      approval.response = args.response ?? null;
      approval.resolved_at = nowIso();
      await store.saveApproval(approval);

      const task = await store.loadTask(approval.task_id);
      task.pending_approval_ids = task.pending_approval_ids.filter((id) => id !== approvalId);
      if (task.pending_approval_ids.length === 0 && task.status === 'waiting_owner') task.status = 'running';
      await store.saveTask(task);

      if (approval.item_id) {
        const item = await store.loadItem(approval.item_id);
        if (['rejected', 'returned', 'closed'].includes(resolution)) {
          item.status = 'closed';
          task.open_item_ids = task.open_item_ids.filter((id) => id !== item.item_id);
          await store.saveTask(task);
        } else if (resolution === 'approved') {
          item.status = 'approved';
        } else {
          item.status = 'modified';
        }
        await store.saveItem(item);
      }
      await store.logEvent('approval_resolved', { task_id: approval.task_id, approval_id: approvalId, resolution });
      jsonOutput({ ok: true, approval });
      return;
    }

    case 'record-message': {
      await ensureInitialized();
      const entry = await store.logMessage({
        direction: requireArg(args, 'direction'),
        participant_type: requireArg(args, 'participant-type'),
        participant_id: requireArg(args, 'participant-id'),
        content: requireArg(args, 'content'),
        task_id: args['task-id'] ?? null,
        subtask_id: args['subtask-id'] ?? null,
        external_message_id: args['external-message-id'] ?? null,
        status: 'recorded'
      });
      jsonOutput({ ok: true, message: entry });
      return;
    }


    case 'set-cursor': {
      await ensureInitialized();
      const participantType = requireArg(args, 'participant-type');
      const participantId = requireArg(args, 'participant-id');
      const messageId = requireArg(args, 'message-id');
      const state = await store.loadState();
      const key = `${participantType}:${participantId}`;
      state.cursors[key] = {
        last_message_id: messageId,
        last_message_time: args['message-time'] ?? null,
        updated_at: nowIso()
      };
      await store.saveState(state);
      jsonOutput({ ok: true, key, cursor: state.cursors[key] });
      return;
    }

    case 'update-task': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const task = await store.loadTask(taskId);
      if (args.status) task.status = args.status;
      if (args['working-summary-file']) {
        task.working_summary = await readJsonFile(path.resolve(rootDir, args['working-summary-file']));
      }
      await store.saveTask(task);
      await store.logEvent('task_updated', { task_id: taskId, status: task.status });
      jsonOutput({ ok: true, task });
      return;
    }

    case 'send-user': {
      await ensureInitialized();
      const employeeNumber = requireArg(args, 'employee-number');
      const contacts = await store.loadConfig('contacts');
      const contact = contacts[employeeNumber];
      if (!contact) throw new Error(`Employee number is not configured: ${employeeNumber}`);
      if (!contact.auto_contact) throw new Error(`Auto contact is disabled for: ${employeeNumber}`);
      const policies = await store.loadConfig('policies');
      const message = withAgentFooter(requireArg(args, 'text'), policies, {
        task: args['task-id'],
        subtask: args['subtask-id'],
        type: args.type ?? 'communication'
      });
      const result = await executeSend({
        actionType: 'send_user_message',
        targetType: 'user',
        targetId: employeeNumber,
        cliArgs: ['im', 'send-to-user', '--receiver', contact.w3account, '--text', message],
        content: message,
        taskId: args['task-id'],
        subtaskId: args['subtask-id'],
        messageType: args.type
      });
      jsonOutput({ ok: result.result.ok, ...result });
      return;
    }

    case 'send-group': {
      await ensureInitialized();
      const groupId = requireArg(args, 'group-id');
      const groups = await store.loadConfig('groups');
      if (!groups[groupId]?.trusted) throw new Error(`Group is not configured as trusted: ${groupId}`);
      const policies = await store.loadConfig('policies');
      const message = withAgentFooter(requireArg(args, 'text'), policies, {
        task: args['task-id'],
        approval: args['approval-id'],
        type: args.type ?? 'notification'
      });
      const result = await executeSend({
        actionType: 'send_group_message',
        targetType: 'group',
        targetId: groupId,
        cliArgs: ['im', 'send-to-group', '--group-id', groupId, '--text', message],
        content: message,
        taskId: args['task-id'],
        approvalId: args['approval-id'],
        messageType: args.type
      });
      jsonOutput({ ok: result.result.ok, ...result });
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
      const [tasks, approvals, items, actions, state] = await Promise.all([
        store.listTasks(),
        store.listApprovals(),
        store.listItems(),
        store.listActions(),
        store.loadState()
      ]);
      jsonOutput({
        agent_state: state,
        unfinished_tasks: tasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(task.status)),
        pending_approvals: approvals.filter((approval) => approval.status === 'pending'),
        open_items: items.filter((item) => !['closed', 'linked'].includes(item.status)),
        uncertain_actions: actions.filter((action) => ['executing', 'unknown'].includes(action.status)),
        instruction: 'Recover uncertain actions first, then process pending approvals and unfinished tasks.'
      });
      return;
    }

    case 'complete-task': {
      await ensureInitialized();
      const taskId = requireArg(args, 'task-id');
      const task = await store.loadTask(taskId);
      const blocking = {
        mandatory_subtasks: task.subtasks.filter((s) => s.required && s.status !== 'completed').map((s) => s.subtask_id),
        open_items: task.open_item_ids,
        pending_approvals: task.pending_approval_ids,
        conflicts: task.conflicts.filter((c) => c.status !== 'resolved')
      };
      if (Object.values(blocking).some((entries) => entries.length > 0) && !boolArg(args.force, false)) {
        jsonOutput({ ok: false, reason: 'Task still has blocking work.', blocking });
        process.exitCode = 2;
        return;
      }
      task.status = 'completed';
      task.final_summary = args.summary ?? task.final_summary;
      task.completed_at = nowIso();
      await store.saveTask(task);
      const state = await store.loadState();
      state.active_task_ids = state.active_task_ids.filter((id) => id !== taskId);
      await store.saveState(state);
      await store.logEvent('task_completed', { task_id: taskId });
      jsonOutput({ ok: true, task });
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
