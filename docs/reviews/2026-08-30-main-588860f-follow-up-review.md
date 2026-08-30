Branch: `main`

Review range: `66e97bd19b6f7b96d55cef3322c2b45d28aab8f9..588860f04a963f12007dc19cc8fff39256f3e0f0`

Reviewed at: `2026-08-30T19:45:58+08:00`

Verdict: `request changes`

# 阶段一至四修复提交复审

## 结论

提交 `588860f04a963f12007dc19cc8fff39256f3e0f0` 明显改善了上一轮评审中的锁接管、失败任务重试、loopback 边界和 SSE 恢复，也补充了有价值的回归测试。F-01、F-04、F-07 以及上一轮列为延后加固的 SSE cursor 问题可以关闭。

但当前还不能认定 7 项 findings 全部关闭。F-02、F-05、F-06 均存在可稳定复现的残余正确性问题；F-03 的正常并发重放已修复，但进程中断后的持久化占位没有恢复路径。前三项会分别导致任务更新丢失、回复串错任务、取消后的命令重新执行或 assignment 永久卡住，属于进入 live 模式前需要修复的问题。

## 原 findings 关闭状态

| 原 finding | 状态 | 复审结论 |
| --- | --- | --- |
| F-01 过期锁接管 | 已关闭 | 接管后重新参与 `wx` 竞争，锁带 owner token，迟到释放不会删除新 owner 的锁；回归测试覆盖主路径。 |
| F-02 并发写绕过 mutation | 未关闭 | 催办结果仍以旧快照直接 `saveTask`；完成条件仍在任务锁外检查，均可破坏并发正确性。 |
| F-03 POST 幂等 | 部分关闭 | 正常重放、并发重复请求和 body 冲突已覆盖；崩溃遗留的 `in_progress` 记录永久阻塞重试。 |
| F-04 failed task retry | 已关闭 | HTTP 创建的 `task.retry` 可以由 tick 输出 `retry_task` assignment。 |
| F-05 延迟回复归属 | 未关闭 | 已关闭会话的精确匹配已实现，但“带显式标识且未匹配”仍错误回退到唯一活动会话。 |
| F-06 waiting_agent 交付/取消 | 未关闭 | claim 到 delivery 的取消可被复活；ack 后没有恢复租约，取消校验依赖过期的 assignment 状态。 |
| F-07 非 loopback 暴露 | 已关闭 | 启动前及 bind 后均检查 loopback，非 loopback 参数有测试覆盖。 |
| SSE per-record cursor / 截断恢复 | 已关闭 | event id 按 JSONL 记录推进，非法或越界 cursor 触发 `snapshot.required`。 |

## 必须修复的问题

### R-01 [高，阻断 live] F-02 的任务读改写仍未全部收口

代码证据：

- `scripts/agent.mjs:313-318`
- `scripts/lib/task-service.mjs:247-259`

现实触发条件一：tick 成功发送一条催办后准备增加 `reminder_count`；与此同时 Console API 或宿主 Agent 给同一任务追加指令或更新其他字段。这是推荐的 Console API 与 Agent 并行运行方式。

催办路径重新读取 task 后直接修改并调用 `saveTask(updatedTask)`，没有经过 task 锁。按“tick 先读旧快照 → API 在 `mutateTask` 中加入 instruction → tick 保存旧快照”的顺序稳定复现后，新增 instruction 数量从 1 变回 0。

现实触发条件二：`completeTask()` 在 task 锁外读取 task 并计算 blockers，之后才调用 `mutateTask()` 写完成状态。若两步之间并发加入 pending approval 或其他阻塞工作，完成写会保留新字段但仍把根任务标为 completed。注入一个并发 `pending_approval_id` 的复现结果为 `status=completed` 且 `pending_approval_ids=["AP-CONCURRENT"]`。

影响：丢失用户新指令、错误增加催办次数，或让仍有审批/工作项的任务进入完成态。修复应把催办计数更新改为 `mutateTask`，并在同一个 task 锁窗口内对最新 task 重新计算完成条件；涉及 uncertain actions 时也要定义一致的锁定或二次校验策略。增加带 barrier 的并发回归测试，不能只测试两个顺序执行的 service 调用。

### R-02 [高，阻断 live] F-05 在显式 reply 标识未命中时仍会串到当前任务

代码证据：`scripts/lib/conversations.mjs:76-85`

现实触发条件：联系人回复一条历史消息并携带 reply/thread 标识，但本地 conversation 因历史迁移、清理或上游标识格式变化而没有对应记录；同一联系人此时已经有任务 B 的唯一活动会话。

`attributeReply()` 尝试精确匹配失败后，无条件继续执行“唯一活动会话”回退。使用一个关闭的任务 A 会话、一个活动的任务 B 会话和 `replyToActionId=ACT-UNKNOWN` 可稳定得到 `attributedTaskId=TASK-B`。

影响：明确指向其他上下文的回复被写入任务 B，违反“不得猜测回复归属”的核心边界。修复应在任一显式标识存在但未命中时直接返回 `unattributed`（或专门的 unresolved 状态），只有完全没有显式标识时才能应用唯一活动会话规则。增加“未知显式 marker + 唯一活动会话”的回归测试。

