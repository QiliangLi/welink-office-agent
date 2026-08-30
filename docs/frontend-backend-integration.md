# WeLink Office Agent 前后端对接设计

## 1. 文档用途

本文给出 `web-console/` 与现有 WeLink Agent runtime 的完整对接方案。目标是让页面展示真实任务、审批、计划和活动记录，并让创建任务、暂停、继续、取消、审批、补充信息、催办和追加指令能够可靠地进入 Agent 执行流程。

这份设计以仓库在 2026 年 8 月 30 日的实现为依据。当前 runtime 仍由可移植 Agent Skill、Node CLI 包装器、`welink-cli` 和本地 JSON/JSONL 文件组成。当前 Web 控制台只使用内存 mock，没有 HTTP 请求，也没有持久化写入。

本文同时划清第一阶段边界。第一阶段保留本地单用户、单 Agent、文件存储和 WeLink CLI，不引入数据库，不把控制台直接连到 `welink-cli`，也不把 `runtime/raw/` 暴露给浏览器。

## 2. 当前实现能做什么

### 2.1 Runtime 已有能力

Runtime CLI 入口位于 `scripts/agent.mjs`，可复用的存储、ID、WeLink wrapper 和通用工具位于 `scripts/lib/`，已经具备以下能力。

| 能力 | 当前入口 | 持久化位置 |
| --- | --- | --- |
| 初始化 | `init` | `config/*.json`、`runtime/agent-state.json` |
| 创建主任务 | `create-task` | `runtime/tasks/*.json` |
| 创建和更新子任务 | `add-subtask`、`update-subtask` | 主任务快照中的 `subtasks` |
| 记录动态事项 | `add-item`、`classify-item` | `runtime/items/*.json` |
| 创建和处理审批 | `create-approval`、`resolve-approval` | `runtime/approvals/*.json` |
| 发送用户或群消息 | `send-user`、`send-group` | `runtime/actions/*.json`、`runtime/logs/messages.jsonl` |
| 查询 WeLink 历史 | `query-history-*` | `runtime/raw/*.json` |
| 记录消息与游标 | `record-message`、`set-cursor` | JSONL 日志和 `agent-state.json` |
| 查看和恢复 | `status`、`resume` | 读取全部 runtime 数据 |
| 完成任务 | `complete-task` | 主任务快照和 Agent 状态 |

发送消息前，runtime 会先写一条状态为 `executing` 的 action。CLI 返回后再把 action 更新为 `succeeded`、`dry_run`、`failed` 或 `unknown`。这套顺序应当保留，它是恢复超时和避免重复发送的基础。

### 2.2 Web 控制台已有能力

当前页面已经覆盖总览、任务列表、新建任务、任务详情和待我处理。页面中的操作目前只修改 React 内存状态。

| 页面操作 | 当前行为 | 对接后的真实行为 |
| --- | --- | --- |
| 搜索和筛选 | 浏览器内筛选 mock | 小数据量阶段可继续前端筛选，随后切到服务端查询 |
| 新建任务 | 生成固定日期的 mock ID | 创建 runtime 任务并投递 Agent 规划命令 |
| 暂停和继续 | 修改内存中的状态 | 写入持久化命令并更新任务状态 |
| 取消任务 | 把状态改成 `stopped` | runtime 使用 `cancelled`，API 映射为 `stopped` |
| 审批 | 修改审批卡片状态 | 记录决定，并按审批类型投递后续 Agent 命令 |
| 澄清输入 | 输入只存在卡片内部 | 把回答保存到审批记录和关联任务 |
| 选择会议时间 | 选择只存在卡片内部 | 保存所选 option，并交给 Agent 执行后续动作 |
| 催一下 | 只显示 mock Toast | 创建受频率策略约束的提醒命令 |
| 给 Agent 新指令 | 只显示占位提示 | 创建与任务关联的新指令命令 |
| 活动时间线 | 来自 mock 数组 | 由 events 和 messages 日志生成读模型 |
| Agent 健康状态 | 固定显示正常 | 来自 runtime tick 时间、CLI 认证和命令积压 |

### 2.3 直接对接会遇到的问题

现有前后端不能靠读取几个 JSON 文件直接连起来，主要有以下原因。

1. 浏览器不能安全地访问本地文件系统，也不应知道 runtime 目录结构。
2. runtime 没有 HTTP 服务。
3. `create-task` 只创建主任务快照。任务拆解、联系人路由和消息发送依赖宿主 Agent 后续执行。
4. 前端状态和 runtime 状态名称不同。
5. 前端审批卡片是消息、日程和澄清三种联合类型，runtime 只有通用的 `question`、`options` 和 `proposed_action`。
6. 前端新任务包含优先级、截止时间、外部操作策略和执行方式，runtime 尚未保存这些字段。
7. Store 使用临时文件加 rename 保证单次 JSON 写入完整，但没有跨进程锁。控制台和宿主 Agent 同时改同一任务时可能发生覆盖。
8. JSONL 事件没有读取接口，也没有可恢复的流式游标。
9. 页面中附件、分页、产物、成本和部分详情文案仍是展示占位，runtime 没有对应数据。
10. `completion_policy` 声明了“没有不确定 action”等条件，当前 `complete-task` 的实际检查没有覆盖全部声明项。API 不能把声明字段当成已经执行的规则。
11. 当前消息日志没有稳定的 conversation 关联。如果两个任务同时等待同一联系人回复，仅凭联系人和最近时间无法判断回复属于哪个任务。

## 3. 推荐架构

推荐在浏览器与 runtime 之间增加一个只监听本机的 Console API，并增加持久化命令队列。宿主 Agent 的 `tick` 消费需要推理或 WeLink 操作的命令。

```text
┌──────────────────────┐
│ React Web Console    │
│ 页面、查询缓存、表单  │
└──────────┬───────────┘
           │ HTTP JSON + SSE
┌──────────▼───────────┐
│ Local Console API    │
│ 校验、DTO、权限、读模型│
│ 命令落盘、SSE、健康检查 │
└──────┬────────┬──────┘
       │        │
       │        └────────────────────┐
       │                             │
┌──────▼───────────┐       ┌─────────▼──────────┐
│ Runtime Store    │       │ Agent Command Inbox│
│ JSON、JSONL、锁   │       │ queued/claimed/... │
└──────┬───────────┘       └─────────┬──────────┘
       │                             │
       │                    ┌────────▼───────────┐
       │                    │ Host Agent tick   │
       │                    │ 推理、路由、推进任务 │
       │                    └────────┬───────────┘
       │                             │
       └─────────────────────────────▼
                              wrapper → welink-cli
```

