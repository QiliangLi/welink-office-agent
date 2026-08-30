import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Store } from '../scripts/lib/store.mjs';
import { CommandService } from '../scripts/lib/commands.mjs';
import { TaskService } from '../scripts/lib/task-service.mjs';
import { ApprovalService } from '../scripts/lib/approval-service.mjs';
import { SendService } from '../scripts/lib/send-service.mjs';
import { MessageService } from '../scripts/lib/message-service.mjs';
import { createFixture, runCli } from './helpers.mjs';
import { deriveProgress, deriveTaskView } from '../scripts/lib/task-status.mjs';

test('deriveTaskView maps every root status to its display status', () => {
  const cases = [
    ['queued', 'queued'],
    ['waiting_owner', 'waiting_approval'],
    ['paused', 'paused'],
    ['completed', 'completed'],
    ['cancelled', 'stopped'],
    ['failed', 'failed'],
  ];
  for (const [sourceStatus, expected] of cases) {
    const task = { task_id: 'TASK-X', status: sourceStatus, subtasks: [], pending_approval_ids: [] };
    const view = deriveTaskView(task, {});
    assert.equal(view.displayStatus, expected, `${sourceStatus} -> ${expected}`);
  }
});

function makeTask(overrides = {}) {
  return {
    task_id: 'TASK-X',
    status: 'running',
    priority: 'normal',
    pending_approval_ids: [],
    subtasks: [],
    working_summary: { next_actions: [] },
    ...overrides
  };
}

test('running derivation follows the documented priority order', () => {
  const waitingReply = { subtask_id: 'S1', title: '等回复', required: true, status: 'waiting_reply', target_employee_number: '00123456' };
  const ready = { subtask_id: 'S2', title: '可执行', required: true, status: 'ready_to_contact' };
  const queuedSlot = { subtask_id: 'S3', title: '排队', required: true, status: 'waiting_contact_slot', waiting_kind: 'contact_slot', queue_entered_at: '2026-08-30T04:00:00.000Z' };

  // 1. pending approval wins
  const withApproval = makeTask({ subtasks: [ready], pending_approval_ids: ['AP-1'] });
  const approvalView = deriveTaskView(withApproval, { approvals: [{ approval_id: 'AP-1', task_id: 'TASK-X', status: 'pending', question: '确认发送？' }] });
  assert.equal(approvalView.displayStatus, 'waiting_approval');
  assert.equal(approvalView.currentAction, '确认发送？');

  // 2. uncertain action wins over executable work
  const withUnknown = makeTask({ subtasks: [ready] });
  const unknownView = deriveTaskView(withUnknown, { actions: [{ action_id: 'ACT-1', task_id: 'TASK-X', status: 'unknown' }] });
  assert.equal(unknownView.displayStatus, 'partial');
  assert.match(unknownView.waitingReason, /待核实/);

  // 3. every required subtask in contact_slot -> queued, even with completed ones
  const allQueued = makeTask({ subtasks: [queuedSlot, { subtask_id: 'S0', title: '已完成', required: true, status: 'completed' }] });
  const queuedView = deriveTaskView(allQueued, {});
  assert.equal(queuedView.displayStatus, 'queued');
  assert.equal(queuedView.waitingKind, 'contact_slot');

  // 4. other executable work keeps the task running despite one slot wait
  const mixed = makeTask({ subtasks: [queuedSlot, ready] });
  const mixedView = deriveTaskView(mixed, {});
  assert.equal(mixedView.displayStatus, 'running');

  // 5. all waiting on reply -> waiting_external
  const external = makeTask({ subtasks: [waitingReply] });
  const externalView = deriveTaskView(external, { contactNames: { '00123456': '张三' } });
  assert.equal(externalView.displayStatus, 'waiting_external');
  assert.match(externalView.waitingReason, /张三/);

  // 6. completed + failed mix -> partial
  const partial = makeTask({ subtasks: [
    { subtask_id: 'S1', title: '完成', required: true, status: 'completed' },
    { subtask_id: 'S2', title: '失败', required: true, status: 'failed' }
  ] });
  const partialView = deriveTaskView(partial, {});
  assert.equal(partialView.displayStatus, 'partial');
});

