import { describe, expect, it } from "vitest";
import { initialTasks } from "../mocks/data";
import { filterTasks, relativeTime } from "./task-utils";

describe("filterTasks", () => {
  it("combines query and status filters", () => {
    const result = filterTasks(initialTasks, "市场活动", "running", "all");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TASK-20260830-002");
  });

  it("matches task ids and creator names", () => {
    expect(filterTasks(initialTasks, "TASK-20260829-006", "all", "all")).toHaveLength(1);
    expect(filterTasks(initialTasks, "陈墨", "all", "all").length).toBeGreaterThan(0);
  });
});

describe("relativeTime", () => {
  it("formats fixed mock timestamps deterministically", () => {
    expect(relativeTime("2026-08-30T11:42:00+08:00")).toBe("18 分钟前");
  });
});
