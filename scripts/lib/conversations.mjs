import { makeId } from './ids.mjs';
import { nowIso, readOptionalJson } from './utils.mjs';

/**
 * Conversation records link an outbound WeLink message to the task/subtask
 * waiting for its reply (docs/frontend-backend-integration.md §5.2.1).
 * Reply attribution runs before any task progress may be derived from an
 * inbound message.
 */

export function contactKeyFor(participantType, participantId) {
  return participantType === 'group' ? `group:${participantId}` : `employee:${participantId}`;
}

export function conversationPath(store, conversationId) {
  return store.conversationPath(conversationId);
}

export async function createConversation(store, { contactType, contactKey, taskId, subtaskId, correlationId = null, openedBy = 'send' }) {
  const conversation = {
    schema_version: 1,
    revision: 1,
    conversation_id: makeId('CONV'),
    contact_type: contactType,
    contact_key: contactKey,
    task_id: taskId ?? null,
    subtask_id: subtaskId ?? null,
    correlation_id: correlationId,
    status: 'active',
    opened_at: nowIso(),
    opened_by: openedBy,
    last_outbound_at: null,
    last_inbound_at: null,
    closed_at: null,
    close_reason: null
  };
  await store.saveConversation(conversation);
  await store.logEvent('conversation_opened', {
    conversation_id: conversation.conversation_id,
    contact_key: contactKey,
    task_id: taskId ?? null,
    subtask_id: subtaskId ?? null
  });
  return conversation;
}

export async function loadConversation(store, conversationId) {
  return readOptionalJson(store.conversationPath(conversationId), null);
}

export async function findActiveConversation(store, contactKey) {
  const conversations = await store.listConversations();
  return conversations.find((entry) => entry.contact_key === contactKey && entry.status === 'active') ?? null;
}

export async function listActiveConversations(store, contactKey) {
  const conversations = await store.listConversations();
  return conversations.filter((entry) => entry.contact_key === contactKey && entry.status === 'active');
}

/**
 * Attribution rules in priority order:
 * 1. explicit reply/thread markers match correlation_id or conversation_id;
 * 2. exactly one active conversation for the contact wins;
 * 3. no active conversation -> unattributed (owner/recovery path);
 * 4. multiple candidates -> unresolved_multiple, never guess by time/name.
 */
export function attributeReply({ conversations, replyToActionId = null, externalThreadId = null }) {
  if (replyToActionId || externalThreadId) {
    const exact = conversations.find((entry) =>
      (replyToActionId && entry.correlation_id === replyToActionId) ||
      (externalThreadId && entry.conversation_id === externalThreadId)
    );
    if (exact) return { status: 'attributed', conversation: exact };
  }
  if (conversations.length === 1) return { status: 'attributed', conversation: conversations[0] };
  if (conversations.length === 0) return { status: 'unattributed', conversation: null };
  return { status: 'unresolved_multiple', conversation: null };
}

export async function markConversationInbound(store, conversation) {
  conversation.last_inbound_at = nowIso();
  await store.saveConversation(conversation);
}
