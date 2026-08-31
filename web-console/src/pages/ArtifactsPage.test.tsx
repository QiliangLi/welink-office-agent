import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppDataProvider } from "../state/AppDataContext";
import { ArtifactsPage } from "./ArtifactsPage";

describe("ArtifactsPage", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DATA_SOURCE", "mock");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it("reports the capability as unavailable without fake artifact actions", async () => {
    render(
      <MemoryRouter initialEntries={["/artifacts"]}>
        <AppDataProvider>
          <ArtifactsPage />
        </AppDataProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText("产物功能尚未接入")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看已完成任务" })).toHaveAttribute("href", "/tasks?status=completed");
    expect(screen.getByRole("link", { name: "创建任务" })).toHaveAttribute("href", "/tasks/new");
    expect(screen.queryByRole("button", { name: /下载/ })).toBeNull();
  });
});
