import { collectWaitingCandidates } from '../../scripts/lib/contact-slots.mjs';

/**
 * One read-time bundle of everything the serializers need. Loading the
 * configs repeatedly is cheap (small local files) but must stay consistent
 * inside one request so every region of a page reflects the same instant.
 */
export async function loadReadContext(store) {
  const [tasks, approvals, actions, commands, contactsConfig, groupsConfig, ownerConfig] = await Promise.all([
    store.listTasks(),
    store.listApprovals(),
    store.listActions(),
    store.listCommands(),
    store.loadConfig('contacts').catch(() => ({})),
    store.loadConfig('groups').catch(() => ({})),
    store.loadConfig('owner').catch(() => ({}))
  ]);
  return { store, tasks, approvals, actions, commands, contactsConfig, groupsConfig, ownerConfig };
}

/**
 * Compute contact-slot queue positions for tasks that serialize as queued.
 * The queue order lives in scripts/lib/contact-slots.mjs so restarts keep
 * the same ordering.
 */
export async function computeQueuePositions(store, tasks) {
  const positions = {};
  const byContact = new Map();
  for (const task of tasks) {
    for (const subtask of task.subtasks ?? []) {
      if (subtask.waiting_kind !== 'contact_slot' || !subtask.contact_key) continue;
      if (!byContact.has(subtask.contact_key)) byContact.set(subtask.contact_key, []);
      byContact.get(subtask.contact_key).push(task.task_id);
    }
  }
  for (const contactKey of byContact.keys()) {
    const candidates = await collectWaitingCandidates(store, contactKey);
    candidates.forEach((candidate) => {
      positions[`${candidate.task_id}:${candidate.subtask_id}`] = candidates.indexOf(candidate) + 1;
    });
  }
  return positions;
}
