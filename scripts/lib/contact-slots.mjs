import {
  contactKeyFor,
  createConversation
} from './conversations.mjs';
import { nowIso } from './utils.mjs';

/**
 * One active private conversation per contact (docs §5.2.1). Candidates
 * waiting for a slot keep waiting_kind=contact_slot on their subtask; the
 * queue order is stable across restarts: priority desc, queue_entered_at
 * asc, task id asc, subtask id asc.
 *
 * Lock order for slot operations: slot:<contactKey> first, then task locks
 * sorted by task id. No other code path takes a slot lock after a task lock.
 */

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

export function orderWaitingCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    const leftRank = PRIORITY_RANK[left.priority] ?? 1;
    const rightRank = PRIORITY_RANK[right.priority] ?? 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftEntered = left.queue_entered_at ?? '';
    const rightEntered = right.queue_entered_at ?? '';
    if (leftEntered !== rightEntered) return leftEntered.localeCompare(rightEntered);
    if (left.task_id !== right.task_id) return left.task_id.localeCompare(right.task_id);
    return left.subtask_id.localeCompare(right.subtask_id);
  });
}

/** Collect every subtask waiting on the given contact slot across all tasks. */
export async function collectWaitingCandidates(store, contactKey) {
  const tasks = await store.listTasks();
  const candidates = [];
  for (const task of tasks) {
    for (const subtask of task.subtasks ?? []) {
      if (subtask.waiting_kind !== 'contact_slot' || subtask.contact_key !== contactKey) continue;
      candidates.push({
        task_id: task.task_id,
        priority: task.priority ?? 'normal',
        subtask_id: subtask.subtask_id,
        title: subtask.title,
        queue_entered_at: subtask.queue_entered_at ?? ''
      });
    }
  }
  return orderWaitingCandidates(candidates);
}

/** Position (1-based) of a waiting subtask in its contact queue, or null. */
export async function queuePositionFor(store, contactKey, taskId, subtaskId) {
  const candidates = await collectWaitingCandidates(store, contactKey);
  const index = candidates.findIndex((entry) => entry.task_id === taskId && entry.subtask_id === subtaskId);
  return index === -1 ? null : index + 1;
}

const TERMINAL_CHAT_STATUSES = ['completed', 'cancelled', 'failed', 'paused'];

/**
 * Release every active conversation a task still holds. Called when a task
 * reaches a terminal state so a conversation created while the task was
 * running cannot block later tasks for the same contact after the task is
 * gone (U-01/V-01 family). Runs outside the task lock: releaseContactSlot
 * takes its own slot lock, and slot locks are never taken while holding a
 * task lock.
 */
export async function releaseTaskConversations(store, taskId, { reason = 'task_finished' } = {}) {
  const conversations = await store.listConversations();
  const released = [];
  for (const conversation of conversations) {
    if (conversation.task_id !== taskId || conversation.status !== 'active') continue;
    const result = await releaseContactSlot(store, conversation, { reason });
    if (result.released) released.push(conversation.conversation_id);
  }
  return released;
}

function terminalRefusal(taskId, status) {
  const error = new Error(`Task ${taskId} is ${status}; contact slot acquisition refused.`);
  error.code = 'INVALID_STATE_TRANSITION';
  // Same marker as executeSend's terminal refusal: callers can tell "no
  // conversation/queue entry was created" apart from real send failures.
  error.terminalRefusal = true;
  return error;
}

/**
 * Try to acquire the single active conversation slot for a contact. On
 * success a new active conversation is created and linked to the subtask;
 * on failure the subtask is parked in the contact queue and the holder
 * information is returned so callers can explain the wait.
 *
 * The task's terminal status is re-checked under the already-held slot+task
 * lock BEFORE any queue entry or conversation is created (review V-01), so
 * a stale-snapshot send for a finished task can neither park itself in the
 * wait queue nor take the slot.
 */
