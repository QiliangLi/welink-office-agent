# WeLink Office Agent UI 详细实现规格

> **状态说明（2026-08-30）**：本文描述的是第一阶段的 mock UI 原型规格（`VITE_DATA_SOURCE=mock` 仍保留该形态用于离线开发与视觉验证）。当前默认实现已接入 Console API 与 SSE：数据契约见 `web-console/src/api/contracts.ts`，状态语义以服务端 `displayStatus`/`allowedCommands` 为准，行为约束见 `docs/agent-guides/web-console.md` 与 `docs/frontend-backend-integration.md`。本文中与“固定 mock 时间”“mock 数据计算”等相关的条目仅适用于 mock 模式。

## 1. 文档目标

本文把 `ui-implementation-outline.md` 和 `docs/design-reference/` 中的五张概念图转换成可直接执行的工程规格。

第一阶段目标只有一个：完成一个可运行、可交互、可响应式展示的 React UI 原型。所有数据使用 mock，暂不连接 `runtime/`、WeLink CLI、SSE 或后端 API。

参考图负责定义视觉层级、布局比例和页面气质；现有 Agent runtime schema 负责定义状态和业务语义。出现冲突时，以业务语义、可访问性和真实可操作性为先。

## 2. 产品定位

这是一个桌面端优先的 AI 任务工作台。用户不是在和聊天机器人闲聊，而是在监督 Agent 执行长期任务、处理等待项、审核外部动作并检查产物。

界面需要持续回答四个问题：

1. Agent 现在在做什么。
2. Agent 为什么这样做，证据在哪里。
3. 哪一步需要用户处理。
4. 用户如何暂停、继续、修改或终止。

## 3. 技术方案

### 3.1 技术栈

- React 18+。
- TypeScript，开启严格模式。
- Vite。
- React Router。
- Tailwind CSS。
- Lucide React。
- Vitest + Testing Library。
- ESLint。

不引入全局状态库。页面级交互使用 React state，共享 mock 数据由模块导出。未来接 API 时再引入 TanStack Query 或等价的数据请求层。

### 3.2 工程位置

前端作为独立工程放在 `web-console/`，避免污染根目录现有 Node Skill 的依赖与脚本。

Agent 形象统一由 `components/mascot/AgentMascot.tsx` 接入 `zhulin025/LaoA-GrokBot` 原版实现。机器人轮廓、25 套表情坐标、视线跟随、眨眼、表情弹性变形、状态动作和 6 种果冻快捷动作均直接使用上游代码与数据，不进行重新绘制或视觉改编；本项目只负责 React 生命周期、尺寸、无障碍名称，以及业务场景到上游状态池的映射。第三方版权与 MIT License 记录在 `web-console/THIRD_PARTY_NOTICES.md`。

```text
web-console/
├── public/
├── src/
│   ├── components/
│   │   ├── approvals/
│   │   ├── mascot/
│   │   ├── shell/
│   │   ├── tasks/
│   │   └── ui/
│   ├── layouts/
│   ├── lib/
│   ├── mocks/
│   ├── pages/
│   ├── types/
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── index.html
├── package.json
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```

## 4. 路由与信息架构

| 路由 | 页面 | 目的 |
|---|---|---|
| `/` | Redirect | 跳转到 `/overview` |
| `/overview` | Overview | 在一屏内看运行中、等待、审批、异常、近期活动 |
| `/tasks` | Tasks | 搜索、筛选、排序、查看全部任务 |
| `/tasks/new` | New Task | 创建任务并配置执行策略 |
| `/tasks/:taskId` | Task Detail | 查看目标、执行计划、当前状态、时间线和相关人 |
| `/approvals` | Approvals | 处理消息发送、日程选择和信息澄清 |

Activity、Artifacts、Settings 保留在侧栏中，但第一版使用不可用状态和“即将开放”提示，不创建假功能。

## 5. 统一数据模型

### 5.1 UI 状态

