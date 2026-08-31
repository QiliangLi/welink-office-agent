Branch: main
Review range: d89f5305ff849bba447a740ac0cbbf1f60692c23..8e15e16e2a3d3ec10c51a3ef3d0f98df64c5146d
Reviewed at: 2026-09-01T01:39:41+08:00
Verdict: request changes

# 最近两次提交 Review

## 范围

本次评审覆盖以下两个提交：

- `650abd3 feat(console): add activity, artifacts and settings sidebar pages`
- `8e15e16 feat(console): contacts management, Windows fixes and shell layout repair`

评审目标是确认新增侧栏页面、跨任务动态接口、联系人配置写入、SSE 修复、Windows wrapper 调整和 shell 布局修复满足仓库的运行时、安全、前后端契约、文档同步与质量门禁要求。

## 结论

当前实现需要修改后再合入。自动化测试和构建全部通过，但隔离复现与实际浏览器检查确认 2 项高优先级问题和 4 项中优先级问题仍然存在，其中包括 SSE 实时流实际不可用，以及配置解析失败时可能覆盖联系人配置的数据丢失风险。

## 正式 Findings

### [P1] raw response 处理完成后仍进入 JSON 响应路径，SSE 在 `hello` 后立即断开

- 证据：`server/app.mjs:102-115` 对 `rawResponse` 只跳过 no-reply 分支，随后仍无条件访问 `captured.status` 并调用 `sendJson`。SSE handler 不调用 `reply()`，因此 `captured` 保持 `null`。
- 触发：浏览器请求 `GET /api/v1/events/stream`。服务端写出首个 `hello` 事件，handler 返回后触发 `TypeError: Cannot read properties of null (reading 'status')`，catch 分支因 headers 已发送而结束响应。
- 复现：隔离 HTTP 复现中第一次 `reader.read()` 得到 `event: hello`，第二次读取立即返回 `done: true`。现有测试只读取首个 `hello` 并确认其他 HTTP 请求仍可用，没有验证 SSE 连接继续保持。
- 影响：实时更新完全失效，`EventSource` 会持续重连；任务、审批、消息和全局动态不能依赖 SSE 自动刷新。
- 修复：raw response handler 返回后直接结束 router 的 JSON pipeline；测试应等待后续 heartbeat 或事件，并断言连接在首个 `hello` 后没有 EOF。

### [P1] `mutateConfig` 把所有配置读取错误当成空配置，下一次联系人写入可能覆盖原文件

- 证据：`scripts/lib/store.mjs:78-82` 使用 `this.loadConfig(name).catch(() => ({}))`，无法区分文件不存在、JSON 损坏、权限错误和其他 I/O 异常。
- 触发：用户手工维护的 `config/contacts.json` 出现尾逗号、半写入内容或其他 JSON 解析错误，随后在设置页新增、编辑或移除联系人。
- 复现：让 `loadConfig()` 抛出 `SyntaxError` 后调用 `mutateConfig()`，mutator 收到空对象并写出只包含本次新增联系人的配置。
- 影响：现有联系人以及未暴露给浏览器的 `w3account`、`expertise` 等字段可能整体丢失。该问题触发频率不高，但影响属于本地配置数据丢失。
- 修复：只在明确的 `ENOENT` 情况下初始化空配置；解析错误或其他读取失败必须中止写入并返回安全错误。增加 malformed config 不得覆盖原文件的回归测试。

### [P2] 离线/降级横幅没有计入 sidebar 和移动端抽屉的高度与偏移

- 证据：`web-console/src/styles.css:125-135` 增加了横幅网格行，但 `:266-275` 的 sidebar 高度仍是 `100dvh - topbar`，`:314-315` 的页面最小高度也只减 topbar；`:628-633` 的移动端 sidebar 和 scrim 仍固定从 `var(--topbar-h)` 开始。
- 触发：Console API 不可用或 health 为 degraded，页面显示顶部横幅。
- 浏览器证据：1440×900 下横幅高度为 40.5px，但 shell/sidebar 底部到 940.5px，产生额外页面滚动并在首屏裁掉 sidebar 底部；414×896 下横幅高度为 60px、topbar 位于 60-124px，而 sidebar/scrim 从 64px 开始，直接覆盖顶栏。
- 影响：本提交宣称修复的 shell/侧栏布局在最需要横幅的离线路径仍然失效，移动端抽屉遮挡导航顶栏，桌面端侧栏内容需要额外滚动才能完整看到。
- 修复：让第三个 grid row 决定 sidebar/main 的可用高度，或统一维护 banner + topbar 的动态偏移；移动端 fixed sidebar 与 scrim 使用同一偏移。增加带离线横幅的桌面和移动端布局回归检查。

