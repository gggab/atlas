// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WelcomeScreen } from "./welcome-screen";

const profile = vi.hoisted(() => ({ productName: "Atlas改" }));
vi.mock("@/lib/app-profile", () => ({
  useAppProfile: () => profile,
  DEFAULT_APP_PROFILE: { productName: "Atlas改" },
}));
vi.mock("../stores/app-store", () => ({
  useAppStore: { use: { recentProjects: () => [], actions: () => ({}) } },
}));
vi.mock("@/features/keybindings/lib/use-action-shortcut", () => ({
  useActionShortcut: () => null,
}));

afterEach(cleanup);

describe("welcome branding", () => {
  it.each(["Atlas改", "Atlas改 Dev"])("shows the active profile name %s", (name) => {
    profile.productName = name;
    render(<WelcomeScreen />);
    expect(screen.getByRole("heading", { name }).textContent).toBe(name);
    expect(screen.getByRole("img", { name }).getAttribute("alt")).toBe(name);
  });
});