### 3.1 Console API 的职责

Console API 只做确定性的工作。

- 读取 runtime 快照和日志。
- 把内部数据转换成稳定的前端 DTO。
- 校验所有浏览器输入。
- 把写操作先记录成幂等命令。
- 立即处理暂停、取消这类确定性状态变更。
- 把需要 Agent 推理、联系人路由或外部发送的命令留给 `tick`。
- 通过 SSE 通知页面数据已变化。
- 返回 Agent 健康、dry-run 和能力开关。
- 计算同联系人沟通队列读模型，但不替 Agent 猜测消息语义。

Console API 不直接调用 `welink-cli`。外部发送仍然经过现有 wrapper，这样联系人白名单、Agent 尾注、action 预落盘和恢复逻辑只有一套。

### 3.2 Agent tick 的职责

`tick` 开始后，先处理命令队列，再查询 WeLink 新消息。

1. 恢复 `executing` 和 `unknown` action。
2. 领取一个尚未处理的 UI 命令。
3. 执行任务规划、追加指令、催办或审批后续动作。
4. 写回任务、审批、item、action 和日志。
5. 把命令标记为成功、失败或等待人工处理。
6. 继续处理 WeLink 历史消息和常规跟进。

一轮只领取有限数量的命令，避免 UI 突然提交大量操作后阻塞常规消息轮询。建议默认每轮最多处理 10 个确定性命令和 3 个需要外部操作的命令。

### 3.3 进程方式

开发环境使用两个进程。

```text
Vite                http://127.0.0.1:4173
Console API         http://127.0.0.1:4174
```

Vite 把 `/api` 代理到 4174。浏览器始终请求相对路径，因此不需要开放 CORS。

生产式本地运行时，先构建前端，再由 Console API 托管 `web-console/dist/`。页面和 API 使用同一个 origin。

### 3.4 复用 runtime 逻辑

`agent.mjs` 目前把参数解析、状态变更和命令执行写在同一个 switch 中。对接时应把 create task、update task、resolve approval、send message 等逻辑抽成可复用的 service。CLI 继续负责把命令行参数转换成 service 输入，Console API 也调用同一组 service。

API 不应为每次确定性写入再 spawn 一个 `node agent.mjs` 子进程。子进程方式很难传 revision、锁上下文和结构化错误，还会把参数长度与转义问题带进 HTTP 层。外部消息发送仍由共享的 send service 调用 `runWelink`，保留 action 预落盘和 Agent marker。

## 4. 数据契约原则

### 4.1 Runtime 模型和页面 DTO 分开

Runtime 文件是执行模型，页面需要的是读模型。两者不能共用同一个 TypeScript `Task` 后就假定字段含义一致。

API 返回的 DTO 使用 camelCase，runtime 文件继续使用 snake_case。转换集中放在服务端 serializer 中。页面不得读取 `task_id`、`pending_approval_ids` 或文件路径。

服务端 route schema 是 HTTP 契约的唯一来源。构建时从 JSON Schema 生成 OpenAPI 和 `web-console/src/api/contracts.ts`，CI 检查生成文件是否与 schema 一致。不要在 runtime、API 和前端分别手写三套 enum。

前端现有 `Task.status` 在迁移时改名为 `displayStatus`，`StatusBadge` 和筛选器都使用这个字段。调试界面需要查看 runtime 状态时读取只读的 `sourceStatus`。这样业务代码不会把 `running` 的 runtime 状态误当成页面一定要显示“执行中”。

### 4.2 身份字段

用户的逻辑主键继续使用工号，群的逻辑主键继续使用群号。`w3account` 只允许 wrapper 在执行时读取，API 不返回给浏览器。

前端 `Person.id` 应改为 employee number。联系人展示信息来自 `contacts.json`。建议给联系人配置补充可选字段 `department` 和 `avatar_initials`。缺少时，API 用姓名生成 initials，department 返回空字符串。

### 4.3 时间字段

Runtime 继续保存 ISO 8601 UTC 时间。API 同时返回 `serverTime` 和 owner 配置中的 `timezone`。前端用真实当前时间计算相对时间，不再使用固定的 2026 年时间常量。

新任务页面的 `datetime-local` 没有时区。提交时同时发送 `timezone`，服务端转换成完整 ISO 时间并保存。

### 4.4 版本和幂等

所有可修改快照增加整数 `revision`。每次保存加一。API 返回 `revision`，修改已有对象时携带 `expectedRevision`。

每个 POST 请求携带 `Idempotency-Key` 请求头。服务端以 owner、路由和 key 作为唯一约束。相同 key 和相同请求体返回第一次的结果；相同 key 配上不同请求体返回 `409 IDEMPOTENCY_CONFLICT`。

## 5. Runtime 需要补充的模型

### 5.1 Task 新字段

现有 Task 快照保留，并补充以下字段。

```json
{
  "revision": 3,
  "created_by_employee_number": "00000000",
  "source": "web_console",
  "category": "follow_up",
  "priority": "normal",
  "deadline_at": "2026-09-01T10:00:00.000Z",
  "external_policy": "balanced",
  "execution_mode": "automatic",
  "attachment_ids": [],
  "queued_command_id": "CMD-20260830-A1B2C3"
}
```

`status` 增加 `queued`。Web 页面创建任务后，API 先写入 queued 快照；Agent 完成拆解后改成 running。任务已经完成规划、但 required subtask 因同一联系人沟通槽被占用而无法开始时，也可以由 serializer 推导为 `displayStatus=queued`。因此 `sourceStatus=queued` 表示 runtime 根任务尚未启动，`displayStatus=queued` 表示页面语义上的“待执行”，二者不能混为同一个判断条件。

### 5.2 Subtask 新字段

```json
{
  "parent_subtask_id": null,
  "sequence": 1,
  "revision": 2,
  "waiting_kind": "contact_slot",
  "waiting_reason": "等待与王璐的上一项沟通完成",
  "estimated_completion_at": null,
  "contact_key": "employee:002",
  "conversation_id": null,
  "blocked_by_task_id": "TASK-20260829-A1B2C3",
  "blocked_by_subtask_id": "SUBTASK-20260829-D4E5F6",
  "queue_entered_at": "2026-08-30T04:00:00.000Z"
}
```

