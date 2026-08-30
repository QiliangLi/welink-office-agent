Branch: `main`

Review range: `588860f04a963f12007dc19cc8fff39256f3e0f0..ece95074be8ce9789118bf373b698eab03dd8a54`

Reviewed at: `2026-08-30T20:30:52+08:00`

Verdict: `request changes`

# 阶段一至四第三轮复审

## 结论

提交 `ece95074be8ce9789118bf373b698eab03dd8a54` 确实关闭了显式 reply 标识未命中时错误回退的问题，并修复了创建任务响应 revision 与 command 幂等追踪键两个观察项。提醒计数改用任务 mutation、完成条件移入任务锁、assignment 增加 delivered/acked/executing 状态、幂等占位区分 reserved/running，方向都正确。

但 R-01、R-03、R-04 尚未完全关闭。根测试在完整套件中连续两次稳定得到 45/46；此外四条隔离复现分别确认了 immediate replay 冲突、ack 被租约恢复覆盖、父任务取消遗漏 approval command、任务完成越过新建 executing action。完成态任务创建审批还会留下 pending 孤儿记录。这些问题都处在文档声明支持的正常并发、取消、重启和幂等路径，不是为了凑数提出的极端 benign corner case。

## 上轮项目关闭状态

| 项目 | 状态 | 本轮结论 |
| --- | --- | --- |
| R-01 任务读改写收口 | 部分关闭 | 催办计数和 task/approval 竞态有改善；action 创建仍不参与任务完成的锁窗口，可把有 executing action 的任务标为 completed。 |
| R-02 显式 reply 未命中 | 已关闭 | 未知 reply/thread marker 直接记为 `unattributed/explicit_marker_unmatched`，不会污染唯一活动会话。 |
| R-03 assignment 取消与恢复 | 未关闭 | cancel/deliver 单记录路径已修；租约恢复仍可覆盖并发 ack，且任务取消遗漏 aggregate 为 approval 的 `approval.apply`。 |
| R-04 幂等占位崩溃恢复 | 部分关闭 | reserved 可接管、running 结果未知的模型已落地；但正常请求已回包而记录尚未 complete 的窗口会把即时重放误判为 unknown outcome。 |
| 观察：创建响应 revision | 已关闭 | POST `/tasks` 返回 mutation 后的 task，响应 revision 与磁盘一致。 |
| 观察：command 幂等追踪键 | 已关闭 | HTTP `Idempotency-Key` 已传入 `task.create` command。 |
| 观察：集成设计状态 | 未关闭 | 首页已改写为“全部关闭”，但本复审仍有未关闭项，应在修复后再保留该声明。 |

## 必须修复的问题

### T-01 [高，阻断发布] 正常的即时幂等重放会被误判为未知结果

代码证据：

- `server/app.mjs:88-102`
- `server/services/idempotency-service.mjs:75-89`
- `test/server.test.mjs:79-97`

现实触发条件：客户端收到 POST `/tasks` 的 202 后立即用相同 `Idempotency-Key` 和 body 重放；这既是现有回归测试的直接用法，也是网络层在响应边界重试的正常行为。

`reply()` 先调用 `res.end()`，而 idempotency `complete()` 要等 handler 返回后才执行。客户端可在首个响应已经可见、记录仍为 `running` 的窗口发起第二次请求；`begin()` 对任何 running 记录立即返回 `IDEMPOTENCY_CONFLICT/unknown_outcome`，没有等待仍存活的首请求完成。

完整根测试连续两次均为 45/46，失败点是重放响应没有 `task.id`；单独运行该用例可通过，说明它是由真实调度窗口触发的竞态，而不是断言写错。

影响：相同请求不能稳定重放首个结果；如果首个响应在网络中丢失，客户端既拿不到 task ID，也会被要求查询一个它不知道的 aggregate。修复时应在发送 HTTP 响应前完成幂等记录持久化，或让 lease 尚有效的 running 记录短暂等待 completed，仅在租约过期/确认进程中断后返回 unknown outcome。增加一个控制 complete 时序的确定性回归测试。

### T-02 [高，阻断 live] 租约恢复可用旧快照覆盖已经成功的 ack

代码证据：

- `scripts/lib/commands.mjs:173-182`
- `scripts/lib/commands.mjs:214-243`
- `references/runtime-schema.md:70`

现实触发条件：delivered assignment 到达租约边界时，宿主执行 `ack-command`，同时另一轮 tick 执行 `recoverExpiredLeases()`。这是宿主处理稍慢或调度拥塞时的直接恢复路径。

ack 持有 `command:<id>` 记录锁；恢复只持有 `commands` 集合锁，读取 delivered 快照后不再取得记录锁或重读当前状态。用 barrier 暂停恢复写入、让 ack 先完成，再恢复旧快照写入，可稳定得到：

```json
{"ackReturned":"acked","recovered":["CMD-..."],"finalStatus":"queued","finalAssignmentState":null}
```

影响：宿主已经确认接手的 assignment 又回到队列，可能被第二个宿主重复规划、重复执行或重复外发。发生频率取决于 lease 边界，但潜在影响是重复外部动作，按仓库评审规则仍属于高价值 finding。

修复应让 recover/claim/cancel 与单记录 writer 共享可证明的锁协议：集合锁后逐条取得 `command:<id>`，在记录锁内重新读取并验证 transition，再保存；同时补充 recovery-vs-ack 和 recovery-vs-begin 的 barrier 测试。文档不能继续声称所有 transition 都已在记录锁内验证，除非实现真正满足。

