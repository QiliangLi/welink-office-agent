# WeLink Office Agent 端到端验收手册

> **文档用途**：本文是阶段一至四的验收执行手册与验收记录表。它描述当前进度快照、验收前置条件、8 个验收场景的分步操作与通过标准，以及验收通过后的收尾动作。进度的事实来源是 `docs/frontend-backend-integration.md` 的状态横幅与 `docs/reviews/` 的评审记录；本文负责把它们落成可执行的验收步骤，并在验收完成后回写状态。

## 1. 当前进度快照（2026-08-31）

- 阶段一至四已实现：只读 DTO、revision/文件锁/持久化命令队列、tick 消费/联系人沟通槽/回复归属、SSE 与断线恢复；
- 八轮评审全部关闭（F-01~F-07、R-01~R-04、T-01~T-06、U-01、V-01、W-01、X-01），第八轮（`docs/reviews/2026-08-31-main-c75a9d0-eighth-review.md`）verdict 为 approve；
- 自动化门禁：根目录 `npm test` 60/60，web-console 30/30 + lint + build；
- **未完成**：真实 `welink-cli` 环境的端到端验收（即本文）、阶段五（附件与产物）；live 模式尚未开启。

## 2. 前置条件

1. Node.js ≥ 18；`welink-cli` 已安装、已登录，`npm run preflight` 通过。
2. `config/*.json` 已按 README 配置完成，其中本验收特别需要：
   - owner 工号与控制群 ID（真实群，便于观察通知）；
   - **至少两名**可自动联系的同事（`auto_contact: true`，含真实 `w3account`）；
   - 其中一名同事会出现在多个场景中（同联系人排队场景依赖“同一联系人”）；
   - 一个 `trusted` 的项目群（周报发送场景）。
3. `policies.json` 保持 `dry_run: true` 起步；`send_timeout_ms` 可暂不配置（默认 60000）。
4. 控制台可用：`node server/index.mjs`（127.0.0.1:4174，需先 `cd web-console && npm run build` 托管页面）或 `cd web-console && npm run dev`（4173，/api 代理）。顶栏应显示 “Agent 正常” 和 dry-run 标识。
5. 宿主 Agent 按 `SKILL.md` 方式可执行（`tick`、`resume`、`add-subtask` 等命令由宿主 Agent 调用）。
6. 基线确认：`npm test` 全绿、`node scripts/agent.mjs help` 正常。

## 3. 验收场景（对应集成设计 §15.5）

> 约定：宿主 Agent 的推理/执行步骤写为“让宿主 Agent …”；控制台操作写为“控制台 …”。每个场景完成后在 §5 记录表打勾并写日期。

### 场景 1：dry-run 创建任务，Agent 拆解并生成外发

**步骤**
1. 控制台“新建任务”创建一个需要联系同事的任务（例如“向张三确认性能测试进展”）。
2. 让宿主 Agent 执行 `tick`；根据返回的 `plan_task` assignment 完成拆解（`add-subtask`）并发送（`send-user`、`send-group` 控制群）。
3. 观察 `runtime/tasks/<ID>.json`、`runtime/actions/`、`runtime/logs/messages.jsonl`。

**通过标准**
- [ ] 任务快照从 `queued` 变为 `running`，subtask 正确生成；
- [ ] action 状态为 `dry_run`，messages.jsonl 有带 marker 的 outbound 记录，未真实发送（同事确认未收到）；
- [ ] 控制台任务详情显示执行中/等待回复，顶栏 dry-run 标识可见；成功页在创建时显示“待执行”。

### 场景 2：人工检查后切 live，验证真实用户消息

**步骤**
1. 逐条检查场景 1 产生的 `runtime/actions/*.json` 内容与 `messages.jsonl` 文案（称呼、联系人、marker）。
2. 把 `policies.json` 的 `dry_run` 改为 `false`（改前可让宿主 Agent 先 `resume` 确认无未收口动作）。
3. 重新创建一个同类任务并让宿主 Agent 发送；向同事确认收到。
4. 完成后观察 action 与会话状态。

**通过标准**
- [ ] action 状态为 `succeeded`（非 dry_run），同事实际收到消息；
- [ ] 子任务进入 `waiting_reply`，会话记录 `runtime/conversations/` 为 active 并带 `correlation_id`；
- [ ] 没有出现重复发送（同一 subtask 只有一条 outbound）。

### 场景 3：收到同事回复后自动更新

**步骤**
1. 场景 2 的同事回复消息。
2. 让宿主 Agent 执行 `tick`（内含 `record-message` 与归属）。
3. 不刷新页面的情况下观察控制台任务详情。

**通过标准**
- [ ] `messages.jsonl` 该回复 `attribution_status` 为 `attributed` 且 `task_id`/`subtask_id` 正确；
- [ ] subtask 离开 `waiting_reply`（信息收集完成或按回复推进）；
- [ ] 控制台时间线经 SSE 自动出现“收到回复”条目，无需手动刷新。

### 场景 4：scope extension 审批

**步骤**
1. 让同事在回复中提出一个超出当前范围的新事项（例如“顺便组织一次评审”）。
2. 宿主 Agent `tick`：`add-item` 落盘后按动态事项策略创建 `owner_approval`（`create-approval`，`proposed_action` 为 `scope_change`）。
3. 控制台“待我处理”处理该卡片，选择一种处理方式（如“纳入当前任务”）。
4. 让宿主 Agent 再执行一轮 `tick` 消费 `approval.apply` assignment。

