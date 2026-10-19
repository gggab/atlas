// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RightPanel } from "./right-panel";

vi.mock("@/features/ssh/components/remote-execution-panel", () => ({
  RemoteExecutionPanel: () => <div>Remote execution output</div>,
}));

afterEach(cleanup);

it("shows remote output without the removed source control navigation", async () => {
  render(<RightPanel />);
  expect(await screen.findByText("Remote execution output")).toBeVisible();
  expect(screen.queryByRole("button", { name: /source control|commit|github/i })).toBeNull();
});
