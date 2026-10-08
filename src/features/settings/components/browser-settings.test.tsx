// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { BrowserSettings } from "./browser-settings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/lib/env", () => ({ isBrowserMock: false }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function mount(connected = false, storeInstall = false, edgeAvailable = false) {
  mocks.invoke.mockResolvedValue({
    paused: false,
    sessions: [],
    extensionPath: "C:/Atlas/browser-extension",
    connection: {
      connected,
      browser: connected ? "chrome" : null,
      version: connected ? "0.3.0" : null,
      browsers: [
        { id: "chrome", available: true, storeInstall },
        { id: "edge", available: edgeAvailable, storeInstall },
      ],
    },
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BrowserSettings />
    </QueryClientProvider>,
  );
}
it("installs in the chosen available browser and distinguishes offline from missing browser", async () => {
  mount();
  expect(await screen.findByText("Extension not connected")).toBeTruthy();
  expect(screen.getByText("Browser not found")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install in Google Chrome" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_manage", {
      browser: "chrome",
      action: "install",
    }),
  );
  expect(screen.queryByText("Enable automatic connection")).toBeNull();
});
it("opens Chrome store installation while keeping local loading guidance explicit", async () => {
  mount(false, true);
  fireEvent.click(
    await screen.findByRole("button", { name: "Install from Google Chrome Web Store" }),
  );
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_manage", {
      browser: "chrome",
      action: "install",
    }),
  );
  expect(
    screen.getByText("Open chrome://extensions or edge://extensions to load a local build."),
  ).toBeTruthy();
});
it("manages a connected extension and pauses browser actions from Atlas", async () => {
  mount(true);
  expect(await screen.findByText("Connected · v0.3.0")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage Google Chrome extension" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_manage", {
      browser: "chrome",
      action: "manage",
    }),
  );
  const pauseSwitch = screen.getByRole("switch") as HTMLButtonElement;
  await waitFor(() => expect(pauseSwitch.disabled).toBe(false));
  fireEvent.click(pauseSwitch);
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_pause", { paused: true }),
  );
});
it("opens Edge Add-ons with an accurate visible store label", async () => {
  mount(false, true, true);
  fireEvent.click(
    await screen.findByRole("button", { name: "Install from Microsoft Edge Add-ons" }),
  );
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("browser_use_manage", {
      browser: "edge",
      action: "install",
    }),
  );
  expect(screen.getByText("Install from Edge Add-ons")).toBeTruthy();
  expect(screen.queryByText(/Edge store setup is pending/)).toBeNull();
});
