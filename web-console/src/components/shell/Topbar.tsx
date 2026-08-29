import { Bell, Bot, ChevronDown, Menu, Plus } from "lucide-react";
import { Link } from "react-router-dom";

export function Topbar({ onMenu }: { onMenu: () => void }) {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <button className="icon-button menu-button" onClick={onMenu} aria-label="打开导航"><Menu /></button>
        <span className="brand-mark"><Bot aria-hidden="true" /></span>
        <strong>WeLink Office Agent</strong>
      </div>
      <div className="topbar-actions">
        <span className="agent-health"><i />Agent 正常</span>
        <Link className="button button-primary topbar-create" to="/tasks/new"><Plus />下发新任务</Link>
        <button className="icon-button" aria-label="通知"><Bell /></button>
        <button className="profile-button" aria-label="打开用户菜单">
          <span className="avatar">QL</span><ChevronDown />
        </button>
      </div>
    </header>
  );
}
