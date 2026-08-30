Branch: `main`

Review range: `ece95074be8ce9789118bf373b698eab03dd8a54..77c27d72315e9c486fa0308aa52f7eb0b91dc5fa`

Reviewed at: `2026-08-31T01:52:44+08:00`

Verdict: `request changes`

# 阶段一至四第四轮复审

## 结论

提交 `77c27d72315e9c486fa0308aa52f7eb0b91dc5fa` 已实质关闭 T-01、T-02、T-03、T-05、T-06，T-04 的 action/complete 原子性主问题也已关闭。HTTP 响应现在晚于幂等结果落盘；command 扫描路径按 collection -> record 顺序重读验证；`parent_task_id` 覆盖了 `approval.apply` 取消传播；审批创建在终态校验后才落盘；runtime reference 与实现一致。根测试连续三次 53/53，没有复现上一轮 45/46 flake。

但 T-04 的私聊入口仍有一个可稳定复现的资源泄漏：`sendUser()` 在终态检查之前先取得联系人槽并创建 active conversation；随后 action 预落盘因任务已完成而被拒绝，却没有释放刚创建的 conversation。下一任务联系同一人会被永久排队。该问题触发于已支持的任务终态/发送竞态，影响同联系人后续任务，具有明确修复价值，因此本轮仍为 `request changes`。

## T-01～T-06 关闭状态

| Finding | 状态 | 本轮证据 |
| --- | --- | --- |
| T-01 即时幂等重放 | 已关闭 | handler 响应先捕获，幂等记录 completed 后才发送；live running 重放等待完成，过期 running 才返回 unknown outcome。根测试三次全绿。 |
| T-02 recover 覆盖 ack | 已关闭 | claim/recover/cancel 均在 collection lock 后逐条取得 `command:<id>`，锁内重读并验证；新增恢复与 ack/begin 回归测试通过。 |
| T-03 取消遗漏 approval.apply | 已关闭 | 派生命令保存 `parent_task_id`，取消按父任务匹配；取消审批命令和 tick 不复活测试通过。 |
| T-04 complete/action 竞态 | 部分关闭 | action 预落盘与完成检查已通过 task lock 串行；但私聊 conversation 在终态拒绝前创建，失败后未回滚。见 U-01。 |
| T-05 pending 孤儿审批 | 已关闭 | 终态校验、approval 创建、task/item 关联处于同一锁窗口；完成/审批竞态与三种终态测试均未留下孤儿。 |
| T-06 runtime reference | 已关闭 | command 锁协议、`parent_task_id`、幂等生命周期和 explicit-marker stop rule 已同步。 |

## 应修复的问题

### U-01 [中，阻断 live 私聊路径] 被拒绝的终态任务发送会泄漏 active conversation

代码证据：

- `scripts/lib/send-service.mjs:168-195`
- `scripts/lib/contact-slots.mjs:64-85`

现实触发条件：宿主准备向任务 A 的联系人发送私聊时，任务 A 已完成，或者任务在联系人槽取得后、action 预落盘前并发完成。这是 T-04 所处理的同一任务完成/外发竞态，不需要损坏 runtime 或手工编辑文件。

`sendUser()` 先调用 `acquireContactSlot()`；该函数会创建 active conversation 并写入 subtask。随后 `executeSend(... rejectFinishedTask: true)` 在 task 锁内发现 completed/cancelled/failed/paused，抛出 `INVALID_STATE_TRANSITION`。调用链没有关闭或释放此前取得的 conversation。

隔离顺序复现稳定得到：

```json
{
  "sendError": "INVALID_STATE_TRANSITION",
  "activeAfterRejectedSend": [{ "taskId": "TASK-A", "subtaskId": "SUB-A" }],
  "nextTaskSend": { "queued": true, "holderTaskId": "TASK-A", "position": 1 },
  "actionCountForA": 0
}
```

影响：任务 A 没有发送 action，却永久占用该联系人的唯一活动沟通槽；之后所有需要联系同一人的任务都会等待，直到人工发现并执行 `close-conversation`。页面表现为无实际会话却持续“等待联系人槽”，属于 live 工作流可用性问题。

修复应保证“取得槽位 + 终态复核 + action intent 预落盘”具有一致的提交/回滚语义。可在 slot/task 锁窗口内完成终态复核与 action intent 创建，或在 `executeSend` 因终态拒绝且尚未创建 action 时幂等释放刚取得的 conversation。回归测试至少覆盖：已完成任务调用 `sendUser` 后没有 active conversation；以及 acquire 后并发 complete、send 被拒绝时下一任务仍可取得同一联系人槽。

## 验证记录

- 根目录 `npm test`：连续三次 53/53 通过；上一轮即时 replay 的 45/46 flake 未复现。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。
- `git diff --check ece9507..77c27d7`：通过。
- 逐项检查了 T-01～T-06 的实现、契约和新增测试；原四条并发/恢复主路径均已关闭。
- 额外隔离复现确认 U-01：终态私聊被拒绝后 active conversation 仍存在，后续任务稳定进入 contact-slot 队列。
- 本提交没有 `web-console/` 视觉改动，因此未进行五路由视觉检查。
- 评审开始时分支为 `main`，HEAD 为 `77c27d7`，工作区干净；本评审只新增本文件，没有修改实现。

## 最终判定

T-01～T-06 中除 T-04 的 conversation 生命周期残余外均可关闭。修复 U-01 并补充两条联系人槽回归测试后，可再做一次聚焦复审；在此之前不建议开启 live 私聊执行。
