import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRevalidationScheduler } from "./revalidation-scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("coalesces a burst into one disk read", () => {
  const read = vi.fn();
  const scheduler = createRevalidationScheduler(read);
  for (let i = 0; i < 5; i++) scheduler.schedule();
  vi.advanceTimersByTime(150);
  expect(read).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000);
  expect(read).toHaveBeenCalledTimes(1);
});

it("reads within one second while watcher events keep arriving", () => {
  const read = vi.fn();
  const scheduler = createRevalidationScheduler(read);
  for (let i = 0; i < 20; i++) {
    scheduler.schedule();
    vi.advanceTimersByTime(50);
  }
  expect(read).toHaveBeenCalledTimes(1);
  scheduler.cancel();
});

it("reconciles immediately on focus and cancels pending reads on disposal", () => {
  const read = vi.fn();
  const scheduler = createRevalidationScheduler(read);
  scheduler.schedule();
  scheduler.flush();
  expect(read).toHaveBeenCalledTimes(1);
  scheduler.schedule();
  scheduler.cancel();
  vi.advanceTimersByTime(2000);
  expect(read).toHaveBeenCalledTimes(1);
});
