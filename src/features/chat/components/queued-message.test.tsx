// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueuedMessage } from "./queued-message";
afterEach(cleanup);

it("offers steering only when the connection supplies the action", () => {
  const base = { text: "看看", onEdit: vi.fn(), onRemove: vi.fn() };
  const { rerender } = render(<QueuedMessage {...base} />);
  expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
  const steer = vi.fn();
  rerender(<QueuedMessage {...base} onSteer={steer} />);
  fireEvent.click(screen.getByRole("button", { name: "引导" }));
  expect(steer).toHaveBeenCalledTimes(1);
  rerender(<QueuedMessage {...base} onSteer={steer} pending />);
  expect((screen.getByRole("button", { name: "引导" }) as HTMLButtonElement).disabled).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Remove from queue" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
