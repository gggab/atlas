// @vitest-environment happy-dom
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BackgroundControl } from "./background-control";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(cleanup);
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (name: string) =>
    name === "background_status"
      ? {
          supported: true,
          enabled: false,
          role: "local",
          login: false,
          error: null,
          needsRestart: false,
        }
      : null,
  );
});
it("requires an explicit confirmation before enabling and restarting", async () => {
  render(<BackgroundControl />);
  fireEvent.click(await screen.findByText("启用并重启"));
  expect(invoke).not.toHaveBeenCalledWith("background_configure", expect.anything());
  fireEvent.click(screen.getByText("确认并重启"));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("background_configure", { enabled: true }),
  );
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("background_restart"));
});
it("shows configuration failure and does not restart on failure", async () => {
  invoke.mockImplementation(async (name: string) => {
    if (name === "background_configure") throw new Error("login registration failed");
    return { supported: true, enabled: false, role: "local", error: null };
  });
  render(<BackgroundControl />);
  fireEvent.click(await screen.findByText("启用并重启"));
  fireEvent.click(screen.getByText("确认并重启"));
  await screen.findAllByText(/login registration failed/);
  expect(invoke).not.toHaveBeenCalledWith("background_restart");
});
it("exposes a service connection error instead of claiming local fallback", async () => {
  invoke.mockResolvedValue({
    supported: true,
    enabled: true,
    role: "client",
    login: true,
    error: "background connection lost",
  });
  render(<BackgroundControl />);
  expect((await screen.findByRole("alert")).textContent).toContain("background connection lost");
});
it("restarts only the interface when reconnecting and preserves backend configuration", async () => {
  invoke.mockImplementation(async (name: string) =>
    name === "background_status"
      ? {
          supported: true,
          enabled: true,
          role: "client",
          login: true,
          error: "stream interrupted",
          connected: false,
        }
      : null,
  );
  render(<BackgroundControl />);
  fireEvent.click(await screen.findByText("重启界面重新连接"));
  fireEvent.click(screen.getByText("确认并重启"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("background_restart"));
  expect(invoke.mock.calls.some(([name]) => name === "background_configure")).toBe(false);
});
