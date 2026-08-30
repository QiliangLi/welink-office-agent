import {
  attributeReply,
  contactKeyFor,
  listActiveConversations,
  markConversationInbound
} from './conversations.mjs';

/**
 * Every inbound message is persisted BEFORE the Agent reasons about it, and
 * reply attribution runs before any task progress may be derived from it
 * (docs §9.6). Ambiguous replies stay unattributed — they never advance a
 * task just because the contact name and timestamp look plausible.
 */
export class MessageService {
  constructor(store) {
    this.store = store;
  }

  async recordInbound({ participantType, participantId, content, externalMessageId = null, replyToActionId = null, externalThreadId = null, taskId = null, subtaskId = null }) {
    const contactKey = contactKeyFor(participantType, participantId);
    const candidates = await listActiveConversations(this.store, contactKey);
    const attribution = attributeReply({ conversations: candidates, replyToActionId, externalThreadId });

    const attributed = attribution.status === 'attributed' ? attribution.conversation : null;
    if (attributed) {
      await markConversationInbound(this.store, attributed);
    }

    const entry = await this.store.logMessage({
      direction: 'inbound',
      participant_type: participantType,
      participant_id: participantId,
      contact_key: contactKey,
      content,
      external_message_id: externalMessageId,
      reply_to_action_id: replyToActionId,
      external_thread_id: externalThreadId,
      task_id: attributed?.task_id ?? taskId ?? null,
      subtask_id: attributed?.subtask_id ?? subtaskId ?? null,
      conversation_id: attributed?.conversation_id ?? null,
      attribution_status: attribution.status,
      status: 'recorded'
    });

    await this.store.logEvent(attribution.status === 'attributed' ? 'message_attributed' : 'message_unattributed', {
      log_id: entry.log_id,
      contact_key: contactKey,
      attribution_status: attribution.status,
      conversation_id: attributed?.conversation_id ?? null,
      task_id: attributed?.task_id ?? null,
      subtask_id: attributed?.subtask_id ?? null
    });

    return { message: entry, attribution };
  }

  /** Outbound logging lives in SendService; this records manual/CLI-side entries. */
  async recordManualOutbound({ participantType, participantId, content, taskId = null, subtaskId = null, externalMessageId = null }) {
    return this.store.logMessage({
      direction: 'outbound',
      participant_type: participantType,
      participant_id: participantId,
      content,
      task_id: taskId,
      subtask_id: subtaskId,
      external_message_id: externalMessageId,
      status: 'recorded'
    });
  }
}