### [P2] Activity 时间筛选用字符串比较，合法的带时区 ISO 8601 边界会漏数据

- 证据：`server/routes/activity.mjs:20-29` 使用 `Date.parse` 接受时间后仍以原始字符串比较 from/to；`server/services/activity-read-service.mjs:39-41` 直接对 `occurredAt` 和筛选参数做字典序比较。
- 触发：客户端传入带时区偏移的合法 ISO 8601 值，或者使用与 runtime `Z` 时间不同的合法精度/格式。
- 复现：筛选边界 `2026-09-01T08:00:00+08:00` 等价于 `2026-09-01T00:00:00Z`，但发生于 `2026-09-01T00:30:00.000Z` 的记录被错误排除，结果 total 为 0。
- 影响：时间筛选返回错误结果，from/to 的先后校验也可能错误拒绝或接受时间窗口。
- 修复：route 中把边界解析成数值时间并验证先后，service 使用数值毫秒比较；增加不同时区表示同一时刻的测试。

### [P2] 联系人编辑无法清空可选的部门或地址字段

- 证据：设置页在清空部门后于 `web-console/src/pages/SettingsPage.tsx:104-109` 提交 `department: null`；`scripts/lib/contacts-service.mjs:54-61` 使用 `input.department ?? existing.department` 和 `input.address ?? existing.address`，把显式 `null` 当成未提交。
- 触发：编辑已有联系人，删除部门内容后保存。
- 复现：已有部门“市场部”的联系人提交 `department: null` 后，API DTO 与磁盘配置仍返回“市场部”，但页面显示“联系人已更新”。
- 影响：文档宣称支持编辑部门，但用户无法清空旧值，成功反馈与持久化结果不一致。
- 修复：使用 own-property 检查区分字段缺省与显式清空；API schema、前端类型和测试统一明确 `null` 的清除语义。

### [P2] `sidebar-pages-design.md` 同时声明联系人配置已开放和仍未开放

- 证据：`docs/sidebar-pages-design.md:188` 声明联系人配置管理已实现；`:213-226` 仍把“联系人白名单”列为暂不开放并写页面不能修改 `config/*.json`；`:362-369` 又声明第一阶段新增页面全部只读、不产生幂等写请求。
- 触发：维护者按该设计文档判断当前安全边界、可编辑配置范围或后续实现计划。
- 影响：文档作为前后端行为和安全边界契约时互相矛盾，可能导致后续实现误删联系人管理或绕过既有 API/锁/幂等约束。仓库文档同步规范明确把互相矛盾的规格视为阻断问题。
- 修复：把联系人增量并入正式设置章节，明确“浏览器不直接读写配置文件；Console API 仅允许在 mutation lock、CSRF、schema 和幂等层下修改 contacts”，并同步删除“所有新增页面均只读”的过期陈述。

## 验证记录

- 根目录 `npm test`：67/67 通过。
- `web-console npm run test`：41/41 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `git diff --check d89f5305ff849bba447a740ac0cbbf1f60692c23..8e15e16e2a3d3ec10c51a3ef3d0f98df64c5146d`：通过。
- SSE 隔离复现：首个 `hello` 后第二次读取立即 EOF，并记录 `captured.status` 的 `TypeError`。
- 联系人字段隔离复现：提交 `department: null` 后旧部门仍保留。
- 配置错误隔离复现：`loadConfig` 抛出 JSON 解析错误后，`mutateConfig` 仍以空对象生成替代配置。
- Activity 时区隔离复现：`+08:00` 边界错误排除实际晚 30 分钟的 `Z` 时间记录。
- 实际浏览器检查：1440px 动态页、1024px/414px 设置页，以及 1440px/414px 离线横幅布局；确认横幅触发时 shell 高度和移动端抽屉偏移错误。
- 评审与保存前分支均为 `main`，被评审工作区干净；保存动作只新增本 review 文件，没有修改实现。

## 最终判定

Verdict 为 `request changes`。SSE 立即断开与配置读取失败后的覆盖风险应作为合入前修复项；其余四项应在同一修复轮次关闭并补充相应测试与文档同步。
