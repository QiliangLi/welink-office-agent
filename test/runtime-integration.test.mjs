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

test('assignment protocol: claim/cancel/deliver, ack/cancel/begin, lease redelivery (R-03)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  // --- Cancel between claim and delivery must win (no resurrection). ---
  const task1 = await tasks.createTask({ request: 'claim 后取消' });
  const { command: cmd1 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task1.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await tasks.cancel(task1.task_id);
  const delivered = await commands.markWaitingAgent(cmd1.command_id, { leaseMs: 60_000 });
  assert.equal(delivered.status, 'cancelled', 'cancelled command never becomes waiting_agent');
  await commands.complete(cmd1.command_id, { status: 'succeeded' });
  assert.equal((await store.loadCommand(cmd1.command_id)).status, 'cancelled', 'complete cannot resurrect');

  // --- Cancel revokes acked assignments; executing ones stay with host. ---
  const task2 = await tasks.createTask({ request: 'acked 取消' });
  const { command: cmd2 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task2.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(cmd2.command_id, { leaseMs: 60_000 });
  await commands.ackCommand(cmd2.command_id);
  let current = await store.loadCommand(cmd2.command_id);
  assert.equal(current.assignment_state, 'acked');

  await tasks.cancel(task2.task_id);
  current = await store.loadCommand(cmd2.command_id);
  assert.equal(current.status, 'cancelled', 'acked-but-not-started assignment is revoked by cancellation');

  const task2b = await tasks.createTask({ request: 'executing 保留' });
  const { command: cmd2b } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task2b.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(cmd2b.command_id, { leaseMs: 60_000 });
  await commands.ackCommand(cmd2b.command_id);
  await commands.beginCommand(cmd2b.command_id);
  await tasks.cancel(task2b.task_id);
  current = await store.loadCommand(cmd2b.command_id);
  assert.equal(current.status, 'waiting_agent', 'executing assignment survives cancellation');
  assert.equal(current.assignment_state, 'executing');

  // --- Recovery: delivered + expired lease is redelivered; acked is not. ---
  const task3 = await tasks.createTask({ request: '重投递' });
  const { command: cmd3 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task3.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(cmd3.command_id, { leaseMs: 60_000 });
  const stale = await store.loadCommand(cmd3.command_id);
  stale.lease_until = new Date(Date.now() - 60_000).toISOString();
  await store.saveCommand(stale);
  assert.deepEqual(await commands.recoverExpiredLeases(), [cmd3.command_id], 'delivered assignment requeued after lease expiry');
  assert.equal((await store.loadCommand(cmd3.command_id)).status, 'queued');

  // The restarted host re-claims the redelivered assignment and moves it to
  // executing, taking it out of the queue.
  await commands.claimNext({ workerId: 'w2' });
  await commands.markWaitingAgent(cmd3.command_id, { leaseMs: 60_000 });
  await commands.ackCommand(cmd3.command_id);
  await commands.beginCommand(cmd3.command_id);

  const task4 = await tasks.createTask({ request: 'acked 不重投' });
  const { command: cmd4 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task4.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await commands.markWaitingAgent(cmd4.command_id, { leaseMs: 60_000 });
  await commands.ackCommand(cmd4.command_id);
  const staleAcked = await store.loadCommand(cmd4.command_id);
  staleAcked.lease_until = new Date(Date.now() - 60_000).toISOString();
  await store.saveCommand(staleAcked);
  assert.deepEqual(await commands.recoverExpiredLeases(), [], 'acked assignment is never auto-redelivered (resume protocol)');
  assert.equal((await store.loadCommand(cmd4.command_id)).status, 'waiting_agent');

  // --- begin/ack reject commands in the wrong state. ---
  await assert.rejects(() => commands.ackCommand(cmd3.command_id), /not a delivered assignment/);
  await assert.rejects(() => commands.beginCommand(cmd1.command_id), /not an acked assignment/);

  // --- releaseClaim only releases claimed commands. ---
  const task5 = await tasks.createTask({ request: 'releaseClaim 边界' });
  const { command: cmd5 } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task5.task_id });
  await commands.claimNext({ workerId: 'w1' });
  await tasks.cancel(task5.task_id);
  await commands.releaseClaim(cmd5.command_id);
  assert.equal((await store.loadCommand(cmd5.command_id)).status, 'cancelled', 'releaseClaim does not resurrect cancelled commands');
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

test('explicit-but-unknown reply marker never falls back to the active conversation (R-02 regression)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);
  const messages = new MessageService(store);

  // Task A's conversation exists but is closed; task B holds the only
  // active conversation for the contact.
  const taskA = await tasks.createTask({ request: '历史任务 A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: 'A 询问', target_employee_number: '00123456' });
  const sendA = await sends.sendUser({ employeeNumber: '00123456', text: 'A 的问题', taskId: taskA.task_id, subtaskId: subA.subtask_id });
  const { releaseContactSlot } = await import('../scripts/lib/contact-slots.mjs');
  await releaseContactSlot(store, await store.loadConversation(sendA.action.conversation_id), { reason: 'closed' });

  const taskB = await tasks.createTask({ request: '当前任务 B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: 'B 询问', target_employee_number: '00123456' });
  await sends.sendUser({ employeeNumber: '00123456', text: 'B 的问题', taskId: taskB.task_id, subtaskId: subB.subtask_id });

  // A reply carrying a marker that matches no local record: must NOT be
  // attributed to B just because B is the unique active conversation.
  const unknown = await messages.recordInbound({
    participantType: 'user',
    participantId: '00123456',
    content: '这句是别处的回复',
    replyToActionId: 'ACT-UNKNOWN-000000'
  });
  assert.equal(unknown.attribution.status, 'unattributed');
  assert.equal(unknown.attribution.reason, 'explicit_marker_unmatched');
  assert.equal(unknown.message.task_id, null, 'task B is not polluted');
  assert.equal(unknown.message.subtask_id, null);
  assert.equal(unknown.message.conversation_id, null);

  // Same for an unknown thread id.
  const unknownThread = await messages.recordInbound({
    participantType: 'user',
    participantId: '00123456',
    content: '另一句别处的回复',
    externalThreadId: 'CONV-UNKNOWN-000000'
  });
  assert.equal(unknownThread.attribution.status, 'unattributed');
  assert.equal(unknownThread.attribution.reason, 'explicit_marker_unmatched');
  assert.equal(unknownThread.message.task_id, null);
});

test('concurrent reminder send and console instruction both persist (R-01 barrier regression)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  const task = await tasks.createTask({ request: '催办并发任务' });
  const subtask = await tasks.addSubtask(task.task_id, { title: '询问张三', target_employee_number: '00123456', required_information: ['状态'] });
  await tasks.updateSubtask(task.task_id, subtask.subtask_id, { status: 'waiting_reply' });
  const { command } = await commands.create({
    type: 'subtask.remind',
    aggregateType: 'task',
    aggregateId: task.task_id,
    payload: { task_id: task.task_id, subtask_id: subtask.subtask_id }
  });

  // Real cross-process race: tick (separate process) bumps the reminder
  // counters while the console path appends instructions to the same task.
  const { runCli } = await import('./helpers.mjs');
  await Promise.all([
    runCli(root, ['tick']),
    tasks.addInstruction(task.task_id, '先只汇总市场反馈'),
    tasks.addInstruction(task.task_id, '不要联系财务')
  ]);

  const finalTask = await store.loadTask(task.task_id);
  assert.equal(finalTask.instructions.length, 2, 'concurrent instructions are not lost');
  const fresh = finalTask.subtasks.find((entry) => entry.subtask_id === subtask.subtask_id);
  assert.equal(fresh.communication.reminder_count, 1, 'reminder counted exactly once');
  assert.ok(fresh.communication.next_reminder_at, 'reminder due time recorded');
  assert.equal((await store.loadCommand(command.command_id)).status, 'succeeded');
});

test('completion re-evaluates blockers inside the task lock (R-01 regression)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const approvals = new ApprovalService(store, commands);

  const task = await tasks.createTask({ request: '完成竞态任务' });
  const subtask = await tasks.addSubtask(task.task_id, { title: '已完成部分', target_employee_number: '00123456' });
  await tasks.updateSubtask(task.task_id, subtask.subtask_id, { status: 'completed' });

  // Race: complete-task vs a pending approval landing on the same task.
  // The lock re-check must let completion win ONLY when it truly ran first;
  // afterwards a new approval can never attach to a completed task.
  const results = await Promise.allSettled([
    tasks.completeTask(task.task_id, { summary: '竞态完成' }),
    approvals.createApproval({ taskId: task.task_id, question: '竞态审批？' })
  ]);

  const finalTask = await store.loadTask(task.task_id);
  const completion = results[0];
  const approvalResult = results[1];
  const orphanApprovals = (await store.listApprovals())
    .filter((entry) => entry.task_id === task.task_id && entry.status === 'pending');
  if (completion.status === 'fulfilled' && completion.value.ok) {
    assert.equal(finalTask.status, 'completed');
    assert.equal(approvalResult.status, 'rejected', 'approval cannot attach to a completed task');
    assert.equal(finalTask.pending_approval_ids.length, 0);
    assert.equal(orphanApprovals.length, 0, 'no orphan pending approval on the completed task');
  } else {
    assert.equal(finalTask.status, 'waiting_owner', 'approval landed first and blocks completion');
    assert.equal(approvalResult.status, 'fulfilled');
    assert.equal(finalTask.pending_approval_ids.length, 1);
    assert.equal(orphanApprovals.length, 1, 'the winning approval is the only pending record');
    assert.notEqual(finalTask.status, 'completed', 'completion never rides over fresh blockers');
  }
});

test('lease recovery never overwrites a concurrent ack or begin (T-02)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);

  for (let round = 0; round < 12; round += 1) {
    const task = await tasks.createTask({ request: `恢复竞态 ${round}` });
    const { command } = await commands.create({ type: 'task.create', aggregateType: 'task', aggregateId: task.task_id });
    await commands.claimNext({ workerId: 'w1' });
    await commands.markWaitingAgent(command.command_id, { leaseMs: 30 });
    // Force the lease to its boundary so recovery is eligible.
    const stale = await store.loadCommand(command.command_id);
    stale.lease_until = new Date(Date.now() - 5).toISOString();
    await store.saveCommand(stale);

    const ackOutcome = await commands.ackCommand(command.command_id).then(
      () => 'acked',
      (error) => error.code,
    );
    const recovered = await commands.recoverExpiredLeases();
    const final = await store.loadCommand(command.command_id);

    if (ackOutcome === 'acked') {
      assert.ok(!recovered.includes(command.command_id), `round ${round}: acked command must not be recovered`);
      assert.equal(final.status, 'waiting_agent');
      assert.equal(final.assignment_state, 'acked');
    } else {
      assert.equal(ackOutcome, 'INVALID_STATE_TRANSITION', `round ${round}: only ack rejection explains recovery`);
      assert.ok(recovered.includes(command.command_id), `round ${round}: recovered command was not acked`);
      assert.equal(final.status, 'queued');
    }
    await tasks.cancel(task.task_id); // cleanup for next round
  }
});

test('cancelling a task revokes its approval.apply commands via parent_task_id (T-03)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const approvals = new ApprovalService(store, commands);
  const groups = await store.loadConfig('groups');
  const groupId = Object.keys(groups)[0];

  const task = await tasks.createTask({ request: '取消审批命令任务' });
  const approval = await approvals.createApproval({
    taskId: task.task_id,
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
  const applyCommand = await store.loadCommand(decision.commandId);
  assert.equal(applyCommand.parent_task_id, task.task_id, 'approval.apply carries the parent task id');

  const { cancelledCommands } = await tasks.cancel(task.task_id);
  assert.ok(cancelledCommands.includes(decision.commandId), 'cancellation revokes the approval.apply command');
  assert.equal((await store.loadCommand(decision.commandId)).status, 'cancelled');

  // Tick must not resurrect or execute it.
  const { runCli } = await import('./helpers.mjs');
  const tick = await runCli(root, ['tick']);
  assert.equal(tick.parsed.executed.find((entry) => entry.command_id === decision.commandId), undefined);
  assert.equal((await store.loadCommand(decision.commandId)).status, 'cancelled');

  // No send ever landed on the wire for this task.
  const messages = await store.readJsonlAll('messages.jsonl');
  assert.equal(messages.filter((entry) => entry.direction === 'outbound' && entry.task_id === task.task_id).length, 0);
});

test('action pre-persistence serializes with task completion (T-04)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);

  const task = await tasks.createTask({ request: '完成与外发竞态' });
  const subtask = await tasks.addSubtask(task.task_id, { title: '询问', target_employee_number: '00123456' });

  // Barrier: hold the task lock (the completion critical section) and prove
  // the send cannot pre-persist its action outside the lock.
  await store.locks.acquire(`task:${task.task_id}`);
  let sendSettled = false;
  const sendPromise = sends.executeSend({
    actionType: 'send_user_message',
    targetType: 'user',
    targetId: '00123456',
    cliArgs: ['im', 'send-to-user', '--receiver', 'z00123456', '--text', '竞态消息'],
    content: '竞态消息',
    taskId: task.task_id,
    subtaskId: subtask.subtask_id,
    rejectFinishedTask: true
  }).then(
    (value) => { sendSettled = true; return value; },
    (error) => { sendSettled = true; throw error; },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sendSettled, false, 'send waits for the task lock');
  assert.equal((await store.listActions()).length, 0, 'action is never pre-persisted outside the task lock');
  await store.locks.release(`task:${task.task_id}`);

  // Whichever write wins the lock, the invariant must hold:
  // a completed task never carries an uncertain action.
  const completion = await tasks.completeTask(task.task_id).then(
    (value) => value,
    (error) => ({ ok: false, error }),
  );
  const outcome = await sendPromise.then(
    () => 'sent',
    (error) => error.code,
  );
  const finalTask = await store.loadTask(task.task_id);
  const taskActions = (await store.listActions()).filter((action) => action.task_id === task.task_id);

  if (completion.ok) {
    assert.equal(finalTask.status, 'completed');
    assert.equal(outcome, 'INVALID_STATE_TRANSITION', 'send after completion is refused');
    assert.equal(taskActions.length, 0, 'no action landed on a completed task');
  } else {
    assert.equal(finalTask.status, 'running', 'completion is blocked by the fresh action');
    assert.equal(outcome, 'sent');
    assert.ok(taskActions.some((action) => ['executing', 'dry_run', 'succeeded'].includes(action.status)), 'action exists and blocks completion');
  }
});

test('deterministic orders: completed task refuses sends, fresh action blocks completion (T-04)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);

  // Order A: completion first, send after -> refused, no action file.
  const taskA = await tasks.createTask({ request: '顺序 A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: '询问', target_employee_number: '00123456' });
  await tasks.updateSubtask(taskA.task_id, subA.subtask_id, { status: 'completed' });
  await tasks.completeTask(taskA.task_id);
  await assert.rejects(
    () => sends.executeSend({
      actionType: 'send_user_message',
      targetType: 'user',
      targetId: '00123456',
      cliArgs: ['im', 'send-to-user', '--receiver', 'z00123456', '--text', 'x'],
      content: 'x',
      taskId: taskA.task_id,
      subtaskId: subA.subtask_id,
      rejectFinishedTask: true
    }),
    (error) => error.code === 'INVALID_STATE_TRANSITION',
  );
  assert.equal((await store.listActions()).filter((action) => action.task_id === taskA.task_id).length, 0);

  // Order B: send first (executing action lands), completion after -> blocked.
  const taskB = await tasks.createTask({ request: '顺序 B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: '询问', target_employee_number: '00678901' });
  const send = await sends.executeSend({
    actionType: 'send_user_message',
    targetType: 'user',
    targetId: '00678901',
    cliArgs: ['im', 'send-to-user', '--receiver', 'l00678901', '--text', 'y'],
    content: 'y',
    taskId: taskB.task_id,
    subtaskId: subB.subtask_id,
    rejectFinishedTask: true
  });
  assert.equal(send.action.status, 'dry_run');
  const completion = await tasks.completeTask(taskB.task_id);
  assert.equal(completion.ok, false, 'uncertain/in-flight action blocks completion');
  assert.ok(completion.blocking.uncertain_actions.length > 0 || completion.blocking.waiting_replies.length > 0);
});

test('createApproval on a terminal task leaves no orphan pending record (T-05)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const approvals = new ApprovalService(store, commands);

  for (const status of ['completed', 'cancelled', 'failed']) {
    const task = await tasks.createTask({ request: `终态任务 ${status}` });
    await tasks.changeStatus(task.task_id, status);
    await assert.rejects(
      () => approvals.createApproval({ taskId: task.task_id, question: '不应创建' }),
      (error) => error.code === 'INVALID_STATE_TRANSITION',
    );
    assert.equal((await store.listApprovals()).filter((entry) => entry.task_id === task.task_id).length, 0, `${status}: no orphan approval`);
    assert.equal((await store.loadTask(task.task_id)).pending_approval_ids.length, 0);
  }
});

test("rejected terminal-task sendUser leaves no active conversation behind (U-01)", async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);

  const taskA = await tasks.createTask({ request: '已完成任务 A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: '询问王璐', target_employee_number: '00123456' });
  await tasks.updateSubtask(taskA.task_id, subA.subtask_id, { status: 'completed' });
  await tasks.completeTask(taskA.task_id);

  // The host works from a stale snapshot and still tries to send for task A:
  // the send must be refused AND must not leak the contact slot.
  await assert.rejects(
    () => sends.sendUser({ employeeNumber: '00123456', text: '迟到的询问', taskId: taskA.task_id, subtaskId: subA.subtask_id }),
    (error) => error.code === 'INVALID_STATE_TRANSITION' && error.terminalRefusal === true,
  );
  const active = (await store.listConversations()).filter((entry) => entry.status === 'active');
  assert.deepEqual(active, [], 'no active conversation survives the refused send');
  assert.equal((await store.listActions()).filter((action) => action.task_id === taskA.task_id).length, 0, 'no action was created');

  // The same contact is immediately available for the next task.
  const taskB = await tasks.createTask({ request: '后续任务 B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const next = await sends.sendUser({ employeeNumber: '00123456', text: 'B 的问题', taskId: taskB.task_id, subtaskId: subB.subtask_id });
  assert.equal(next.queued, false, 'next task acquires the slot without waiting');
});

test('slot acquired then task completes concurrently: refused send frees the slot for the next task (U-01)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);

  const taskA = await tasks.createTask({ request: '并发完成任务 A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: '询问王璐', target_employee_number: '00123456' });

  // Step 1: the send already passed the slot-acquisition stage (the host
  // works from a pre-completion snapshot) — an active conversation exists.
  const { acquireContactSlot } = await import('../scripts/lib/contact-slots.mjs');
  const slot = await acquireContactSlot(store, {
    contactType: 'user',
    contactId: '00123456',
    taskId: taskA.task_id,
    subtaskId: subA.subtask_id
  });
  assert.equal(slot.acquired, true);
  assert.equal(((await store.listConversations()).filter((entry) => entry.status === 'active')).length, 1);

  // Step 2: the task completes concurrently.
  await tasks.updateSubtask(taskA.task_id, subA.subtask_id, { status: 'completed' });
  await tasks.completeTask(taskA.task_id);

  // Step 3: sendUser resumes, re-acquires its OWN conversation, hits the
  // terminal refusal and must roll the slot back.
  await assert.rejects(
    () => sends.sendUser({ employeeNumber: '00123456', text: '迟到的询问', taskId: taskA.task_id, subtaskId: subA.subtask_id }),
    (error) => error.code === 'INVALID_STATE_TRANSITION',
  );
  assert.deepEqual(
    (await store.listConversations()).filter((entry) => entry.status === 'active'),
    [],
    'own conversation is released after the refusal',
  );

  // Step 4: the next task for the same contact proceeds without queueing.
  const taskB = await tasks.createTask({ request: '后续任务 B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const next = await sends.sendUser({ employeeNumber: '00123456', text: 'B 的问题', taskId: taskB.task_id, subtaskId: subB.subtask_id });
  assert.equal(next.queued, false);
  assert.equal((await store.listConversations()).filter((entry) => entry.status === 'active').length, 1, 'exactly the new task holds the slot');
});

test('busy slot: terminal task is refused instead of queued and never promoted (V-01)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);

  // Task A holds the slot (a real send).
  const taskA = await tasks.createTask({ request: '持槽任务 A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: '询问王璐', target_employee_number: '00123456' });
  await sends.sendUser({ employeeNumber: '00123456', text: 'A 的问题', taskId: taskA.task_id, subtaskId: subA.subtask_id });

  // Task B is already terminal; the host works from a stale snapshot and
  // calls sendUser while the slot is busy.
  const taskB = await tasks.createTask({ request: '终态任务 B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  await tasks.updateSubtask(taskB.task_id, subB.subtask_id, { status: 'completed' });
  await tasks.completeTask(taskB.task_id);

  await assert.rejects(
    () => sends.sendUser({ employeeNumber: '00123456', text: '迟到的询问', taskId: taskB.task_id, subtaskId: subB.subtask_id }),
    (error) => error.code === 'INVALID_STATE_TRANSITION' && error.terminalRefusal === true,
  );

  // Task B must NOT be parked in the wait queue.
  const taskBAfter = await store.loadTask(taskB.task_id);
  const subBAfter = taskBAfter.subtasks.find((entry) => entry.subtask_id === subB.subtask_id);
  assert.equal(subBAfter.waiting_kind, null, 'terminal task is not queued');
  assert.equal(subBAfter.queue_entered_at, null);
  assert.equal(subBAfter.blocked_by_task_id, null);

  // Releasing A's slot must not hand the conversation to the terminal task.
  const conversations = await store.listConversations();
  const activeA = conversations.find((entry) => entry.status === 'active' && entry.task_id === taskA.task_id);
  const release = await (await import('../scripts/lib/contact-slots.mjs')).releaseContactSlot(store, activeA, { reason: 'replied' });
  assert.equal(release.released, true);
  assert.equal(release.promoted, null, 'terminal candidate is never promoted');
  assert.equal((await store.listConversations()).filter((entry) => entry.status === 'active').length, 0, 'no active conversation after release');

  // A valid later task can still acquire the slot normally.
  const taskC = await tasks.createTask({ request: '后续任务 C' });
  const subC = await tasks.addSubtask(taskC.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const next = await sends.sendUser({ employeeNumber: '00123456', text: 'C 的问题', taskId: taskC.task_id, subtaskId: subC.subtask_id });
  assert.equal(next.queued, false);
});

test('release skips candidates whose task turned terminal while queued (V-01 promotion filter)', async (t) => {
  const root = await createFixture();
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  const store = new Store(root);
  await store.initialize();
  const commands = new CommandService(store);
  const tasks = new TaskService(store, commands);
  const sends = new SendService(store);
  const { acquireContactSlot, releaseContactSlot } = await import('../scripts/lib/contact-slots.mjs');

  // A holds the slot; B and C queue behind it.
  const taskA = await tasks.createTask({ request: '持槽任务 A' });
  const subA = await tasks.addSubtask(taskA.task_id, { title: '询问王璐', target_employee_number: '00123456' });
  await sends.sendUser({ employeeNumber: '00123456', text: 'A 的问题', taskId: taskA.task_id, subtaskId: subA.subtask_id });

  const taskB = await tasks.createTask({ request: '排队后取消的任务 B' });
  const subB = await tasks.addSubtask(taskB.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const queuedB = await acquireContactSlot(store, { contactType: 'user', contactId: '00123456', taskId: taskB.task_id, subtaskId: subB.subtask_id });
  assert.equal(queuedB.acquired, false);

  const taskC = await tasks.createTask({ request: '正常排队的任务 C' });
  const subC = await tasks.addSubtask(taskC.task_id, { title: '联系王璐', target_employee_number: '00123456' });
  const queuedC = await acquireContactSlot(store, { contactType: 'user', contactId: '00123456', taskId: taskC.task_id, subtaskId: subC.subtask_id });
  assert.equal(queuedC.acquired, false);
  assert.equal(queuedC.position, 2);

  // B turns terminal while queued (owner cancelled it meanwhile).
  await tasks.cancel(taskB.task_id);

  // Releasing A skips B (cleaning its queue fields) and promotes C.
  const activeA = (await store.listConversations()).find((entry) => entry.status === 'active' && entry.task_id === taskA.task_id);
  const release = await releaseContactSlot(store, activeA, { reason: 'replied' });
  assert.equal(release.released, true);
  assert.equal(release.promoted.task_id, taskC.task_id, 'the next valid candidate is promoted');

  const taskBAfter = await store.loadTask(taskB.task_id);
  const subBAfter = taskBAfter.subtasks.find((entry) => entry.subtask_id === subB.subtask_id);
  assert.equal(subBAfter.waiting_kind, null, 'terminal candidate queue fields are cleaned');
  assert.equal(subBAfter.conversation_id, null);

  const actives = (await store.listConversations()).filter((entry) => entry.status === 'active');
  assert.equal(actives.length, 1);
  assert.equal(actives[0].task_id, taskC.task_id);
});
