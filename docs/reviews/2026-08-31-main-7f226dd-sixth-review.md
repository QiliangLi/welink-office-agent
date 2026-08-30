Branch: `main`

Review range: `7147d5510947ff0d5d709652daf8d3519271b28b..7f226dd2bbcd8748fa67dc0ce4195364d803ec04`

Reviewed at: `2026-08-31T02:25:51+08:00`

Verdict: `request changes`

# 阶段一至四第六轮复审

## 结论

提交 `7f226dd2bbcd8748fa67dc0ce4195364d803ec04` 已完整关闭 V-01 指出的两条路径：联系人忙时，终态任务会在 slot + task 锁内被拒绝且不会入队；候选排队后变成终态时，释放逻辑会清理该候选并继续按稳定顺序晋升下一项。新增两条测试覆盖了拒绝、清理和有效候选继续晋升，独立检查未发现 V-01 残留。

但本次为取消和完成新增的 `releaseTaskConversations()` 会无条件关闭 active conversation，没有等待该会话关联的 `executing`/`unknown` 外发收口。live 外发尚在 `welink-cli` 中执行时取消任务，会立即把同一联系人槽交给下一任务；下一任务可以在上一条外发结果未知时启动自己的外发。上一条外发随后成功时，`executeSend()` 还会把已取消任务的子任务重新写成 `waiting_reply`。该竞态可稳定复现，会破坏同联系人串行和回复归属不变量，因此本轮仍为 `request changes`。

## V-01 关闭状态

| 场景 | 状态 | 本轮证据 |
| --- | --- | --- |
| 联系人忙时，终态任务发起迟到发送 | 已关闭 | `acquireContactSlot()` 在持有 slot + task 锁时先检查根任务状态；completed 任务抛出带 `terminalRefusal` 的错误，不写队列字段。 |
| 候选排队后取消/终止 | 已关闭 | `releaseContactSlot()` 在 candidate task lock 内复核状态，清理无效候选并继续遍历。 |
| 无效候选之后仍有有效候选 | 已关闭 | 新增测试确认跳过 B 后稳定晋升 C，且仅 C 持有 active conversation。 |

## 应修复的问题

### W-01 [高，阻断 live 私聊取消路径] 取消会在外发仍 executing 时提前释放联系人槽

代码证据：

- `scripts/lib/task-service.mjs:99-109`
- `scripts/lib/contact-slots.mjs:68-76`
- `scripts/lib/send-service.mjs:97-138`

现实触发条件：任务 A 已取得联系人槽并预落盘 `executing` action，`welink-cli` 调用尚未返回；任务 B 已在同一联系人后排队；此时用户从控制台取消任务 A。这是公开支持的 live 发送、同联系人排队和取消操作的直接组合，CLI 网络延迟或超时会自然扩大触发窗口。

`cancel()` 先把 A 改为 cancelled，随后无条件调用 `releaseTaskConversations()`。该函数只检查 conversation 是否 active，不检查关联 action 是否仍为 `executing` 或 `unknown`，于是关闭 A 的会话并立即晋升 B。B 再次调用 `sendUser()` 时会取得自己刚被晋升的 conversation，并预落盘第二条 action；此时 A 的外发仍在执行。同一联系人因此同时存在两个 `executing` 外发，只是 active conversation 已切换到 B。

使用一个延迟 3 秒返回成功的隔离 `welink-cli` 替身可稳定得到：

```json
{
  "taskAStatus": "cancelled",
  "simultaneousActions": [
    { "task": "A", "status": "executing", "conversationId": "conversation-A" },
    { "task": "B", "status": "executing", "conversationId": "conversation-B" }
  ],
  "activeConversationOwners": ["B"]
}
```

当 A 的 CLI 随后成功返回，当前 `executeSend()` 仍无条件执行成功后的 subtask mutation，隔离复现中的 A 最终状态为：根任务 `cancelled`，子任务却变成 `waiting_reply`。

影响：

- 对同一联系人的两条私聊可以重叠发送，违反仓库规定的联系人串行不变量。
- A 的实际消息可能在取消后才送达，而 runtime 已把唯一 active conversation 指向 B；没有显式 reply/thread 标识的回复会按“唯一活动会话”回退到 B，产生错误回复归属。
- 已取消任务的子任务被异步写回 `waiting_reply`，终态快照内部自相矛盾。

修复需要让取消/强制完成、action 收口和槽位移交共享一致的时序。至少应做到：关联 action 为 `executing` 或 `unknown` 时不晋升下一联系人任务；action 最终落盘后重新读取根任务状态，终态任务不得再把 subtask 改为 `waiting_reply`，并在安全收口点关闭原 conversation、再晋升下一有效候选。不能仅在 `cancel()` 前做一次无锁 action 查询，否则新的竞态窗口仍然存在。回归测试应使用可控的延迟 CLI：A 外发进入 executing，B 排队，取消 A；断言 A action 收口前 B 不会获得可发送槽位，A/B 不会同时 executing；A 收口后 A 的 subtask 不会复活为 waiting_reply，B 才能按策略晋升。

## 验证记录

- 根目录 `npm test`：连续两次 57/57 通过。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。
- `git diff --check 7147d55..7f226dd`：通过。
- 逐条核对并运行了 V-01 的“终态任务不入队”和“跳过终态候选后继续晋升”测试；V-01 已关闭。
- 独立 live-mode 隔离复现 W-01 两次：取消时 A action 保持 executing 而 B 已成为 active owner；继续触发 B 发送后，A/B 两条 action 同时为 executing。A 返回成功后，cancelled 任务的 subtask 稳定变为 waiting_reply。
- 本提交没有 `web-console/` 视觉改动，因此未进行路由视觉检查。
- 评审开始时分支为 `main`，HEAD 与远端 `origin/main` 均为 `7f226dd`，工作区干净；本评审只新增本文件，没有修改实现。

## 最终判定

V-01 可以关闭。W-01 是本次主动释放终态任务会话带来的 live 并发回归；在保证外发收口前不移交联系人槽、并阻止终态任务的 post-send 子任务复活后，可再做一次聚焦复审。修复时还应同步 `references/runtime-schema.md` 和 `docs/frontend-backend-integration.md` 中的取消、会话释放与晋升语义。
