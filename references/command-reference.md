# Wrapper command reference

All commands run from the project root:

```bash
node scripts/agent.mjs <command>
```

## Bootstrap and inspection

```bash
node scripts/agent.mjs init
node scripts/agent.mjs preflight
node scripts/agent.mjs status
node scripts/agent.mjs status --task-id TASK-ID
node scripts/agent.mjs resume
```

## Task and subtask

```bash
node scripts/agent.mjs create-task --title "标题" --request "完整任务" --priority high --deadline 2026-09-01T10:00:00Z --status queued
node scripts/agent.mjs add-subtask --task-id TASK-ID --title "询问测试进度" --target-employee-number 00123456 --required-info "当前状态,阻塞问题,预计完成时间"
node scripts/agent.mjs update-subtask --task-id TASK-ID --subtask-id SUB-ID --status completed --summary "已获得完整信息" --next-action wait_reply
node scripts/agent.mjs add-instruction --task-id TASK-ID --text "先只汇总市场和技术反馈"
node scripts/agent.mjs complete-task --task-id TASK-ID --summary "最终汇总"
```

`create-task --status queued` 只落盘待执行快照（Web 控制台路径）；Skill 直接创建时默认 `running`。`--priority low|normal|high` 同时决定同一联系人沟通队列中的顺序。

## Tick loop

```bash
node scripts/agent.mjs tick [--max-commands 10]
node scripts/agent.mjs ack-command --command-id CMD-ID
node scripts/agent.mjs begin-command --command-id CMD-ID
node scripts/agent.mjs complete-command --command-id CMD-ID --status succeeded
node scripts/agent.mjs complete-command --command-id CMD-ID --status failed --error-code AGENT_ERROR --error-message "原因"
node scripts/agent.mjs close-conversation --conversation-id CONV-ID [--reason replied]
```

`tick` 输出 `assignments`（需要宿主 Agent 推理的工作，含 `command_id` 与 `task_status`）、`executed`（确定性命令结果）、`due_followups`（到期追问）与 `uncertain_actions`。接手流程：`ack-command` 确认所有权 → `begin-command` 宣布开始执行 → 执行前用 `status --task-id` 读取任务当前持久化状态（payload 里的 `task_status` 只是 tick 时刻的提示）→ 完成后 `complete-command` 回写。状态机为单调转换：cancelled 不可复活；任务取消会撤销 queued/claimed/delivered/acked 命令，但不动 executing；delivered 未 ack 的在租约到期后回队列重投，acked/executing 不重投（宿主重启后通过 `resume` 的 pending_commands 找回）。子任务完成或会话结束时用 `close-conversation` 释放联系人沟通槽。

## Dynamic item and approval

```bash
node scripts/agent.mjs add-item --task-id TASK-ID --description "组织一次评审" --source-employee-number 00123456 --relation scope_extension --workload large
node scripts/agent.mjs classify-item --item-id ITEM-ID --decision auto_subtask --target-employee-number 00678901 --required-info "当前状态,预计完成时间"
node scripts/agent.mjs create-approval --task-id TASK-ID --item-id ITEM-ID --question "是否组织评审？" --proposed-action-file proposed-action.json
node scripts/agent.mjs resolve-approval --approval-id AP-ID --resolution approved --response "同意"
```

`--proposed-action-file` 指向带 `type` 的联合对象：`send_message`（含 `target_type`/`target_id`/`display_target`/`content`）、`schedule_meeting`（`options[].option_id/label/attendance_text/tone`）、`clarification`（`question/field/placeholder`）或 `scope_change`（`item_id/options[].value/label`）。`resolve-approval` 在 approved/modified 后同样会生成 `approval.apply` 命令，由 `tick` 执行后续动作。

## Messages

```bash
node scripts/agent.mjs send-user --employee-number 00123456 --task-id TASK-ID --subtask-id SUB-ID --text "张哥，麻烦同步当前状态。"
node scripts/agent.mjs send-group --group-id GROUP-ID --task-id TASK-ID --type progress --text "【任务进度】..."
node scripts/agent.mjs query-history-user --employee-number 00123456 --count 20
node scripts/agent.mjs query-history-group --group-id GROUP-ID --count 20
node scripts/agent.mjs record-message --direction inbound --participant-type user --participant-id 00123456 --task-id TASK-ID --content "同事原始回复" --reply-to-action-id ACTION-ID --external-thread-id CONV-ID
node scripts/agent.mjs set-cursor --participant-type user --participant-id 00123456 --message-id MESSAGE-ID
```

`send-user` 在同一联系人已有活动会话时返回 `queued: true` 并把子任务排入沟通队列，不会发送消息。`record-message --direction inbound` 会先做回复归属（reply/thread 标识 → 唯一活动会话 → 未归属），归属失败的消息不得用于推进任务。

## Console API

```bash
node server/index.mjs [--host 127.0.0.1] [--port 4174] [--no-static]
```

服务 `http://127.0.0.1:4174/api/v1`（health/session/overview/tasks/approvals/commands/events.stream），并在已构建 `web-console/dist/` 时同源托管页面。开发模式配合 `cd web-console && npm run dev`（Vite 代理 `/api`）。路由不得读写文件或调用 `welink-cli`；所有状态变更经由 `scripts/lib/` 的服务与命令队列。
