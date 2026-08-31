import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppDataProvider } from "../state/AppDataContext";
import { SettingsPage } from "./SettingsPage";

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DATA_SOURCE", "mock");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("shows the masked owner, dry-run mode and capability states", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppDataProvider>
          <SettingsPage />
        </AppDataProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("当前用户")).toBeInTheDocument();
    expect(screen.getByText("齐亮")).toBeInTheDocument();
    expect(screen.getByText("••••0000")).toBeInTheDocument();
    expect(screen.getByText("Asia/Shanghai")).toBeInTheDocument();
    expect(screen.getByText("Dry-run（预演）")).toBeInTheDocument();
    expect(screen.getByText(/外发消息不会真实发送/)).toBeInTheDocument();
    expect(screen.getByText("附件上传")).toBeInTheDocument();
    expect(screen.getAllByText("未接入").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("button", { name: /刷新状态/ })).toBeEnabled();
  });
});
