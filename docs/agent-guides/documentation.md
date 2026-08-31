# 文档同步约束

涉及实现行为、目录、命令、状态、安装或文档本身的任务必须阅读本文件。

## 文档职责

- `AGENTS.md`：仓库入口、目录边界、细则路由和所有任务都必须遵守的不变量。
- `README.md`：用户现在可以执行的安装、命令、能力和限制；不得把规划写成已实现。
- `SKILL.md`：宿主 Agent 的发现入口、工作流、安全边界和 reference 路由。
- `references/command-reference.md`、`references/runtime-schema.md`：当前可执行 Skill 契约。
- `docs/ui-implementation-outline.md`：产品意图。
- `docs/ui-implementation-spec.md`：可执行 UI 规格。
- `docs/e2e-acceptance.md`：端到端验收手册与记录表；验收通过后回写状态横幅。
- `docs/frontend-backend-integration.md`：前后端目标设计和迁移计划，必须标清 proposed 与 implemented。
- `docs/design-reference/`：只读 UI 视觉规格。
- `docs/agent-guides/`：按改动范围加载的实现细则。

## 同步矩阵

文档必须与实现同一次修改完成，不能留到后续清理。

- CLI 命令、flag、安装、配置或用户能力变化：检查并更新 `README.md`、`SKILL.md` 和 command reference。
- Runtime 字段、状态、完成规则、消息恢复或持久化变化：检查并更新 runtime schema、集成设计和相关实现不变量。
- UI 路由、状态语义、交互规则或 API DTO 变化：检查并更新 UI 规格、集成设计和 UI 指南。
- 目录、依赖方向、公共入口或质量门禁变化：更新根 `AGENTS.md` 的目录索引/路由，以及对应 agent guide。
- 安装步骤、环境、当前限制或用户命令变化：更新 `README.md`。
- Skill 工作流、安全边界或 reference 路由变化：更新 `SKILL.md`。

## 写作与一致性

- 文件名使用 kebab-case。耐久项目文档放在 `docs/`，Skill 按需参考放在 `references/`；不要创建个人目录或任意根 Markdown。
- 每份文档说明它描述的是当前行为、目标设计还是迁移计划。
- Runtime 文件示例使用 snake_case，API DTO 使用 camelCase。
- 执行代码和生成 schema 是当前行为的证据，但发现冲突时不能静默忽略文档；应在本次范围内修正过期一方。
- 跨层决策（如同联系人串行和回复归属）写入集成设计，并在相关 agent guide 中保留不变量摘要。
- 交付前搜索旧路径和退役术语。失效链接、过期命令和互相矛盾的规格属于阻断问题。
