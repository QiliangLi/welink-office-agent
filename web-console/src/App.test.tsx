import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { AppDataProvider } from "./state/AppDataContext";

const sidebarPages = [
  { path: "/activity", heading: "动态" },
  { path: "/artifacts", heading: "产物" },
  { path: "/settings", heading: "设置" },
] as const;

describe("sidebar page routes", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it.each(sidebarPages)("renders $path as its own page without redirecting", async ({ path, heading }) => {
    vi.stubEnv("VITE_DATA_SOURCE", "mock");
    render(
      <MemoryRouter initialEntries={[path]}>
        <AppDataProvider>
          <App />
        </AppDataProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
  });

  it("keeps all six sidebar entries as enabled navigation links", async () => {
    vi.stubEnv("VITE_DATA_SOURCE", "mock");
    const { container } = render(
      <MemoryRouter initialEntries={["/overview"]}>
        <AppDataProvider>
          <App />
        </AppDataProvider>
      </MemoryRouter>,
    );
    await screen.findByText("当前任务");
    expect(container.querySelectorAll("aside[aria-label='主导航'] a.nav-item")).toHaveLength(6);
    expect(container.querySelectorAll("button.nav-item-disabled")).toHaveLength(0);
  });
});