test('progress counts required subtasks only', () => {
  const task = makeTask({ subtasks: [
    { subtask_id: 'S1', status: 'completed', required: true },
    { subtask_id: 'S2', status: 'waiting_reply', required: true },
    { subtask_id: 'S3', status: 'ready_to_contact', required: false }
  ] });
  assert.deepEqual(deriveProgress(task), { progress: 50, completedSubtasks: 1, totalSubtasks: 2 });
  assert.deepEqual(deriveProgress(makeTask({})), { progress: 0, completedSubtasks: 0, totalSubtasks: 0 });
});

test('contact slot queue blocks the second task and releases in stable order', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);

  const taskA = await tasks.createTask({ request: '任务A', priority: 'normal' });
  const taskB = await tasks.createTask({ request: '任务B', priority: 'high' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: '联系王璐', target_employee_number: '00123456' });

  const first = await sends.sendUser({ employeeNumber: '00123456', text: 'A 的问题', taskId: taskA.task_id, subtaskId: subA.subtask_id });
  assert.equal(first.queued, false);
  assert.equal(first.action.status, 'dry_run');

  const second = await sends.sendUser({ employeeNumber: '00123456', text: 'B 的问题', taskId: taskB.task_id, subtaskId: subB.subtask_id });
  assert.equal(second.queued, true, 'second send to the same contact must queue');
  assert.equal(second.position, 1);
  assert.equal(second.holderTaskId, taskA.task_id);

  const taskBAfter = await store.loadTask(taskB.task_id);
  const subBAfter = taskBAfter.subtasks.find((entry) => entry.subtask_id === subB.subtask_id);
  assert.equal(subBAfter.status, 'waiting_contact_slot');
  assert.equal(subBAfter.waiting_kind, 'contact_slot');
  assert.equal(subBAfter.blocked_by_task_id, taskA.task_id);
  assert.ok(subBAfter.queue_entered_at);

  // High priority B entered the queue; closing A's conversation promotes B.
  const conversations = await store.listConversations();
  const activeA = conversations.find((entry) => entry.status === 'active' && entry.task_id === taskA.task_id);
  const { releaseContactSlot } = await import('../scripts/lib/contact-slots.mjs');
  const result = await releaseContactSlot(store, activeA, { reason: 'replied' });
  assert.equal(result.released, true);
  assert.equal(result.promoted.task_id, taskB.task_id);

  const taskBFinal = await store.loadTask(taskB.task_id);
  const subBFinal = taskBFinal.subtasks.find((entry) => entry.subtask_id === subB.subtask_id);
  assert.equal(subBFinal.status, 'ready_to_contact');
  assert.equal(subBFinal.waiting_kind, null);
  assert.ok(subBFinal.conversation_id, 'promoted subtask holds a fresh conversation');

  // Releasing twice must not promote anyone else (idempotent slot release).
  const again = await releaseContactSlot(store, activeA, { reason: 'replied' });
  assert.equal(again.released, false);
});

