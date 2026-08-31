# 左侧菜单扩展页面设计

> 文档状态　Implemented（第一阶段：三个路由与页面、`GET /api/v1/activity`、筛选/分页/SSE 提示均已实现并有测试；2026-09-01 增量：设置页新增「可联系同事」配置管理；第 6.2 节产物列表与下载仍待 runtime 具备稳定产物模型）
>
> 编写日期　2026-09-01　实现日期　2026-09-01
>
> 适用范围　`/activity`、`/artifacts`、`/settings`

## 1. 背景

控制台左侧菜单已经展示“动态”“产物”“设置”三个入口，当前都带有 `disabled` 标记。点击后没有页面，也没有对应路由。

三个入口的后端基础并不相同。

| 入口 | 当前基础 | 结论 |
| --- | --- | --- |
| 动态 | runtime 已保存事件与消息，服务端已有统一的 `ActivityEvent` 序列化逻辑 | 可以补齐独立页面和全局读取接口 |
| 产物 | `health.capabilities.artifacts` 固定为 `false`，没有稳定的产物 ID、元数据和下载接口 | 先开放说明页，不能展示或下载虚构产物 |
| 设置 | `/health` 与 `/session` 已返回运行模式、时区、当前用户和能力开关 | 可以先做只读状态页，配置写入留待单独设计 |

本设计让三个菜单都能正常进入页面，同时保留现有的安全边界。浏览器仍然只访问 Console API，不读取 `runtime/` 和生效中的 `config/`，也不直接调用 `welink-cli`。

## 2. 设计目标

- 让三个左侧入口具备明确的路由、页面标题和可恢复的加载状态。
- 让“动态”成为跨任务查看 Agent 行为的入口。
- 让“产物”如实说明当前能力，并为后续接入留下稳定页面位置。
- 让“设置”先回答当前控制台怎样运行，不在页面里泄露敏感配置。
- 复用现有查询层、SSE 失效机制、设计变量与响应式规则。
- 保证每项可见信息都能回到 API 字段或已经记录的事件。

## 3. 本次不处理的内容

- 不在浏览器里切换 `dry_run` 和 `live`。
- 不编辑 owner、群组、路由或发送策略配置（2026-09-01 增量：联系人配置已开放编辑，见第 7 节）。
- 不读取或展示配置文件路径、runtime 路径、原始 CLI 输出和 `w3account`。
- 不上传附件，不生成产物，不根据任务标题猜测产物。
- 不提供没有后端记录支撑的成本、已读状态、预计完成时间或下载按钮。
- 不把任务详情里的“子任务”“消息”“产物”“Debug”标签页一起纳入本次范围。

## 4. 信息架构

侧栏维持现有顺序。六个入口全部使用 `NavLink`，当前页面沿用现有选中态。

| 路由 | 页面名称 | 页面任务 |
| --- | --- | --- |
| `/overview` | 总览 | 查看当前任务、队列和待处理事项 |
| `/tasks` | 任务 | 搜索和筛选全部任务 |
| `/approvals` | 待我处理 | 处理审批与澄清 |
| `/activity` | 动态 | 查看跨任务活动记录 |
| `/artifacts` | 产物 | 查看产物能力状态，接入后浏览真实产物 |
| `/settings` | 设置 | 查看当前用户、运行模式、健康状态和能力开关 |

移动端继续使用现有侧栏抽屉。点击任意入口后关闭抽屉。桌面、折叠侧栏和移动抽屉使用同一组菜单配置，避免三个位置出现不同的开放状态。

## 5. 动态页

### 5.1 用户要解决的问题

总览只显示少量最近动态，任务详情只显示单个任务的时间线。用户还需要一个跨任务入口，用来回答下面几件事。

- Agent 最近做过什么。
- 哪些动作属于消息、审批、状态变化或文件记录。
- 一条动态关联哪个任务。
- 断线恢复后是否出现了新记录。

### 5.2 页面结构

页面顶部显示标题、用途说明和刷新按钮。刷新按钮重新请求当前筛选条件下的第一页，不清除筛选。

