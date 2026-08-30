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

- Runtime source state 与 UI display state 是两个契约。未来 API serializer 负责映射，前端不得从自然语言猜状态。
- `queued` 对应“待执行”，与 `running`、`waiting_external` 分离。
- 根任务可以并发推进；同一联系人的活动私聊默认串行，直到 conversation/reply 关联能够可靠持久化。
- 入站回复不能只按联系人姓名归属。优先使用 reply/thread 标识，其次只能匹配唯一活动会话；多候选时保持未归属且不得推进任务。
- 状态变更必须继续满足完成条件、审批、动态事项、冲突、等待回复和 action 恢复约束。不得绕过 Store/service 边界直接临时改 JSON。

## 与 Console API 的边界

- `web-console/` 不得直接读取 `runtime/` 或 `config/`。
- 未来 Console API 可以放在 `server/`。Route 只负责 HTTP 校验和 DTO，不能复制状态机，也不能为普通写入 spawn CLI。
- Route schema 应生成或校验前端契约，避免 runtime、server 和 UI 分别手写 enum。
- 具体状态、排队、回复归属和 SSE 设计见 `docs/frontend-backend-integration.md`。
