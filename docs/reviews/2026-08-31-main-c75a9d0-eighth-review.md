Branch: `main`

Review range: `c2e17a5a54942b7eaafab87700c4ae53c2384c77..c75a9d037a0877bfa9c240ad5178cedd554e5115`

Reviewed at: `2026-08-31T10:34:15+08:00`

Verdict: `approve`

# 阶段一至四第八轮复审

## 结论

提交 `c75a9d037a0877bfa9c240ad5178cedd554e5115` 已关闭 X-01，未发现新的有修复价值的正式 finding。

终态任务的外发落成 `unknown` 时，`executeSend()` 现在明确不释放原 conversation；任务 B 继续停留在联系人槽队列，直到宿主完成结果核实并显式关闭 A 的 conversation 后才被晋升。成功、dry-run 和已知失败仍沿用既有安全收口路径，不会让终态任务的 subtask 复活为 `waiting_reply`。实现、runtime schema 和集成文档在这一点上保持一致。

因此 U-01、V-01、W-01、X-01 所覆盖的联系人槽生命周期问题均可关闭，本轮结论为 `approve`。

## X-01 关闭证据

| 场景 | 结果 |
| --- | --- |
| A executing 时取消，随后 timeout/unknown | A 的 conversation 保持 active，不晋升 B。 |
| unknown 未核实期间 B 再次尝试发送 | 返回 queued，不创建 B 的外发 action。 |
| 宿主核实后显式关闭 A conversation | A 只释放一次，B 按队列顺序晋升并取得唯一 active conversation。 |
| A 在发送期间已进入终态 | A subtask 不会被改回 `waiting_reply`。 |
| A 得到 succeeded/dry_run/failed 的已知结果 | 仍在安全收口点释放，不产生永久占槽回退。 |

关键实现证据：

- `scripts/lib/send-service.mjs`：终态 post-send 释放条件显式排除 `finalAction.status === 'unknown'`。
- `test/runtime-integration.test.mjs`：使用真实 wrapper 和可控短 timeout 覆盖 unknown 保留、B 继续排队、显式关闭后晋升的完整路径。
- `references/runtime-schema.md`：明确只有 known outcome 才在发送收口路径释放，unknown 由 recovery 流程显式关闭。

## 正式 Findings

无。

## 非阻断观察

- 为可控超时测试新增了可选 `policies.send_timeout_ms`，默认缺省时仍为历史值 60 秒，当前行为安全且不影响既有部署。该字段尚未写入 `config/policies.example.json` 或用户配置说明；如果它准备作为正式部署选项，应在后续文档维护中补充示例、单位和建议下限。若它只用于测试，后续可改成测试依赖注入，避免形成隐式公共配置。此项不影响 X-01 正确性，不作为本轮 finding。

## 验证记录

- 根目录 `npm test`：连续两次 60/60 通过。
- `web-console npm run test`：30/30 通过。
- `web-console npm run lint`：通过。
- `web-console npm run build`：通过。
- Skill validator：通过（`Skill is valid!`）。
- `node scripts/agent.mjs help`：通过。
- `node server/index.mjs --help`：通过。
- `git diff --check c2e17a5..c75a9d0`：通过。
- 默认 timeout 分支检查：`send_timeout_ms` 缺失或无效时仍使用 60,000 ms。
- 本提交没有 `web-console/` 视觉改动，因此未进行路由视觉检查。
- 评审开始时分支为 `main`，HEAD 与远端 `origin/main` 均为 `c75a9d0`，工作区干净；本评审只新增本文件，没有修改实现。

## 最终判定

X-01 已关闭，本轮无阻断问题，可以按当前实现继续进入真实 `welink-cli` 环境的端到端验收。
