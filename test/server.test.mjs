import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../scripts/lib/store.mjs';
import { CommandService } from '../scripts/lib/commands.mjs';
import { TaskService } from '../scripts/lib/task-service.mjs';
import { ApprovalService } from '../scripts/lib/approval-service.mjs';
import { createFixture, startServer, stopServer } from './helpers.mjs';

async function bootstrap(t, seed) {
  const root = await createFixture({ withServer: true });
  t.after(async () => {
    await stopServer(server.child);
    await fs.rm(root, { recursive: true, force: true });
  });

  if (seed) {
    const store = new Store(root);
    await store.initialize();
    const commands = new CommandService(store);
    await seed({ store, commands, tasks: new TaskService(store, commands), approvals: new ApprovalService(store, commands), root });
  }

  const server = await startServer(root);
  const json = async (path, options = {}) => {
    const response = await fetch(`${server.baseUrl}${path}`, options);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body, response };
  };
  const post = (path, body, extraHeaders = {}) => json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  });
  const session = (await json('/session')).body;
  const headers = {
    'x-csrf-token': session.csrfToken,
    'idempotency-key': `idem-${Math.random().toString(36).slice(2, 10)}`,
    origin: server.baseUrl.replace('/api/v1', '')
  };
  return { root, server, json, post, session, headers, storeRef: { get store() { throw new Error('use seed'); } } };
}

test('health reports mode, agent backlog and capabilities', async (t) => {
  const { json } = await bootstrap(t);
  const { status, body } = await json('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.mode, 'dry_run');
  assert.equal(body.capabilities.sse, true);
  assert.equal(body.capabilities.attachments, false);
  assert.ok(body.agent);
  assert.equal(body.requestId.startsWith('REQ-'), true);
});

test('write requests require CSRF token and reject mismatched origin', async (t) => {
  const { post, json } = await bootstrap(t);
  const noToken = await post('/tasks', { description: '这段描述足够长，可以创建任务。' });
  assert.equal(noToken.status, 403);

  const badOrigin = await json('/tasks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': (await json('/session')).body.csrfToken,
      'idempotency-key': 'idem-origin-test',
      origin: 'http://evil.example'
    },
    body: JSON.stringify({ description: '这段描述足够长，可以创建任务。' })
  });
  assert.equal(badOrigin.status, 403);
});

test('create task returns 202, replays idempotently and conflicts on payload change', async (t) => {
  const { post, headers, json } = await bootstrap(t);
  const description = '收集本周项目进展，确认阻塞和预计完成时间，并整理成周报。';
  const first = await post('/tasks', { description, priority: 'high' }, headers);
  assert.equal(first.status, 202);
  assert.equal(first.body.task.displayStatus, 'queued');
  assert.equal(first.body.command.status, 'queued');

  const replay = await post('/tasks', { description, priority: 'high' }, headers);
  assert.equal(replay.body.task.id, first.body.task.id);
  assert.equal(replay.body.command.id, first.body.command.id);

  const conflict = await post('/tasks', { description: '不同的任务描述，内容和第一次不一样。' }, headers);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  const list = await json('/tasks');
  assert.equal(list.body.total, 1, 'no duplicate task created');
});

test('tasks list supports query, status filter and cursor pagination', async (t) => {
  const { json, post, headers } = await bootstrap(t, async ({ tasks }) => {
    for (const request of ['第一个测试任务，用来填充列表分页。', '第二个测试任务，同样用于分页检查。']) {
      await tasks.createTask({ request, source: 'web_console', status: 'queued' });
    }
  });
  await post('/tasks', { description: '第三个测试任务，从控制台直接创建。' }, headers);

  const page1 = await json('/tasks?limit=2');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 2);
  assert.ok(page1.body.nextCursor);
  assert.equal(page1.body.requestId.startsWith('REQ-'), true);

  const page2 = await json(`/tasks?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`);
  assert.equal(page2.body.items.length, 1);
  assert.equal(page2.body.nextCursor, null);
  assert.equal(page2.body.total, 3);
  assert.ok(page2.body.totalsByStatus.queued >= 1);

  const filtered = await json('/tasks?status=queued');
  assert.equal(filtered.body.items.every((item) => item.displayStatus === 'queued'), true);
});

