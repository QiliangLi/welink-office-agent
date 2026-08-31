import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("lists configurable colleagues and adds a new one through the form", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppDataProvider>
          <SettingsPage />
        </AppDataProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("可联系同事")).toBeInTheDocument();
    expect(screen.getByText("王璐")).toBeInTheDocument();
    expect(screen.getAllByText("允许主动联系").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("员工号"), { target: { value: "00700000" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "沈舟" } });
    fireEvent.click(screen.getByRole("button", { name: "添加联系人" }));

    await waitFor(() => {
      expect(screen.getAllByText("沈舟").length).toBeGreaterThan(0);
      expect(screen.getByText("联系人已添加。")).toBeInTheDocument();
    });
  });

  it("blocks saving with an invalid employee number", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppDataProvider>
          <SettingsPage />
        </AppDataProvider>
      </MemoryRouter>,
    );
    await screen.findByText("可联系同事");
    fireEvent.change(screen.getByLabelText("员工号"), { target: { value: "123" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "沈舟" } });
    expect(screen.getByText("员工号必须是 4 到 16 位数字。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加联系人" })).toBeDisabled();
  });
});
