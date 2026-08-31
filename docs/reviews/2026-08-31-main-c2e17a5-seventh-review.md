Branch: `main`

Review range: `7f226dd2bbcd8748fa67dc0ce4195364d803ec04..c2e17a5a54942b7eaafab87700c4ae53c2384c77`

Reviewed at: `2026-08-31T09:49:00+08:00`

Verdict: `request changes`

# 阶段一至四第七轮复审

## 结论

提交 `c2e17a5a54942b7eaafab87700c4ae53c2384c77` 已关闭 W-01 的成功收口路径：取消任务时，`releaseTaskConversations()` 会在 action lock 内复核状态，仍为 `executing` 的会话继续占槽；外发成功落盘后才释放并晋升下一候选；终态任务的 subtask 不再被写回 `waiting_reply`。已收口 action 的安全取消路径也能立即释放联系人。新增测试和独立延迟 CLI 验证均通过。

但 timeout/unknown 路径仍与实现注释、新增 runtime schema 和集成文档直接矛盾。`executeSend()` 把超时结果落成 `unknown` 后，只依据“任务是否终态”释放 conversation，没有排除 `unknown`；因此取消期间发生 CLI timeout 时，下一任务仍会在结果核实前获得同一联系人槽。该路径正是 action recovery 的公开能力边界，影响同联系人串行和回复归属，W-01 尚未完整关闭。

## W-01 修复状态

| 场景 | 状态 | 本轮证据 |
| --- | --- | --- |
| 取消发生在 action executing，随后成功 | 已关闭 | 取消阶段保留 A；action succeeded 后释放 A、晋升 B；A subtask 不复活。 |
| 取消发生在已收口 action 之后 | 已关闭 | 没有 unsettled action 时立即释放 conversation，后续任务可直接取得槽位。 |
| 取消发生在 action executing，随后已知失败 | 已关闭 | failed 是确定结果，终态收口路径可以安全释放。 |
| 取消发生在 action executing，随后 timeout/unknown | 未关闭 | action 落成 unknown 后，`finishedDuringSend` 触发无条件 release，B 在核实前被晋升。见 X-01。 |

## 应修复的问题

### X-01 [高，阻断 live timeout 恢复路径] unknown action 收口时仍会释放联系人槽

代码与契约证据：

- `scripts/lib/send-service.mjs:138-165`
- `scripts/lib/contact-slots.mjs:70-77`
- `references/runtime-schema.md:91`
- `docs/frontend-backend-integration.md:872`

现实触发条件：任务 A 正在向联系人发送 live 私聊，任务 B 在同一联系人后排队；用户在 CLI 尚未返回时取消 A，随后 `welink-cli` 超时，action 进入 `unknown`。这不依赖损坏数据或手工改 runtime；默认 wrapper 明确定义了 60 秒 timeout，并把模糊结果作为 unknown 进入恢复流程。

取消阶段本身处理正确：`releaseTaskConversations()` 在 action lock 内看到 `executing`，保留 A 的 active conversation。但 CLI 超时后，`executeSend()` 把 action 更新为 `unknown`，随后在 `result.ok === false` 分支读取到 A 已 cancelled，将 `finishedDuringSend` 设为 true。第 161～165 行没有检查 `finalAction.status`，因此仍调用 `releaseContactSlot()`，关闭 A 并晋升 B。

使用与生产代码相同的 `runWelink()`，仅在隔离 fixture 中把 60 秒 timeout 缩短为 300 毫秒，并让 CLI 替身延迟返回，可稳定得到：

```json
{
  "actionAStatus": "unknown",
  "taskAStatus": "cancelled",
  "activeConversationOwners": ["B"]
}
```

影响：A 的消息是否已经送达尚未核实，B 却已经可以向同一联系人发送；如果 A 实际已送达，A/B 消息会在语义上重叠。没有显式 reply/thread 标识的联系人回复会按唯一 active conversation 归入 B，造成错误任务推进。与此同时，新增文档声称 unknown 会保持占槽，实际行为相反，宿主 Agent 会基于错误恢复契约行动。

修复应让终态 post-send 释放条件显式排除 `finalAction.status === 'unknown'`：unknown conversation 保持 active，直到宿主按 recovery 流程核实外发结果并显式 `close-conversation`。成功、dry-run 和已知失败仍可在安全收口点释放。回归测试应使用可控短 timeout 覆盖：A executing、B 排队、取消 A、A 变 unknown；断言 A 仍是唯一 active owner，B 继续排队，直到显式关闭 A 后才晋升 B。测试不应只覆盖成功的延迟 CLI。

## 验证记录

- 根目录 `npm test`：连续两次 59/59 通过。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。
- `git diff --check 7f226dd..c2e17a5`：通过。
- 独立验证成功收口：取消时 A 保持 active；A succeeded 后 B 才晋升；A subtask 不变为 waiting_reply。
- 独立验证 unknown 收口：缩短隔离 fixture 的 wrapper timeout 后，A action 稳定落成 unknown，但 active owner 已切换为 B，复现 X-01。
- 文档已同步新增的取消/会话生命周期语义，但 unknown 的当前实现不符合该语义。
- 本提交没有 `web-console/` 视觉改动，因此未进行路由视觉检查。
- 评审开始时分支为 `main`，HEAD 与远端 `origin/main` 均为 `c2e17a5`，工作区干净；本评审只新增本文件，没有修改实现。

## 最终判定

W-01 的成功、dry-run、已知失败和安全立即释放路径可以关闭；timeout/unknown 路径仍会提前移交联系人槽。补充 unknown 状态保护和对应短超时回归测试后，可再做一次聚焦复审。