标题下方放置一行筛选控件。

| 控件 | 行为 |
| --- | --- |
| 类型 | 可选择全部、任务、状态、消息、审批、文件 |
| 任务 | 输入任务 ID 或标题关键词，提交后写入 URL 查询参数 |
| 时间 | 第一版提供全部、今天、最近 7 天三档 |
| 清除 | 清除全部筛选并回到第一页 |

主体使用按日期分组的时间线。每条记录显示类型图标、标题、详情、发生时间和关联任务。存在 `taskId` 时，整条记录可以进入 `/tasks/:taskId`。没有 `taskId` 的全局事件保留为普通记录，不创建无效链接。

记录按 `occurredAt` 和 `sequence` 稳定排序。页面从新到旧展示，加载更多时把旧记录追加到末尾。相同时间戳不能改变顺序。

### 5.3 页面状态

| 状态 | 呈现 |
| --- | --- |
| 首次加载 | 使用与时间线行高一致的骨架，不使用遮挡整页的转圈 |
| 空记录 | 说明 Agent 产生事件后会显示在这里，并提供“查看任务”入口 |
| 筛选无结果 | 保留筛选栏，说明当前条件没有记录，并提供“清除筛选” |
| 请求失败 | 保留最近一次成功数据，在页头下显示错误横幅和“重试” |
| 加载更多失败 | 已显示的记录不消失，在列表末尾显示重试按钮 |
| SSE 断开 | 沿用全局离线提示，页面保留旧数据 |

### 5.4 API 设计

新增只读接口 `GET /api/v1/activity`。接口复用 `server/serializers/activity-dto.mjs`，不能在新 route 中重新解释 runtime 日志。

查询参数如下。

| 参数 | 说明 |
| --- | --- |
| `kind` | 可重复的活动类型 |
| `taskId` | 精确任务 ID |
| `q` | 标题、详情或任务展示字段的关键词 |
| `occurredFrom` | ISO 8601 起始时间 |
| `occurredTo` | ISO 8601 结束时间 |
| `cursor` | 上一页返回的不透明游标 |
| `limit` | 默认 30，最大 100 |

响应使用下面的 DTO。

```ts
export interface ActivityListResponse {
  items: ActivityEvent[];
  nextCursor: string | null;
  total: number;
  snapshotAt: string;
}
```

服务端先把 event 和 message 转为统一的 `ActivityEvent`，随后执行筛选和 cursor 分页。游标应基于稳定顺序位置或稳定记录键，不能包含本地文件路径。

`overview.recentActivity` 继续保留。总览需要同一读取时点下的聚合数据，不能为了复用新页面接口而拆成额外的浏览器请求。

### 5.5 前端数据流

`ConsoleClient` 和 `MockConsoleClient` 增加 `getActivity()`。查询键包含全部 URL 筛选参数和 cursor。

SSE 收到 `task.*`、`approval.*`、`message.*` 或需要全局快照的事件时，使 `activity` 查询失效。正在浏览旧页时不主动把用户拉回第一页。页面显示“有新动态，点击刷新”，由用户决定何时更新视图。

## 6. 产物页

### 6.1 第一阶段页面

第一阶段让 `/artifacts` 成为可访问页面，但不把尚未存在的能力包装成产物列表。

页面读取 `health.capabilities.artifacts`。当值为 `false` 时，显示一张能力说明卡。

- 标题使用“产物功能尚未接入”。
- 正文说明任务结果目前保留在任务详情和执行记录中。
- 主操作进入 `/tasks?status=completed`，文案使用“查看已完成任务”。
- 次操作进入 `/tasks/new`，文案使用“创建任务”。
- 页面不显示空表头、虚构文件名、下载按钮或假进度。

这是一种能力不可用状态，不是无数据状态。文案和图标要与普通空列表区分。

### 6.2 后续接入后的页面

