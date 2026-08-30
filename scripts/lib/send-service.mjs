import { hashText, makeId } from './ids.mjs';
import { nowIso } from './utils.mjs';
import { runWelink } from './welink.mjs';
import { acquireContactSlot } from './contact-slots.mjs';

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

export function withAgentFooter(text, policies, metadata) {
  const trimmed = String(text).trim();
  if (trimmed.includes('[WELINK_AGENT_MESSAGE')) return trimmed;
  return `${trimmed}\n\n${agentSuffix(policies, metadata)}`;
}

/**
 * All WeLink sends flow through one service so action pre-persistence,
 * dry-run handling, agent marker, contact slots and conversation linkage
 * stay in one place (docs §3.1, §5.2.1). The browser never reaches this
 * path directly; the Console API only persists commands.
 *
 * Locking: the initial `executing` action record is a fresh file (unique
 * id, atomic rename) and needs no lock. Every subsequent read-modify-write
 * — action result, subtask transition, conversation linkage — goes through
 * the Store's mutate helpers so concurrent Console/Agent processes cannot
 * overwrite each other.
 */
export class SendService {
  constructor(store) {
    this.store = store;
  }

  /**
   * Persist the action as executing BEFORE invoking welink-cli, then update
   * to succeeded/dry_run/failed/unknown. This order is the basis for crash
   * recovery and duplicate-send prevention and must not be changed.
   */
  async executeSend({ actionType, targetType, targetId, cliArgs, content, taskId, subtaskId, approvalId, messageType, conversationId }) {
    const actionId = makeId('ACT');
    const action = {
      schema_version: 1,
      revision: 1,
      action_id: actionId,
      task_id: taskId ?? null,
      subtask_id: subtaskId ?? null,
      approval_id: approvalId ?? null,
      conversation_id: conversationId ?? null,
      type: actionType,
      target_type: targetType,
      target_id: targetId,
      content,
      content_hash: hashText(content),
      status: 'executing',
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await this.store.saveAction(action);
    await this.store.logEvent('action_started', {
      action_id: actionId,
      task_id: taskId ?? null,
      action_type: actionType,
      target_id: targetId
    });

    const policies = await this.store.loadConfig('policies');
    const result = await runWelink(cliArgs, { dryRun: policies.dry_run === true });
    const finalAction = await this.store.mutateAction(actionId, (current) => {
      current.external_result = result;
      current.status = result.ok ? (result.dry_run ? 'dry_run' : 'succeeded') : (result.timed_out ? 'unknown' : 'failed');
      current.completed_at = nowIso();
    });

    await this.store.logMessage({
      direction: 'outbound',
      participant_type: targetType,
      participant_id: targetId,
      task_id: taskId ?? null,
      subtask_id: subtaskId ?? null,
      approval_id: approvalId ?? null,
      conversation_id: conversationId ?? null,
      correlation_id: actionId,
      message_type: messageType ?? 'message',
      content,
      action_id: actionId,
      status: finalAction.status
    });
    await this.store.logEvent('action_finished', {
      action_id: actionId,
      task_id: taskId ?? null,
      conversation_id: conversationId ?? null,
      status: finalAction.status
    });

    if (taskId && subtaskId && result.ok) {
      await this.store.mutateTask(taskId, undefined, (task) => {
        const subtask = task.subtasks?.find((entry) => entry.subtask_id === subtaskId);
        if (!subtask) return;
        subtask.status = 'waiting_reply';
        subtask.waiting_kind = null;
        subtask.waiting_reason = null;
        subtask.communication.round += 1;
        subtask.communication.first_contact_at ??= nowIso();
        subtask.communication.last_contact_at = nowIso();
        subtask.conversation_id = conversationId ?? subtask.conversation_id;
        subtask.next_action = { type: 'wait_reply' };
      });
    }

    return { action: finalAction, result };
  }

  /**
   * Send to a user through the contact slot. When the contact already has an
   * active conversation for another subtask, the send is NOT attempted: the
   * subtask is parked in the contact queue and the caller reports the wait.
   */
  async sendUser({ employeeNumber, text, taskId = null, subtaskId = null, type = null }) {
    const contacts = await this.store.loadConfig('contacts');
    const contact = contacts[employeeNumber];
    if (!contact) {
      const error = new Error(`Employee number is not configured: ${employeeNumber}`);
      error.code = 'CONTACT_NOT_CONFIGURED';
      throw error;
    }
    if (!contact.auto_contact) {
      const error = new Error(`Auto contact is disabled for: ${employeeNumber}`);
      error.code = 'AUTO_CONTACT_DISABLED';
      throw error;
    }
    const policies = await this.store.loadConfig('policies');
    const message = withAgentFooter(text, policies, {
      task: taskId,
      subtask: subtaskId,
      type: type ?? 'communication'
    });

    let conversation = null;
    if (taskId && subtaskId) {
      const task = await this.store.loadTask(taskId);
      const slot = await acquireContactSlot(this.store, {
        contactType: 'user',
        contactId: employeeNumber,
        taskId,
        subtaskId,
        priority: task.priority ?? 'normal'
      });
      if (!slot.acquired) {
        return { queued: true, position: slot.position, holderTaskId: slot.holderTaskId };
      }
      conversation = slot.conversation;
    }

    const { action, result } = await this.executeSend({
      actionType: 'send_user_message',
      targetType: 'user',
      targetId: employeeNumber,
      cliArgs: ['im', 'send-to-user', '--receiver', contact.w3account, '--text', message],
      content: message,
      taskId,
      subtaskId,
      messageType: type,
      conversationId: conversation?.conversation_id ?? null
    });
    if (conversation) {
      await this.store.mutateConversation(conversation.conversation_id, (current) => {
        current.correlation_id = action.action_id;
        current.last_outbound_at = nowIso();
      });
    }
    return { queued: false, action, result };
  }

  async sendGroup({ groupId, text, taskId = null, subtaskId = null, approvalId = null, type = null }) {
    const groups = await this.store.loadConfig('groups');
    if (!groups[groupId]?.trusted) {
      const error = new Error(`Group is not configured as trusted: ${groupId}`);
      error.code = 'GROUP_NOT_TRUSTED';
      throw error;
    }
    const policies = await this.store.loadConfig('policies');
    const message = withAgentFooter(text, policies, {
      task: taskId,
      approval: approvalId,
      type: type ?? 'notification'
    });
    return this.executeSend({
      actionType: 'send_group_message',
      targetType: 'group',
      targetId: groupId,
      cliArgs: ['im', 'send-to-group', '--group-id', groupId, '--text', message],
      content: message,
      taskId,
      subtaskId,
      approvalId,
      messageType: type
    });
  }
}
