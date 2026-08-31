import { Check, RefreshCw, ShieldCheck, UserRound, X } from "lucide-react";
import { formatDateTime, relativeTime } from "../lib/task-utils";
import { useQuery } from "../queries/core";
import { queryKeys } from "../queries/keys";
import { useAppData } from "../state/AppDataContext";
import type { HealthDto } from "../types/domain";

/**
 * Read-only runtime status page (docs/sidebar-pages-design.md §7): who the
 * owner is, how the console is running and which capabilities are enabled.
 * Nothing here writes configuration; editable settings need their own
 * backend contract first.
 */

const AGENT_STATE_LABELS: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting: "等待中",
};

const CAPABILITY_ITEMS = [
  { key: "attachments", label: "附件上传", onLabel: "已开启", offLabel: "未接入" },
  { key: "artifacts", label: "产物浏览与下载", onLabel: "已开启", offLabel: "未接入" },
  { key: "liveSend", label: "真实消息发送", onLabel: "已开启", offLabel: "未开启" },
  { key: "sse", label: "实时推送（SSE）", onLabel: "已开启", offLabel: "不可用" },
] as const;

/** Masked for display only; the API keeps the full employee number. */
function maskEmployeeNumber(value: string | null) {
  if (!value) return "未配置";
  return value.length <= 4 ? value : `••••${value.slice(-4)}`;
}

function CardNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <p className="settings-card-error" role="alert">
      <span>{message}</span>
      <button className="button button-secondary" onClick={onRetry}>重试</button>
    </p>
  );
}

export function SettingsPage() {
  const { client } = useAppData();
  const healthQuery = useQuery(queryKeys.health(), () => client.getHealth());
  const sessionQuery = useQuery(queryKeys.session(), () => client.getSession());
  const health = healthQuery.data;
  const session = sessionQuery.data;

  const refreshStatus = () => {
    healthQuery.refetch();
    sessionQuery.refetch();
  };

  return (
    <div className="page settings-page">
      <div className="page-heading">
        <div>
          <h1>设置</h1>
          <p>查看当前用户、运行模式、健康状态和能力开关。</p>
        </div>
        <button className="button button-secondary" onClick={refreshStatus} disabled={healthQuery.loading || sessionQuery.loading}>
          <RefreshCw aria-hidden="true" />刷新状态
        </button>
      </div>

      <div className="settings-grid">
        <section className="panel settings-user-panel">
          <header className="panel-header"><div><UserRound /><h2>当前用户</h2></div></header>
          {session ? (
            <div className="settings-user">
              <span className="avatar" aria-hidden="true">{session.owner.initials}</span>
              <dl className="settings-dl">
                <div><dt>姓名</dt><dd>{session.owner.name}</dd></div>
                <div><dt>员工号</dt><dd>{maskEmployeeNumber(session.owner.employeeNumber)}</dd></div>
                <div><dt>时区</dt><dd>{session.timezone}</dd></div>
              </dl>
            </div>
          ) : sessionQuery.error ? (
            <CardNotice message={`无法读取用户信息：${sessionQuery.error.message}`} onRetry={sessionQuery.refetch} />
          ) : (
            <div className="skeleton-panel" style={{ height: 140 }} aria-busy="true" aria-label="正在读取用户信息" />
          )}
        </section>

        <section className="panel settings-runtime-panel">
          <header className="panel-header"><div><ShieldCheck /><h2>运行状态</h2></div></header>
          {health ? (
            <>
              <dl className="settings-dl">
                <div>
                  <dt>Agent 状态</dt>
                  <dd>{AGENT_STATE_LABELS[health.agent.state] ?? health.agent.state}{health.agent.stale ? "（数据已过期）" : ""}</dd>
                </div>
                <div>
                  <dt>最近一次成功 tick</dt>
                  <dd>{health.agent.lastSuccessfulTick ? `${formatDateTime(health.agent.lastSuccessfulTick)} · ${relativeTime(health.agent.lastSuccessfulTick)}` : "尚未记录"}</dd>
                </div>
                <div><dt>命令积压</dt><dd>{health.agent.queuedCommands} 个</dd></div>
                <div><dt>待核实外部动作</dt><dd>{health.agent.uncertainActions} 个</dd></div>
                <div>
                  <dt>运行模式</dt>
                  <dd className={health.mode === "dry_run" ? "warning-text" : "text-success"}>
                    {health.mode === "dry_run" ? "Dry-run（预演）" : "Live（真实发送）"}
                  </dd>
                </div>
                <div><dt>实时推送（SSE）</dt><dd>{health.capabilities.sse ? "可用" : "不可用"}</dd></div>
              </dl>
              {health.mode === "dry_run" ? (
                <p className="mode-note">当前为 dry-run 预演模式：外发消息不会真实发送，只会生成发送预览并记录。切换到 live 需要在服务端配置中修改。</p>
              ) : (
                <p className="mode-note mode-note-live">后端当前运行在 live 模式，经过审批的外发消息会真实发送。页面不提供模式切换。</p>
              )}
            </>
          ) : healthQuery.error ? (
            <CardNotice message={`无法读取运行状态：${healthQuery.error.message}`} onRetry={healthQuery.refetch} />
          ) : (
            <div className="skeleton-panel" style={{ height: 220 }} aria-busy="true" aria-label="正在读取运行状态" />
          )}
        </section>

        <section className="panel settings-capability-panel">
          <header className="panel-header"><div><ShieldCheck /><h2>能力</h2></div></header>
          {health ? (
            <div className="capability-list">
              {CAPABILITY_ITEMS.map(({ key, label, onLabel, offLabel }) => {
                const enabled = health.capabilities[key as keyof HealthDto["capabilities"]];
                return (
                  <div className="capability-item" key={key}>
                    {enabled
                      ? <Check className="capability-on" aria-hidden="true" />
                      : <X className="capability-off" aria-hidden="true" />}
                    <div>
                      <strong>{label}</strong>
                      <small>{enabled ? onLabel : offLabel}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : healthQuery.error ? (
            <CardNotice message={`无法读取能力开关：${healthQuery.error.message}`} onRetry={healthQuery.refetch} />
          ) : (
            <div className="skeleton-panel" style={{ height: 120 }} aria-busy="true" aria-label="正在读取能力开关" />
          )}
        </section>
      </div>
    </div>
  );
}
