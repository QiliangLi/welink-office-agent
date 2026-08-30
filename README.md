# WeLink Office Agent — MVP

这是一个面向少量可信同事和群组的可移植办公 Skill。当前仓库目录本身就是完整 Skill 包：根目录 `SKILL.md` 提供跨 Agent 入口，`scripts/` 提供确定性 runtime/CLI，`references/` 提供按需加载的命令和状态说明，并附带桌面优先的 Web 控制台。

## 当前实现范围

已实现：

- 可直接安装的根目录 `SKILL.md`；
- 独立的 runtime/CLI；
- JSON 配置与任务快照（快照带 `revision`，跨进程文件锁保护并发写入）；
- JSONL 消息和事件日志（带单调 `sequence`，供时间线与 SSE 排序）；
- 主任务、子任务、动态事项、审批、外部动作状态；
- 发送消息前落盘及中断恢复信息；
- 持久化命令队列（`runtime/commands/`）：控制台写入先落盘，再由 `tick` 消费；
- 联系人沟通槽：同一联系人默认只有一个活动私聊会话，其余子任务排队（`waiting_kind=contact_slot`）；
- 会话记录与回复归属（`runtime/conversations/`）：优先 reply/thread 标识，其次唯一活动会话，多候选保持未归属；
- 用户/群消息统一追加 Agent 标记；
- WeLink CLI 查询与发送包装器；
- `status`、`resume`、`tick` 和主任务收口检查；
- 本机 Console API（`server/`，默认 `127.0.0.1:4174`）：只读 DTO、创建任务、暂停/继续/取消、审批决定、催办、SSE 实时通知；
- 桌面 Web 控制台接入真实 API（`VITE_DATA_SOURCE=mock` 可切回演示数据）；
- 默认 dry-run。

尚未实现：附件上传（页面隐藏入口）、产物下载、多用户/远程访问。控制台不能直接调用 `welink-cli`，也不能读取 `runtime/` 文件。

当前 IM 查询结果仍由宿主 Agent 解析，因为已提供的 WeLink CLI 文档没有说明 IM 模块存在统一 JSON 输出。原始 CLI 输出会保存到 `runtime/raw/`。

## 环境

- Node.js 18 或更高版本；
- 已安装并登录 `welink-cli`；
- 支持目录式 Skills、能够读取 `SKILL.md` 并执行本地命令的 Agent；
- Skill 运行时能够访问本目录中的配置和 runtime 数据。

根目录 runtime/CLI/Console API 没有第三方 npm 依赖，不需要执行 `npm install`。开发 Web 控制台时需在 `web-console/` 中安装其前端依赖。

核心 CLI 位于 `scripts/agent.mjs`，Console API 位于 `server/index.mjs`。完整目录职责和文档同步规则见 `AGENTS.md`。

## 安装为 Skill

把整个 `welink-office-agent/` 目录复制或链接到目标 Agent 的 Skills 目录，目标结构应保持如下形态：

```text
<agent-skills>/welink-office-agent/
├── SKILL.md
├── scripts/
├── references/
├── config/
└── runtime/
```

不同 Agent 的 Skills 目录和调用语法不同，请以目标 Agent 的安装说明为准。不要只复制 `SKILL.md`，也不要在本仓库内部再创建 `.claude/skills/` 或 `.codex/skills/` 套壳。

## 初始化

```bash
cd welink-office-agent
npm run init
```

随后编辑：

```text
config/owner.json
config/contacts.json
config/groups.json
config/routing.json
config/auto-reply.json
config/policies.json
```

至少替换：

- 你的工号；
- 控制群号；
- 可信同事的工号和 `w3account`；
- 事项路由。

首次测试保留：

```json
"dry_run": true
```

检查认证：

```bash
npm run preflight
```

## 使用

下文用 `$welink-office-agent` 表示“调用目标 Agent 中的 welink-office-agent Skill”。如果目标 Agent 使用斜杠命令或其他语法，请替换为对应形式。

### 创建任务示例

```text
$welink-office-agent 帮我确认性能测试和跨域网络方案的最新进展。性能测试找配置中的负责人，收集当前状态、阻塞问题和预计完成时间；跨域网络收集当前方案、验证结果和下一步计划。沟通过程中出现简单的必要询问可以自行完成，较大的新增工作先在控制群问我。收齐后统一汇总。
```

Skill 会：

1. 创建主任务和子任务；
2. 根据 `routing.json` 解析工号；
3. 生成并发送消息（dry-run 时只记录，不真正发送）；
4. 在控制群报告任务已创建；
5. 保存任务、动作和日志。

### 执行一次轮询

```text
$welink-office-agent tick
```

每次只处理一个有边界的 Tick：先恢复状态，再消费 Web 控制台落盘的命令队列（任务规划、追加指令、催办、审批后续），输出需要推理的分配项，最后查询新消息、更新任务、创建动态事项、发送到期追问并输出变化。`tick` 会返回 `assignments`（需要宿主 Agent 推理的工作）、`executed`（确定性命令的执行结果）和 `due_followups`；宿主 Agent 完成推理后用 `complete-command` 回写命令结果。如果目标 Agent 支持定时或循环任务，可以按它的原生方式定期调用 `tick`。

### 查看状态

```text
$welink-office-agent status
```

或：

```text
$welink-office-agent status TASK-20260715-ABC123
```

### 重新启动后恢复

```text
$welink-office-agent resume
```

恢复完成后继续按目标 Agent 的原生循环或定时机制调用 `tick`。

## Web 控制台与 Console API

Web 控制台通过本机 Console API（`server/`）读写 runtime，不直接访问文件或 `welink-cli`。API 只监听 `127.0.0.1`，写请求需要 Origin 校验和 CSRF token，外部发送仍走共享 wrapper。

开发模式（两个进程）：

```bash
node server/index.mjs          # Console API，http://127.0.0.1:4174
cd web-console && npm run dev  # Vite，http://127.0.0.1:4173，/api 代理到 4174
```

生产式本地运行（同源）：

```bash
cd web-console && npm run build
node server/index.mjs          # 同时托管 web-console/dist/
```

常用参数：`--host 127.0.0.1 --port 4174 --no-static`。

页面默认读取真实 API；设置 `VITE_DATA_SOURCE=mock` 可切换到内置演示数据（用于离线开发与视觉验证）。顶栏会显示 Agent 健康状态、命令积压和 dry-run 标识；Agent 未运行时任务保持"待执行"，页面会如实显示等待原因，不会假装已开始联系同事。

## 从 dry-run 切换到真实发送

先检查 `runtime/actions/` 和 `runtime/logs/messages.jsonl` 中生成的消息，确认联系人、群号、称呼和文案都正确。然后修改：

```json
"dry_run": false
```

发送命令会调用：

```text
welink-cli im send-to-user
welink-cli im send-to-group
```

所有 Agent 消息尾部都会追加：

```text
—— 此条消息来自 WeLink CLI Agent
[WELINK_AGENT_MESSAGE task=...]
```

## 控制群约定

控制群同时承担通知、确认、任务进度和人工指令。建议使用：

```text
状态
状态 TASK-ID
待确认
同意 AP-ID
拒绝 AP-ID
退回 AP-ID
暂停 TASK-ID
继续 TASK-ID
取消 TASK-ID
```

在正式依赖控制群通知前，请验证：

1. CLI 发到该群的消息是否会在客户端提醒你；
2. 你手动发送的群消息是否能被 `query-history-message` 查询到；
3. 群历史输出是否包含稳定的消息 ID 和时间字段。

## 测试

```bash
npm test
```
