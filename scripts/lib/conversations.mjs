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

export async function listConversationsForContact(store, contactKey) {
  const conversations = await store.listConversations();
  return conversations.filter((entry) => entry.contact_key === contactKey);
}

/**
 * Attribution rules in priority order:
 * 1. explicit reply/thread markers match correlation_id or conversation_id
 *    across ALL conversations of the contact — a closed conversation still
 *    owns its late replies (delayed-response case, docs §5.2.1);
 * 2. an explicit marker that matches NOTHING is reported unattributed with
 *    reason `explicit_marker_unmatched` — it must never fall through to the
 *    unique-active heuristic, or a reply aimed at some other context gets
 *    written onto whatever task currently holds the contact slot;
 * 3. exactly one ACTIVE conversation for the contact wins (no marker only);
 * 4. no active conversation -> unattributed (owner/recovery path);
 * 5. multiple active candidates -> unresolved_multiple, never guess by
 *    time or name.
 */
export function attributeReply({ conversations, activeConversations, replyToActionId = null, externalThreadId = null }) {
  if (replyToActionId || externalThreadId) {
    const exact = conversations.find((entry) =>
      (replyToActionId && entry.correlation_id === replyToActionId) ||
      (externalThreadId && entry.conversation_id === externalThreadId)
    );
    if (exact) return { status: 'attributed', conversation: exact };
    return { status: 'unattributed', reason: 'explicit_marker_unmatched', conversation: null };
  }
  if (activeConversations.length === 1) return { status: 'attributed', conversation: activeConversations[0] };
  if (activeConversations.length === 0) return { status: 'unattributed', reason: 'no_active_conversation', conversation: null };
  return { status: 'unresolved_multiple', reason: 'multiple_active_candidates', conversation: null };
}
