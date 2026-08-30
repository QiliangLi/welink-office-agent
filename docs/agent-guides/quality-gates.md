# 质量门禁与变更纪律

交付代码、目录或行为修改前必须阅读并执行本文件中与改动范围对应的检查。

## 通用检查

- 保留用户已有和无关修改，不得回退现有 runtime 行为。
- 不修改 `docs/design-reference/` 中的视觉规格。
- 运行 `git diff --check` 并检查最终 `git status`。
- 移动文件后用 `rg` 确认入口、import、测试 fixture、安装脚本和文档链接没有残留旧路径。
- 被移动的公共入口至少实际运行一次；静态搜索不能替代运行验证。
- 文档同步按 `docs/agent-guides/documentation.md` 执行。

## Skill 与 Runtime

修改 `SKILL.md`、`scripts/`、`references/`、`config/`、安装脚本、根 package metadata 或 runtime 行为时：

1. 运行 Skill validator。
2. 运行 `node scripts/agent.mjs help` 或受影响的安全入口。
3. 运行根目录 `npm test`。
4. 确认 `scripts/agent.mjs` 仍是 package scripts、installer、测试、SKILL 和 command reference 的统一入口。

## Web Console

修改 `web-console/` 或 UI 契约时，在 `web-console/` 中运行：

1. `npm run test`
2. `npm run lint`
3. `npm run build`

有视觉变化时，在桌面尺寸打开并检查五个主要路由，对照相应 PNG 检查 sidebar、topbar、主列宽度、卡片间距、字体层级、圆角、边框/阴影、状态色和留白。不能只凭静态检查声称视觉一致；交付时明确说明是否实际打开页面检查。

## 实现纪律

- 可见中文文案保持自然、可操作，不复制参考图中不可能的日期、冲突 ID、占位人名或畸形文字。
- 组件拆分服务于共享和数据边界，避免单体文件，也避免无意义的 wrapper 组件泛滥。
- 新增顶层目录、公共入口或质量门禁时，同步更新根 `AGENTS.md`。
