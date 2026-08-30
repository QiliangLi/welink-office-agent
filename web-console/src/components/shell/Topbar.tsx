import { Bell, Bot, ChevronDown, Menu, Plus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "../../queries/core";
import { queryKeys } from "../../queries/keys";
import { useAppData } from "../../state/AppDataContext";

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { client, session, health, healthUnavailable, dataSource } = useAppData();
  const navigate = useNavigate();
  const approvalsQuery = useQuery(
    queryKeys.approvals("pending"),
    () => client.getApprovals({ status: ["pending"] }),
  );

  const pendingCount = approvalsQuery.data?.total ?? 0;
  const offline = dataSource === "api" && healthUnavailable;
  const degraded = !offline && (health?.status === "degraded" || health?.agent.stale);
  const dryRun = health ? health.mode === "dry_run" : dataSource === "mock";
  const backlog = health?.agent.queuedCommands ?? 0;

  const healthLabel = offline ? "服务不可用" : degraded ? "Agent 待恢复" : "Agent 正常";
  const healthClass = offline || degraded ? "agent-health agent-health-degraded" : "agent-health";

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <button className="icon-button menu-button" onClick={onMenu} aria-label="打开导航"><Menu /></button>
        <span className="brand-mark"><Bot aria-hidden="true" /></span>
        <strong>WeLink Office Agent</strong>
      </div>
      <div className="topbar-actions">
        <span className={healthClass} title={dryRun ? "当前为 dry-run 模式，消息不会真实发送" : undefined}>
          <i />
          {healthLabel}
          {dryRun && <em className="dry-run-chip">dry-run</em>}
          {backlog > 0 && <em className="backlog-chip">待处理 {backlog} 个命令</em>}
        </span>
        <Link className="button button-primary topbar-create" to="/tasks/new"><Plus />下发新任务</Link>
        <button
          className="icon-button"
          aria-label={`通知，${pendingCount} 个待处理`}
          onClick={() => navigate("/approvals")}
        >
          <Bell />
          {pendingCount > 0 && <span className="bell-badge" aria-hidden="true">{pendingCount}</span>}
        </button>
        <button className="profile-button" aria-label="当前用户">
          <span className="avatar">{session?.owner.initials ?? "—"}</span>
          <ChevronDown />
        </button>
      </div>
    </header>
  );
}