第一阶段的执行计划可以把每个 runtime subtask 显示为一个 PlanStep。确实存在父子关系时再使用 `parent_subtask_id`。页面不再虚构“准备材料”“确认送达”等 runtime 没有记录的步骤。

`waiting_kind` 使用 `reply`、`followup_window`、`contact_slot`、`owner` 和 `recovery` 等稳定枚举，`waiting_reason` 只负责展示说明。页面不得解析自然语言来判断任务是否待执行。

### 5.2.1 联系人沟通槽和回复关联

任务可以整体并发执行，但同一联系人默认只允许一个处于活动状态的私聊会话。这里的“活动”指已经向联系人发出消息、且仍在等待该会话回复或后续动作。新任务仍可完成拆解和不涉及该联系人的工作；需要联系同一人的 subtask 进入 `waiting_kind=contact_slot`，直到前一个会话关闭、超时或人工释放。

沟通槽使用稳定的 `contact_key` 作为锁键，不能使用展示姓名。候选项按 priority（high、normal、low）降序、`queue_entered_at` 升序、task ID 升序排列，以保证重启后顺序不变。获得槽位时必须在同一次加锁事务中写入 `conversation_id`，并清除 blocked-by 和排队时间字段；释放槽位后唤醒下一项并写 `contact_slot_released`、`contact_slot_acquired` 事件。

每次外发动作需要保存以下关联信息。

```json
{
  "conversation_id": "CONV-20260830-A1B2C3",
  "correlation_id": "ACTION-20260830-D4E5F6",
  "task_id": "TASK-20260830-G7H8I9",
  "subtask_id": "SUBTASK-20260830-J1K2L3",
  "contact_key": "employee:002",
  "sent_at": "2026-08-30T04:03:00.000Z"
}
```

收到联系人消息后，runtime 按以下优先级归属回复。

1. WeLink 能提供 reply/thread 标识时，精确匹配 `correlation_id` 或 `conversation_id`。
2. 没有显式标识、但该联系人只有一个活动会话时，归入该会话。
3. 没有活动会话时，记录为未归属消息，等待 Agent 判断或人工处理。
4. 存在多个候选会话时，创建澄清/恢复项，不得只凭联系人和时间猜测任务归属。

同联系人串行策略使正常路径始终只有一个候选会话，但第 3、4 项仍必须存在，用来处理历史数据、外部主动消息和异常恢复。当前后端如果只按联系人查询最近消息，无法可靠支持两个同联系人会话同时等待回复；完成本节的数据关联和串行约束以前，不能开启这种并发。

### 5.3 Approval 的 proposed_action 联合类型

`proposed_action` 需要成为带 `type` 的联合对象。API 根据 type 生成不同审批卡片。

```json
{
  "type": "send_message",
  "target_type": "group",
  "target_id": "1234567891011",
  "display_target": "智能办公项目群",
  "audience_text": "28 人",
  "content": "大家好，项目周报已生成。"
}
```

```json
{
  "type": "schedule_meeting",
  "options": [
    {
      "option_id": "slot-1",
      "label": "周二 14:00 到 15:00",
      "attendance_text": "6/6 可参加",
      "tone": "good"
    }
  ]
}
```

```json
{
  "type": "clarification",
  "question": "周三下午具体是几点到几点？",
  "field": "meeting_time_range",
  "placeholder": "例如 14:00 到 16:00"
}
```

```json
{
  "type": "scope_change",
  "item_id": "ITEM-20260830-A1B2C3",
  "options": [
    { "value": "include_current", "label": "纳入当前任务" },
    { "value": "create_separate", "label": "创建独立任务" },
    { "value": "return", "label": "退回提出人" },
    { "value": "close", "label": "关闭事项" }
  ]
}
```

审批再增加 `decision_payload`，保存用户选择的时段、澄清回答或修改后的消息。只写 `status=approved` 无法还原用户究竟批准了什么。

### 5.4 持久化命令

新增 `runtime/commands/`。每条命令独立保存，文件结构与 action 类似。

```json
{
  "schema_version": 1,
  "revision": 1,
  "command_id": "CMD-20260830-A1B2C3",
  "type": "task.create",
  "aggregate_type": "task",
  "aggregate_id": "TASK-20260830-D4E5F6",
  "idempotency_key": "0f31b8c0-2a6d-4df4-97d3-f4f8da0a6721",
  "requested_by_employee_number": "00000000",
  "payload": {},
  "status": "queued",
  "attempts": 0,
  "claimed_by": null,
  "claimed_at": null,
  "created_at": "2026-08-30T04:00:00.000Z",
  "updated_at": "2026-08-30T04:00:00.000Z",
  "completed_at": null,
  "error": null
}
```

命令状态使用以下集合。

| 状态 | 含义 |
| --- | --- |
| `queued` | 已持久化，尚未领取 |
| `claimed` | 某个 worker 或 tick 已领取 |
| `waiting_agent` | 确定性部分已完成，等待 Agent 推理或外部动作 |
| `succeeded` | 预期状态和后续动作均已落盘 |
| `failed` | 已知失败，可根据 `retryable` 判断能否重试 |
| `cancelled` | 命令在执行前被取消 |

命令领取必须有租约。进程异常退出后，超过租约时间的 `claimed` 命令回到 queued。已经产生外部 action 的命令先走 action 恢复，不能直接重发。

### 5.5 文件锁和 revision

新增 `runtime/.locks/`。所有会读后改写 Task、Approval、Item、Action、Command 和 AgentState 的代码都通过 Store 的 `mutate*` 方法执行。

建议锁流程如下。

1. 使用 `fs.open(lockPath, "wx")` 创建锁文件。
2. 锁文件写入 pid、创建时间和租约截止时间。
3. 获得锁后重新读取最新快照。
4. 检查 `expectedRevision`。
5. 写临时文件并 rename。
6. 释放锁。

任务、审批和关联 item 需要一起修改时，按固定顺序获取锁，顺序为 task、approval、item、command。所有调用方使用同一顺序，避免互相等待。

## 6. 页面 TaskStatus 的推导

Runtime 状态是执行事实，页面状态是对用户的解释。API 统一计算 `displayStatus`，前端不再自行猜测。

### 6.1 根状态直接映射

| Runtime `status` | API `displayStatus` | 页面文案 |
| --- | --- | --- |
| `queued` | `queued` | 待执行 |
| `waiting_owner` | `waiting_approval` | 待我处理 |
| `paused` | `paused` | 已暂停 |
| `completed` | `completed` | 已完成 |
| `cancelled` | `stopped` | 已停止 |
| `failed` | `failed` | 异常 |
| `reopened` | 继续按子任务推导 | 已重新打开 |

