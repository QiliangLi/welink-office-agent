# Skill 与 Runtime 实现约束

适用于修改 `SKILL.md`、`scripts/`、`references/`、`config/`、`runtime/`、根 `package.json` 或安装脚本的任务。

## 可移植 Skill 结构

- 仓库根目录本身是完整的 `welink-office-agent` Skill 包。
- `SKILL.md` 是跨 Agent 的唯一入口。不要在仓库内增加 `.claude/skills/`、`.codex/skills/` 或其他宿主专用套壳。
- `SKILL.md` 只保留发现信息、核心工作流、安全边界和引用路由。宿主专用权限字段不能进入 frontmatter，除非仓库明确增加并记录兼容层。
- `references/` 保存按需阅读的命令和状态契约。每份 reference 必须从 `SKILL.md` 链接，避免重复维护同一契约。

## 代码边界

- `scripts/agent.mjs` 是公共 Node.js 入口，负责参数解析和命令协调。
- 可复用的持久化、ID、工具和 WeLink 执行逻辑放在 `scripts/lib/`；不要把大段业务状态转换继续堆进 CLI 分支。
- `scripts/lib/` 不得依赖 `web-console/`，也不得假定具体宿主 Agent。
- `runtime/` 只保存生成数据，不是源码目录。不得提交 owner 数据、消息、原始 CLI 输出、任务快照或凭据。
- `config/*.example.json` 是可分发配置契约；生效中的 `config/*.json` 保持本地并由 Git 忽略。
- 所有 WeLink 查询和发送必须通过共享 wrapper，保留 dry-run、外部 action 预落盘、Agent marker、超时和恢复语义。
- 外部 action 必须先持久化再调用 `welink-cli`。超时或 unknown 结果必须先查历史再决定是否重试。

依赖方向固定为：宿主 Agent → `SKILL.md` → `scripts/agent.mjs` → `scripts/lib/`。

## 领域不变量

- Runtime source state 与 UI display state 是两个契约。display 状态映射集中在 `scripts/lib/task-status.mjs` 与 `server/serializers/`，前端不得从自然语言猜状态。
- `queued` 对应“待执行”，与 `running`、`waiting_external` 分离。任务快照带整数 `revision`，并发修改必须经过 Store 的文件锁与 `expectedRevision` 检查。
- 根任务可以并发推进；同一联系人的活动私聊默认串行（`scripts/lib/contact-slots.mjs`），直到 conversation/reply 关联能够可靠持久化。
- 入站回复不能只按联系人姓名归属（`scripts/lib/message-service.mjs`）。优先使用 reply/thread 标识，其次只能匹配唯一活动会话；多候选时保持未归属且不得推进任务。
- 控制台写入先落盘为 `runtime/commands/` 中的幂等命令，再由 `tick` 消费；UI 命令不得绕过命令队列直接改状态。
- 状态变更必须继续满足完成条件、审批、动态事项、冲突、等待回复和 action 恢复约束。不得绕过 Store/service 边界直接临时改 JSON。

## 与 Console API 的边界

- `web-console/` 不得直接读取 `runtime/` 或 `config/`，也不得调用 `welink-cli`。
- Console API 位于 `server/`，只监听本机并暴露 `/api/v1`。Route 只负责 HTTP 校验和 DTO，不复制状态机，也不为普通写入 spawn CLI；所有状态变更通过 `scripts/lib/` 的服务、Store 的 `mutate*`（文件锁 + revision）和 `runtime/commands/` 命令队列完成。
- 需要宿主 Agent 推理或 WeLink 外发的命令（task.create、task.instruction、approval.apply、subtask.remind 等）由 `agent.mjs tick` 领取：确定性部分直接执行，推理部分以 `assignments` 输出，宿主 Agent 完成后用 `complete-command` 回写。
- Route schema（`server/schemas/`）是 HTTP 契约的唯一来源；前端契约镜像在 `web-console/src/api/contracts.ts`。避免 runtime、server 和 UI 分别手写同一 enum。
- 跨层设计（状态映射、联系人沟通槽、回复归属、SSE cursor）以 `docs/frontend-backend-integration.md` 为准。