test('task detail exposes allowedCommands and rejects disallowed commands', async (t) => {
  const { json, post, headers } = await bootstrap(t);
  const created = await post('/tasks', { description: '允许命令检查的任务描述，长度足够。' }, headers);
  const taskId = created.body.task.id;

  const detail = await json(`/tasks/${taskId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.task.allowedCommands, ['pause', 'cancel', 'instruction']);
  assert.ok(detail.body.task.revision >= 1);
  assert.ok(Array.isArray(detail.body.activity));

  const disallowed = await post(`/tasks/${taskId}/commands`, { type: 'resume', expectedRevision: detail.body.task.revision }, { ...headers, 'idempotency-key': 'idem-disallowed-1' });
  assert.equal(disallowed.status, 409);
  assert.equal(disallowed.body.error.code, 'INVALID_STATE_TRANSITION');
});

test('pause enforces revision conflict, cancel removes queued commands', async (t) => {
  const { json, post, headers, root } = await bootstrap(t);
  const created = await post('/tasks', { description: '并发保护检查的任务描述，长度足够。' }, headers);
  const taskId = created.body.task.id;

  const detail = await json(`/tasks/${taskId}`);
  const revision = detail.body.task.revision;

  const conflict = await post(`/tasks/${taskId}/commands`, { type: 'pause', expectedRevision: revision + 10 }, { ...headers, 'idempotency-key': 'idem-conflict-1' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
  assert.equal(conflict.body.error.details.currentRevision, revision);

  const pause = await post(`/tasks/${taskId}/commands`, { type: 'pause', expectedRevision: revision }, { ...headers, 'idempotency-key': 'idem-pause-1' });
  assert.equal(pause.status, 200);
  assert.equal(pause.body.task.sourceStatus, 'paused');

  const pausedDetail = await json(`/tasks/${taskId}`);
  const resume = await post(`/tasks/${taskId}/commands`, { type: 'resume', expectedRevision: pausedDetail.body.task.revision }, { ...headers, 'idempotency-key': 'idem-resume-1' });
  assert.equal(resume.status, 202);

  const freshDetail = await json(`/tasks/${taskId}`);
  const cancel = await post(`/tasks/${taskId}/commands`, { type: 'cancel', expectedRevision: freshDetail.body.task.revision }, { ...headers, 'idempotency-key': 'idem-cancel-1' });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.task.sourceStatus, 'cancelled');

  const store = new Store(root);
  await store.initialize();
  const commands = await store.listCommands();
  const taskCommands = commands.filter((entry) => entry.aggregate_id === taskId);
  const cancelled = taskCommands.filter((entry) => entry.status === 'cancelled');
  assert.ok(cancelled.length >= 1, 'queued commands are cancelled with the task');
});

test('overview returns independent current and queued collections with counts', async (t) => {
  const { json, post, headers } = await bootstrap(t, async ({ tasks }) => {
    await tasks.createTask({ request: '排队任务一，等待联系人释放。', status: 'queued', source: 'web_console' });
    await tasks.createTask({ request: '排队任务二，同样等待。', status: 'queued', source: 'web_console', priority: 'high' });
    const running = await tasks.createTask({ request: '运行中的任务，应出现在当前列表。' });
    await tasks.addSubtask(running.task_id, { title: '询问进度', target_employee_number: '00123456' });
  });
  await post('/tasks', { description: '控制台创建的第四个任务，直接排队。' }, headers);

  const overview = await json('/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.body.snapshotAt);
  assert.equal(overview.body.currentTasks.every((task) => ['running', 'waiting_external'].includes(task.displayStatus)), true);
  assert.equal(overview.body.queuedTasks.length, 3, 'one CLI queued + two seeded + one console task');
  assert.ok(overview.body.totalsByStatus.queued >= 3);
  const positions = overview.body.queuedTasks.map((task) => task.queuePosition);
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'stable queue order');
  assert.ok(Array.isArray(overview.body.pendingApprovals));
  assert.ok(Array.isArray(overview.body.recentActivity));
});

test('approval decision records payload and schedules apply command', async (t) => {
  const { json, post, headers, root } = await bootstrap(t, async ({ approvals, tasks, store }) => {
    const groups = await store.loadConfig('groups');
    const groupId = Object.keys(groups)[0];
    const task = await tasks.createTask({ request: '审批测试任务' });
    await approvals.createApproval({
      taskId: task.task_id,
      question: '发送项目周报',
      proposedAction: {
        type: 'send_message',
        target_type: 'group',
        target_id: groupId,
        display_target: groups[groupId].name,
        content: '大家好，项目周报已生成。'
      }
    });
  });

  const pending = await json('/approvals');
  assert.equal(pending.body.items.length, 1);
  const approval = pending.body.items[0];
  assert.equal(approval.kind, 'message');
  assert.equal(approval.decisionStatus, 'pending');
  assert.equal(approval.executionStatus, 'not_started');
  assert.deepEqual(approval.allowedDecisions, ['approve', 'reject', 'edit']);
  assert.ok(approval.payload.message.includes('周报'));

  const decided = await post(`/approvals/${approval.id}/decisions`, { decision: 'approve', expectedRevision: approval.revision }, { ...headers, 'idempotency-key': 'idem-decide-1' });
  assert.equal(decided.status, 202);
  assert.equal(decided.body.approval.decisionStatus, 'approved');
  assert.ok(decided.body.command);

  const afterApply = await json('/approvals?status=approved');
  assert.equal(afterApply.body.items[0].executionStatus, 'queued', 'external send is queued, not yet executed');

  // The store keeps the decision payload for the tick to replay exactly.
  const store = new Store(root);
  await store.initialize();
  const persisted = (await store.listApprovals()).find((entry) => entry.approval_id === approval.id);
  assert.equal(persisted.decision_payload.decision, 'approve');
});

test('schedule approval requires select_option with a valid option', async (t) => {
  const { json, post, headers } = await bootstrap(t, async ({ approvals, tasks }) => {
    const task = await tasks.createTask({ request: '日程审批任务' });
    await approvals.createApproval({
      taskId: task.task_id,
      question: '选择会议时间',
      proposedAction: {
        type: 'schedule_meeting',
        options: [
          { option_id: 'slot-1', label: '周二 14:00 到 15:00', attendance_text: '6/6 可参加', tone: 'good' },
          { option_id: 'slot-2', label: '周四 10:00 到 11:00', attendance_text: '4/6 可参加', tone: 'warn' }
        ]
      }
    });
  });

  const approval = (await json('/approvals')).body.items[0];
  assert.equal(approval.kind, 'schedule');
  const invalid = await post(`/approvals/${approval.id}/decisions`, { decision: 'approve', expectedRevision: approval.revision }, { ...headers, 'idempotency-key': 'idem-sched-1' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'APPROVAL_PAYLOAD_INVALID');

  const selected = await post(`/approvals/${approval.id}/decisions`, { decision: 'select_option', optionId: 'slot-1', expectedRevision: approval.revision }, { ...headers, 'idempotency-key': 'idem-sched-2' });
  assert.equal(selected.status, 202);
  assert.equal(selected.body.approval.decisionPayload.option_id, 'slot-1');
});

test('bulk decisions only mark for edit and never approve external actions', async (t) => {
  const { json, post, headers } = await bootstrap(t, async ({ approvals, tasks }) => {
    const task = await tasks.createTask({ request: '批量审批任务' });
    await approvals.createApproval({ taskId: task.task_id, question: '第一个确认' });
    await approvals.createApproval({ taskId: task.task_id, question: '第二个确认' });
  });
  const items = (await json('/approvals')).body.items;
  const all = await post('/approvals/bulk-decisions', { approvalIds: items.map((item) => item.id), decision: 'mark_for_edit' }, { ...headers, 'idempotency-key': 'idem-bulk-1' });
  assert.equal(all.status, 200);
  assert.equal(all.body.changed.length, 2);
  const rejectedBulk = await post('/approvals/bulk-decisions', { approvalIds: items.map((item) => item.id), decision: 'approve' }, { ...headers, 'idempotency-key': 'idem-bulk-2' });
  assert.equal(rejectedBulk.status, 400);
});

test('reminder policy returns typed 409 conflicts', async (t) => {
  const { json, post, headers, root } = await bootstrap(t, async ({ tasks }) => {
    const task = await tasks.createTask({ request: '催办策略任务' });
    // Not waiting_reply yet: reminder must be rejected as invalid state.
    await tasks.addSubtask(task.task_id, { title: '询问张三', target_employee_number: '00123456', required_information: ['当前状态'] });
  });

  const seeded = (await json('/tasks')).body.items;
  const task = seeded[0];
  const detail = await json(`/tasks/${task.id}`);
  const planStep = detail.body.task.plan[0];
  assert.ok(planStep);

  const invalidState = await post(`/tasks/${task.id}/subtasks/${planStep.id}/reminders`, {}, { ...headers, 'idempotency-key': 'idem-remind-1' });
  assert.equal(invalidState.status, 409);
  assert.equal(invalidState.body.error.code, 'INVALID_STATE_TRANSITION');

  // Now put the subtask into waiting_reply and hit the reminder limit.
  const store = new Store(root);
  await store.initialize();
  const runtimeTask = await store.loadTask(task.id);
  const subtask = runtimeTask.subtasks[0];
  subtask.status = 'waiting_reply';
  subtask.communication.reminder_count = 2;
  await store.saveTask(runtimeTask);

  const limit = await post(`/tasks/${task.id}/subtasks/${subtask.subtask_id}/reminders`, {}, { ...headers, 'idempotency-key': 'idem-remind-2' });
  assert.equal(limit.status, 409);
  assert.equal(limit.body.error.code, 'REMINDER_LIMIT_REACHED');

  // Due-date enforcement: reset the counter but set a future reminder time.
  const fresh = await store.loadTask(task.id);
  fresh.subtasks[0].communication.reminder_count = 0;
  fresh.subtasks[0].communication.next_reminder_at = new Date(Date.now() + 3_600_000).toISOString();
  await store.saveTask(fresh);
  const notDue = await post(`/tasks/${task.id}/subtasks/${subtask.subtask_id}/reminders`, {}, { ...headers, 'idempotency-key': 'idem-remind-3' });
  assert.equal(notDue.status, 409);
  assert.equal(notDue.body.error.code, 'REMINDER_NOT_DUE');
  assert.ok(notDue.body.error.details.nextReminderAt);
});

test('task events endpoint merges logs in stable order and filters by task', async (t) => {
  const { json, post, headers } = await bootstrap(t, async ({ tasks }) => {
    const task = await tasks.createTask({ request: '时间线合并任务' });
    await tasks.addSubtask(task.task_id, { title: '询问进展', target_employee_number: '00123456' });
  });
  const created = await post('/tasks', { description: '第二个任务，用来检查过滤效果。' }, headers);
  void created;

  const items = (await json('/tasks')).body.items;
  const target = items[0];
  const events = await json(`/tasks/${target.id}/events`);
  assert.equal(events.status, 200);
  const occurred = events.body.items.map((item) => item.occurredAt);
  assert.deepEqual(occurred, [...occurred].sort(), 'occurredAt ascending within the batch');
  assert.ok(events.body.items.every((item) => item.taskId === target.id));
  assert.ok(events.body.items.every((item) => typeof item.sequence === 'number'));
});

test('missing resources return the documented 404 envelope', async (t) => {
  const { json } = await bootstrap(t);
  const task = await json('/tasks/TASK-19990101-XXXXXX');
  assert.equal(task.status, 404);
  assert.equal(task.body.error.code, 'TASK_NOT_FOUND');
  const command = await json('/commands/CMD-19990101-XXXXXX');
  assert.equal(command.status, 404);
  assert.equal(command.body.error.code, 'COMMAND_NOT_FOUND');
});

test('validation errors identify the offending field', async (t) => {
  const { post, headers } = await bootstrap(t);
  const short = await post('/tasks', { description: '太短' }, { ...headers, 'idempotency-key': 'idem-short-1' });
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, 'VALIDATION_ERROR');
  assert.equal(short.body.error.details.field, 'body.description');
});

test('idempotency: concurrent duplicate POSTs produce one command, body change conflicts (F-03)', async (t) => {
  const { post, headers, json, root } = await bootstrap(t);
  const description = '幂等并发检查的任务描述，长度足够。';
  const sharedHeaders = { ...headers, 'idempotency-key': 'idem-parallel-001' };

  // Fire two requests with the same key at the same time.
  const [first, second] = await Promise.all([
    post('/tasks', { description, priority: 'high' }, sharedHeaders),
    post('/tasks', { description, priority: 'high' }, sharedHeaders)
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202, 'the duplicate waits and receives the first result');
  assert.equal(second.body.task.id, first.body.task.id, 'same task id');
  assert.equal(second.body.command.id, first.body.command.id, 'same command id');

  // Same key, different body: hard conflict.
  const conflict = await post('/tasks', { description: '换了内容的不同任务描述，长度足够。' }, sharedHeaders);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  // Same body after completion: clean replay, still one task/command on disk.
  const replay = await post('/tasks', { description, priority: 'high' }, sharedHeaders);
  assert.equal(replay.status, 202);
  assert.equal(replay.body.command.id, first.body.command.id);
  const store = new Store(root);
  await store.initialize();
  assert.equal((await store.listCommands()).filter((command) => command.type === 'task.create').length, 1);
  const list = await json('/tasks');
  assert.equal(list.body.total, 1, 'no duplicate task created');
});

test('idempotency covers reminders and approval decisions (F-03)', async (t) => {
  const { post, headers, json, root } = await bootstrap(t, async ({ tasks }) => {
    const task = await tasks.createTask({ request: '催办幂等任务' });
    const subtask = await tasks.addSubtask(task.task_id, { title: '询问张三', target_employee_number: '00123456', required_information: ['状态'] });
    await tasks.updateSubtask(task.task_id, subtask.subtask_id, { status: 'waiting_reply' });
  });

  const detail = await json('/tasks');
  const task = detail.body.items[0];
  const subtaskId = (await json(`/tasks/${task.id}`)).body.task.plan[0].id;
  const remindHeaders = { ...headers, 'idempotency-key': 'idem-remind-parallel' };

  const [first, second] = await Promise.all([
    post(`/tasks/${task.id}/subtasks/${subtaskId}/reminders`, {}, remindHeaders),
    post(`/tasks/${task.id}/subtasks/${subtaskId}/reminders`, {}, remindHeaders)
  ]);
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.body.command.id, first.body.command.id, 'reminder replayed, not duplicated');

  const store = new Store(root);
  await store.initialize();
  const remindCommands = (await store.listCommands()).filter((command) => command.type === 'subtask.remind');
  assert.equal(remindCommands.length, 1, 'exactly one reminder command persisted');
});

test('retry on a failed task flows from HTTP to a tick assignment (F-04 e2e)', async (t) => {
  const { post, headers, json, root } = await bootstrap(t, async ({ tasks }) => {
    const task = await tasks.createTask({ request: 'HTTP 重试链路任务' });
    await tasks.changeStatus(task.task_id, 'failed');
  });

  const failed = (await json('/tasks')).body.items[0];
  assert.equal(failed.displayStatus, 'failed');
  const detail = await json(`/tasks/${failed.id}`);
  assert.ok(detail.body.task.allowedCommands.includes('retry'));

  const retry = await post(`/tasks/${failed.id}/commands`, { type: 'retry', expectedRevision: detail.body.task.revision }, { ...headers, 'idempotency-key': 'idem-retry-e2e' });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.command.status, 'queued');

  const { runCli } = await import('./helpers.mjs');
  const tick = await runCli(root, ['tick']);
  const assignment = tick.parsed.assignments.find((entry) => entry.command_id === retry.body.command.id);
  assert.ok(assignment, 'tick delivers the retry assignment');
  assert.equal(assignment.kind, 'retry_task');
});

test('server refuses non-loopback host binding (F-07)', async (t) => {
  const root = await createFixture({ withServer: true });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const { spawn } = await import('node:child_process');
  const path = await import('node:path');

  for (const host of ['0.0.0.0', '192.168.1.10']) {
    const child = spawn(process.execPath, [path.join(root, 'server/index.mjs'), '--host', host, '--port', '0'], { cwd: root });
    const result = await new Promise((resolve) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1, `host ${host} must be refused`);
    assert.match(result.stderr, /loopback/, 'error explains the loopback boundary');
  }
});

test('idempotency crash recovery: expired reservation is taken over, running outcome stays unknown (R-04)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const { IdempotencyService } = await import('../server/services/idempotency-service.mjs');
  const store = new Store(root);
  await store.initialize();

  const first = new IdempotencyService(store, { owner: '00000000' });
  const beginArgs = { route: 'POST /api/v1/tasks', key: 'crash-key-0001', pathname: '/api/v1/tasks', body: { description: '崩溃恢复检查的任务描述' } };
  const reserved = await first.begin(beginArgs);
  assert.ok(reserved.key);
  assert.ok(reserved.attemptId);

  // Simulate a crash after reservation but before the handler ran: expire
  // the reservation lease, then a fresh service instance (API restart) with
  // the same key takes over safely.
  const staleReserved = JSON.parse(JSON.stringify(await store.readIdempotency(reserved.key)));
  staleReserved.lease_until = new Date(Date.now() - 60_000).toISOString();
  await store.writeIdempotency(staleReserved);
  const restarted = new IdempotencyService(store, { owner: '00000000' });
  const takeover = await restarted.begin(beginArgs);
  assert.ok(takeover.key, 'expired reservation is taken over');
  assert.notEqual(takeover.attemptId, reserved.attemptId, 'takeover issues a fresh attempt');

  // The stale attempt can no longer transition the placeholder to running.
  await assert.rejects(() => restarted.markRunning(takeover.key, reserved.attemptId), /接管/);
  await restarted.markRunning(takeover.key, takeover.attemptId);

  // Crash while running: side effects are possible, so replays get a typed
  // unknown-outcome conflict instead of a blind re-execution — even after
  // the running lease expired.
  const staleRunning = JSON.parse(JSON.stringify(await store.readIdempotency(takeover.key)));
  staleRunning.lease_until = new Date(Date.now() - 60_000).toISOString();
  await store.writeIdempotency(staleRunning);
  await assert.rejects(async () => restarted.begin(beginArgs), (error) => {
    assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(error.details.phase, 'unknown_outcome');
    return true;
  }, 'running records never auto-take-over');

  // completed still replays normally.
  await restarted.complete(takeover.key, 202, { task: { id: 'TASK-X' } });
  const replay = await restarted.begin(beginArgs);
  assert.deepEqual(replay.replay.response, { task: { id: 'TASK-X' } });

  // fail() only drops our own reservation, never someone else's record.
  const other = await restarted.begin({ ...beginArgs, key: 'crash-key-0002' });
  await restarted.fail(other.key, 'ATT-not-the-owner');
  assert.ok(await store.readIdempotency(other.key), 'foreign attempt cannot delete the record');
  await restarted.fail(other.key, other.attemptId);
  assert.equal(await store.readIdempotency(other.key), null);
});

test('HTTP layer surfaces the idempotency key to handlers and returns fresh revision (observations)', async (t) => {
  const { post, headers, json, root } = await bootstrap(t);
  const created = await post('/tasks', { description: '响应 revision 一致性检查任务。' }, { ...headers, 'idempotency-key': 'idem-rev-check-1' });
  assert.equal(created.status, 202);

  const detail = await json(`/tasks/${created.body.task.id}`);
  assert.equal(created.body.task.revision, detail.body.task.revision, 'create response revision matches disk');

  // The command carries the client idempotency key for traceability.
  const store = new Store(root);
  await store.initialize();
  const command = (await store.listCommands()).find((entry) => entry.type === 'task.create');
  assert.equal(command.idempotency_key, 'idem-rev-check-1');
});

test('idempotency: immediate replay during the running window waits for completion (T-01)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const { IdempotencyService } = await import('../server/services/idempotency-service.mjs');
  const store = new Store(root);
  await store.initialize();

  const server1 = new IdempotencyService(store, { owner: '00000000' });
  const server2 = new IdempotencyService(store, { owner: '00000000' });
  const args = { route: 'POST /api/v1/tasks', key: 'immediate-replay-1', pathname: '/api/v1/tasks', body: { description: '即时重放时序检查的任务描述' } };

  const first = await server1.begin(args);
  await server1.markRunning(first.key, first.attemptId);

  // The client saw the (not yet persisted) response and replays immediately:
  // the second begin must WAIT for the live running record, not report an
  // unknown outcome.
  let replayOutcome = null;
  const replayPromise = server2.begin(args).then(
    (result) => { replayOutcome = result; return result; },
    (error) => { replayOutcome = error; throw error; },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(replayOutcome, null, 'replay is still waiting while the first request is live');

  // The first request finishes: record completed BEFORE the client could
  // act on the response (app.mjs sends the reply after complete()).
  await server1.complete(first.key, 202, { task: { id: 'TASK-REPLAY' }, command: { id: 'CMD-1' } });
  const replay = await replayPromise;
  assert.ok(replay.replay, 'waiting replay resolves to the first result');
  assert.deepEqual(replay.replay.response, { task: { id: 'TASK-REPLAY' }, command: { id: 'CMD-1' } });
});

test('HTTP create + immediate replay is stable across repeated rounds (T-01 regression)', async (t) => {
  const { post, headers } = await bootstrap(t);
  for (let round = 0; round < 5; round += 1) {
    const shared = { ...headers, 'idempotency-key': `idem-t01-round-${round}` };
    const description = `即时重放稳定性检查 第 ${round} 轮任务描述`;
    const first = await post('/tasks', { description }, shared);
    assert.equal(first.status, 202);
    // Fire the replay before anything else can run: complete() already
    // happened before the first response was sent, so this must never
    // produce unknown_outcome.
    const replay = await post('/tasks', { description }, shared);
    assert.equal(replay.status, 202, `round ${round}: replay is not misjudged`);
    assert.equal(replay.body.task.id, first.body.task.id, `round ${round}: same task`);
    assert.equal(replay.body.command.id, first.body.command.id, `round ${round}: same command`);
  }
});
