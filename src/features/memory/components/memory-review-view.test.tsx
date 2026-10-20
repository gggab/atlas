// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { MemoryReviewView } from "./memory-review-view";

function entry(id: number, content: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "fact",
    key: "",
    content,
    status: "",
    source: "capture",
    agent: "claude-code",
    sessionId: "s1",
    confidence: 0.3,
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: null,
    uses: 0,
    revision: 1,
    state: "candidate",
    ...over,
  };
}

beforeEach(() => {
  const queue = {
    candidates: [entry(1, "Prefers small PRs"), entry(2, "always force-push")],
    merges: [
      {
        keep: entry(5, "Keep PRs small", { state: "active" }),
        drop: [
          entry(6, "Prefer small PRs", { state: "active" }),
          entry(7, "Small PRs are preferred", { state: "active" }),
        ],
      },
    ],
    conflicts: [
      {
        a: entry(8, "main needs Java 21", { state: "active" }),
        b: entry(9, "main needs Java 17", { state: "active" }),
      },
    ],
    dreams: [
      {
        id: 41,
        op: { op: "archive", id: 10, reason: "transient" },
        why: "task state",
        entries: [entry(10, "PR 412 is in review", { state: "active" })],
      },
    ],
  };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "memory_review" ? queue : true));
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

it("does not show an old project's late response in the new project", async () => {
  let finishOld!: (value: unknown) => void;
  const old = new Promise((resolve) => {
    finishOld = resolve;
  });
  invoke.mockImplementation((_cmd: string, args: { projectPath: string }) =>
    args.projectPath === "/old"
      ? old
      : Promise.resolve({
          candidates: [entry(22, "New project claim")],
          merges: [],
          conflicts: [],
        }),
  );
  const view = render(<MemoryReviewView projectPath="/old" />);
  view.rerender(<MemoryReviewView projectPath="/new" />);
  await screen.findByText("New project claim");
  await act(async () =>
    finishOld({ candidates: [entry(1, "Old project claim")], merges: [], conflicts: [] }),
  );
  expect(screen.queryByText("Old project claim")).toBeNull();
  expect(screen.getByText("New project claim")).toBeTruthy();
});
afterEach(cleanup);

describe("the review queue", () => {
  it("merges a proposal into its survivor", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click(await screen.findByRole("button", { name: "Merge" }));
    expect(invoke).toHaveBeenCalledWith("memory_merge", {
      projectPath: "/repo",
      keep: 5,
      drop: [6, 7],
    });
  });

  it("keeps both sides of a conflict when told they both hold", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click(await screen.findByRole("button", { name: "Both hold" }));
    expect(invoke).toHaveBeenCalledWith("memory_resolve_conflict", {
      projectPath: "/repo",
      a: 8,
      b: 9,
      keep: "both",
    });
  });

  it("says the queue could not be read instead of claiming it is empty", async () => {
    invoke.mockImplementation(async () => {
      throw new Error("database is locked");
    });
    render(<MemoryReviewView projectPath="/repo" />);
    expect(
      await screen.findByText("Couldn't read the review queue: database is locked"),
    ).toBeTruthy();
    expect(screen.queryByText("Nothing to review")).toBeNull();
  });

  it("reports an action that fails", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, ...rest: unknown[]) => {
      if (cmd === "memory_promote") throw new Error("database is locked");
      return base(cmd, ...rest);
    });
    const user = userEvent.setup();
    render(<MemoryReviewView projectPath="/repo" />);
    await user.click((await screen.findAllByRole("button", { name: "Approve" }))[0]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't update memory: database is locked"),
    );
  });
});