### R-03 [高，阻断 live] F-06 的 assignment 状态机仍可越过取消且无法恢复 ack 后崩溃

代码证据：

- `scripts/lib/commands.mjs:100-145,148-159,173-220`
- `scripts/agent.mjs:131-182`
- `SKILL.md:51`

现实触发条件一：tick 已把 command 从 queued 领取为 claimed，用户随后取消任务，之后 tick 继续执行刚才读取到的 assignment 分支。`claimNext()`/`cancelQueuedForAggregate()` 使用集合锁 `commands`，而 `markWaitingAgent()` 使用记录锁 `command:<id>`；两套锁互不排斥，且 `markWaitingAgent()` 不检查当前状态。顺序执行“claim → cancel → markWaitingAgent”即可把已经是 cancelled 的 command 重新写成 `waiting_agent/delivered`。

现实触发条件二：宿主执行 `ack-command` 后、真正执行 assignment 前任务被取消或宿主进程退出。ack 会清空租约，取消逻辑明确跳过 acked assignment；文档要求检查 assignment 中的 `task_status`，但该值是 tick 输出时的旧快照，不是取消后的当前状态。复现中 assignment 的状态仍为 running，而磁盘 task 已为 cancelled，command 永久保持 `waiting_agent/acked`。

影响：取消后的规划、指令或外部动作仍可能继续；宿主在 ack 后崩溃会让命令永久卡住。这正是 F-06 原本要关闭的两个风险。

修复应统一 command 状态变更的锁域并对每个转换实施单调状态校验，例如 cancelled 不允许进入 waiting_agent/succeeded；ack 需要在锁内同时校验 command 和当前 task。acked 只代表交付确认，不应永久清除恢复能力，应保留可续租的 execution lease/heartbeat 或明确的宿主恢复协议。外部动作前必须读取持久化的当前 task/command 状态，不能使用 assignment payload 中的旧 `task_status`。回归测试至少覆盖 claim/cancel/deliver、ack/cancel/action 和 ack 后进程退出三条路径。

## 应修复的问题

### R-04 [中] F-03 的 `in_progress` 幂等占位没有崩溃恢复

代码证据：

- `server/services/idempotency-service.mjs:52-89,104-106`
- `references/runtime-schema.md:74`

现实触发条件：Console API 在 `begin()` 写入 `in_progress` 后、handler 完成或 `fail()` 清理前被终止，然后使用同一 `Idempotency-Key` 重试。这是持久化幂等层应处理的直接恢复场景。

记录没有 lease、owner attempt 或过期时间。重启后的每次 `begin()` 都等待 10 秒，再返回 `IDEMPOTENCY_CONFLICT`；记录永远不会自动清理。复现保留首次占位但不调用 complete/fail，第二个 service 实例在约 10.1 秒后稳定得到冲突。runtime schema 中“崩溃遗留占位会释放重试”的描述与实现不符。

影响：如果中断发生在 handler 前，请求永久无法执行；如果发生在部分写入后，客户端也无法取得首次结果或进入有依据的恢复流程，只能人工删除 runtime 文件。

修复应给占位增加 lease/attempt owner，并区分“尚未开始副作用，可安全接管”与“结果未知，需要按 aggregate/command 查询恢复”。不能简单按时间删除后盲目重放可能产生外部动作的请求。增加跨 service 实例或模拟重启的测试，并同步修正文档。

## 非阻断观察

- `server/services/console-command-service.mjs:19-46` 在链接 `queued_command_id` 后仍返回第一次创建的 task 对象，因此 POST `/tasks` 返回的 revision 比磁盘当前 revision 小 1。当前前端成功页不复用该 revision，暂不列为 formal finding；若 API 客户端会基于创建响应立即写入，应返回 mutate 后的 task。
- `createTaskFromConsole()` 的注释称会把幂等键写入 command 供追踪，但 route 传入的 `body.__idempotencyKey` 实际未被设置，command 的 `idempotency_key` 为 null。统一 HTTP 幂等仍有效，因此当前只属于可观测性/文档一致性问题。
- `docs/frontend-backend-integration.md:3` 当前写“7 项 findings 已全部修复”。应在上述残余问题修复后再保留此结论；本次复审判定下该状态声明不准确。

## 验证记录

- 根目录 `npm test`：41/41 通过。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。
- `git diff --check`：通过。
- 评审开始及质量门禁完成时，分支为 `main`，被评审提交工作区干净。

由于本地没有可用的 `ask` 命令，review Skill 约定的第二 provider 交叉评审未能执行。本结论来自逐项代码核查、现有 41 项根测试和上述四组隔离复现，不把缺少交叉 reviewer 当作代码 finding。

## 最终判定

本次提交可以合并其已关闭的 F-01、F-04、F-07 与 SSE 修复，但不能把原评审整体改为 approve，也不应据此开启 live 模式。先关闭 R-01 至 R-03；R-04 至少需要在发布前给出可恢复实现或明确的受限策略。修复完成后，再把集成设计首页的“7 项全部修复”恢复为事实陈述。