### 6.2 running 和 reopened 的推导优先级

从上到下匹配，命中后停止。

1. 存在 pending approval 时返回 `waiting_approval`。
2. 存在 `executing` 或 `unknown` action 且需要人工恢复时返回 `partial`，同时给出 `waitingReason`。
3. 所有未完成 required subtask 都在 `waiting_kind=contact_slot` 时返回 `queued`。
4. 存在可立即执行的 required subtask 时返回 `running`。即使某个联系人 subtask 正在等槽，只要还有其他必要工作可执行，根任务仍显示执行中。
5. 所有未完成 required subtask 都在 `waiting_kind=reply` 或 `waiting_kind=followup_window` 时返回 `waiting_external`。
6. required subtask 中同时存在完成项与不可继续的 failed/cancelled 项时返回 `partial`。
7. 其余情况返回 `running`。

`partial` 表示已有可保留结果，同时存在未能完成的必要工作。它不能用来代替普通等待。

### 6.3 进度算法

第一阶段使用可解释的完成比例。

```text
progress = completed required subtasks / all required subtasks × 100
```

结果四舍五入到整数。没有子任务时，queued 和 running 返回 0，completed 返回 100。动态创建且 `required=true` 的子任务进入分母，与初始子任务权重相同。

页面中的 `completedSubtasks` 和 `totalSubtasks` 使用同一批 required subtasks。可选子任务单独显示，不影响主进度。

### 6.4 当前动作和等待原因

`currentAction` 的来源按以下顺序选择。

1. pending approval 的 question。
2. 正在执行子任务的 title 和 `next_action.type`。
3. 最早到期等待项的 title。
4. 任务 `working_summary.next_actions[0]`。
5. 状态对应的安全兜底文案。

`waitingReason` 需要包含可行动的信息。等待外部时返回联系人显示名和等待内容；待审批时返回审批标题；action 不确定时返回“发送结果待核实”。待执行时同时返回结构化的 `waitingKind=contact_slot`、`queuePosition`、`blockedByTaskId`、`blockedBySubtaskId` 和 `queueEnteredAt`，自然语言可写“等待与王璐的上一项沟通完成”。页面不得继续使用固定的“已等待 37 分钟”，也不得从这句文案反解析队列字段。等待时长由相关时间戳实时计算。

### 6.5 审批状态映射

审批决定和外部执行结果分开返回。Approval DTO 增加 `decisionStatus` 和 `executionStatus`。

| Runtime approval status | 页面 status | executionStatus |
| --- | --- | --- |
| `pending` | `pending` | `not_started` |
| `approved` | `approved` | 根据关联 command/action 返回 `queued`、`executing`、`succeeded`、`failed` 或 `unknown` |
| `rejected`、`closed` | `rejected` | `not_applicable` |
| `returned`、`modified` | `edited` | `not_started` |

只有 executionStatus 为 succeeded 时，页面才能说外部动作已经执行。澄清输入和范围选择没有外部 action 时，应用决定成功即可返回 succeeded。

## 7. API 约定

### 7.1 基础规则

- 基础路径使用 `/api/v1`。
- JSON 字段使用 camelCase。
- 时间使用 ISO 8601。
- 列表默认按 `updatedAt` 倒序。
- 列表使用 cursor 分页，不使用文件名页码。
- 所有响应带 `requestId`。
- 写请求要求 `Idempotency-Key`。
- 冲突写请求返回 409，并带当前 revision。
- 需要 Agent 异步执行的请求返回 202。

### 7.2 健康和能力

#### `GET /api/v1/health`

```json
{
  "status": "degraded",
  "requestId": "REQ-A1B2C3",
  "serverTime": "2026-08-30T04:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "mode": "dry_run",
  "agent": {
    "state": "idle",
    "lastSuccessfulTick": null,
    "stale": true,
    "queuedCommands": 1,
    "uncertainActions": 0
  },
  "capabilities": {
    "attachments": false,
    "artifacts": false,
    "liveSend": false,
    "sse": true
  }
}
```

页面顶部的“Agent 正常”由这个接口决定。`dry_run` 必须有清楚标识，不能显示成真实发送成功。

#### `GET /api/v1/session`

返回当前 owner 的安全展示信息和短期 CSRF token。前端只把 token 保存在内存中，所有写请求通过 `X-CSRF-Token` 发送。token 在 Console API 重启后失效，页面收到 403 时重新获取 session 并提示用户重试原操作。

### 7.3 总览

#### `GET /api/v1/overview`

返回状态计数、当前任务、待执行任务、待处理审批、最近完成和最近活动。这个聚合接口减少首屏并发请求，也确保各区域来自同一个读取时点。

支持 `activityLimit` 和 `taskLimit`，上限由服务端限制。响应带 `snapshotAt`。

`currentTasks` 与 `queuedTasks` 必须是两个独立集合，不能让前端从一个数组里临时切分。`currentTasks` 包含 `running` 和 `waiting_external`；`queuedTasks` 只包含 `queued`，并按 priority、`queueEnteredAt`、task ID 的稳定顺序返回。`totalsByStatus.queued` 参与顶部统计，即使数量为 0 也返回。

```json
{
  "totalsByStatus": {
    "running": 2,
    "queued": 1,
    "waiting_external": 1,
    "waiting_approval": 0
  },
  "currentTasks": [],
  "queuedTasks": [
    {
      "id": "TASK-20260830-D4E5F6",
      "displayStatus": "queued",
      "currentAction": "等待与王璐的上一项沟通完成",
      "waitingKind": "contact_slot",
      "queuePosition": 1,
      "blockedByTaskId": "TASK-20260829-A1B2C3",
      "queueEnteredAt": "2026-08-30T04:00:00.000Z"
    }
  ],
  "pendingApprovals": [],
  "recentCompleted": [],
  "recentActivity": [],
  "snapshotAt": "2026-08-30T04:05:00.000Z",
  "requestId": "REQ-A1B2C3"
}
```

### 7.4 任务列表

#### `GET /api/v1/tasks`

查询参数如下。

| 参数 | 说明 |
| --- | --- |
| `q` | 标题、任务 ID、原始请求和联系人姓名 |
| `status` | 可重复的 display status |
| `updatedFrom` | ISO 时间 |
| `updatedTo` | ISO 时间 |
| `cursor` | 上一页返回的 opaque cursor |
| `limit` | 默认 20，最大 100 |

