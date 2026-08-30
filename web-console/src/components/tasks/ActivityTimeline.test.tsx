import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../types/domain";
import { ActivityTimeline } from "./ActivityTimeline";

const events: ActivityEvent[] = [
  { id: "latest", kind: "task", title: "生成报告", detail: null, occurredAt: new Date(Date.now() - 60_000).toISOString(), sequence: 2, taskId: "TASK-1", subtaskId: null, conversationId: null },
  { id: "first", kind: "file", title: "读取数据", detail: null, occurredAt: new Date(Date.now() - 7_200_000).toISOString(), sequence: 1, taskId: "TASK-1", subtaskId: null, conversationId: null },
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

  it("keeps non-running statuses static even with multiple events", () => {
    const { container } = render(<ActivityTimeline events={events} status="waiting_external" />);
    expect(container.querySelector(".timeline-flow-marker")).not.toBeInTheDocument();
  });

  it("breaks sequence ties with the runtime sequence counter", () => {
    const at = new Date().toISOString();
    const tied: ActivityEvent[] = [
      { id: "b", kind: "status", title: "第二条", detail: null, occurredAt: at, sequence: 9, taskId: null, subtaskId: null, conversationId: null },
      { id: "a", kind: "status", title: "第一条", detail: null, occurredAt: at, sequence: 8, taskId: null, subtaskId: null, conversationId: null },
    ];
    const { container } = render(<ActivityTimeline events={tied} status="running" />);
    const titles = Array.from(container.querySelectorAll("strong")).map((node) => node.textContent);
    expect(titles).toEqual(["第一条", "第二条"]);
  });

  it("renders an explanatory empty state", () => {
    render(<ActivityTimeline events={[]} status="queued" />);
    expect(screen.getByText("任务开始后，进展会沿时间线显示在这里。")).toBeInTheDocument();
  });
});