当 `health.capabilities.artifacts` 为 `true` 时，页面切换为真实产物列表。每项产物至少要有稳定 ID、所属任务、名称、类型、大小、创建时间和下载可用状态。

建议 DTO 如下。

```ts
export interface ArtifactDto {
  id: string;
  taskId: string;
  subtaskId: string | null;
  name: string;
  kind: "document" | "spreadsheet" | "presentation" | "image" | "archive" | "other";
  mimeType: string;
  sizeBytes: number;
  summary: string | null;
  createdAt: string;
  downloadAvailable: boolean;
}

export interface ArtifactListResponse {
  items: ArtifactDto[];
  nextCursor: string | null;
  total: number;
  snapshotAt: string;
}
```

后续接口使用 `GET /api/v1/artifacts` 和 `GET /api/v1/artifacts/:artifactId/download`。下载接口只接收 artifact ID，由服务端解析实际文件。响应和错误信息不能包含本地路径。

下载前还要补齐 MIME 校验、文件名清理、大小限制和文件生命周期。完成这些条件以前，能力开关保持 `false`。

## 7. 设置页

### 7.1 第一阶段页面

设置页先做成只读运行信息页。它帮助用户判断当前控制台是否能执行真实外部动作，也为排查 Agent 未运行、命令积压和 SSE 不可用提供固定入口。

页面分为三个区域。

> 2026-09-01 增量（已实现）：设置页新增第四个区域「可联系同事」，对应 `GET /api/v1/contacts` 与 `POST /api/v1/contacts/commands`。支持新增、编辑（姓名、部门、允许主动联系）和移除联系人；写操作是确定性的本地配置变更，在 `Store.mutateConfig` 的文件锁下直接执行，DTO 永不包含 `w3account`，文件中未提交的字段（如 w3account、expertise）在更新时保留。其余配置（owner、群组、路由、dry-run）仍保持只读。

#### 当前用户

读取 `/session`，显示姓名、姓名缩写、员工号脱敏值和时区。员工号只显示末四位。值为空时显示“未配置”，不展示占位号码。

#### 运行状态

读取 `/health`，显示下面的信息。

- Agent 状态。
- 最近一次成功 tick 时间。
- 命令积压数量。
- 待核实外部动作数量。
- 当前为 `dry-run` 或 `live`。
- SSE 是否可用。

`dry-run` 使用说明文案，明确消息不会真实发送。`live` 只表示后端返回 live，页面不提供切换按钮。

#### 能力

把 attachments、artifacts、liveSend 和 SSE 映射为自然中文。每项同时显示文字和图标，不能只靠颜色区分开启与关闭。

页面提供“刷新状态”按钮。该按钮只重新请求 `/health` 和 `/session`，不写入配置。

### 7.2 可编辑设置的边界

联系人白名单（2026-09-01 增量）是当前唯一开放编辑的本地配置，经由 `GET /api/v1/contacts` 与 `POST /api/v1/contacts/commands` 完成。浏览器不直接读写 `config/*.json`；Console API 仅允许在 mutation lock（`Store.mutateConfig`）、CSRF、schema 校验和持久化幂等层之下修改 contacts，且 DTO 不包含 `w3account`，未提交的文件字段在更新时保留。

其余可编辑设置仍需要单独的后端契约和权限设计。未来若开放，同样必须经过 CSRF、持久化幂等层、schema 校验和 mutation lock；需要 Agent 推理或外部发送的变更仍然写入命令队列。

以下配置暂不开放。

- owner 身份和 WeLink 凭据。
- 可信群。
- 路由规则。
- 自动回复策略。
- `dry-run` 与 `live` 切换。
- 消息发送风险策略。

## 8. 共用视觉与交互

三个页面延续现有控制台的冷色 lilac 和 slate 基底、扁平紫色主色、共享圆角和轻边框。不增加新的视觉主题，也不引入图片素材。

页面标题、筛选栏、卡片和按钮继续使用 `styles.css` 中的共享变量。新样式应围绕页面职责命名，不能复制一套仅颜色不同的卡片组件。

### 8.1 页面外框

