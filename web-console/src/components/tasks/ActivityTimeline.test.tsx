import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../types/domain";
import { ActivityTimeline } from "./ActivityTimeline";

const events: ActivityEvent[] = [
  { id: "latest", kind: "task", title: "生成报告", at: "2026-08-30T11:00:00+08:00" },
  { id: "first", kind: "file", title: "读取数据", at: "2026-08-30T09:00:00+08:00" },
];

describe("ActivityTimeline", () => {
  it("orders progress from the earliest event to the current event", () => {
    const { container } = render(<ActivityTimeline events={events} status="running" />);
    const titles = screen.getAllByRole("strong").map((node) => node.textContent);
    expect(titles).toEqual(["读取数据", "生成报告"]);
    expect(screen.getByText("当前")).toBeInTheDocument();
    expect(container.querySelectorAll(".timeline-arrow-cue")).toHaveLength(1);
    expect(container.querySelector(".timeline-flow-marker")).toBeInTheDocument();
  });

  it("renders an explanatory empty state", () => {
    render(<ActivityTimeline events={[]} status="queued" />);
    expect(screen.getByText("任务开始后，进展会沿时间线显示在这里。")).toBeInTheDocument();
  });
});