test('reply attribution: exact thread match, unique active conversation, and ambiguous stays unattributed', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);
  const messages = new MessageService(store);
  const { createConversation, contactKeyFor } = await import('../scripts/lib/conversations.mjs');

  const task = await tasks.createTask({ request: '归属测试' });
  const sub = await tasks.addSubtask(task.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const send = await sends.sendUser({ employeeNumber: '00123456', text: '在吗', taskId: task.task_id, subtaskId: sub.subtask_id });

  // 1. unique active conversation: attributed even without thread ids.
  const inbound = await messages.recordInbound({ participantType: 'user', participantId: '00123456', content: '在的' });
  assert.equal(inbound.attribution.status, 'attributed');
  assert.equal(inbound.attribution.conversation.task_id, task.task_id);
  assert.equal(inbound.message.attribution_status, 'attributed');

  // 2. explicit reply/thread id wins.
  const explicit = await messages.recordInbound({ participantType: 'user', participantId: '00123456', content: '已确认', replyToActionId: send.action.action_id });
  assert.equal(explicit.attribution.conversation.conversation_id, send.action.conversation_id);

  // 3. two candidate conversations (an unrelated active one exists) with no thread id -> unresolved.
  const otherTask = await tasks.createTask({ request: '另一个任务' });
  await createConversation(store, {
    contactType: 'user',
    contactKey: contactKeyFor('user', '00123456'),
    taskId: otherTask.task_id,
    subtaskId: null
  });
  const ambiguous = await messages.recordInbound({ participantType: 'user', participantId: '00123456', content: '这句属于谁？' });
  assert.equal(ambiguous.attribution.status, 'unresolved_multiple');
  assert.equal(ambiguous.message.task_id, null);
  assert.equal(ambiguous.message.subtask_id, null);

  // 4. no active conversation -> unattributed.
  for (const conversation of await store.listConversations()) {
    conversation.status = 'closed';
    await store.saveConversation(conversation);
  }
  const orphan = await messages.recordInbound({ participantType: 'user', participantId: '00123456', content: '突然发来一句' });
  assert.equal(orphan.attribution.status, 'unattributed');
});

test('approval apply executes the approved send exactly once via tick', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const approvals = new ApprovalService(store, commands);
  const groups = await store.loadConfig('groups');
  const groupId = Object.keys(groups).find((id) => groups[id].trusted && groups[id].type === 'project') ?? Object.keys(groups)[0];

  const approval = await approvals.createApproval({
    taskId: (await new TaskService(store, commands).createTask({ request: '周报' })).task_id,
    question: '发送周报',
    proposedAction: {
      type: 'send_message',
      target_type: 'group',
      target_id: groupId,
      display_target: groups[groupId].name,
      content: '大家好，项目周报已生成。'
    }
  });
  const decision = await approvals.recordDecision({ approvalId: approval.approval_id, decision: 'approve', expectedRevision: approval.revision });
  assert.ok(decision.commandId);

  // First tick consumes the approval.apply command and performs the dry-run send.
  const tick = await runCli(root, ['tick']);
  assert.equal(tick.code, 0);
  const executed = tick.parsed.executed.find((entry) => entry.command_id === decision.commandId);
  assert.ok(executed, 'tick reports the executed command');
  assert.equal(executed.status, 'succeeded');
  assert.equal(executed.action_status, 'dry_run');

  const messages = await store.readJsonlAll('messages.jsonl');
  const outbound = messages.filter((entry) => entry.direction === 'outbound' && entry.participant_id === groupId);
  assert.equal(outbound.length, 1, 'approved message logged once');

  // Second tick must not resend: command already completed.
  const tickAgain = await runCli(root, ['tick']);
  assert.equal(tickAgain.parsed.executed.find((entry) => entry.command_id === decision.commandId), undefined);
  const messagesAfter = await store.readJsonlAll('messages.jsonl');
  assert.equal(messagesAfter.filter((entry) => entry.direction === 'outbound').length, outbound.length, 'no duplicate send');
});

test('command lease recovery returns expired claims to the queue', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const task = await tasks.createTask({ request: '租约测试' });
  const { command } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task.task_id });

  const claimed = await commands.claimNext({ workerId: 'worker-1' });
  assert.equal(claimed.command_id, command.command_id);

  // Simulate a crashed worker: lease already expired.
  const stale = await store.loadCommand(command.command_id);
  stale.lease_until = new Date(Date.now() - 60_000).toISOString();
  await store.saveCommand(stale);

  const recovered = await commands.recoverExpiredLeases();
  assert.deepEqual(recovered, [command.command_id]);
  const after = await store.loadCommand(command.command_id);
  assert.equal(after.status, 'queued');

  const reclaimed = await commands.claimNext({ workerId: 'worker-2' });
  assert.equal(reclaimed.command_id, command.command_id);
});

test('paused tasks keep their queued commands untouched by tick', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  const task = await tasks.createTask({ request: '暂停测试', status: 'queued', source: 'web_console' });
  await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task.task_id });
  await tasks.pause(task.task_id);

  const tick = await runCli(root, ['tick']);
  assert.equal(tick.code, 0);
  assert.equal(tick.parsed.assignments.length, 0, 'no planning assignment while paused');

  const pending = (await store.listCommands()).find((entry) => entry.type === 'task.create');
  assert.equal(pending.status, 'queued', 'command stays queued for resume');
});

