import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentMascot } from "./AgentMascot";

const moods = [
  ["working", "Agent 正在工作"],
  ["waiting", "Agent 正在等待"],
  ["approval", "Agent 正在等待你的确认"],
  ["success", "Agent 已完成任务"],
  ["empty", "当前没有待处理事项"],
] as const;

const scenes = [
  ["idle", "Agent 在这里陪你", "7", "quick-wave quick-peek"],
  ["monitoring", "Agent 正在持续跟进", "12", "act-scan act-tilt quick-pinch"],
  ["waiting", "Agent 正在等待新的进展", "8", "act-tilt quick-peek"],
  ["filtering", "Agent 正在帮你筛选任务", "12", "act-tilt act-scan quick-peek"],
  ["create", "Agent 正在协助创建任务", "10", "act-tilt quick-pinch act-scan"],
  ["inspiration", "Agent 正在提供任务灵感", "9", "quick-peek quick-squish act-tilt"],
  ["approval", "Agent 正在等待你的确认", "9", "quick-wave act-glitch quick-peek"],
  ["success", "Agent 已完成任务", "6", "quick-bounce quick-wave quick-squish"],
  ["empty", "当前没有待处理事项", "4", "act-pulse"],
  ["blocked", "Agent 遇到阻塞", "9", "act-glitch quick-shake act-tilt"],
] as const;

describe("AgentMascot", () => {
  it.each(moods)("renders the %s GrokBot mood", (mood, label) => {
    const { container } = render(<AgentMascot mood={mood} />);

    expect(screen.getByRole("img", { name: label })).toHaveClass(`grokbot-${mood}`);
    expect(container.querySelector("svg.bot")).toBeInTheDocument();
    expect(container.querySelector("path.body")).toBeInTheDocument();
    expect(container.querySelectorAll("path.eye")).toHaveLength(2);
    expect(screen.getByRole("img", { name: label })).toHaveAttribute("data-upstream", "zhulin025/LaoA-GrokBot@527c3b5");
  });

  it.each(scenes)("maps the %s scene to a semantic upstream expression and motion set", (scene, label, expressionCount, motions) => {
    const { container } = render(<AgentMascot scene={scene} />);

    const mascot = container.querySelector(`[role="img"][aria-label="${label}"]`);
    expect(mascot).toBeInTheDocument();
    expect(mascot).toHaveAttribute("data-grokbot-scene", scene);
    expect(mascot).toHaveAttribute("data-expression-count", expressionCount);
    expect(mascot).toHaveAttribute("data-motion-set", motions);
  });

  it("moves the original eye paths with a fine pointer", async () => {
    const { container } = render(<AgentMascot />);
    const mascot = container.querySelector<HTMLElement>("[role='img']");
    expect(mascot).toBeInTheDocument();
    if (!mascot) throw new Error("Mascot did not render");
    Object.defineProperty(mascot, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const eye = container.querySelector("path.eye");
    await waitFor(() => expect(eye?.getAttribute("transform")).toBeTruthy());
    const before = eye?.getAttribute("transform");
    fireEvent.pointerMove(mascot, { clientX: 100, clientY: 100 });
    await waitFor(() => expect(eye?.getAttribute("transform")).not.toBe(before));
  });
});