```ts
export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_external"
  | "waiting_approval"
  | "paused"
  | "partial"
  | "failed"
  | "stopped"
  | "completed";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  category: "research" | "report" | "follow_up" | "travel" | "document";
  currentAction?: string;
  blockedBy?: string;
  waitingReason?: string;
  progress: number;
  completedSubtasks: number;
  totalSubtasks: number;
  createdBy: Person;
  contacts: Person[];
  createdAt: string;
  updatedAt: string;
  nextAction?: string;
  nextCheckAt?: string;
  estimatedCompletion?: string;
  receipt?: RunReceipt;
  plan: PlanStep[];
  activity: ActivityEvent[];
}
```

### 5.2 runtime 状态映射

UI 不直接复用 runtime 的字符串，而是通过适配器映射，避免页面和存储协议紧耦合。

| runtime 状态 | UI 状态 | 展示文案 |
|---|---|---|
| root `running` | `running` | 执行中 |
| root `waiting_owner` | `waiting_approval` | 待我处理 |
| root `paused` | `paused` | 已暂停 |
| root `completed` | `completed` | 已完成 |
| root `cancelled` | `stopped` | 已取消 |
| root `failed` | `failed` | 异常 |
| subtask `waiting_reply` | `waiting_external` | 等待外部 |
| subtask `waiting_owner` | `waiting_approval` | 等待确认 |
| action `unknown` | `partial` | 结果待核实 |
| action `failed` | `failed` | 操作失败 |

### 5.3 审批模型

```ts
export type ApprovalKind = "message" | "schedule" | "clarification";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "edited";

export interface Approval {
  id: string;
  taskId: string;
  kind: ApprovalKind;
  title: string;
  summary: string;
  reason: string;
  impact: string;
  evidenceLabel: string;
  evidenceTarget: string;
  createdAt: string;
  status: ApprovalStatus;
  payload: MessageApprovalPayload | ScheduleApprovalPayload | ClarificationPayload;
}
```

审批卡必须同时展示“要做什么、影响什么、为什么、证据在哪里”，并提供批准、修改、拒绝三种动作。日程和信息澄清可以使用更适合语义的按钮，但不能只给一个无解释的确认按钮。

### 5.4 执行计划

```ts
export type PlanStepStatus =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  summary?: string;
  owner?: Person;
  startedAt?: string;
  completedAt?: string;
  duration?: string;
  children?: PlanStep[];
}
```

Task Detail 的计划树必须由该结构递归渲染，不得在 JSX 中硬编码连接线和固定节点。

## 6. 设计系统

### 6.1 颜色

采用“浅 lilac substrate + flat violet accent”，与参考图一致，但避免暗色紫光和渐变文字。

```css
:root {
  --page: #f1f0f8;
  --surface: #fdfcff;
  --surface-subtle: #f7f5fc;
  --surface-strong: #eeebf8;
  --border: rgba(32, 27, 70, 0.08);
  --border-strong: rgba(32, 27, 70, 0.14);

  --text-primary: #18152f;
  --text-secondary: #494563;
  --text-muted: #716b8c;

  --primary: #5b4bd1;
  --primary-hover: #4d3fc1;
  --primary-soft: rgba(91, 75, 209, 0.10);
  --on-primary: #fbfaff;

  --success: #2f875e;
  --success-soft: rgba(47, 135, 94, 0.11);
  --warning: #b87517;
  --warning-soft: rgba(184, 117, 23, 0.12);
  --danger: #c5484b;
  --danger-soft: rgba(197, 72, 75, 0.10);
  --info: #3478c8;
  --info-soft: rgba(52, 120, 200, 0.10);
}
```

颜色只通过 token 使用。状态不能只依赖颜色，必须搭配图标和文字。

### 6.2 字体

- UI 使用系统中文无衬线字体栈。
- 数字、任务 ID、时间和用量使用等宽或 `tabular-nums`。
- 固定字号：12、13、14、16、18、20、24、28、32px。
- 页面标题 28 至 32px；卡片标题 16 至 18px；正文 14px；辅助信息 12 至 13px。

### 6.3 间距与圆角

- 基础间距单位 4px。
- 页面外边距：桌面 24px，1024px 下 20px，移动端 16px。
- 卡片间距：16px。
- 卡片内边距：18 至 22px。
- 小控件圆角 10px；按钮/输入 12px；卡片 18px；大面板 22px。
- 阴影使用带紫灰色相的轻阴影，不使用纯黑大阴影。

