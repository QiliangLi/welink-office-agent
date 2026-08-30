Branch: `main`

Review range: `77c27d72315e9c486fa0308aa52f7eb0b91dc5fa..7147d5510947ff0d5d709652daf8d3519271b28b`

Reviewed at: `2026-08-31T02:09:27+08:00`

Verdict: `request changes`

# 阶段一至四第五轮复审

## 结论

提交 `7147d5510947ff0d5d709652daf8d3519271b28b` 已修复 U-01 的两个既有回归场景：联系人空闲时，终态任务的迟到发送会关闭刚取得的 conversation；任务在取得槽位后并发完成时也会走同一回滚。新增测试与独立顺序复现均证实，拒绝发生后没有 action 或 active conversation，后续任务可以立即联系同一人。

但 `sendUser()` 在联系人槽已被占用时会从 `!slot.acquired` 分支提前返回，完全绕过 `executeSend()` 的终态复核及新增回滚。已完成任务因此仍会被写入联系人等待队列；原持有者释放槽位后，该已完成任务会被晋升并创建新的 active conversation。这个路径只要求“联系人正忙 + 宿主基于旧快照发起迟到发送”，属于正常并发和排队能力的直接组合，并非损坏数据或罕见环境故障。它会再次永久占住同一联系人，故 U-01 尚未完整关闭。

## U-01 修复状态

| 场景 | 状态 | 证据 |
| --- | --- | --- |
| 终态任务、联系人空闲 | 已关闭 | `sendUser()` 取得槽位后收到带 `terminalRefusal` 的错误，调用 `releaseContactSlot()`；新增顺序测试通过。 |
| 取得槽位后任务并发完成 | 已关闭 | action 预落盘在 task lock 内拒绝，catch 释放当前 conversation；新增并发顺序测试通过。 |
| 终态任务、联系人已有持有者 | 未关闭 | `acquireContactSlot()` 先将任务排队，`sendUser()` 随即返回 `queued: true`，不执行终态校验；释放持有者后终态任务被晋升。见 V-01。 |

## 应修复的问题

### V-01 [中，阻断 live 私聊排队路径] 槽位忙时终态任务绕过拒绝并在稍后占用 active conversation

代码证据：

- `scripts/lib/send-service.mjs:171-184`
- `scripts/lib/contact-slots.mjs:68-115`
- `scripts/lib/contact-slots.mjs:150-175`

现实触发条件：任务 A 正与联系人沟通并持有槽位；任务 B 已完成，但宿主仍基于完成前的旧快照调用一次 `sendUser()`。这与 U-01 已覆盖的迟到发送相同，只是此时联系人槽正忙。

`acquireContactSlot()` 在 slot/task 锁内发现已有 holder 后，不检查任务 B 的状态，而是给其 subtask 写入 `waiting_kind=contact_slot`。`sendUser()` 看到 `slot.acquired === false` 就立即返回，因而不会进入 `executeSend(... rejectFinishedTask: true)`。随后任务 A 释放槽位，`releaseContactSlot()` 也不校验候选任务状态，直接为 completed 的任务 B 创建 active conversation。

独立隔离复现稳定得到：

```json
{
  "staleResult": { "queued": true, "position": 1 },
  "terminalStatus": "completed",
  "queuedState": { "status": "completed", "waitingKind": "contact_slot" },
  "promotion": { "taskId": "completed-task", "conversationId": "new-conversation" },
  "promotedState": { "status": "completed", "waitingKind": null },
  "activeConversationOwner": "completed-task"
}
```

影响：completed 任务没有待发送 action，却在前一会话结束后成为该联系人的唯一 active conversation；后续任务再次进入队列，直到人工关闭这个无实际消息的会话。控制台先显示迟到发送“已排队”，随后又可能表现为无对应外发的联系人占用。

建议在 `acquireContactSlot()` 已持有的 slot + task 锁窗口内、创建 conversation 或写入等待队列之前复核任务是否允许私聊；终态任务直接返回/抛出与 `executeSend()` 一致的拒绝结果。现有“取得槽位后才并发完成”的 catch 回滚仍需保留。`releaseContactSlot()` 晋升候选时也应在 task lock 内跳过或清理已经终态的候选，避免排队后取消/终止产生同类泄漏。回归测试至少覆盖：联系人忙时 completed 任务的 `sendUser()` 被拒绝且不写入队列；持有者释放后不会为它创建 conversation，下一有效候选仍可晋升。

## 验证记录

- 根目录 `npm test`：连续两次 55/55 通过。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。
- `git diff --check 77c27d7..7147d55`：通过。
- 独立验证了 U-01 新增的空闲槽位顺序路径和取得槽位后完成路径；两者均已关闭。
- 额外隔离复现 V-01：槽位忙时 completed 任务稳定返回 `queued: true`，原持有者释放后该 completed 任务稳定成为 active conversation 的 owner。
- 本提交没有 `web-console/` 视觉改动，因此未进行路由视觉检查。
- 评审开始时分支为 `main`，HEAD 与远端 `origin/main` 均为 `7147d55`，工作区干净；本评审只新增本文件，没有修改实现。

## 最终判定

U-01 在“已取得槽位”的两条路径上已修复，但在“槽位忙、直接排队”的分支上仍可稳定复现同等影响。补齐入队前终态复核、晋升时终态过滤及相应测试后，再做一次聚焦复审即可。