**通过标准**
- [ ] approval 快照的 `decision_payload` 准确记录所选选项（不只 status）；
- [ ] 控制台区分“已记录决定”与“已执行”：外部动作成功前不显示“已执行”；
- [ ] Agent 按选择正确继续（纳入则生成动态子任务并联系相应同事）。

### 场景 5：模拟 CLI 超时，不重复发送

**步骤**
1. `policies.json` 设 `"send_timeout_ms": 3000`（验收后改回），并让 `welink-cli` 对下一次发送挂起超过该时长（例如断网，或临时在 PATH 放置一个 sleep 的替身脚本）。
2. 创建任务并发送；在 CLI 挂起期间从控制台取消该任务。
3. 等待 wrapper 超时，观察 action 与会话；让宿主 Agent 按 recovery 流程查询会话历史核实是否已送达。
4. 核实后用 `close-conversation` 显式关闭；如确认未送达，再手动安排重发。

**通过标准**
- [ ] action 落为 `unknown`（不是 failed）；被取消任务的 subtask 未被写回 `waiting_reply`；
- [ ] unknown 期间该联系人会话保持占用：同联系人的下一个任务停在 `queued`，不会被晋升；
- [ ] 显式 `close-conversation` 后下一任务才晋升；全程没有自动重发。

### 场景 6：页面与宿主 Agent 并发修改

**步骤**
1. 选一个执行中的任务：在控制台点“暂停”的同时让宿主 Agent 执行一轮 `tick` 推进子任务；再各做一次“追加指令/更新摘要”。
2. 观察两个来源的字段是否都保留；用两个浏览器窗口同时提交同一任务的不同命令，观察后者的错误提示。

**通过标准**
- [ ] 两边的变更都落盘（instructions 与 subtask 状态并存），没有字段被覆盖；
- [ ] revision 冲突时控制台提示“任务已被其他操作更新，请刷新”，用户输入不丢失。

### 场景 7：同一联系人双任务排队与晋升

**步骤**
1. 任务 A 联系同事甲并处于 `waiting_reply`（真实等待回复）。
2. 创建任务 B 联系同一同事甲；控制台创建或宿主 Agent `send-user` 均可。
3. 观察 B 的状态；让同事甲回复 A 后，宿主 Agent 处理 A 的回复并用 `close-conversation` 结束 A 的会话。

**通过标准**
- [ ] B 显示为“待执行”，`waiting_kind=contact_slot`，带 `queuePosition` 与 `blockedByTaskId=A`；B 未发出任何消息；
- [ ] A 的会话关闭后 B 自动晋升为该联系人唯一 active 会话并开始发送；
- [ ] 全程同一联系人至多一个活动会话，总览页“当前任务”与“待执行队列”正确反映两个阶段。

### 场景 8：回复归属三路径

**步骤**
1. 显式标识路径：同事对 A 的消息直接引用回复（WeLink 带 reply 标识），即使 A 的会话已关闭而 B 正持有槽位。
2. 唯一活动会话路径：同一联系人只有一个 active 会话且回复不带引用。
3. 多候选路径：人为制造同联系人两个 active 会话（可用两台设备或让宿主在旧快照下对同一联系人连发两个不同任务的会话——正常流程不应出现；如无法安全构造，改为验证 `attributeReply` 的单元测试并记录跳过原因）。
4. 每条回复让宿主 Agent `record-message` 并观察归属结果。

**通过标准**
- [ ] 路径 1：回复归属到原任务（即使其会话已 closed），`attribution_status=attributed`；
- [ ] 路径 2：回复归属到唯一活动会话对应任务；
- [ ] 路径 3：结果为 `unresolved_multiple`，不推进任何任务，等待人工判断。

## 4. 记录与收尾

| 场景 | 结果 | 日期 | 执行人 | 备注 |
| --- | --- | --- | --- | --- |
| 1 dry-run 创建拆解 | ☐ 通过 ☐ 失败 | | | |
| 2 切 live 真实发送 | ☐ 通过 ☐ 失败 | | | |
| 3 回复自动更新 | ☐ 通过 ☐ 失败 | | | |
| 4 scope extension 审批 | ☐ 通过 ☐ 失败 | | | |
| 5 CLI 超时不重复发送 | ☐ 通过 ☐ 失败 | | | |
| 6 并发修改 | ☐ 通过 ☐ 失败 | | | |
| 7 同联系人排队晋升 | ☐ 通过 ☐ 失败 | | | |
| 8 回复归属三路径 | ☐ 通过 ☐ 失败 | | | |

全部通过后：
1. 在本表填写环境信息（welink-cli 版本、日期、涉及同事/群）；
2. 把 `docs/frontend-backend-integration.md` 状态横幅更新为“端到端验收已通过（日期）”，此后方可保持 `dry_run: false` 作为常态；
3. 场景 5 的 `send_timeout_ms` 临时值改回（或删除字段用默认 60000）。

某个场景失败时：记录失败步骤、相关 `runtime/` 证据（tasks/actions/conversations 快照与 JSONL 片段），修复后只需重跑失败场景及其关联场景。

## 5. 与自动化测试的边界

并发锁、幂等重放、命令状态机、回复归属规则、槽位生命周期等正确性已由根目录自动化测试覆盖（`npm test`，60 项）。必须真实环境验证的是自动化无法覆盖的部分：真实 CLI 认证与网络、消息真实到达与已读、WeLink reply 标识的真实形态、以及控制台在真实延迟下的体验。不要因为自动化全绿而跳过本文验收，也不要在未通过 §15.5 场景 5（超时不重复发送）前长期开启 live。