### 6.4 动效

- 页面切换：120 至 180ms 的透明度和轻位移。
- 卡片 hover：仅改变边框、背景和极轻的位移。
- 运行状态：全页只保留一个持续脉冲点。
- 审批结果、暂停和继续：即时更新状态并用 `aria-live` 通知。
- `prefers-reduced-motion` 下关闭脉冲与位移动画。

### 6.5 Mascot

`AgentMascot` 直接渲染原版 GrokBot SVG，并保留 `working`、`waiting`、`approval`、`success`、`empty` 五种业务 mood。具体出现位置再通过 `scene` 区分 `idle`、`monitoring`、`waiting`、`filtering`、`create`、`inspiration`、`approval`、`success`、`empty`、`blocked`，避免同一种笼统情绪覆盖不同业务含义。

每个 scene 组合多个原版状态池，扩大表情覆盖；动作则使用小而明确的白名单。例如监控使用扫描/观察，创建使用思考/挤压，审批使用招手/提醒，完成使用弹跳/挥手，空状态只保留低频呼吸。机器人挂载后先静止，动作按 6.5 至 12 秒的场景节奏低频触发，不同实例以稳定偏移错开。禁止把全部动作无差别轮播到每个位置。

该组件只承担装饰和状态强化，不传递唯一信息。所有图片等价信息必须出现在文字中；`prefers-reduced-motion` 下停止自动表情和位移动画。

## 7. App Shell

### 7.1 顶栏

- 高度 64px。
- 左侧显示品牌和折叠菜单按钮。
- 右侧显示 Agent 健康状态、新建任务、通知、用户菜单。
- “下发新任务”跳转 `/tasks/new`。
- Agent 状态使用绿色点 + “Agent 正常”，不能只有颜色。

### 7.2 侧栏

- 桌面宽 232px，固定在左侧。
- 每项使用 Lucide 图标、中文主标签、英文副标签。
- 当前项使用 `primary-soft` 背景和主色文字。
- 底部显示一张轻量 Mascot 卡片。
- 1024px 以下折叠为 72px 图标栏。
- 768px 以下变为可关闭抽屉。

### 7.3 主内容

- 宽度自适应，不使用超宽表单。
- 普通页面最大可读宽度约 1500px。
- New Task 表单主体控制在 760 至 820px。
- 主内容是唯一主要垂直滚动区域。

## 8. 页面详细规格

### 8.1 Overview

参考 `docs/design-reference/overview.png`。

桌面结构：

1. 四张状态汇总卡：执行中、等待外部、待我处理、异常。
2. 三栏主区：当前正在工作、需要你的处理、最近完成。
3. 一张横向 Agent 最近动态卡。

交互：

- 状态卡可跳转到带对应筛选条件的 `/tasks`。
- “需要你的处理”中的审批、拒绝与查看动作可直接生效到本地 mock state。
- 当前任务可进入详情。
- 最近活动显示图标、动作、对象和相对时间。

响应式：

- 1280px 下四张汇总卡保持四列但压缩插画。
- 1024px 下汇总卡两列，主区两列，最近完成单独换行。
- 768px 下全部单列。

### 8.2 Tasks

参考 `docs/design-reference/tasks.png`。

桌面结构：

- 页头 + 结果数量。
- 搜索、状态筛选、时间筛选、列表/看板切换。
- 任务表格。
- 右侧快速筛选、状态概览和新建任务引导。

表格列：任务名称、进度、状态、当前动作、等待/阻塞原因、更新时间、更多操作。

交互：

- 搜索标题、创建者、任务 ID。
- 状态和时间筛选实时组合。
- 列表/看板模式切换。
- 行点击进入详情；更多按钮不能触发行跳转。
- 清空筛选恢复全部 mock 数据。
- 分页控件使用真实当前页 state。

响应式：

- 1180px 下右侧栏移至列表下方。
- 860px 下表格变为任务卡列表，不允许横向压缩成不可读表格。

### 8.3 New Task

参考 `docs/design-reference/new-task.png`。

