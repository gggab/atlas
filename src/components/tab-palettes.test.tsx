// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NewTabPalette } from "./new-tab-palette";
import { CommandPalette } from "./command-palette";

const mocks = vi.hoisted(() => ({ addTab: vi.fn() }));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: { use: { actions: () => ({ addTab: mocks.addTab }) } },
}));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { use: { actions: () => ({}) } },
}));
vi.mock("@/features/chat/lib/open-agent-session", () => ({ openNewAgentChat: vi.fn() }));
vi.mock("@/features/keybindings/components/action-kbd", () => ({ ActionKbd: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

for (const Palette of [NewTabPalette, CommandPalette]) {
  it(`${Palette.name} omits untitled creation and still opens terminals`, () => {
    render(<Palette open onOpenChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /untitled/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
    expect(mocks.addTab).toHaveBeenCalledWith(expect.objectContaining({ type: "terminal" }));
  });
}