```json
{
  "items": [
    {
      "id": "TASK-20260830-D4E5F6",
      "revision": 4,
      "title": "收集性能测试进展",
      "description": "确认当前状态、阻塞问题和预计完成时间。",
      "sourceStatus": "running",
      "displayStatus": "waiting_external",
      "category": "research",
      "priority": "normal",
      "currentAction": "等待张三回复性能测试进展",
      "waitingReason": "已等待张三回复 42 分钟",
      "waitingKind": "reply",
      "queuePosition": null,
      "blockedByTaskId": null,
      "blockedBySubtaskId": null,
      "queueEnteredAt": null,
      "progress": 50,
      "completedSubtasks": 1,
      "totalSubtasks": 2,
      "createdAt": "2026-08-30T03:00:00.000Z",
      "updatedAt": "2026-08-30T03:42:00.000Z"
    }
  ],
  "nextCursor": null,
  "total": 1,
  "totalsByStatus": {
    "waiting_external": 1
  },
  "requestId": "REQ-A1B2C3"
}
```

第一阶段任务量较少时，API 仍应实现这些参数。前端可以保留即时本地筛选体验，但 URL 和服务端查询需要保持一致。

### 7.5 任务详情

#### `GET /api/v1/tasks/:taskId`

返回以下数据。

- 任务摘要和显示状态。
- 原始请求、优先级、截止时间和策略。
- 由 subtasks 生成的 plan。
- 联系人展示信息。
- working summary。
- pending approval 摘要。
- 最近活动和分页游标。
- action 恢复提示。
- 当前 revision 和允许的命令列表。

`allowedCommands` 由服务端计算。页面只显示服务端允许的动作。例如 completed 任务不显示暂停，存在 unknown send action 时不提供普通重试，只提供“核实发送结果”。

#### `GET /api/v1/tasks/:taskId/events`

用于加载完整时间线。查询参数使用 `cursor` 和 `limit`。API 合并 `events.jsonl` 与 `messages.jsonl`，但只返回安全字段。原始 CLI stdout、stderr、`w3account` 和文件路径不进入响应。

活动 DTO 使用稳定的类型和顺序字段。

```json
{
  "items": [
    {
      "id": "EVT-20260830-A1B2C3",
      "kind": "message",
      "title": "已向王璐发出进度确认",
      "detail": "等待对方回复",
      "occurredAt": "2026-08-30T04:03:00.000Z",
      "sequence": 18420,
      "taskId": "TASK-20260830-D4E5F6",
      "subtaskId": "SUBTASK-20260830-G7H8I9",
      "conversationId": "CONV-20260830-J1K2L3"
    }
  ],
  "nextCursor": null,
  "requestId": "REQ-A1B2C3"
}
```

`kind` 第一阶段使用 `task`、`status`、`message`、`approval`、`file`。首次请求返回最近 N 条，但同一批内必须按 `occurredAt ASC, sequence ASC` 排列；获取更早一页后，前端把该批整体前插。`sequence` 是 runtime 内单调递增的稳定次序，用来处理相同时间戳，不能用随机 event ID 排序。

时间线箭头是否流动完全由前端展示：只有任务 `displayStatus=running` 且至少有两个活动节点时播放流动效果；`queued`、等待、暂停和终态都静止。API 不返回动画开关，避免把视觉表现写入业务模型。最新一项由排序结果确定，前端不依赖后端持久化 `isCurrent`。

### 7.6 创建任务

#### `POST /api/v1/tasks`

```json
{
  "description": "收集本周项目进展，确认阻塞和预计完成时间，并整理成周报。",
  "priority": "high",
  "deadline": "2026-09-01T10:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "externalPolicy": "balanced",
  "executionMode": "automatic",
  "attachmentIds": []
}
```

服务端处理顺序如下。

1. 校验描述长度、截止时间和 enum。
2. 创建状态为 queued 的 Task 快照。
3. 写入 `task.create` 命令。
4. 写入 `task_created_from_console` 事件。
5. 返回任务 ID 和命令 ID。

```json
{
  "task": {
    "id": "TASK-20260830-D4E5F6",
    "revision": 1,
    "displayStatus": "queued"
  },
  "command": {
    "id": "CMD-20260830-A1B2C3",
    "status": "waiting_agent"
  },
  "requestId": "REQ-A1B2C3"
}
```

HTTP 状态使用 202。页面成功卡片写“任务已创建，当前待执行”。等 SSE 收到 `task_planned`，并且 serializer 返回 `displayStatus=running` 后再显示“已开始执行”。如果任务规划后进入联系人沟通队列，页面继续显示“待执行”及排队原因，不能只凭 `task_planned` 改成执行中。

附件在第一阶段返回 capability false，页面隐藏上传入口或明确标为尚未接入。不能继续展示“支持 20MB”却只保存文件名。

### 7.7 任务命令

#### `POST /api/v1/tasks/:taskId/commands`

通用命令入口使用受限联合类型。

```json
{
  "type": "pause",
  "expectedRevision": 4
}
```

```json
{
  "type": "instruction",
  "expectedRevision": 4,
  "text": "先暂停联系财务，只汇总市场和技术反馈。"
}
```

允许的 type 如下。

| type | 是否需要 Agent | 说明 |
| --- | --- | --- |
| `pause` | 否 | 立即把任务改成 paused，并阻止 tick 领取新外部动作 |
| `resume` | 是 | 先改为 running，再让 Agent 重建下一步 |
| `cancel` | 是 | 立即改为 cancelled，Agent 清理未执行命令并通知必要对象 |
| `instruction` | 是 | 保存原文，Agent 判断是否改变范围或产生审批 |
| `retry` | 是 | 只针对服务端返回的可重试失败 |

取消不能删除任务、日志或已有产物。已经发送到 WeLink 的消息无法通过取消撤回。

### 7.8 子任务催办

#### `POST /api/v1/tasks/:taskId/subtasks/:subtaskId/reminders`

服务端先检查联系人、subtask 状态、`next_reminder_at`、`max_reminders` 和 uncertain action。允许后创建 `subtask.remind` 命令。

达到提醒上限时返回 `409 REMINDER_LIMIT_REACHED`。尚未到时间时返回 `409 REMINDER_NOT_DUE`，并带 `nextReminderAt`。页面不能只弹一个成功 Toast。

### 7.9 审批列表和详情

#### `GET /api/v1/approvals`

支持 `status=pending`、`taskId`、cursor 和 limit。默认只返回 pending。

