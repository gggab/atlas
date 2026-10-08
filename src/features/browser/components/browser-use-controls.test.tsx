// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserUseControls } from "./browser-use-controls";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), paused: false, openSettings: vi.fn() }));
vi.mock("@/features/settings/lib/open-settings", () => ({
  openSettingsSection: mocks.openSettings,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/lib/env", () => ({ isBrowserMock: false }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.paused = false;
});

function mount(sessionId: string) {
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "browser_use_pause") mocks.paused = args.paused;
    return {
      paused: mocks.paused,
      sessions: [
        {
          sessionId: "own",
          browser: "extension",
          pairingUrl: "ws://127.0.0.1:1234/extension/test-secret",
          title: "Check form",
          status: "idle",
          tabs: [],
        },
      ],
    };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrowserUseControls sessionId={sessionId} />
    </QueryClientProvider>,
  );
}

it("stops only the current session and exposes the global pause control", async () => {
  mount("own");
  fireEvent.click(await screen.findByRole("button", { name: "Browser automation" }));
  expect(screen.queryByLabelText("Extension connection address")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect browser control" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_stop", { sessionId: "own" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Pause all browser automation" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_pause", { paused: true }),
  );
  expect(await screen.findByText("Browser paused")).toBeTruthy();
});

it("does not show another session's browser", async () => {
  mount("different");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("browser_use_snapshot"));
  fireEvent.click(await screen.findByRole("button", { name: "Browser automation" }));
  expect(screen.queryByLabelText("Extension connection address")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Open Agent task tab" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_connect", { sessionId: "different" }),
  );
});

it("opens app-managed browser settings without extension setup controls in chat", async () => {
  mount("own");
  fireEvent.click(await screen.findByRole("button", { name: "Browser automation" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open browser settings" }));
  expect(mocks.openSettings).toHaveBeenCalledWith("browser");
  expect(screen.queryByText("Set up automatic connection")).toBeNull();
});
