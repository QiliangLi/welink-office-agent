import { Activity, Archive, CheckSquare2, LayoutDashboard, ListTodo, Settings, X } from "lucide-react";
import { NavLink } from "react-router-dom";
import { AgentMascot } from "../mascot/AgentMascot";

const items = [
  { to: "/overview", label: "总览", en: "Overview", icon: LayoutDashboard },
  { to: "/tasks", label: "任务", en: "Tasks", icon: ListTodo },
  { to: "/approvals", label: "待我处理", en: "Approvals", icon: CheckSquare2 },
  { to: "/activity", label: "动态", en: "Activity", icon: Activity },
  { to: "/artifacts", label: "产物", en: "Artifacts", icon: Archive },
  { to: "/settings", label: "设置", en: "Settings", icon: Settings },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="关闭导航" />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="主导航">
        <div className="sidebar-mobile-head">
          <strong>导航</strong>
          <button className="icon-button" onClick={onClose} aria-label="关闭导航"><X /></button>
        </div>
        <nav className="sidebar-nav">
          {items.map(({ to, label, en, icon: Icon }) => (
            <NavLink key={to} to={to} onClick={onClose} className={({ isActive }) => `nav-item ${isActive ? "nav-item-active" : ""}`}>
              <Icon aria-hidden="true" /><span><strong>{label}</strong><small>{en}</small></span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-helper">
          <div className="helper-note">Hi，今天也交给我。我会把阻塞和风险及时告诉你。</div>
          <AgentMascot mood="working" scene="idle" size="lg" />
        </div>
      </aside>
    </>
  );
}
