// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
vi.mock("../lib/retry-turn", () => ({ retryLastTurn: vi.fn() }));
vi.mock("@/ui/hint-group", () => ({
  HintGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HintItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { UserRowActions } from "./user-row-actions";
afterEach(cleanup);
const props = {
  canRetry: false,
  tabId: "personal",
  text: "Rent fifteen",
  messageId: "original-human",
  timestamp: "2026-10-17T12:00:00Z",
  pinScopeKey: "personal",
  toggleAbove: false,
};
describe("personal memory action", () => {
  it("is absent from ordinary conversations unless explicitly provided", () => {
    render(<UserRowActions {...props} />);
    expect(screen.queryByRole("button", { name: "保存为个人记忆" })).toBeNull();
  });
  it("passes the selected human message id without saving automatically", () => {
    const remember = vi.fn();
    render(<UserRowActions {...props} onRememberMessage={remember} />);
    expect(remember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存为个人记忆" }));
    expect(remember).toHaveBeenCalledExactlyOnceWith("original-human");
  });
});