export async function acquireContactSlot(store, { contactType, contactId, taskId, subtaskId, priority = 'normal' }) {
  const contactKey = contactKeyFor(contactType, contactId);
  const taskLocks = [...new Set([`task:${taskId}`])];

  return store.locks.withLocks([`slot:${contactKey}`, ...taskLocks.sort()], async () => {
    const task = await store.loadTask(taskId);
    if (TERMINAL_CHAT_STATUSES.includes(task.status)) {
      throw terminalRefusal(taskId, task.status);
    }

    const conversations = await store.listConversations();
    const holder = conversations.find((entry) => entry.contact_key === contactKey && entry.status === 'active');

    if (!holder) {
      const conversation = await createConversation(store, { contactType, contactKey, taskId, subtaskId });
      const subtask = task.subtasks?.find((entry) => entry.subtask_id === subtaskId);
      if (subtask) {
        subtask.conversation_id = conversation.conversation_id;
        subtask.waiting_kind = null;
        subtask.waiting_reason = null;
        subtask.blocked_by_task_id = null;
        subtask.blocked_by_subtask_id = null;
        subtask.queue_entered_at = null;
        await store.saveTask(task);
      }
      return { acquired: true, conversation, position: null, holderTaskId: null };
    }

    if (holder.task_id === taskId && holder.subtask_id === subtaskId) {
      // Same subtask retrying its own conversation (e.g. after action recovery).
      return { acquired: true, conversation: holder, position: null, holderTaskId: taskId };
    }

    const subtask = task.subtasks?.find((entry) => entry.subtask_id === subtaskId);
    if (subtask) {
      if (subtask.status === 'ready_to_contact') subtask.status = 'waiting_contact_slot';
      subtask.waiting_kind = 'contact_slot';
      subtask.waiting_reason = `等待与该联系人的上一项沟通完成`;
      subtask.contact_key = contactKey;
      subtask.blocked_by_task_id = holder.task_id;
      subtask.blocked_by_subtask_id = holder.subtask_id;
      subtask.queue_entered_at = subtask.queue_entered_at ?? nowIso();
      subtask.conversation_id = null;
      await store.saveTask(task);
    }

    const position = await queuePositionFor(store, contactKey, taskId, subtaskId);
    await store.logEvent('contact_slot_wait', {
      contact_key: contactKey,
      task_id: taskId,
      subtask_id: subtaskId,
      blocked_by_task_id: holder.task_id,
      position
    });
    return { acquired: false, conversation: null, position, holderTaskId: holder.task_id };
  });
}

/**
 * Close a conversation and release its contact slot. The next waiting
 * candidate (stable order) is promoted: a fresh conversation is created for
 * it, queue fields are cleared and both slot events are written. Releasing
 * twice is a no-op so crash recovery cannot double-promote.
 *
 * Locking: the slot lock is held throughout; the closing conversation is
 * mutated under its own conversation lock, and the promoted task is mutated
 * under its own task lock (with a re-check that it still waits for this
 * slot) so a concurrent Console/Agent edit to that task cannot be lost.
 */
export async function releaseContactSlot(store, conversation, { reason = 'closed' } = {}) {
  const contactKey = conversation.contact_key;
  return store.locks.withLocks([`slot:${contactKey}`], async () => {
    const conversations = await store.listConversations();
    const current = conversations.find((entry) => entry.conversation_id === conversation.conversation_id) ?? conversation;
    if (current.status !== 'active') {
      return { released: false, promoted: null };
    }
    await store.mutateConversation(current.conversation_id, (record) => {
      record.status = 'closed';
      record.closed_at = nowIso();
      record.close_reason = reason;
    });
    await store.logEvent('contact_slot_released', {
      conversation_id: current.conversation_id,
      contact_key: contactKey,
      task_id: current.task_id,
      reason
    });

    const candidates = await collectWaitingCandidates(store, contactKey);
    let promoted = null;
    // Promote candidates in stable order, skipping (and cleaning up) any
    // whose task turned terminal while queued (review V-01) — promoting a
    // finished task would hand the slot to a conversation nobody will use.
    for (const candidate of candidates) {
      const promotedForCandidate = await store.locks.withLocks([`task:${candidate.task_id}`], async () => {
        const task = await store.loadTask(candidate.task_id);
        const subtask = task.subtasks?.find((entry) => entry.subtask_id === candidate.subtask_id);
        // Re-check under the task lock: state may have moved on while we
        // were closing the previous conversation.
        if (!subtask || subtask.waiting_kind !== 'contact_slot') return null;
        if (TERMINAL_CHAT_STATUSES.includes(task.status)) {
          if (subtask.status === 'waiting_contact_slot') subtask.status = 'ready_to_contact';
          subtask.waiting_kind = null;
          subtask.waiting_reason = null;
          subtask.blocked_by_task_id = null;
          subtask.blocked_by_subtask_id = null;
          subtask.queue_entered_at = null;
          subtask.conversation_id = null;
          await store.saveTask(task);
          await store.logEvent('contact_slot_candidate_skipped', {
            contact_key: contactKey,
            task_id: candidate.task_id,
            subtask_id: candidate.subtask_id,
            task_status: task.status
          });
          return null;
        }
        const nextConversation = await createConversation(store, {
          contactType: contactKey.startsWith('group:') ? 'group' : 'user',
          contactKey,
          taskId: candidate.task_id,
          subtaskId: candidate.subtask_id,
          openedBy: 'slot_release'
        });
        if (subtask.status === 'waiting_contact_slot') subtask.status = 'ready_to_contact';
        subtask.waiting_kind = null;
        subtask.waiting_reason = null;
        subtask.blocked_by_task_id = null;
        subtask.blocked_by_subtask_id = null;
        subtask.queue_entered_at = null;
        subtask.conversation_id = nextConversation.conversation_id;
        await store.saveTask(task);
        return { task_id: candidate.task_id, subtask_id: candidate.subtask_id, conversation_id: nextConversation.conversation_id };
      });
      if (promotedForCandidate) {
        promoted = promotedForCandidate;
        break;
      }
    }
    if (promoted) {
      await store.logEvent('contact_slot_acquired', {
        conversation_id: promoted.conversation_id,
        contact_key: contactKey,
        task_id: promoted.task_id,
        subtask_id: promoted.subtask_id
      });
    }
    return { released: true, promoted };
  });
}