这是单页创建流程，不拆成多步 wizard。

表单内容：

1. 任务描述，必填，1000 字以内，显示字符计数。
2. 附件入口，第一版模拟文件选择并显示文件 chip。
3. 高级设置：优先级、截止时间、外部操作策略、执行方式。
4. 创建检查：实时显示描述、截止时间、审批策略和阻塞项。
5. 提交区：保存草稿、创建任务。

右侧为“描述示例与效果预览”，不做静态 FAQ。点击示例可填入主输入框。

行为：

- 草稿每 3 秒写入 `localStorage`，同时提供“保存草稿”。
- 失焦时验证描述和截止时间。
- 提交前弹出确认框，明确 Agent 将立即拆解并执行。
- 创建成功后生成 mock task ID，显示成功信息，并提供“查看任务”和“继续创建”。

移动端：右侧灵感栏移到表单下方；提交条固定在底部，但必须预留安全内容空间。

### 8.4 Task Detail

参考 `docs/design-reference/task-detail.png`。

页头：返回任务列表、标题、状态、任务 ID、创建时间、创建者，以及继续、暂停、取消、给 Agent 新指令等动作。

第一版只实现“总览”内容，但保留子任务、消息、时间线、产物、Debug 的 tab 外观。未实现 tab 必须明确标记为预览，不展示假数据页。

桌面主体：

- 左上：任务目标。
- 中上：当前状态和子任务统计。
- 左下：递归执行计划。
- 中下：最近进展和提炼洞察。
- 右栏：Agent 跟进状态、关键指标、相关联系人。

交互：

- 暂停和继续即时更新状态与按钮。
- 取消任务需要明确后果的确认对话框。
- “催一下”更新当前联系人步骤的时间线。
- 计划项可展开查看摘要、耗时与 owner。
- 点击证据/产物链接滚动到对应模块。

响应式：1180px 下右栏并入主体；860px 下所有区域单列，动作栏可横向滚动但按钮文字不换行。

### 8.5 Approvals

参考 `docs/design-reference/approvals.png`。

页头显示待处理数量、说明、全部标为已处理动作。

审批卡支持三种形态：

- 消息发送：显示目标群、人数、消息正文、风险与批准/修改/拒绝。
- 日程选择：显示可选时间、参会人数和冲突提示，选择后继续。
- 信息澄清：显示缺失字段并提供输入框提交。

右侧为“人工参与小贴士”，只承担解释，不重复卡片信息。

行为：

- 批准、拒绝、修改后立即把卡片移入已处理状态，并通过 toast 提示。
- “全部标为已处理”必须有确认对话框，且不能自动批准待处理动作。
- 无待处理项时显示完整空状态与返回任务入口。

## 9. 公共组件

| 组件 | 责任 |
|---|---|
| `AppLayout` | 组合顶栏、侧栏、移动抽屉和内容区 |
| `Sidebar` | 路由导航与当前项状态 |
| `Topbar` | Agent 状态、通知、新建任务、用户菜单 |
| `PageHeader` | 页面标题、说明、右侧动作 |
| `StatusBadge` | 统一状态图标、颜色和文案 |
| `TaskIcon` | 按 task category 显示一致图标块 |
| `ProgressBar` | 任务进度与可访问文本 |
| `TaskPlan` | 递归渲染计划树 |
| `ApprovalCard` | 审批共同骨架与三种 payload |
| `ConfirmDialog` | 有后果动作的确认 |
| `ToastRegion` | `aria-live` 状态通知 |
| `AgentMascot` | 统一装饰角色，可替换资产 |
| `EmptyState` | 空数据原因、说明和下一步 |

不为单次使用的简单容器创建组件。页面可保留语义明确的小块 JSX。

## 10. Mock 数据策略

- 所有页面使用同一组 8 至 12 个任务。
- 当前时间固定为 mock 基准时间，避免测试依赖真实当前时间。
- 内容使用真实业务语气，避免 `XXX`、Jane Doe、无来源的精确效果数据。
- 数量必须能从 mock 数据计算得出，汇总卡和状态图不写死互相矛盾的数字。
- 所有相对时间由格式化函数生成。
- 操作只影响 React 内存状态和 `localStorage` 草稿，不写入根目录 runtime。

