# Runtime schema and states

## Root task states

- `queued`: persisted but planning not started (console-created tasks; also the serializer's display status when every required subtask waits for a contact slot)
- `running`
- `waiting_owner`
- `paused`
- `completed`
- `cancelled`
- `failed`
- `reopened`

Root task snapshots additionally carry: `revision`, `created_by_employee_number`, `source` (`skill` | `web_console`), `category`, `priority` (`low`|`normal`|`high` — also the contact-slot queue weight), `deadline_at`, `external_policy`, `execution_mode`, `attachment_ids`, `queued_command_id`, `instructions[]`.

The Console API derives a separate `displayStatus` (`queued`/`running`/`waiting_external`/`waiting_approval`/`paused`/`partial`/`stopped`/`failed`/`completed`) from these facts; the mapping lives in `scripts/lib/task-status.mjs` and must not be duplicated elsewhere.

## Subtask states

- `pending`
- `waiting_contact_slot` (queued behind another active conversation)
- `ready_to_contact`
- `waiting_reply`
- `reply_received`
- `waiting_followup`
- `waiting_owner`
- `completed`
- `cancelled`
- `failed`

Subtask snapshots additionally carry: `revision`, `parent_subtask_id`, `sequence`, `waiting_kind` (`reply`|`followup_window`|`contact_slot`|`owner`|`recovery`), `waiting_reason`, `estimated_completion_at`, `contact_key` (`employee:<工号>` or `group:<群号>`), `conversation_id`, `blocked_by_task_id`, `blocked_by_subtask_id`, `queue_entered_at`.

## Dynamic item states

- `detected`: persisted, not yet classified
- `linked`: converted into a child subtask
- `waiting_owner`: owner decision required
- `approved`: approved but not yet converted/executed
- `independent_pending`: should become a root task after owner confirmation
- `modified`: owner changed the proposed handling
- `closed`: no further work

## Approval schema

Approvals keep a stable shell (`question`, `options`, `status`) plus a typed `proposed_action` union:

- `send_message`: `target_type` (`user`|`group`), `target_id` (employee number or group ID), `display_target`, `audience_text?`, `content`
- `schedule_meeting`: `options[]` with `option_id`, `label`, `attendance_text`, `tone`
- `clarification`: `question`, `field?`, `placeholder?`
- `scope_change`: `item_id`, `item_description?`, `options[]` with `value`, `label`

Statuses: `pending`, `approved`, `rejected`, `returned`, `modified`, `closed`. A decision stores `decision_payload` (what the owner actually chose: option id, answer, edited content) and — except for plain rejections — creates an `approval.apply` command the tick consumes to perform the follow-up.

## Action states

- `executing`: persisted before invoking WeLink CLI
- `succeeded`: CLI returned success
- `dry_run`: no external call was made
- `failed`: known failure
- `unknown`: timeout or ambiguous result; verify conversation before retrying

Actions additionally carry `conversation_id` linking the send to its conversation.

## Commands (`runtime/commands/*.json`)

One file per command with `command_id`, `type` (`task.create`, `task.resume`, `task.cancel`, `task.instruction`, `task.retry`, `subtask.remind`, `approval.apply`), `aggregate_type`/`aggregate_id`, `parent_task_id`, `idempotency_key`, `payload`, `attempts`, `lease_until`, `assignment_state`, `error`.

Statuses: `queued` -> `claimed` (lease) -> `waiting_agent` (deterministic part done, Agent reasoning pending) -> `succeeded` | `failed` (retryable via `error.code`) | `cancelled`.

All transitions are monotonic AND re-validated under the record's own `command:<id>` lock: every writer — including the scanning paths — re-reads the current record and checks the transition before saving, so a cancelled command can never enter waiting_agent/succeeded and a stale snapshot can never overwrite a concurrent ack/begin. Scanning paths (claim, lease recovery, cancellation) hold the `commands` collection lock first and then take each candidate's record lock one by one (collection before record, never the reverse). `releaseClaim` only releases claimed commands; `complete` on a cancelled command is a no-op.

Commands derived from a task carry a stable `parent_task_id` (approval.apply points at its parent task even though its aggregate is the approval), so cancellation reaches every derived command.

Assignment delivery protocol: a command handed to the host Agent as a tick assignment becomes `waiting_agent` with `assignment_state=delivered` and keeps its lease. The host confirms via `ack-command` (`assignment_state=acked`) and announces execution via `begin-command` (`assignment_state=executing`). Rules:

- delivered + lease expired -> back to `queued` (redelivery after a host crash);
- acked/executing are never auto-redelivered — a restarted host finds them through the `resume` listing (`pending_commands`);
- task cancellation revokes queued/claimed/delivered/acked commands whose `parent_task_id` matches; executing ones stay with the host, which re-reads the task's persisted status before acting and reports the outcome via `complete-command`;
- `complete`/`failed` on a cancelled command is a no-op — cancellation always wins.

## Idempotency records (`runtime/idempotency/*.json`)

One file per hash of (owner, route pattern, Idempotency-Key), persisted by the Console API's unified idempotency layer: `{ key, fingerprint, route, status, attempt_id, lease_until, status_code?, response? }`.

Placeholder lifecycle: `reserved` (begin placed it, handler not started, short lease — an expired reservation is safely taken over by the next identical request with a fresh attempt id) -> `running` (handler executing, longer lease) -> `completed` (first response stored; the HTTP reply is sent only AFTER this write, so an immediate replay always finds it) or removed (handler failed before side effects). Same key + same fingerprint (path + normalized body) replays the first completed response; same key with a different fingerprint is `409 IDEMPOTENCY_CONFLICT`. A `running` record with a live lease means the first request is still in flight and replays wait for it. A crash while `running` leaves the outcome unknown: once the lease expires, replays get `409 IDEMPOTENCY_CONFLICT` with `details.phase="unknown_outcome"` and must query the affected aggregate (task/command status) instead of blindly retrying; such records are never auto-deleted.

## Conversations (`runtime/conversations/*.json`)

One active conversation per `contact_key`. Fields: `conversation_id`, `contact_type`, `contact_key`, `task_id`, `subtask_id`, `correlation_id` (last outbound action id), `status` (`active`|`closed`), `opened_at`, `last_outbound_at`, `last_inbound_at`, `closed_at`, `close_reason`. Release closes the record and promotes the next waiting subtask in stable order (priority desc, `queue_entered_at` asc, task id asc, subtask id asc); releasing twice is a no-op.

Lifecycle rules for terminal tasks (review W-01): when a task is cancelled or completed, conversations whose outbound action is still `executing`/`unknown` stay active — handing the slot to the next task early would allow two overlapping private sends to the same contact. The send's own completion path (executeSend) closes such a conversation once the action settles and promotes the next valid candidate; `unknown` results stay with the host recovery flow until it closes the conversation explicitly. A task that finished while its CLI call was running never has its subtask revived to `waiting_reply`.

## Reply attribution

Priority order: (1) explicit reply/thread id (`correlation_id`/`conversation_id`) matched across ALL conversations of the contact (closed ones included, so a late reply to a closed session lands on its original task); (2) STOP RULE — if an explicit marker exists but matches nothing, the reply is `unattributed` with reason `explicit_marker_unmatched`; it must never fall through to the unique-active heuristic; (3) the single ACTIVE conversation for the contact, only when NO marker was supplied; (4) `unattributed` (no active conversation); (5) `unresolved_multiple` (several candidates). The raw message log entry is persisted before any related state is mutated. Only `attributed` replies may advance a task; message log entries carry `attribution_status`, `attribution_reason`, `conversation_id`, `task_id`, `subtask_id`.

## Identity rules

- User primary key: employee number.
- Group primary key: group ID.
- `w3account` is an execution-time field resolved from `contacts.json`, not the logical identity.
- `contacts.json` may add optional `department` and `avatar_initials` for display; the API derives initials from the name when absent.

## Persistence rules

- `runtime/tasks/*.json`: current task snapshots.
- `runtime/items/*.json`: every dynamic item, including closed ones.
- `runtime/approvals/*.json`: owner decisions and proposed actions.
- `runtime/actions/*.json`: external action lifecycle.
- `runtime/commands/*.json`: durable console command inbox with idempotency keys.
- `runtime/conversations/*.json`: contact-slot conversations and reply linkage.
- `runtime/idempotency/*.json`: Console API idempotency records.
- `runtime/logs/messages.jsonl`: full communication log with monotonic `sequence` and attribution fields.
- `runtime/logs/events.jsonl`: state-transition audit log with the same `sequence`.
- `runtime/agent-state.json`: active task IDs, conversation cursors, tick timestamps, `log_sequence` counter.
- `runtime/.locks/`: transient lock files (never committed).
- All snapshot writes bump an integer `revision` under a file lock (`runtime/.locks/`); lock files carry an owner token and release only removes a matching token. Canonical lock order: `slot:<contact_key>` first, then task -> approval -> item -> command -> conversation -> action -> state (state only innermost). Writers that expect a specific revision must pass `expectedRevision` through the Store's `mutate*` helpers; `mutateGroup` updates related records inside one lock window keyed by kind+id.
