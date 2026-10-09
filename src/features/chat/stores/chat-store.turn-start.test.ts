// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./chat-store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const tab = "turn-tab";
const start = () => useChatStore.getState().sessions[tab].turnStartedAt;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(tab, "codex");
});
afterEach(() => {
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  vi.useRealTimers();
});

describe("current turn timer", () => {
  it("starts a fresh timer when queued turns cross in one buffered batch", () => {
    const { setAcpBinding, applyAgentDelta, applyAgentBatch } = useChatStore.getState().actions;
    setAcpBinding(tab, "agent", "session", "/repo");
    applyAgentDelta({
      kind: "status",
      agent_id: "agent",
      session_id: "session",
      status: "running",
      turn_seq: 1,
    });
    vi.setSystemTime(2_000_000);
    applyAgentBatch({
      texts: [],
      thoughts: [],
      deltas: [
        {
          kind: "turn_finished",
          agent_id: "agent",
          session_id: "session",
          stop_reason: "end_turn",
          turn_seq: 1,
        },
        {
          kind: "status",
          agent_id: "agent",
          session_id: "session",
          status: "running",
          turn_seq: 2,
        },
      ],
    });
    expect(start()).toBe(2_000_000);
    vi.setSystemTime(2_060_000);
    applyAgentDelta({
      kind: "status",
      agent_id: "agent",
      session_id: "session",
      status: "idle",
      turn_seq: 1,
    });
    expect(start()).toBe(2_000_000);
  });

  it("starts once, includes a permission wait, then resets for the next turn", () => {
    const { updateSessionStatus } = useChatStore.getState().actions;
    expect(start() ?? null).toBeNull();
    updateSessionStatus(tab, "running");
    expect(start()).toBe(1_000_000);
    vi.setSystemTime(1_060_000);
    updateSessionStatus(tab, "waiting");
    updateSessionStatus(tab, "running");
    expect(start()).toBe(1_000_000);
    updateSessionStatus(tab, "idle");
    expect(start()).toBeNull();
    vi.setSystemTime(2_000_000);
    updateSessionStatus(tab, "running");
    expect(start()).toBe(2_000_000);
  });

  it.each(["idle", "error"] as const)("clears on a terminal %s status delta", (status) => {
    const { setAcpBinding, applyAgentDelta } = useChatStore.getState().actions;
    setAcpBinding(tab, "agent", "session", "/repo");
    applyAgentDelta({
      kind: "status",
      agent_id: "agent",
      session_id: "session",
      status: "running",
    });
    expect(start()).toBe(1_000_000);
    applyAgentDelta({ kind: "status", agent_id: "agent", session_id: "session", status });
    expect(start()).toBeNull();
  });

  it("clears after killing a busy agent and after clearing a session", () => {
    const { updateSessionStatus, noteAgentKilled, clearSession } = useChatStore.getState().actions;
    updateSessionStatus(tab, "running");
    noteAgentKilled(tab);
    expect(start()).toBeNull();
    updateSessionStatus(tab, "running");
    clearSession(tab);
    expect(start() ?? null).toBeNull();
  });

  it("tracks independent sessions without resetting another running turn", () => {
    const { createSession, updateSessionStatus } = useChatStore.getState().actions;
    updateSessionStatus(tab, "running");
    vi.setSystemTime(1_060_000);
    createSession("second", "codex");
    updateSessionStatus("second", "waiting");
    expect(start()).toBe(1_000_000);
    expect(useChatStore.getState().sessions.second.turnStartedAt).toBe(1_060_000);
    updateSessionStatus("second", "error");
    expect(start()).toBe(1_000_000);
  });
});