三个页面都放在现有 `AppLayout` 内，继续由 `Topbar`、`Sidebar` 和 `main#main-content` 组成页面外框。页面根节点同时使用 `.page` 和页面专属类，例如 `.activity-page`。不能为新页面增加第二套顶栏、侧栏宽度或内容滚动容器。

页头直接复用 `.page-heading` 的结构。

```tsx
<div className="page-heading">
  <div>
    <h1>动态</h1>
    <p>查看 Agent 在全部任务中的最近动作。</p>
  </div>
  <button className="button button-secondary">刷新</button>
</div>
```

页面标题继续使用现有的 30px 字号、紧凑字距和 `var(--text-primary)`。说明文字继续使用 `var(--text-muted)`，上间距保持 7px。开发时不再创建功能相同的 `PageHeader` 包装组件。

### 8.2 颜色、圆角和阴影

新页面只能使用现有语义变量。需要新颜色时，先确认现有变量确实无法表达该状态，再在 `:root` 中补充一个有业务含义的变量。

| 用途 | 现有变量 |
| --- | --- |
| 页面背景 | `--page` |
| 主卡片 | `--surface` |
| 次级区域和悬停 | `--surface-subtle`、`--surface-strong` |
| 默认和强调边框 | `--border`、`--border-strong` |
| 主要文字 | `--text-primary`、`--text-secondary` |
| 辅助文字 | `--text-muted`、`--text-faint` |
| 主操作 | `--primary`、`--primary-hover`、`--primary-soft` |
| 状态 | `--success`、`--warning`、`--danger`、`--info` 及对应 soft 变量 |
| 控件圆角 | `--radius-control` |
| 卡片圆角 | `--radius-card` |
| 卡片阴影 | `--shadow-card` |

新样式中不能写一套近似紫色、近似灰色或新的硬边框。卡片使用 `.panel` 的背景、边框、圆角和阴影。页内确实需要不同布局时，只增加 padding、grid 和内容排版，不覆盖 `.panel` 的视觉属性。

### 8.3 按钮和链接

操作按现有层级选用样式。

| 操作 | 样式 |
| --- | --- |
| 页面主操作 | `.button.button-primary` |
| 刷新、重试和次操作 | `.button.button-secondary` |
| 清除筛选和轻量跳转 | `.button.button-quiet` |
| 只有图标的关闭或菜单操作 | `.icon-button` |
| 卡片底部整行跳转 | `.panel-link` |

动态页的“刷新”“清除筛选”“加载更多”分别使用 secondary、quiet、quiet。产物能力说明中的“查看已完成任务”使用 primary，“创建任务”使用 secondary。设置页的“刷新状态”使用 secondary，不能做成比“下发新任务”更强的主色按钮。

所有按钮继续遵守现有最小高度、单行文字、focus ring 和 reduced motion。不能新增仅有图标却没有 `aria-label` 的按钮。

### 8.4 筛选与表单控件

动态页的搜索和下拉控件复用 `.search-field` 与 `.select-field`。控件高度、边框、focus ring 和 placeholder 颜色不得在新页面重新定义。

筛选区可以增加 `.activity-toolbar` 负责网格排列，但内部 input 和 select 保持现有 DOM 结构。移动端只改变排列方式，不缩小到 44px 以下。

设置页第一阶段没有可编辑字段。运行模式和能力开关以说明卡或定义列表呈现，不能使用 disabled input 冒充可编辑设置。

### 8.5 卡片、状态和空页面

普通内容区使用 `.panel`。带图标的卡片标题复用 `.panel-header`，图标继续使用 Lucide React，默认采用 `var(--primary)`。状态颜色只表示语义，不能让状态色替代页面主色。

任务状态继续使用 `StatusBadge`。能力开关需要单独的文字状态，例如“已开启”“未接入”“仅 dry-run 可用”，配合 Check、X 或 AlertTriangle 图标。不能把能力开关塞进任务状态的 `STATUS_META`。

