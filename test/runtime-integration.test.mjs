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
