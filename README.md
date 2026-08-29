# WeLink Office Agent Skill — MVP

这是一个面向少量可信同事和群组的 Claude Code Skill。它使用工号作为用户唯一标识、群组号作为群唯一标识，通过 `welink-cli` 完成主动询问、追问、动态子任务、控制群确认、进度汇总、完整日志和断点恢复。

## 当前实现范围

已实现：

- Claude Code 项目级 Skill；
- JSON 配置与任务快照；
- JSONL 消息和事件日志；
- 主任务、子任务、动态事项、审批、外部动作状态；
- 发送消息前落盘及中断恢复信息；
- 用户/群消息统一追加 Agent 标记；
- WeLink CLI 查询与发送包装器；
- `status`、`resume` 和主任务收口检查；
- 默认 dry-run。

当前 IM 查询结果仍由 Claude 解析，因为已提供的 WeLink CLI 文档没有说明 IM 模块存在统一 JSON 输出。原始 CLI 输出会保存到 `runtime/raw/`。

## 环境

- Node.js 18 或更高版本；
- 已安装并登录 `welink-cli`；
- Claude Code；
- 从本项目根目录启动 Claude Code。

本项目没有第三方 npm 依赖，不需要执行 `npm install`。

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

## 在 Claude Code 中使用

从项目根目录启动：

```bash
claude
```

Claude Code 会发现 `.claude/skills/welink-office-agent/SKILL.md`。可通过 `/skills` 或 `/welink-office-agent` 查看/调用。项目 Skill 的目录名就是默认斜杠命令名。

### 创建任务示例

```text
/welink-office-agent 帮我确认性能测试和跨域网络方案的最新进展。性能测试找配置中的负责人，收集当前状态、阻塞问题和预计完成时间；跨域网络收集当前方案、验证结果和下一步计划。沟通过程中出现简单的必要询问可以自行完成，较大的新增工作先在控制群问我。收齐后统一汇总。
```

Skill 会：

1. 创建主任务和子任务；
2. 根据 `routing.json` 解析工号；
3. 生成并发送消息（dry-run 时只记录，不真正发送）；
4. 在控制群报告任务已创建；
5. 保存任务、动作和日志。

### 执行一次轮询

```text
/welink-office-agent tick
```

### 使用 Claude Code loop

```text
/loop 2m /welink-office-agent tick
```

每次只处理一个有边界的 Tick：恢复状态、查询新消息、更新任务、创建动态事项、发送到期追问和输出变化。

### 查看状态

```text
/welink-office-agent status
```

或：

```text
/welink-office-agent status TASK-20260715-ABC123
```

### 重新启动后恢复

重新进入项目并启动 Claude Code：

```text
/welink-office-agent resume
```

之后继续：

```text
/loop 2m /welink-office-agent tick
```

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