空页面沿用 `.table-empty` 的居中结构和间距。较小卡片中的空内容可以沿用 `.overview-empty`。产物能力关闭属于能力说明，使用独立的 `.capability-unavailable`，视觉可以沿用 panel 和 table-empty 的结构，但标题必须写明“尚未接入”，不能写“暂无产物”。

错误横幅复用 `.app-banner`、`.app-banner-danger` 和 `.app-banner-warn`。短暂操作反馈复用 `Toast`。页面级请求错误不能只使用 Toast，因为用户关闭后仍需要看到失败原因和重试入口。

### 8.6 动态时间线

动态页沿用任务详情时间线的节点、图标和文字层级，继续使用 `.timeline-node`、`.timeline-copy` 以及各 activity kind 的语义颜色。

现有 `ActivityTimeline` 从过去到现在排列，并根据单个任务的 `displayStatus` 决定流动箭头。全局动态页从新到旧排列，也没有一个可代表全局的任务状态，因此不能把 `status="running"` 硬传进去复用动画。

实现时可以抽取共享的事件图标映射和单行展示组件。任务详情保留原有顺序与流动效果，全局动态页使用静态节点和日期分组。两处共享视觉语言，不共享错误的状态假设。

### 8.7 加载骨架和 Agent 形象

首次加载使用现有 `.skeleton-panel` 及其 shimmer 规则。动态列表可以增加与真实行高一致的 `.activity-row-skeleton`，颜色和动画必须复用现有 skeleton 变量与 keyframes。

新页面默认不放 AgentMascot。只有产物能力说明或完全空白的首次使用场景确实需要引导时，才使用 vendored `AgentMascot`，并选择现有语义 scene。不能为三个页面各放一个装饰机器人，也不能新增静态机器人图片。

### 8.8 实现检查清单

开发完成后逐项核对下面的内容。

- 页面仍由现有 AppLayout 承载，没有第二套顶栏或侧栏。
- 页头使用 `.page-heading`，卡片使用 `.panel`，按钮使用现有 button 变体。
- 新 CSS 使用现有颜色、圆角和阴影变量，没有近似色和硬灰边框。
- 筛选控件复用 `.search-field` 与 `.select-field` 的结构和状态。
- 错误、空数据、能力关闭和加载中四种状态在文案和视觉上可以区分。
- 动态页没有借用单任务的 running 动画表达全局状态。
- 页面没有新增装饰图片，没有为了填空而增加 AgentMascot。
- 1440px 下新页面的页边距、标题位置和卡片起始线与 Tasks、Approvals 一致。

所有可交互元素满足下面的要求。

- 鼠标悬停、键盘焦点、按下、禁用和加载状态可辨认。
- 触控目标最小 44px。
- 按钮、标签页和侧栏标签不换行。
- 状态同时显示图标或文字。
- 反馈动效遵循 `prefers-reduced-motion`。

## 9. 响应式设计

| 宽度 | 页面行为 |
| --- | --- |
| 1024px 以上 | 使用现有固定侧栏，内容区保持舒适行宽 |
| 768px 至 1023px | 侧栏进入折叠形态，筛选栏允许换行，设置卡片从两列收为一列 |
| 767px 以下 | 侧栏使用抽屉，动态筛选控件纵向排列，时间线详情允许自然换行 |
| 320px 至 414px | 主操作占满可用宽度，次操作换到下一行，所有按钮文字保持单行 |

`html` 和 `body` 继续使用 `overflow-x: clip`。可能容纳长任务标题或 ID 的 flex child 使用 `min-width: 0`，标题使用 `overflow-wrap: anywhere`。

## 10. 无障碍

- 侧栏使用 `nav` 和可识别的当前页面状态。
- 时间线使用有序列表或具备等价语义的列表结构。
- 图标不重复朗读已有文字，装饰图标设置 `aria-hidden`。
- 筛选控件具有可见 label，不能只用 placeholder 说明用途。
- 加载更多、刷新和重试按钮使用不同的可访问名称。
- 错误横幅使用 `role="alert"`，离线和新动态提示使用 `role="status"`。
- 空状态的主操作在键盘顺序中紧跟说明文字。