test('concurrent task creation never loses active_task_ids (F-02 regression)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  await Promise.all(Array.from({ length: 6 }, (_, index) => tasks.createTask({ request: `并发任务 ${index}` })));
  const state = await store.loadState();
  assert.equal(state.active_task_ids.length, 6, 'every concurrent create registered its task id');
  assert.deepEqual([...state.active_task_ids].sort().length, new Set(state.active_task_ids).size);
});

test('approval decision and concurrent subtask update do not overwrite each other (F-02 regression)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const approvals = new ApprovalService(store, commands);

  const task = await tasks.createTask({ request: '并发审批任务' });
  const subtask = await tasks.addSubtask(task.task_id, { title: '询问进展', target_employee_number: '00123456' });
  const approval = await approvals.createApproval({ taskId: task.task_id, question: '是否继续？' });

  // Console decision and an Agent-side subtask update race on the same task.
  await Promise.all([
    approvals.recordDecision({ approvalId: approval.approval_id, decision: 'approve', expectedRevision: approval.revision }),
    tasks.updateSubtask(task.task_id, subtask.subtask_id, { status: 'completed', summary: '已收集' })
  ]);

  const finalTask = await store.loadTask(task.task_id);
  assert.equal(finalTask.subtasks[0].status, 'completed', 'agent subtask update survived');
  assert.equal(finalTask.pending_approval_ids.length, 0, 'decision cleared the pending list');
  assert.equal(finalTask.status, 'running', 'task left waiting_owner');
});