Approval DTO 保留稳定外壳，payload 按 kind 变化。

```json
{
  "id": "AP-20260830-A1B2C3",
  "revision": 2,
  "taskId": "TASK-20260830-D4E5F6",
  "kind": "message",
  "title": "发送项目周报",
  "summary": "Agent 建议把周报发送到项目群。",
  "reason": "该操作会向多人发送消息。",
  "impact": "群成员会立即收到消息。",
  "status": "pending",
  "payload": {
    "type": "message",
    "target": "智能办公项目群",
    "audience": "28 人",
    "message": "大家好，项目周报已生成。"
  },
  "allowedDecisions": ["approve", "reject", "edit"],
  "createdAt": "2026-08-30T03:55:00.000Z"
}
```

#### `POST /api/v1/approvals/:approvalId/decisions`

不同审批使用不同 decision payload。

```json
{
  "decision": "approve",
  "expectedRevision": 2
}
```

```json
{
  "decision": "select_option",
  "optionId": "slot-1",
  "expectedRevision": 2
}
```

```json
{
  "decision": "submit_answer",
  "answer": "14:00 到 16:00",
  "expectedRevision": 2
}
```

```json
{
  "decision": "edit",
  "editedContent": "修改后的群消息",
  "expectedRevision": 2
}
```

处理审批分成记录决定和应用决定两个阶段。API 先持久化用户准确选择，再创建 `approval.apply` 命令。涉及外部发送时返回 202，页面显示“已记录，等待 Agent 执行”。只有 action 成功后才显示“已执行”。

当前 `resolve-approval` 在 approved 后只更新状态，不会自动执行 proposed action。实现对接时必须补上 `approval.apply` 消费逻辑，不能沿用页面现在的“已批准，Agent 将继续执行”作为完成凭证。

#### `POST /api/v1/approvals/bulk-decisions`

第一阶段只允许把明确列出的审批批量转为待修改。

```json
{
  "approvalIds": ["AP-1", "AP-2"],
  "decision": "mark_for_edit"
}
```

接口不接受 `all=true`，也不提供批量批准外部动作。

### 7.10 命令状态

#### `GET /api/v1/commands/:commandId`

页面刷新后可以继续查询尚未完成的操作。返回状态、关联对象、创建时间、完成时间和安全错误信息。

## 8. SSE 实时更新

#### `GET /api/v1/events/stream`

SSE 只发送变更通知和少量展示字段，不发送完整 Task 快照。页面收到事件后让对应查询失效并重新请求，避免在浏览器里复刻 runtime 状态机。

```text
event: task.updated
id: events.jsonl:18420
data: {"taskId":"TASK-20260830-D4E5F6","revision":5}
```

建议事件类型如下。

- `task.created`
- `task.updated`
- `task.queue.updated`
- `task.completed`
- `approval.created`
- `approval.resolved`
- `command.updated`
- `action.updated`
- `message.received`
- `message.attributed`
- `conversation.updated`
- `agent.health`

当前 event ID 是随机值，不能用来确定先后。第一阶段可以用 JSONL 文件字节 offset 作为 SSE cursor，并通过 `Last-Event-ID` 恢复。Console API 保存每个连接已经发送到哪个 offset。

监听 JSONL 时同时使用 `fs.watch` 和短间隔兜底轮询。读取时只处理以换行结尾的完整记录。文件轮转前先定义 checkpoint，避免 offset 失效。

断线重连策略如下。

1. 浏览器使用 `EventSource` 自动重连。
2. 服务端每 20 秒发送 heartbeat。
3. 连接恢复后从 Last-Event-ID 继续。
4. cursor 已失效时发送 `snapshot.required`。
5. 页面收到该事件后重新加载 overview、tasks 和 approvals。

## 9. 关键交互时序

### 9.1 页面首次加载

```text
Browser             Console API              Runtime
   │ GET /health         │                       │
   │────────────────────>│ read agent-state      │
   │<────────────────────│                       │
   │ GET /overview       │                       │
   │────────────────────>│ read snapshots/logs   │
   │<────────────────────│                       │
   │ EventSource         │                       │
   │────────────────────>│ tail events.jsonl     │
```

前端先渲染 skeleton。健康接口失败时保留最近一次数据并显示“Agent 服务不可用”，不把任务清空成零。

### 9.2 创建任务

```text
Browser        Console API        Runtime Store       Agent tick
   │ POST task      │                   │                  │
   │───────────────>│ lock + write task │                  │
   │                │ write command     │                  │
   │<────── 202 ────│                   │                  │
   │ queued UI      │                   │                  │
   │                │                   │<── claim command─│
   │                │                   │<── add subtasks ─│
   │                │                   │<── send actions ─│
   │<── SSE task.updated ───────────────│                  │
   │ GET task       │                   │                  │
```

如果 Agent loop 没有运行，任务会保持 queued。健康区显示“等待 Agent 处理 1 个命令”，页面不能假装已经开始联系同事。

### 9.3 批准一条群消息

1. 页面提交 approval revision 和 approve decision。
2. API 在锁内保存 decision payload，并写 `approval.apply` 命令。
3. Agent tick 领取命令，调用现有 `send-group` wrapper。
4. wrapper 先写 action executing，再执行 `welink-cli`。
5. action succeeded 后，Agent 完成命令并恢复关联 subtask。
6. action unknown 时，审批显示“已批准，发送结果待核实”，Agent 下轮先查群历史。

批准记录和发送结果是两个事实，页面需要分别展示。

### 9.4 暂停和取消

暂停提交后，API 立即把任务状态改为 paused。已经执行中的外部 CLI 不能强行中断，完成后 action 仍然落盘，但 tick 不再领取该任务的新命令。

取消提交后，API 把任务状态改为 cancelled，并取消尚未 claimed 的关联命令。已经发送的消息、已记录回复和产物保留。Agent 下轮判断是否需要向相关联系人发送停止通知；若需要外部发送，仍遵守策略和审批规则。

### 9.5 同一联系人任务排队

```text
Task A              Runtime Store             Task B              Contact
   │ acquire 王璐 slot   │                       │                    │
   │────────────────────>│                       │                    │
   │ send conversation A │──────────────────────────────────────────>│
   │                     │<── request same slot─│                    │
   │                     │── queued(position 1)>│                    │
   │<────────────────────────────────────────────────────── reply A ─│
   │ close conversation A│                       │                    │
   │────────────────────>│── acquire + wake B ─>│                    │
   │                     │                       │── send B ─────────>│
```