## 11. 安全边界

- 新增接口仍只位于 `/api/v1`，服务端继续拒绝非 loopback 监听地址。
- 活动接口只返回 `ActivityEvent` DTO，不返回原始日志行。
- 产物下载只使用 artifact ID，不能接受客户端传入的文件路径。
- 设置页不返回 `w3account`、CSRF token、配置路径和原始认证结果。
- 员工号在设置页展示时脱敏，API 中现有逻辑主键不因此改变。
- 三个页面中除联系人配置（7.2 节，走 Console API 的锁、CSRF、schema 与幂等层）外均为只读；浏览器任何情况下都不直接读写 `config/*.json`。

## 12. 文件改动建议

第一阶段预计涉及下面的文件。

```text
server/routes/activity.mjs
server/schemas/activity.mjs
server/index.mjs
server/services/activity-read-service.mjs
web-console/src/api/contracts.ts
web-console/src/api/client.ts
web-console/src/mocks/mock-client.ts
web-console/src/queries/keys.ts
web-console/src/pages/ActivityPage.tsx
web-console/src/pages/ArtifactsPage.tsx
web-console/src/pages/SettingsPage.tsx
web-console/src/components/shell/Sidebar.tsx
web-console/src/App.tsx
web-console/src/styles.css
```

如果活动读取逻辑足够小，可以放进 route 使用现有 serializer。只要出现筛选、分页和 cursor 编解码，就应提取到 `activity-read-service.mjs`，让 route 只负责校验和响应。

## 13. 测试计划

### 服务端

- 全局活动包含 event 与 message 两种来源。
- 类型、任务和时间筛选可以组合。
- 相同时间戳使用 sequence 保持稳定顺序。
- cursor 翻页不会重复或遗漏记录。
- 响应不包含 runtime 路径、原始 CLI 输出和 `w3account`。
- 非法 kind、时间和 limit 返回统一的 422 错误。

### 前端

- 三个侧栏入口可以进入对应路由，选中态正确。
- 移动端点击菜单后抽屉关闭。
- 动态页覆盖加载、空数据、筛选无结果、错误、旧数据保留和加载更多。
- 动态记录存在 task ID 时可以进入正确任务。
- 产物能力为 false 时只显示能力说明，不显示下载动作。
- 设置页正确区分 dry-run、live、服务降级和能力关闭。
- mock 与 API client 遵循同一接口。

### 质量门禁

在 `web-console/` 中运行下面的命令。

```bash
npm run test
npm run lint
npm run build
```

涉及服务端接口时同时运行根目录 `npm test`。最后执行 `git diff --check`，并在 1440、1024、768、414、375 和 320px 检查三个页面。

## 14. 实施顺序

1. 先增加路由与三个页面骨架，让侧栏不再出现禁用按钮。
2. 完成设置页和产物能力说明页，两页只依赖现有 `/health` 与 `/session`。
3. 增加全局活动接口、前端 client、mock 和查询键。
4. 完成动态筛选、分页、SSE 新记录提示和错误恢复。
5. 补齐前后端测试、响应式检查和文档同步。
6. 等 runtime 具备稳定产物模型后，再实施产物列表与下载阶段。

## 15. 验收标准

- 左侧三个入口都能点击，并进入独立页面。
- 刷新 `/activity`、`/artifacts` 或 `/settings` 时不会被重定向到总览。
- 动态页只展示服务端已记录的数据，筛选和分页稳定。
- 产物能力关闭时，页面不会出现任何可误解为真实产物的内容。
- 设置页清楚显示当前运行模式和能力，但不能修改敏感配置。
- API 不暴露本地路径、原始 CLI 输出、凭据和 `w3account`。
- SSE 中断或 API 暂时不可用时，页面保留最近一次成功数据并说明状态。
- 桌面和移动端的侧栏选中态、按钮尺寸、焦点样式和页面布局均可用。
