import { expect, it, vi } from "vitest";
import { createRecentChatQueue } from "./recent-chat-queue";

it("coalesces one session's activity while keeping sessions separate", () => {
  const record = vi.fn();
  const schedule = vi.fn();
  const queue = createRecentChatQueue(record, schedule);
  queue.note("a");
  queue.note("a");
  queue.note("b");
  expect(record).not.toHaveBeenCalled();
  queue.drain();
  queue.drain();
  expect(record.mock.calls).toEqual([["a"], ["b"]]);
  expect(schedule).toHaveBeenCalledTimes(3);
});

it("schedules a status-only update and reads the applied state when drained", () => {
  let status = "running";
  let flush: (() => void) | undefined;
  const seen: string[] = [];
  const queue = createRecentChatQueue(
    () => seen.push(status),
    () => {
      flush = () => queue.drain();
    },
  );
  queue.note("a");
  status = "idle";
  flush!();
  expect(seen).toEqual(["idle"]);
});