## 11. 状态与反馈

每个关键页面都要有：

- Loading：与最终结构一致的 skeleton。
- Empty：解释为什么为空，并给下一步。
- Error：说明原因和重试动作。
- Success：保留关键事实和后续入口。
- Disabled：仅用于条件未满足，同时在附近解释原因。

任务运行状态还需覆盖 queued、running、waiting external、waiting approval、partial、failed、stopped、completed。

## 12. 可访问性

- 侧栏、tabs、筛选器、表格、对话框和表单全部可键盘操作。
- 当前路由使用 `aria-current="page"`。
- 状态变化使用 `aria-live="polite"`。
- Dialog 打开后管理焦点，Escape 可关闭非强制对话框。
- 表单 label 与输入框关联，错误使用 `aria-describedby`。
- 图标按钮提供 `aria-label` 和可见 tooltip。
- 表格表头使用正确的 `scope`，排序列使用 `aria-sort`。
- 所有可点击区域至少 44px。

## 13. 响应式规则

| 断点 | 行为 |
|---|---|
| `>= 1280px` | 完整桌面布局，侧栏 232px，显示右栏 |
| `1024px - 1279px` | 侧栏折叠，复杂三栏变两栏 |
| `768px - 1023px` | 移动抽屉，主内容单列或两列，右栏下沉 |
| `< 768px` | 单列，表格变任务卡，操作栏允许滚动 |
| `320px - 414px` | 控件堆叠，按钮不换行，最小 16px 页面边距 |

根节点使用 `overflow-x: clip`。所有可收缩的 grid track 使用 `minmax(0, 1fr)`，长标题使用 `overflow-wrap: anywhere`。

## 14. 测试计划

### 14.1 单元与组件测试

- `StatusBadge` 为每种状态输出正确文本。
- 筛选函数正确组合搜索、状态和时间条件。
- `TaskPlan` 递归渲染子步骤。
- 审批动作会更新卡片状态。
- New Task 校验、草稿保存和提交成功流程。
- pause/continue/stop 的 UI 状态转换。

### 14.2 构建检查

```bash
cd web-console
npm run lint
npm run test
npm run build
```

### 14.3 视觉检查

逐页以 1672×941 参考图为对照，在接近 1440px 的视口检查：

1. 侧栏宽度和激活态。
2. 顶栏高度与按钮位置。
3. 主体列宽比例。
4. 卡片间距、内边距和圆角。
5. 标题、正文、辅助文字层级。
6. 状态色和进度表达。
7. 右栏宽度和折叠行为。
8. 阴影是否过重。
9. 留白是否接近参考图。
10. 是否出现不可解释的新元素。

同时检查 1280、1024、768、414、375、320px，确认无横向滚动、按钮文字不换行、表格正确降级、抽屉可关闭。

## 15. 实施顺序

1. 初始化 `web-console` 工程与质量工具。
2. 建立 design tokens 和全局样式。
3. 实现 App Shell、路由和 mock 数据模型。
4. 实现 Overview。
5. 抽取公共任务组件。
6. 实现 Tasks。
7. 实现 New Task。
8. 实现 Task Detail。
9. 实现 Approvals。
10. 补全 loading、empty、error、success、disabled 状态。
11. 运行测试、构建和静态 UI 检查。
12. 打开本地页面逐页截图，对照参考图修正。

## 16. 第一阶段完成定义

满足以下条件才算完成：

- 五条页面路由都可直接访问和刷新。
- 页面使用真实 React 结构，不嵌入参考截图。
- 桌面布局在 1440px 与参考图保持同一结构和视觉重心。
- 任务、审批和计划共用统一类型与 mock 数据。
- 搜索、筛选、页面跳转、暂停/继续、审批、草稿和创建任务可交互。
- 320px 到桌面无横向页面滚动。
- 键盘焦点可见，表单和 Dialog 具备基本无障碍语义。
- lint、test、build 全部通过。
- 已完成渲染后的逐页视觉检查，所有 Agent 场景均使用统一的 GrokBot SVG 组件。