### T-03 [高，阻断 live] 父任务取消不会撤销 `approval.apply` 命令

代码证据：

- `scripts/lib/task-service.mjs:98-106`
- `scripts/lib/approval-service.mjs:143-151`
- `scripts/agent.mjs:121-208`

现实触发条件：用户批准一个消息发送审批，系统写入 `approval.apply`，随后在 tick 执行前取消父任务。这是 UI 允许的常规操作顺序。

`TaskService.cancel()` 只调用 `cancelQueuedForAggregate('task', taskId)`；`approval.apply` 的 `aggregate_type/aggregate_id` 是 `approval/<approvalId>`。隔离复现中取消前后命令均为 `queued`，`cancelledCommands=[]`。后续 tick 会反复 claim 后因任务 cancelled 又 release，造成永久积压；如果取消发生在 tick 已读取 running task、尚未预落盘 action 的窗口，确定性发送仍可能继续。

影响：取消语义对关联审批命令不完整，健康区持续显示无法消费的积压，并保留取消后外发的竞态。修复应给所有命令保存稳定的 parent task 关联，取消时按 parent task 撤销 queued/claimed/delivered/acked 的全部相关命令；外部 action 预落盘前还应在统一锁窗口内复核当前 task/command 状态。测试需覆盖 queued approval.apply 取消以及 claim 后取消与 action 创建的 barrier 路径。

### T-04 [高，阻断 live] 完成检查仍可越过并发创建的 uncertain action

代码证据：

- `scripts/lib/task-service.mjs:247-264`
- `scripts/lib/send-service.mjs:45-65`

现实触发条件：一个进程执行 `complete-task`，另一个 tick/宿主同时为该任务开始发送消息。Console API 与 Agent 并行运行、外部 action 先落盘正是当前架构的正常模式。

`completeTask()` 虽然在 task 锁内读取 actions，但 SendService 创建新的 `executing` action 不取得 task 锁。用 barrier 在完成逻辑取得空 action 快照后创建 `ACT-RACE`，再放行 task 保存，可稳定得到：

```json
{"completeOk":true,"finalTaskStatus":"completed","uncertainActions":["ACT-RACE"]}
```

影响：任务违反 `require_no_uncertain_actions` 仍进入 completed，外部发送结果可能在完成之后才落盘，恢复和 UI 都会得到互相矛盾的事实。修复需要让 action intent 的创建与任务终态检查共享锁/序列化点，或在提交 completed 前做有版本依据的二次校验；仅把 `listActions()` 放进 task mutator 不构成原子性。增加 send-start-vs-complete 的跨 Store barrier 测试。

## 应修复的问题

### T-05 [中] 拒绝为终态任务创建审批时会留下 pending 孤儿记录

代码证据：`scripts/lib/approval-service.mjs:31-73`

现实触发条件：宿主基于稍旧的任务快照创建审批，而任务刚刚完成；即使顺序执行，直接对 completed 任务调用 createApproval 也会触发。

服务先 `saveApproval(approval)`，随后才在 task 锁内检查 terminal status 并抛出 `INVALID_STATE_TRANSITION`。隔离复现得到调用失败但 `listApprovals()` 中仍有一条该 task 的 `pending` approval。它会出现在待处理列表；若用户继续处理，还会生成无法消费的 `approval.apply`。

修复应把 task 状态校验、approval 新记录创建和 task/item 关联置于同一个规范锁窗口；失败时不得留下对外可见的 pending 记录。增加 completed/cancelled task 创建审批不产生文件的测试，并在 completion-vs-createApproval 测试中同时断言 approval 集合。

### T-06 [中，文档契约] runtime reference 与本次实现仍有直接矛盾

代码证据：

- `references/runtime-schema.md:70`
- `references/runtime-schema.md:89-91`
- `scripts/lib/commands.mjs:224-243`
- `scripts/lib/conversations.mjs:80-91`

`runtime-schema.md` 仍写所有 command transition 都在记录锁内验证，但 recover 路径并非如此；回复归属仍写成“显式匹配 -> 唯一活动会话”，没有说明显式标识存在但未命中时必须立即 unattributed。这两处都是 `SKILL.md` 路由给宿主 Agent 的当前行为契约，不是无害措辞偏好。

影响：维护者会错误判断锁保证，宿主实现也可能重新引入本轮刚修复的串任务归属。按仓库文档同步约束，应在代码修复同一提交中同步准确状态机和 explicit-marker stop rule；集成设计首页的“残余问题均关闭”也应在 formal findings 真正关闭后再恢复。

## 验证记录

- 根目录 `npm test`：连续两次均为 45/46；失败用例为 `create task returns 202, replays idempotently and conflicts on payload change`。该用例单独运行可通过，符合响应/幂等落盘竞态特征。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过，并包含 `begin-command`。
- `node server/index.mjs --help`：通过。
- `git diff --check 588860f..ece9507`：通过。
- 四个隔离、非持久化复现：ack/recover 覆盖、task cancel/approval.apply、completed task/orphan approval、complete/action race 均稳定复现，输出已记录在对应 finding。
- 评审开始时分支为 `main`，HEAD 为 `ece9507`，工作区干净；本评审只新增本文件，没有修改实现。

## 最终判定

R-02 可以关闭，两个可观测性观察也可以关闭；R-01、R-03、R-04 仍需继续修复。当前提交不应据此开启 live 模式，也不能保留“第二轮残余均已关闭”的实现状态声明。优先修复 T-01 至 T-04 并补充确定性并发测试，再处理孤儿审批和文档同步后复审。
