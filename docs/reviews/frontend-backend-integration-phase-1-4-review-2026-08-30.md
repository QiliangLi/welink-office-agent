Branch: `main`

Review range: `3ca448f16f1aa53072ff2f485c6cd21325fcae63..ade4b724ead2d9b1be2d333e6e8b924f8783ddaa`

Reviewed at: `2026-08-30T16:13:49+08:00`

Verdict: `request changes`

# 前后端对接阶段一至四实现评审

## 评审结论

本次实现已经完成 Runtime 服务拆分、Console API、前端真实数据源、命令队列、联系人沟通槽、审批事实分离和 SSE 骨架，自动化门禁及桌面端五类主要页面检查均通过。

当前不建议进入 live 模式。正式 findings 只保留 7 个具有明确修复价值的问题：它们均存在可定位的代码证据，能在当前文档定义的运行方式下触发，并会影响核心功能、任务归属、重复外部动作、并发数据一致性或安全边界。样式偏好、无害的极端输入和仅影响体验的推测项不列入阻断清单。

## 必须修复的问题

### F-01 [阻断] 过期锁接管后没有真正持有锁

代码证据：`scripts/lib/locks.mjs:43-58,85-113`

现实触发条件：Console API 或 Agent 进程在持锁期间退出，留下超过租约的锁文件；后续任一进程尝试恢复该锁。

`takeOverIfExpired()` 删除旧锁后直接返回成功，`acquire()` 没有再次通过 `wx` 创建新锁文件。接管者进入临界区时磁盘上实际没有锁，其他进程可以同时进入；旧持有者释放时也没有 owner token 校验，可能删除新持有者的锁。

隔离临时目录复现结果：

```json
{"results":["fulfilled","fulfilled"],"lockFileExistsAfterAcquire":false,"aHeld":true,"bHeld":true}
```

影响：破坏 revision、命令领取、联系人槽位和所有 `mutate*` 的互斥前提，可能造成快照覆盖或重复执行。虽然需要租约过期才触发，但后果涉及持久化正确性，因此属于低频高损害的上线阻断问题。

修复建议：删除过期锁后重新回到 `fs.open(..., "wx")` 竞争；锁文件写入随机 owner token，释放前只删除匹配 token 的锁；为双进程接管和旧持有者延迟释放增加测试。

### F-02 [高] 正常并发写入绕过 mutation 锁

代码证据：

- `scripts/lib/task-service.mjs:65-69,101-108`
- `scripts/lib/approval-service.mjs:28-61,109-139`
- `scripts/lib/send-service.mjs:94-107,165-169`
- `scripts/lib/contact-slots.mjs:125-175`
- `server/services/console-command-service.mjs:153-168`

现实触发条件：Console API 和宿主 Agent 同时运行并修改同一个 task、approval、conversation 或 agent state。这是推荐架构的正常工作方式，不是压力测试专属场景。

多条路径仍使用 `load* → 修改对象 → save*`。例如两个任务并发创建时，两次 `loadState()`/`saveState()` 可能互相覆盖 `active_task_ids`；审批决定也可能覆盖 Agent 同时写入的 task 字段；释放联系人槽时只持有 slot 锁，却直接改写 promoted task。

影响：丢失任务字段、队列状态或审批关联，且 revision 无法阻止覆盖。修复 F-01 后这些路径仍然不安全。

修复建议：为 Action、Conversation 和 AgentState 补齐 mutation helper；跨对象变更统一进入固定锁顺序的 group mutation。`mutateGroup()` 还需要改成按 `kind + id` 保存记录，否则同组两个同类对象会互相覆盖。增加 API 与 tick 同时修改同一 task/approval 的集成测试。

### F-03 [高] POST 幂等没有覆盖实际写接口，并存在并发重复创建

代码证据：`server/app.mjs:46-58`、`server/routes/tasks.mjs:23-86`、`server/routes/approvals.mjs:69-101`、`server/services/console-command-service.mjs:19-57`、`scripts/lib/commands.mjs:29-78`

现实触发条件：用户双击、浏览器在响应丢失后重试，或两个请求携带相同 `Idempotency-Key` 并发到达。催办、追加指令和审批属于可能产生后续外部动作的普通页面操作。

除创建任务外，任务命令、催办、审批决定和批量决定都没有消费路由注入的 idempotency key。创建任务也只比较 description，且 command 的“扫描后创建”不在唯一索引锁内。

隔离复现结果：

```json
{"commandCount":2,"ids":["CMD-…","CMD-…"]}
{"firstPriority":"normal","secondPriority":"normal","replayed":true,"taskCount":1}
```

影响：重复催办、重复 instruction 或重复 command；相同描述但不同策略的请求还可能被静默当成第一次请求。进入 live 后可能造成重复外部消息。

修复建议：新增统一持久化 idempotency record，以 owner、route、key 为唯一约束，保存规范化 body hash、首次状态码和响应体；在独立索引锁内完成首次占位，并让所有 POST 统一使用该层。

### F-04 [高] failed task 的 retry 命令无法被 tick 消费

代码证据：`scripts/agent.mjs:117-167`、`server/services/console-command-service.mjs:81-93`

现实触发条件：用户在任意 failed task 详情页点击重试，是直接的产品功能路径。

Console 会创建 `task.retry` command，但 `runTick()` 在判断 command 类型前先跳过 failed task 的所有 command，后续 `task.retry` 分支对失败任务不可达。

