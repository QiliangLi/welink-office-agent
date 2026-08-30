import { useState } from "react";
import { AlertTriangle, ServerOff } from "lucide-react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "../components/shell/Sidebar";
import { Topbar } from "../components/shell/Topbar";
import { useAppData } from "../state/AppDataContext";

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { health, healthUnavailable, dataSource } = useAppData();
  const offline = dataSource === "api" && healthUnavailable;
  const backlog = health?.agent.queuedCommands ?? 0;
  const degraded = !offline && health?.status === "degraded";

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      {offline && (
        <div className="app-banner app-banner-danger" role="status">
          <ServerOff aria-hidden="true" />
          <span>Agent 服务不可用，正在显示最近一次的数据；你的操作会在服务恢复后继续可用。</span>
        </div>
      )}
      {!offline && degraded && (
        <div className="app-banner app-banner-warn" role="status">
          <AlertTriangle aria-hidden="true" />
          <span>
            {backlog > 0
              ? `Agent 已停止响应或存在 ${backlog} 个待处理命令，任务会在 Agent 恢复后自动推进。`
              : "存在待核实的外部发送结果，Agent 恢复后会先处理它们。"}
          </span>
        </div>
      )}
      <Topbar onMenu={() => setSidebarOpen(true)} />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main id="main-content" className="app-main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