Task B 在等待期间的 runtime 根状态可以仍是 running，但 serializer 在没有其他 required 工作可做时返回 `displayStatus=queued`。释放槽位、提升下一任务和更新两个任务 revision 必须在固定锁顺序下完成；SSE 随后发送 `task.queue.updated`，Overview 重新获取后把 Task B 从“待执行”移动到“当前”。

### 9.6 联系人回复归属

1. `record-message` 保存原始消息的安全字段和 WeLink reply/thread 标识。
2. attribution service 按 5.2.1 的规则解析 conversation。
3. 唯一匹配时，写 `message.attributed`，并用 task、subtask 和 conversation ID 更新对应会话。
4. 多个候选时只写未归属消息和恢复项，不推进任何任务。
5. 回复导致会话结束时释放联系人沟通槽，再提升下一项。

因此“收到王璐回复”本身不是完成某个 subtask 的充分条件，必须先有持久化的 conversation 归属结果。

## 10. 错误响应

统一错误结构如下。

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "任务已被其他操作更新，请刷新后重试。",
    "retryable": true,
    "details": {
      "expectedRevision": 4,
      "currentRevision": 5
    }
  },
  "requestId": "REQ-A1B2C3"
}
```

建议错误码如下。

| HTTP | code | 页面处理 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 保留表单并定位字段 |
| 404 | `TASK_NOT_FOUND` | 显示任务不存在，不跳到总览 |
| 409 | `REVISION_CONFLICT` | 刷新详情并提示数据已更新 |
| 409 | `INVALID_STATE_TRANSITION` | 重新获取 allowedCommands |
| 409 | `IDEMPOTENCY_CONFLICT` | 停止重试并记录 requestId |
| 409 | `REMINDER_NOT_DUE` | 显示下次可提醒时间 |
| 422 | `APPROVAL_PAYLOAD_INVALID` | 保留用户输入并提示具体问题 |
| 503 | `AGENT_UNAVAILABLE` | 命令仍会保留，显示等待 Agent 恢复 |
| 500 | `INTERNAL_ERROR` | 显示 requestId，服务端记录完整错误 |

服务端日志可以记录堆栈和文件位置，响应中不能返回本地绝对路径、CLI stderr 或联系人账户。

## 11. 安全边界

### 11.1 网络边界

- Console API 默认只绑定 `127.0.0.1`。
- 生产式本地运行使用同源页面，不开启 `Access-Control-Allow-Origin: *`。
- 写请求校验 Origin，并使用启动时生成的 CSRF token。
- 如果以后监听局域网，必须先增加登录、TLS 和 owner 权限，不能只修改 host。

### 11.2 数据边界

- 不提供读取 `runtime/raw/` 的通用接口。
- 不提供任意文件路径参数。
- evidence 使用受控类型和 ID，例如 task、approval、message、artifact。
- API 不返回 `w3account`、命令行参数、agent marker hash 和本地路径。
- 消息正文只返回当前 owner 有权查看的任务关联记录。

### 11.3 外部动作边界

- 浏览器不能提交任意 receiver 或 group ID 让后端直接发送。
- target 必须来自已持久化的 approval、subtask 或可信配置。
- `contacts.auto_contact` 和 `groups.trusted` 继续由 wrapper 最终校验。
- dry-run 和 live 模式由服务端返回，前端不能切换。
- unknown action 在查询会话确认前不允许重试。

## 12. 后端目录建议

```text
server/
├── index.mjs
├── app.mjs
├── routes/
│   ├── health.mjs
│   ├── overview.mjs
│   ├── tasks.mjs
│   ├── approvals.mjs
│   ├── commands.mjs
│   └── events.mjs
├── services/
│   ├── task-read-service.mjs
│   ├── approval-read-service.mjs
│   ├── command-service.mjs
│   ├── contact-slot-service.mjs
│   ├── message-attribution-service.mjs
│   ├── health-service.mjs
│   └── event-stream-service.mjs
├── serializers/
│   ├── task-dto.mjs
│   ├── approval-dto.mjs
│   └── activity-dto.mjs
├── schemas/
│   ├── common.mjs
│   ├── tasks.mjs
│   └── approvals.mjs
└── middleware/
    ├── request-id.mjs
    ├── origin-check.mjs
    └── error-handler.mjs

scripts/lib/
├── store.mjs
├── locks.mjs
├── commands.mjs
├── contact-slots.mjs
├── conversations.mjs
├── task-status.mjs
└── welink.mjs

runtime/
├── commands/.gitkeep
└── .locks/.gitkeep
```

HTTP 层建议使用兼容当前 Node engine 的小型框架，并用 JSON Schema 校验请求和响应。路由代码不得直接读写文件，所有状态变更都经过 Store 和 CommandService。

## 13. 前端目录建议

```text
web-console/src/
├── api/
│   ├── client.ts
│   ├── contracts.ts
│   ├── errors.ts
│   └── event-stream.ts
├── queries/
│   ├── overview.ts
│   ├── tasks.ts
│   ├── approvals.ts
│   └── health.ts
├── state/
│   └── AppDataContext.tsx
└── mocks/
    └── data.ts
