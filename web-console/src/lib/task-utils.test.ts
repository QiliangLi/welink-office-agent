import { describe, expect, it } from "vitest";
import { initialTasks } from "../mocks/data";
import { filterTasks, relativeTime } from "./task-utils";

describe("filterTasks", () => {
  it("combines query and status filters", () => {
    const result = filterTasks(initialTasks, "市场活动", "running", "all");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("TASK-MOCK-0002");
  });

  it("matches task ids and creator names", () => {
    expect(filterTasks(initialTasks, "TASK-MOCK-0007", "all", "all")).toHaveLength(1);
    expect(filterTasks(initialTasks, "李然", "all", "all")).toHaveLength(2);
  });
});

describe("relativeTime", () => {
  it("formats timestamps relative to the real current time", () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(relativeTime(tenMinutesAgo)).toBe("10 分钟前");
    const justNow = new Date(Date.now() - 5_000).toISOString();
    expect(relativeTime(justNow)).toBe("刚刚");
  });
});
