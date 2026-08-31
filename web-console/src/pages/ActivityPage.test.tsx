import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { AppDataProvider } from "../state/AppDataContext";
import { ActivityPage } from "./ActivityPage";

function renderWithProviders(element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={["/activity"]}>
      <AppDataProvider>{element}</AppDataProvider>
    </MemoryRouter>,
  );
}

describe("ActivityPage", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DATA_SOURCE", "mock");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("renders the merged feed with rows linking into their tasks", async () => {
    renderWithProviders(<ActivityPage />);
    expect(await screen.findByRole("heading", { name: "动态", level: 1 })).toBeInTheDocument();
    const rows = await screen.findAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    const taskLinks = screen
      .getAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/tasks/"));
    expect(taskLinks.length).toBeGreaterThan(0);
  });

  it("shows the filtered empty state and clears back to the feed", async () => {
    renderWithProviders(<ActivityPage />);
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByPlaceholderText("输入任务 ID 或标题关键词"), {
      target: { value: "绝不匹配的关键词" },
    });
    expect(await screen.findByText("当前筛选条件下没有动态")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(await screen.findAllByRole("listitem")).not.toHaveLength(0);
  });

  it("filters by kind from the URL so every row matches the kind", async () => {
    renderWithProviders(<ActivityPage />);
    await screen.findAllByRole("listitem");
    fireEvent.change(screen.getByRole("combobox", { name: "类型" }), { target: { value: "status" } });
    await waitFor(() => {
      const rows = screen.getAllByRole("listitem");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => {
        expect(row.querySelector(".timeline-entry")?.className).toContain("timeline-entry-status");
      });
    });
  });
});
