import type { CSSProperties } from "react";

type MascotMood = "working" | "waiting" | "approval" | "success" | "empty";

interface AgentMascotProps {
  mood?: MascotMood;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const moodLabel: Record<MascotMood, string> = {
  working: "Agent 正在工作",
  waiting: "Agent 正在等待",
  approval: "Agent 正在等待你的确认",
  success: "Agent 已完成任务",
  empty: "当前没有待处理事项",
};

export function AgentMascot({ mood = "working", size = "md", className = "" }: AgentMascotProps) {
  const dimensions = { sm: 64, md: 98, lg: 142 }[size];
  return (
    <div
      className={`mascot mascot-${mood} ${className}`}
      style={{ "--mascot-size": `${dimensions}px` } as CSSProperties}
      role="img"
      aria-label={moodLabel[mood]}
    >
      <span className="mascot-antenna" />
      <span className="mascot-ear mascot-ear-left" />
      <span className="mascot-ear mascot-ear-right" />
      <span className="mascot-head">
        <span className="mascot-screen">
          <span className="mascot-eye mascot-eye-left" />
          <span className="mascot-eye mascot-eye-right" />
          <span className="mascot-mouth" />
        </span>
      </span>
      <span className="mascot-body"><span className="mascot-core" /></span>
      <span className="mascot-arm mascot-arm-left" />
      <span className="mascot-arm mascot-arm-right" />
    </div>
  );
}
