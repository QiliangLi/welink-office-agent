# Web Console 实现约束

适用于修改 `web-console/`、对照 `docs/design-reference/` 实现或调整 UI 行为的任务。

## 技术与目录

- 使用 React、TypeScript、Vite、React Router、Tailwind CSS、CSS variables 和 Lucide React。
- 依赖保持精简；共享 server state 真正接入前不要增加全局状态库。
- 当前控制台使用 mock DTO；不得直接读取 `runtime/`。接入 API/SSE 时遵循 `docs/frontend-backend-integration.md`。
- 页面位于 `web-console/src/pages/`，共享 shell 位于 `components/shell/` 和 `layouts/`，领域组件位于 `components/`，类型位于 `types/`，mock 位于 `mocks/`，小型展示辅助位于 `lib/`。
- 只在组件确实共享或由数据驱动时抽取，避免单体页面，也避免一个 wrapper 一个文件。
- 所有页面共用 `Task`、`TaskStatus`、`Approval`、`PlanStep` 和 `ActivityEvent` 类型；不要在 JSX 中硬编码完整任务树。

## 路由

- `/` 重定向到 `/overview`。
- `/overview`：总览。
- `/tasks`：任务列表。
- `/tasks/new`：创建任务。
- `/tasks/:taskId`：任务详情。
- `/approvals`：待我处理。
- Activity、Artifacts、Settings 可以显示为禁用入口，但不得伪装成已经实现。

## 视觉与动效

- `docs/design-reference/` 的五张 PNG 是只读视觉规格，不是运行时素材；不得修改、裁切成图标、作为页面背景或进入 UI bundle。
- 以真实 HTML 和 React 重建层级、比例、间距、密度与状态强调，不照抄参考图中的错误文案。
- 主目标是 1440px，同时保证 1280、1024、768、414、375 和 320px 可用。
- 使用冷色 lilac/slate 基底和克制的扁平紫色。禁止霓虹紫光、渐变文字、玻璃拟态、纯白/纯黑和硬灰卡片边框。
- 圆角、间距、图标、按钮、阴影和状态色必须使用共享 token。
- 动效只用于反馈，并支持 `prefers-reduced-motion`。任务时间线从过去到现在排列，只有 `running` 状态显示流动箭头。
- 所有 Agent 形象必须使用 vendored `zhulin025/LaoA-GrokBot` 原版实现：保留 SVG body、25 套表情坐标、视线/眨眼/形变、状态动作和 6 个 jelly quick actions。只允许适配 React 生命周期、尺寸、无障碍名称和业务 scene 映射。
- 每个位置使用语义化 scene 和克制的 action whitelist，不能把所有动作在所有位置轮播。
- 保留 `web-console/THIRD_PARTY_NOTICES.md` 中的来源和 MIT notice。
- 状态不能只靠颜色表达，必须同时提供文字或图标。

## 产品行为

- 页面持续回答：Agent 正在做什么、为什么这样做、哪里需要人工、如何暂停或继续。
- `queued` 是独立“待执行”状态；Overview 必须把当前任务和待执行队列拆开。
- running 任务必须显式显示暂停/停止入口，不能藏进 overflow。
- 审批卡必须展示动作、影响、证据/原因以及批准、编辑、拒绝操作。
- partial、stopped、failed、waiting external、waiting approval 和 queued 是不同状态。
- 任务计划必须数据驱动，展示父子步骤、当前步骤、完成项、等待原因和时间戳。
- 新建任务需要可访问的 label/校验、本地草稿、进阶选项说明，以及说明后果的创建确认。

## 无障碍与响应式

- 使用语义元素、accessible name、键盘操作、可见 focus 和正确关联的 label。
- 正文与控件满足 WCAG AA，触控目标至少 44px。
- `html` 和 `body` 使用 `overflow-x: clip`。
- 图片网格轨道使用 `minmax(0, 1fr)`；可能溢出的 flex child 使用 `min-width: 0`。
- 按钮、tab、breadcrumb 和导航标签不得换行。
- 平板宽度将右侧栏变成 drawer 或堆叠区；移动端侧边栏变 drawer，表格变为可读卡片而不是压缩列。
