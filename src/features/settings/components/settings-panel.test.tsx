// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "./settings-panel";

const mocks = vi.hoisted(() => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.getVersion }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@/lib/app-profile", () => ({
  useAppProfile: () => ({ productName: "同桌 DeskMate Dev" }),
  DEFAULT_APP_PROFILE: { productName: "同桌 DeskMate Dev" },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows the bundled app version while keeping the local workbench branding", async () => {
  mocks.getVersion.mockResolvedValue("0.4.9");
  render(<SettingsPanel initialSection="about" />);
  expect(await screen.findByText("v0.4.9 — Local Agent workbench")).toBeTruthy();
  expect(screen.getByRole("img", { name: "同桌 DeskMate Dev" })).toBeTruthy();
  expect(screen.queryByText(/v0\.4\.0/)).toBeNull();
});

it("shows a loading state instead of inventing a version", () => {
  mocks.getVersion.mockReturnValue(new Promise(() => {}));
  render(<SettingsPanel initialSection="about" />);
  expect(screen.getByText("Loading version… — Local Agent workbench")).toBeTruthy();
});

it("makes a failed version lookup visible", async () => {
  mocks.getVersion.mockRejectedValue(new Error("App metadata unavailable"));
  render(<SettingsPanel initialSection="about" />);
  expect(await screen.findByText("Version unavailable — Local Agent workbench")).toBeTruthy();
});
