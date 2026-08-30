# Runtime schema and states

## Root task states

- `running`
- `waiting_owner`
- `paused`
- `completed`
- `cancelled`
- `failed`
- `reopened`

## Subtask states

- `pending`
- `waiting_contact_slot`
- `ready_to_contact`
- `waiting_reply`
- `reply_received`
- `waiting_followup`
- `waiting_owner`
- `completed`
- `cancelled`
- `failed`

## Dynamic item states

- `detected`: persisted, not yet classified
- `linked`: converted into a child subtask
- `waiting_owner`: owner decision required
- `approved`: approved but not yet converted/executed
- `independent_pending`: should become a root task after owner confirmation
- `modified`: owner changed the proposed handling
- `closed`: no further work

## Action states

- `executing`: persisted before invoking WeLink CLI
- `succeeded`: CLI returned success
- `dry_run`: no external call was made
- `failed`: known failure
- `unknown`: timeout or ambiguous result; verify conversation before retrying

## Identity rules

- User primary key: employee number.
- Group primary key: group ID.
- `w3account` is an execution-time field resolved from `contacts.json`, not the logical identity.

## Persistence rules

- `runtime/tasks/*.json`: current task snapshots.
- `runtime/items/*.json`: every dynamic item, including closed ones.
- `runtime/approvals/*.json`: owner decisions.
- `runtime/actions/*.json`: external action lifecycle.
- `runtime/logs/messages.jsonl`: full communication log.
- `runtime/logs/events.jsonl`: state-transition audit log.
- `runtime/agent-state.json`: active task IDs and conversation cursors.
