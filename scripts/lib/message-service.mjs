import {
  attributeReply,
  contactKeyFor,
  listActiveConversations,
  listConversationsForContact
} from './conversations.mjs';

/**
 * Every inbound message is persisted BEFORE any state is mutated because of
 * it, and reply attribution runs before any task progress may be derived
 * from it (docs §9.6). The attribution decision itself is computed from
 * read-only snapshots; the message log entry is the first write. Ambiguous
 * replies stay unattributed — they never advance a task just because the
 * contact name and timestamp look plausible.
 */
export class MessageService {
  constructor(store) {
    this.store = store;
  }

  async recordInbound({ participantType, participantId, content, externalMessageId = null, replyToActionId = null, externalThreadId = null, taskId = null, subtaskId = null }) {
    const contactKey = contactKeyFor(participantType, participantId);
    const allConversations = await listConversationsForContact(this.store, contactKey);
    const activeConversations = allConversations.filter((entry) => entry.status === 'active');
    const attribution = attributeReply({
      conversations: allConversations,
      activeConversations,
      replyToActionId,
      externalThreadId
    });

    const attributed = attribution.status === 'attributed' ? attribution.conversation : null;

    // First write: the raw message, with whatever attribution we resolved.
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
      attribution_reason: attribution.reason ?? null,
      status: 'recorded'
    });

    // Only after the message is durable do we touch related state.
    if (attributed) {
      await this.store.mutateConversation(attributed.conversation_id, (conversation) => {
        conversation.last_inbound_at = entry.timestamp;
      });
    }

    await this.store.logEvent(attribution.status === 'attributed' ? 'message_attributed' : 'message_unattributed', {
      log_id: entry.log_id,
      contact_key: contactKey,
      attribution_status: attribution.status,
      attribution_reason: attribution.reason ?? null,
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
