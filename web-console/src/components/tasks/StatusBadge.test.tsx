import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["queued", "待执行"],
    ["running", "执行中"],
    ["waiting_external", "等待外部"],
    ["waiting_approval", "待我处理"],
    ["partial", "部分完成"],
    ["failed", "异常"],
    ["completed", "已完成"],
  ] as const)("renders %s with its Chinese label", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
