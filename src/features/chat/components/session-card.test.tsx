// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  SessionCard,
  formatWorkingDuration,
  isTickerRunning,
  projectMonogram,
  type SessionCardProps,
} from "./session-card";
import { useChatStore } from "../stores/chat-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

function renderCard(props: Partial<SessionCardProps> = {}) {
  const handlers = { onOpen: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
  const view = render(
    <SessionCard
      threadId="thread-1"
      title="Fix model selection"
      projectName="atlas"
      showProject={false}
      lastUpdated={new Date().toISOString()}
      status={null}
      liveTabId={null}
      active={false}
      agent="codex"
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

function startTab(id: string, elapsed: number) {
  useChatStore.getState().actions.createSession(id, "codex");
  useChatStore.getState().actions.updateSessionStatus(id, "running");
  useChatStore.setState((s) => {
    s.sessions[id].turnStartedAt = Date.now() - elapsed;
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
});

describe("history card", () => {
  it("shows a title and agent, and names only a different project", () => {
    renderCard();
    expect(screen.getByText("Fix model selection")).toBeTruthy();
    expect(screen.getByTitle("Codex")).toBeTruthy();
    expect(screen.queryByText("atlas")).toBeNull();
    cleanup();
    renderCard({ showProject: true });
    expect(screen.getByText("atlas")).toBeTruthy();
    expect(screen.getByText("AT")).toBeTruthy();
  });

  it("opens by click, Enter and Space", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderCard({ active: true });
    const button = screen.getByRole("button", { name: "Fix model selection" });
    expect(button.getAttribute("aria-current")).toBe("true");
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter} ");
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenCalledWith("thread-1");
  });

  it("archives and deletes without opening the card", async () => {
    const user = userEvent.setup();
    const { onOpen, onArchive, onDelete } = renderCard();
    await user.click(screen.getByRole("button", { name: "Archive session" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));
    expect(onArchive).toHaveBeenCalledWith("thread-1");
    expect(onDelete).toHaveBeenCalledWith("thread-1");
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Fix model selection" }).querySelector("button, a"),
    ).toBeNull();
  });

  it("shows waiting separately from running and describes it to screen readers", () => {
    renderCard({ status: "waiting" });
    expect(screen.getByText("Needs input")).toBeTruthy();
    expect(screen.queryByText(/Working/)).toBeNull();
    const button = screen.getByRole("button", { name: "Fix model selection" });
    expect(
      document.getElementById(button.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("Needs input");
  });

  it("shows last update while idle and Working without inventing a start time", () => {
    renderCard({ lastUpdated: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect(screen.getByText("5m ago")).toBeTruthy();
    cleanup();
    renderCard({ status: "running" });
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.queryByText(/\ds$/)).toBeNull();
    const ring = document.querySelector("svg.animate-spin");
    expect(ring?.getAttribute("aria-hidden")).toBe("true");
    expect(ring?.getAttribute("class")).toContain("motion-reduce:animate-none");
  });

  it("updates multiple running cards with one clock and stops on unmount", () => {
    vi.useFakeTimers();
    startTab("live", 55_000);
    renderCard({ status: "running", liveTabId: "live" });
    renderCard({ threadId: "other", status: "running", liveTabId: "live" });
    expect(screen.getAllByText("55s")).toHaveLength(2);
    expect(isTickerRunning()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getAllByText("1m")).toHaveLength(2);
    cleanup();
    expect(isTickerRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses refresh while hidden and catches up when visible", () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    startTab("live", 55_000);
    renderCard({ status: "running", liveTabId: "live" });
    act(() => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(isTickerRunning()).toBe(false);
    act(() => {
      vi.advanceTimersByTime(10_000);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.getByText("1m")).toBeTruthy();
    expect(isTickerRunning()).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("card formatting", () => {
  it("formats project initials and durations", () => {
    expect(projectMonogram("atlas")).toBe("AT");
    expect(projectMonogram("northwind-shop")).toBe("NS");
    expect(projectMonogram("")).toBe("?");
    expect(formatWorkingDuration(-1000)).toBe("0s");
    expect(formatWorkingDuration(45_000)).toBe("45s");
    expect(formatWorkingDuration(425_000)).toBe("7m");
    expect(formatWorkingDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatWorkingDuration(120 * 60_000)).toBe("2h");
  });
});