影响：重试命令永久保持 queued，页面提供的重试功能实际不可用。

修复建议：按 task 状态和 command 类型组合判断可执行性，明确允许 failed/partial 上的 `task.retry`；增加从 HTTP 创建 retry 到 tick 输出 `retry_task` assignment 的端到端集成测试。

### F-05 [高] 延迟回复可能被归到后续任务

代码证据：`scripts/lib/message-service.mjs:19-52`、`scripts/lib/conversations.mjs:56-84`

现实触发条件：任务 A 的会话关闭或超时后，同联系人的任务 B 获得槽位；联系人随后回复 A 的旧消息，并携带 A 的 reply/action 标识。这是同联系人串行策略下可以自然发生的延迟回复，不需要并行开启两个活动会话。

当前代码只在 active conversations 中做显式标识匹配。A 已关闭后无法命中，随后“唯一活动会话”规则会把回复归到 B。同时，代码先更新 conversation，再调用 `logMessage()`，没有做到集成设计要求的“入站消息先落盘再归属”。

影响：把联系人回复写入错误任务，进而污染任务进度和最终结果；崩溃窗口还可能留下已更新会话但没有原始消息记录的状态。

修复建议：先持久化尚未归属的安全消息；显式 reply/thread 标识查询同联系人的全部历史 conversation；只有没有显式标识时才在 active 集合中应用唯一候选规则。增加“关闭 A、激活 B、A 延迟回复”的回归测试。

### F-06 [高] `waiting_agent` assignment 缺少确认和取消保护

代码证据：`scripts/lib/commands.mjs:123-180`、`scripts/agent.mjs:134-167,237-246`

现实触发条件：tick 把 command 写成 `waiting_agent` 后，在宿主可靠接收 assignment 前退出；或者用户在 assignment 已输出但尚未执行时取消任务。

command 转为 `waiting_agent` 时会清除租约，后续 tick 只领取 queued command，因此丢失的 assignment 不会自动恢复。取消任务也只取消 queued/claimed command，不能阻止已经交给宿主的旧 assignment 继续执行。

影响：任务可能永久卡住；更严重的是，用户取消后旧 assignment 仍可能继续产生外部动作。崩溃窗口概率不高，但涉及取消语义和外部副作用，进入 live 前必须处理。

修复建议：为 assignment 增加 delivery/ack 状态和租约；宿主确认接收后再完成交付，超时可以安全重投。宿主执行前重新校验 command 与 task 状态，取消操作同时撤销尚未开始的 waiting assignment。

### F-07 [高] 公共参数允许暴露无认证控制面

代码证据：`server/index.mjs:24-33,70-78,148-162`、`server/middleware/request-context.mjs:44-67`

现实触发条件：使用公共入口提供的 `--host 0.0.0.0` 或局域网地址启动服务。该参数当前没有警告或保护，而集成设计明确禁止在缺少认证和 TLS 时监听局域网。

远程客户端可以读取 `/session` 取得 CSRF token；没有 Origin 的请求也会被接受。随后可以读取任务、创建 command 和提交审批，live 模式下可能间接触发真实外部操作。

影响：本机控制台变成局域网内无认证的任务与审批控制面。

修复建议：第一版拒绝所有非 loopback host，同时覆盖 IPv4 和 IPv6；未来若支持 LAN，应作为带认证、TLS、owner 授权和严格 Origin 校验的独立模式实现。

## 可延后加固，不阻断当前修复

SSE 的 per-record event id 和日志截断检测仍不完整：`server/services/event-stream-service.mjs:22-35,74-130` 在批次处理结束后才更新 offset，断线可能重复最后一批通知；旧 cursor 大于截断后文件大小时也不会发送 `snapshot.required`。这不会直接重复执行写操作，因为 SSE 只负责让查询失效，但会影响阶段四的断线恢复质量。

该问题应在宣告阶段四完全完成前修复并增加 Last-Event-ID、批量记录和日志截断测试，但不与上述 live 正确性问题放在同一阻断级别。前端 SSE 离线提示、keyset pagination 和跨 owner timezone 支持本次不作为正式 findings。

## 验证记录

自动化门禁复跑结果：

- 根目录 `npm test`：24/24 通过。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。

浏览器在 `VITE_DATA_SOURCE=mock` 和 1280×720 桌面视口下实际检查了 `/overview`、`/tasks`、`/tasks/new`、等待外部与运行中两种 task detail、`/approvals`。五类主要页面均无横向 overflow，浏览器 console 没有 warning/error。运行中任务的时间线 marker 使用 `timeline-flow 1.75s`；等待外部任务不播放流动效果，符合当前状态语义。

## 建议修复顺序

1. 修复 F-01 锁接管，并完成多进程回归测试。
2. 修复 F-02 mutation 收口，建立可信的并发写入基础。
3. 修复 F-03 统一幂等层，阻止重复 command 和外部动作。
4. 修复 F-04 retry 和 F-05 回复归属。
5. 修复 F-06 assignment 交付/取消协议和 F-07 loopback 边界。
6. 运行真实 `welink-cli` 验收后，再处理 SSE 断线恢复并更新阶段完成状态。

## 最终判定

提交 `ade4b724ead2d9b1be2d333e6e8b924f8783ddaa` 可以作为阶段一至四的完整 happy-path 骨架，但尚未满足 live 模式需要的并发安全、统一幂等、任务重试、回复归属、assignment 恢复和网络边界。上述 7 个正式 findings 关闭前保持 `request changes`。