test('delayed reply to a closed conversation is not attributed to the next task (F-05 regression)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);
  const messages = new MessageService(store);
  const { releaseContactSlot } = await import('../scripts/lib/contact-slots.mjs');

  const taskA = await tasks.createTask({ request: '任务A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: 'A 询问王璐', target_employee_number: '00123456' });
  const sendA = await sends.sendUser({ employeeNumber: '00123456', text: 'A 的问题', taskId: taskA.task_id, subtaskId: subA.subtask_id });
  const conversationA = await store.loadConversation(sendA.action.conversation_id);

  // A's conversation closes (timeout/reply processed), B acquires the slot.
  await releaseContactSlot(store, conversationA, { reason: 'closed' });
  const taskB = await tasks.createTask({ request: '任务B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: 'B 询问王璐', target_employee_number: '00123456' });
  const sendB = await sends.sendUser({ employeeNumber: '00123456', text: 'B 的问题', taskId: taskB.task_id, subtaskId: subB.subtask_id });
  assert.equal(sendB.queued, false, 'B holds the slot now');

  // The contact finally answers A's old message, carrying A's correlation id.
  const late = await messages.recordInbound({
    participantType: 'user',
    participantId: '00123456',
    content: 'A 的问题答复：已完成',
    replyToActionId: sendA.action.action_id
  });
  assert.equal(late.attribution.status, 'attributed');
  assert.equal(late.attribution.conversation.conversation_id, conversationA.conversation_id, 'explicit id wins across closed conversations');
  assert.equal(late.message.task_id, taskA.task_id, 'reply landed on task A, not B');
  assert.equal(late.message.subtask_id, subA.subtask_id);
  assert.equal(late.message.attribution_status, 'attributed');

  // The raw message was persisted with its attribution in one record.
  const logs = await store.readJsonlAll('messages.jsonl');
  const recorded = logs.find((entry) => entry.log_id === late.message.log_id);
  assert.equal(recorded.task_id, taskA.task_id);
});

test('message log entry is written before conversation mutation (F-05 ordering)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);
  const messages = new MessageService(store);

  const task = await tasks.createTask({ request: '落盘顺序' });
  const sub = await tasks.addSubtask(task.task_id, { title: '询问', target_employee_number: '00123456' });
  const send = await sends.sendUser({ employeeNumber: '00123456', text: '在吗', taskId: task.task_id, subtaskId: sub.subtask_id });
  const beforeInbound = await store.loadConversation(send.action.conversation_id);
  const originalInboundAt = beforeInbound.last_inbound_at;

  const { message } = await messages.recordInbound({ participantType: 'user', participantId: '00123456', content: '在的' });
  const logs = await store.readJsonlAll('messages.jsonl');
  assert.ok(logs.some((entry) => entry.log_id === message.log_id), 'raw message persisted');
  const after = await store.loadConversation(send.action.conversation_id);
  assert.notEqual(after.last_inbound_at, originalInboundAt, 'conversation updated only after the message record exists');
});

test('waiting_agent assignments: ack keeps ownership, lease expiry redelivers, cancel revokes (F-06)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  const task = await tasks.createTask({ request: 'assignment 协议' });
  const { command } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task.task_id });

  const claimed = await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(claimed.command_id, { leaseMs: 60_000 });
  let current = await store.loadCommand(command.command_id);
  assert.equal(current.status, 'waiting_agent');
  assert.equal(current.assignment_state, 'delivered');
  assert.ok(current.lease_until, 'delivered assignment keeps its lease');

  // Host acks: lease cleared, no longer recoverable or cancellable.
  await commands.ackCommand(command.command_id);
  current = await store.loadCommand(command.command_id);
  assert.equal(current.assignment_state, 'acked');
  assert.equal(current.lease_until, null);
  assert.deepEqual(await commands.recoverExpiredLeases(), []);

  // Acked assignments survive task cancellation (host re-checks task state).
  await tasks.cancel(task.task_id);
  current = await store.loadCommand(command.command_id);
  assert.equal(current.status, 'waiting_agent', 'acked assignment is not cancelled');

  // Unacked assignments ARE cancelled by task cancellation.
  const task2 = await tasks.createTask({ request: '取消撤销' });
  const { command: cmd2 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task2.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(cmd2.command_id, { leaseMs: 60_000 });
  await tasks.cancel(task2.task_id);
  const cancelledCmd = await store.loadCommand(cmd2.command_id);
  assert.equal(cancelledCmd.status, 'cancelled', 'delivered-but-unacked assignment is revoked');

  // Complete refuses to resurrect a cancelled command.
  await commands.complete(cmd2.command_id, { status: 'succeeded' });
  assert.equal((await store.loadCommand(cmd2.command_id)).status, 'cancelled');

  // Delivered-but-unacked assignment with expired lease is redelivered.
  const task3 = await tasks.createTask({ request: '重投递' });
  const { command: cmd3 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task3.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(cmd3.command_id, { leaseMs: 60_000 });
  const stale = await store.loadCommand(cmd3.command_id);
  stale.lease_until = new Date(Date.now() - 60_000).toISOString();
  await store.saveCommand(stale);
  const recovered = await commands.recoverExpiredLeases();
  assert.deepEqual(recovered, [cmd3.command_id], 'unacked assignment requeued after lease expiry');
  assert.equal((await store.loadCommand(cmd3.command_id)).status, 'queued');
});

test('failed task retry reaches tick as a retry_task assignment (F-04 e2e)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  const task = await tasks.createTask({ request: '失败重试任务', source: 'web_console' });
  await tasks.changeStatus(task.task_id, 'failed');

  const { runCli } = await import('./helpers.mjs');
  // CLI path first: create the retry command the way the console would.
  const { command } = await commands.create({ type: 'task.retry', aggregateType: task.task_id && 'task', aggregateId: task.task_id });
  const tick = await runCli(root, ['tick']);
  assert.equal(tick.code, 0);
  const assignment = tick.parsed.assignments.find((entry) => entry.command_id === command.command_id);
  assert.ok(assignment, 'tick delivered the retry assignment');
  assert.equal(assignment.kind, 'retry_task');
  assert.equal(assignment.task_status, 'failed');

  // Host completes the assignment.
  const done = await runCli(root, ['complete-command', '--command-id', command.command_id, '--status', 'succeeded']);
  assert.equal(done.parsed.command.status, 'succeeded');
});
