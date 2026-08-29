---
name: welink-office-agent
description: Run a trusted-contact WeLink communication task: create and resume long-running tasks, route topics to configured employee numbers, contact colleagues through welink-cli, track dynamic subtasks, request owner decisions in the control group, and summarize progress. Use only for the local welink-office-agent project.
when_to_use: Invoke directly for a new communication task, or with tick/resume/status arguments. Suitable for /loop-driven polling after the project configuration is complete.
argument-hint: "<任务描述> | tick | resume | status [TASK-ID]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash(node .claude/skills/welink-office-agent/scripts/agent.mjs *)
disallowed-tools:
  - AskUserQuestion
---

# WeLink Office Agent

Operate only through:

```bash
node .claude/skills/welink-office-agent/scripts/agent.mjs <command> ...
```

Do not invoke `welink-cli` directly. The wrapper appends the Agent marker, writes action/message logs, and preserves recovery state.

## Always start

1. Run `init`.
2. Read `config/owner.json`, `contacts.json`, `groups.json`, `routing.json`, `auto-reply.json`, and `policies.json` when relevant.
3. Run `resume` before changing an existing task or processing a tick.
4. Treat employee number as the only user identity and group ID as the only group identity.
5. Keep `policies.json.dry_run=true` until the owner has tested generated messages.

## Dispatch by arguments

### `status` or `status TASK-ID`

Run `status`; include `--task-id` when provided. Summarize the returned JSON without changing state.

### `resume`

Run `resume`. Recover in this order:

1. Actions with `executing` or `unknown` status: query the relevant conversation and determine whether the message was already sent before retrying.
2. Pending owner approvals.
3. Open dynamic items.
4. Unfinished tasks and waiting replies.

Do not recreate tasks that already exist.

### `tick`

Perform exactly one bounded processing cycle:

1. Run `resume`.
2. Read the control group ID and all participants in unfinished tasks.
3. Query the control group and relevant user/group histories, using saved cursors where available.
4. Ignore messages containing `[WELINK_AGENT_MESSAGE` as Agent-authored messages.
5. For each new human message:
   - write it with `record-message` before reasoning about it;
   - associate it with an existing task/subtask when reasonably clear;
   - extract facts, missing information, conflicts, and newly created work items;
   - create every discovered item with `add-item` before classifying it;
   - update the cursor only after the message has been recorded and processed.
6. For a light item that is necessary for the parent task, classify it as `auto_subtask`, add the required information, and contact the configured colleague.
7. For a larger item, scope extension, ambiguous message, unsupported image/file/rich media, missing contact, or unclear task association:
   - classify/create an owner approval;
   - send one structured request to the configured control group;
   - pause only the affected subtask, not unrelated work.
8. Resolve control-group instructions such as approval, rejection, return, close, pause, resume, status, and retry.
9. Continue due follow-ups, but do not exceed the configured reminder count.
10. Update task working summaries and complete a task only when the wrapper's `complete-task` check passes.
11. Report only what changed during this tick.

### Any other text: create a new task

Treat `$ARGUMENTS` as the owner's task request.

1. Run `create-task` with the full request.
2. Decompose the goal into the smallest useful information-gathering subtasks.
3. Resolve each topic using this priority:
   - employee explicitly named in the current request;
   - `routing.json`;
   - expertise in `contacts.json`.
4. Create subtasks with `add-subtask`; include required information that determines completion.
5. Send concise questions to the selected colleagues with `send-user`.
6. Send a task-created summary to the control group with `send-group`.
7. Return the task ID and current dry-run/live mode.

## Dynamic work policy

Classify new work produced during colleague communication:

- **Light and necessary:** one configured colleague, simple query/confirmation, usually one round, no new resource/commitment/deliverable. Create and execute a dynamic subtask automatically.
- **Large or scope-expanding:** multiple people/teams, repeated coordination, new report/meeting/deliverable, resource request, schedule/scope/ownership commitment. Create an approval and ask the owner whether to include, create separately, return to requester, or close.
- **Unprocessable:** unsupported attachment, ambiguous intent, uncertain task association, unknown employee number, or unresolved conflict. Ask the owner in the control group.

A trusted colleague may create necessary child work, but may not silently create a new root task or expand the owner's scope.

## Completion and non-omission rules

- Every inbound message must be recorded before processing.
- Every newly detected action item must be persisted before classification.
- A required dynamic subtask has the same completion weight as an initial subtask.
- Do not complete the parent task while required subtasks, open items, pending approvals, unresolved conflicts, waiting replies, or uncertain actions remain.
- Preserve conflicting claims with their sources; never overwrite one person's claim with another's.
- If a late reply changes a completed conclusion, reopen or mark the task updated and notify the control group.

## Message style

Use the configured address. Ask only for the fields needed to close the subtask. Do not mention internal reasoning or configuration files. The wrapper automatically appends the WeLink CLI Agent footer and machine-readable marker.

## References

- Runtime schemas and states: [references/runtime-schema.md](references/runtime-schema.md)
- Wrapper commands: [references/command-reference.md](references/command-reference.md)
