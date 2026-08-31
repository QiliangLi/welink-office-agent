import { useEffect, useRef, useState } from "react";
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
  const bannerVisible = offline || degraded;
  const bannerRef = useRef<HTMLDivElement>(null);

  // Publish the real banner height so the topbar, sticky sidebar and the
  // mobile drawer offsets all account for it. The banner wraps on narrow
  // screens, so the value is measured while it is visible (it only shows
  // in offline/degraded states) instead of using a constant — resize
  // events, ResizeObserver and rAF all proved unreliable in embedded
  // webviews, a short interval poll works everywhere.
  useEffect(() => {
    if (!bannerVisible || !bannerRef.current) return;
    const banner = bannerRef.current;
    const root = document.documentElement;
    let last = -1;
    const apply = () => {
      const height = banner.offsetHeight;
      if (height !== last) {
        last = height;
        root.style.setProperty("--banner-h", `${height}px`);
      }
    };
    apply();
    const timer = window.setInterval(apply, 250);
    return () => {
      window.clearInterval(timer);
      root.style.removeProperty("--banner-h");
    };
  }, [bannerVisible]);

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">跳到主要内容</a>
      {bannerVisible && (
        <div
          ref={bannerRef}
          className={`app-banner ${offline ? "app-banner-danger" : "app-banner-warn"}`}
          role="status"
        >
          {offline ? <ServerOff aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
          <span>
            {offline
              ? "Agent 服务不可用，正在显示最近一次的数据；你的操作会在服务恢复后继续可用。"
              : backlog > 0
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
