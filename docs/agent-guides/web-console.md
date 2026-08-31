# Web Console 实现约束

适用于修改 `web-console/`、对照 `docs/design-reference/` 实现或调整 UI 行为的任务。

## 技术与目录

- 使用 React、TypeScript、Vite、React Router、Tailwind CSS、CSS variables 和 Lucide React。
- 依赖保持精简；共享 server state 使用自建查询层（`src/queries/`），不引入全局状态库或 react-query。
- 控制台默认通过 Console API（`/api/v1`，见 `server/`）读写真实数据；`VITE_DATA_SOURCE=mock` 时切换到 `src/mocks/mock-client.ts`。任何模式下都不得直接读取 `runtime/` 或 `config/`。数据契约以 `server/schemas/` 为源，镜像在 `web-console/src/api/contracts.ts`，两端必须同步修改。
- 页面位于 `web-console/src/pages/`，共享 shell 位于 `components/shell/` 和 `layouts/`，领域组件位于 `components/`，类型镜像位于 `types/`（re-export `api/contracts.ts`），mock 位于 `mocks/`，小型展示辅助位于 `lib/`。
- 只在组件确实共享或由数据驱动时抽取，避免单体页面，也避免一个 wrapper 一个文件。
- 页面渲染的 `Task.displayStatus`、`currentAction`、`waitingReason`、进度和 `allowedCommands` 全部来自服务端 DTO；前端不得自行推导状态或解析自然语言等待原因。SSE 事件只触发查询失效，不在浏览器复刻 runtime 状态机。

## 路由

- `/` 重定向到 `/overview`。
- `/overview`：总览。
- `/tasks`：任务列表。
- `/tasks/new`：创建任务。
- `/tasks/:taskId`：任务详情。
- `/approvals`：待我处理。
- `/activity`：动态。跨任务活动时间线，数据来自 `GET /api/v1/activity`；筛选写入 URL，SSE 只使查询失效并提示"有新动态"，由用户决定何时刷新，浏览旧页时不回拉第一页。
- `/artifacts`：产物。`health.capabilities.artifacts` 为 false 时只显示能力说明卡，不得展示虚构产物、空表头或下载按钮。
- `/settings`：设置。只读运行信息（当前用户、运行状态、能力开关），员工号展示脱敏；不提供配置写入，不用 disabled input 冒充可编辑设置。

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
- `queued` 是独立“待执行”状态；Overview 必须把当前任务和待执行队列拆开（`currentTasks`/`queuedTasks` 来自 `/overview` 的两个独立集合）。
- running 任务必须显式显示暂停/停止入口，不能藏进 overflow；详情页按钮集合来自服务端 `allowedCommands`。
- 审批卡必须展示动作、影响、原因以及与 payload 类型匹配的操作（消息批准/编辑/拒绝、日程与范围变更选择选项、澄清提交回答）；只传状态不给 payload 的决定视为无效。
- partial、stopped、failed、waiting external、waiting approval 和 queued 是不同状态。
- 任务计划必须数据驱动，展示当前步骤、完成项、等待原因和时间戳；不确定的发送结果显示“待核实”，不显示“已发送”。
- 新建任务需要可访问的 label/校验、本地草稿、进阶选项说明，以及说明后果的创建确认；附件能力为 false 时隐藏上传入口并说明尚未接入。
- 健康与 SSE：顶栏健康状态、dry-run 标识和命令积压来自 `/health`；API 不可用时保留最近数据并显示横幅，不把任务清空。

## 无障碍与响应式

- 使用语义元素、accessible name、键盘操作、可见 focus 和正确关联的 label。
- 正文与控件满足 WCAG AA，触控目标至少 44px。
- `html` 和 `body` 使用 `overflow-x: clip`。
- 图片网格轨道使用 `minmax(0, 1fr)`；可能溢出的 flex child 使用 `min-width: 0`。
- 按钮、tab、breadcrumb 和导航标签不得换行。
- 平板宽度将右侧栏变成 drawer 或堆叠区；移动端侧边栏变 drawer，表格变为可读卡片而不是压缩列。
