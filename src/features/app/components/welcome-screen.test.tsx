// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomeScreen } from "./welcome-screen";

const profile = vi.hoisted(() => ({
  productName: "同桌 DeskMate",
  openFolderShortcut: null as string | null,
}));
vi.mock("@/lib/app-profile", () => ({
  useAppProfile: () => profile,
  DEFAULT_APP_PROFILE: { productName: "同桌 DeskMate" },
}));
vi.mock("../stores/app-store", () => ({
  useAppStore: { use: { recentProjects: () => [], actions: () => ({}) } },
}));
vi.mock("@/features/keybindings/lib/use-action-shortcut", () => ({
  useActionShortcut: (id: string) =>
    id === "workspace.add" && profile.openFolderShortcut
      ? { keys: [], label: profile.openFolderShortcut }
      : null,
}));

afterEach(() => {
  cleanup();
  profile.openFolderShortcut = null;
});

describe("welcome branding", () => {
  it.each(["同桌 DeskMate", "同桌 DeskMate Dev"])("shows the active profile name %s", (name) => {
    profile.productName = name;
    render(<WelcomeScreen />);
    expect(screen.getByRole("heading", { name }).textContent).toBe(name);
    expect(screen.getByRole("img", { name }).getAttribute("alt")).toBe(name);
  });

  it("shows the current Open Folder shortcut and follows a profile change", () => {
    profile.openFolderShortcut = "Ctrl+Shift+N";
    const { rerender } = render(<WelcomeScreen />);
    expect(screen.getByRole("button", { name: "Open Folder Ctrl+Shift+N" })).toBeTruthy();
    profile.openFolderShortcut = "Ctrl+Alt+O";
    rerender(<WelcomeScreen />);
    expect(screen.getByRole("button", { name: "Open Folder Ctrl+Alt+O" })).toBeTruthy();
  });

  it("hides the Open Folder hint when its action is unbound", () => {
    render(<WelcomeScreen />);
    expect(screen.getByRole("button", { name: "Open Folder" }).textContent).toBe("Open Folder");
  });
});