```

`AppDataContext` 第一阶段可以继续作为页面门面，但内部改为调用 api client。完成迁移后，Context 只保存跨页面 UI 状态，不再保存 Task 和 Approval 的权威副本。

推荐引入支持查询缓存和失效的轻量请求层。若暂时不增加依赖，也可以用自建 hooks，但必须统一处理取消请求、竞态、重试、loading、stale data 和 SSE 失效。

### 13.1 页面迁移要点

| 页面 | 改动 |
| --- | --- |
| AppLayout | 启动 health 查询和 SSE，显示 dry-run、离线和命令积压 |
| Overview | 使用 `/overview`，直接渲染独立的 currentTasks 和 queuedTasks，不从多个本地数组临时统计 |
| Tasks | 查询参数写入 URL，分页使用 nextCursor |
| NewTask | 调用 POST tasks，成功页区分 queued 和 running |
| TaskDetail | 使用服务端 allowedCommands，文案全部来自 DTO；活动按 occurredAt 和 sequence 展示，流动效果只依赖 displayStatus |
| Approvals | 按 payload 提交准确 decision，不只传一个 status |
| Topbar | Agent 健康来自 health，通知数来自 pending approvals |

mock 数据保留给 Storybook、视觉回归或测试，不再作为生产 Provider 的默认数据。开发时由 `VITE_DATA_SOURCE=mock|api` 明确选择，默认使用 api。

## 14. 实施顺序

### 阶段一 只读真实数据

1. 给 Store 增加读取 JSONL、按 ID 查关联记录和安全容错。
2. 实现 task、approval 和 overview serializer。
3. 实现 health、overview、tasks、task detail、approvals 五类 GET 接口。
4. 前端增加 api client、loading、error 和 empty 状态。
5. 保留 mock 开关，逐页对照真实 runtime 数据。

完成标准是页面不再依赖 `initialTasks` 和 `initialApprovals`，刷新后仍能读到已保存数据。

### 阶段二 状态写入和并发保护

1. 给所有快照增加 revision。
2. 实现文件锁和 `mutate*` 方法。
3. 新增 command schema、目录和幂等索引。
4. 接入 pause、resume、cancel 和 mark-for-edit。
5. 前端使用 pending UI，不做不可撤销的乐观成功。

完成标准是连续双击、刷新重试和 API/Skill 同时修改时不会重复创建或覆盖状态。

### 阶段三 Agent 命令消费

1. `tick` 在查询消息前领取 UI 命令。
2. 接入 task.create、task.instruction、subtask.remind 和 approval.apply。
3. 实现联系人沟通槽、稳定队列顺序和释放后的任务提升。
4. 保存 outbound conversation 关联，并在处理回复前完成 message attribution。
5. 补齐 approved item 的实际转换或执行逻辑。
6. 把 completion policy 的声明和实际检查统一。
7. 增加命令租约和失败恢复测试。

完成标准是从页面创建任务后，Agent 能完成拆解、联系和状态回写；审批后能看到 action 的真实结果。

### 阶段四 实时更新

1. 实现 JSONL tail cursor。
2. 实现 SSE 和 heartbeat。
3. 前端按对象 ID 失效查询。
4. 增加断线恢复和 snapshot.required。

完成标准是 Agent 在命令行或下一轮 tick 更新任务后，页面无需手动刷新即可变化。

### 阶段五 附件和产物

附件需要单独设计上传暂存、大小限制、MIME 校验、哈希、病毒扫描策略和生命周期。runtime 能实际读取附件以前，页面保持 capability false。

产物需要稳定的 artifact ID、元数据和下载接口。页面不得直接链接本地路径。

## 15. 测试计划

### 15.1 Serializer 单元测试

- 每个 root task 状态映射到正确 display status。
- running 下各类 subtask 组合符合推导优先级。
- `waiting_kind=contact_slot` 且没有其他可执行工作时映射为 queued。
- 存在其他 required 可执行工作时，contact slot 等待不会把根任务误降为 queued。
- required 动态子任务进入进度分母。
- approval proposed_action 转成正确 payload。
- 联系人缺少可选字段时仍能安全展示。
- 日志中的敏感字段不会出现在 DTO。

### 15.2 API 合约测试

- 所有 enum 和长度限制。
- cursor 稳定性和默认排序。
- 404、409、422 和 503 错误结构。
- revision 冲突。
- Idempotency-Key 重放。
- Origin 和 CSRF 校验。
- 同一任务并发 pause 和 cancel 的最终结果。
- overview 始终分开返回 currentTasks 和 queuedTasks，且 queued 计数不会遗漏。
- events 在相同时间戳下仍按 sequence 稳定排序，分页前插后顺序不变。

### 15.3 Runtime 集成测试

- 页面创建任务后生成一个 Task 和一个 command。
- tick 领取命令后生成 subtasks。
- dry-run 消息仍生成 action 和 message log。
- approved message 只执行一次。
- CLI timeout 后 action 为 unknown，重启不会直接重发。
- pending approval、open item、waiting reply、conflict 和 uncertain action 都能阻止错误完成。
- 取消任务后未领取命令不会继续执行。
- 两个任务联系同一人时只有一个活动 conversation，后一项进入 contact slot 队列。
- 前一会话关闭后槽位只释放一次，下一项按稳定顺序提升。
- 有显式 reply/thread 标识的回复精确关联 conversation。
- 无显式标识且只有一个活动会话时可关联；多候选时不自动推进任何任务。

### 15.4 前端测试

- loading、empty、error、stale 和 degraded health。
- 新任务 202 响应后显示 queued。
- SSE 更新后详情重新请求。
- revision 冲突后保留用户输入。
- 审批的消息、日程、澄清和范围变更分别提交正确 payload。
- pending 命令期间按钮禁用，刷新后仍能恢复状态。
- dry-run 页面不会显示“消息已发送”。
- Overview 将“当前”和“待执行”拆成独立区域，待执行项展示队列原因和位置。
- 时间线按过去到现在排列；仅 running 状态显示流动箭头，其余状态静止。

### 15.5 端到端验收

至少跑通以下真实流程。

1. 在 dry-run 模式从页面创建任务，Agent 拆解并生成外发 action。
2. 启用 live 前人工检查 action，再验证一次真实用户消息。
3. 收到同事回复后，tick 更新 subtask，页面自动显示新活动。
4. 触发 scope extension 审批，页面选择处理方式，Agent 正确继续。
5. 模拟 CLI timeout，页面显示待核实，恢复后没有重复发送。
6. 同时从页面和宿主 Agent 修改任务，revision 和锁阻止覆盖。
7. 创建两个间隔联系同一人的任务，验证后一项先显示待执行，前一会话结束后自动进入当前。
8. 分别验证带 reply/thread 标识、唯一活动会话和多候选三种回复归属路径，多候选不得串到错误任务。

## 16. 第一版明确不做的内容

- 浏览器直接调用 `welink-cli`。
- 浏览器读取 `runtime/` 文件。
- 远程多用户访问。
- 在页面切换 dry-run 和 live。
- 未经审批的任意收件人和任意群发送。
- 上传文件后只保存文件名。
- 把 raw CLI 输出当成活动时间线。
- 为了填满 UI 而伪造成本、token、产物、已读状态或预计完成时间。

## 17. 对接完成后的判断标准

前后端完成对接后，页面上的每一句状态都能回到一个 runtime 字段、日志事件或明确的推导规则。用户提交的每一次操作都会先产生可恢复的持久化记录。外部消息的“已批准”“已执行”和“结果待核实”保持为三个不同状态。

如果 Agent loop 没有运行、CLI 认证失效、action 结果不确定或数据发生并发冲突，页面会把真实情况说清楚，也会保留用户已经提交的命令。做到这些以后，Web 控制台才真正成为 runtime 的控制面，而不只是套在 mock 数据外面的界面。
