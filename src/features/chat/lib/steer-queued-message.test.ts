// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
import { agents } from "./agents-api";
import { useChatStore } from "../stores/chat-store";
import { canSteer, steerQueuedMessage } from "./steer-queued-message";
import { drainEdge } from "./drain-gate";

const tab = "steering-test";
beforeEach(() => {
  vi.restoreAllMocks();
  useChatStore.setState({ sessions: {}, queues: {} });
  const { actions } = useChatStore.getState();
  actions.createSession(tab, "codex");
  actions.setAcpBinding(tab, "agent", "session", "/tmp");
  actions.updateSessionStatus(tab, "running");
  actions.enqueueMessage(tab, "first");
  actions.enqueueMessage(tab, "second");
});

describe("queued steering", () => {
  it("requires a live, negotiated connection, independent of agent name", () => {
    const session = useChatStore.getState().sessions[tab];
    expect(canSteer(session, false)).toBe(false);
    expect(canSteer(session, true)).toBe(true);
    expect(canSteer({ ...session, status: "waiting" }, true)).toBe(true);
    for (const patch of [
      { stopping: true },
      { disconnected: true },
      { resumePending: true },
      { unrestoredModeId: "plan" },
      { status: "idle" as const },
      { acpSessionId: undefined },
    ]) {
      expect(canSteer({ ...session, ...patch }, true)).toBe(false);
    }
  });

  it("injects only the selected message and preserves the active turn", async () => {
    const steer = vi.spyOn(agents, "steer").mockResolvedValue("injected");
    await steerQueuedMessage(tab, 1);
    expect(steer).toHaveBeenCalledWith({ agent_id: "agent", session_id: "session" }, "second");
    const state = useChatStore.getState();
    expect(state.queues[tab]).toEqual(["first"]);
    const messages = state.sessions[tab].messages;
    expect(messages[messages.length - 1]?.content).toBe("second");
    expect(state.sessions[tab].status).toBe("running");
    expect(state.sessions[tab].steeringPending).toBeUndefined();
  });

  it("keeps rejected input queued without failing the running turn", async () => {
    vi.spyOn(agents, "steer").mockRejectedValue(new Error("not supported"));
    await expect(steerQueuedMessage(tab, 0)).rejects.toThrow("not supported");
    expect(useChatStore.getState().queues[tab]).toEqual(["first", "second"]);
    expect(useChatStore.getState().sessions[tab].messages).toEqual([]);
    expect(useChatStore.getState().sessions[tab].status).toBe("running");
  });

  it("blocks duplicate clicks and queue draining until acknowledgement", async () => {
    let accept!: (value: "injected") => void;
    const steer = vi.spyOn(agents, "steer").mockImplementation(
      () =>
        new Promise((r) => {
          accept = r;
        }),
    );
    const pending = steerQueuedMessage(tab, 0);
    expect(useChatStore.getState().sessions[tab].steeringPending).toBe(true);
    await expect(steerQueuedMessage(tab, 0)).rejects.toThrow();
    expect(
      drainEdge({
        prevStatus: "running",
        curStatus: "idle",
        prevAcp: "session",
        curAcp: "session",
        prevResuming: false,
        curResuming: false,
        curSteering: true,
      }).drainQueue,
    ).toBe(false);
    accept("injected");
    await pending;
    expect(steer).toHaveBeenCalledTimes(1);
    expect(
      drainEdge({
        prevStatus: "idle",
        curStatus: "idle",
        prevAcp: "session",
        curAcp: "session",
        prevResuming: false,
        curResuming: false,
        prevSteering: true,
        curSteering: false,
      }).drainQueue,
    ).toBe(true);
    expect(
      drainEdge({
        prevStatus: "running",
        curStatus: "running",
        prevAcp: "session",
        curAcp: "session",
        prevResuming: false,
        curResuming: false,
        prevSteering: true,
        curSteering: false,
      }).drainQueue,
    ).toBe(false);
  });

  it("does not remove messages or append a bubble to a rebound tab", async () => {
    let accept!: (value: "injected") => void;
    vi.spyOn(agents, "steer").mockImplementation(
      () =>
        new Promise((r) => {
          accept = r;
        }),
    );
    const pending = steerQueuedMessage(tab, 0);
    useChatStore.getState().actions.setAcpBinding(tab, "other-agent", "other-session", "/tmp");
    accept("injected");
    await pending;
    expect(useChatStore.getState().queues[tab]).toEqual(["first", "second"]);
    expect(useChatStore.getState().sessions[tab].messages).toEqual([]);
    expect(useChatStore.getState().sessions[tab].steeringPending).toBeUndefined();
  });

  it("keeps idle input queued and does not call send as a steering fallback", async () => {
    vi.spyOn(agents, "steer").mockResolvedValue("prompt_required");
    const send = vi.spyOn(agents, "send");
    expect(await steerQueuedMessage(tab, 0)).toBe("prompt_required");
    expect(useChatStore.getState().queues[tab]).toEqual(["first", "second"]);
    expect(useChatStore.getState().sessions[tab].messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("acknowledges legacy consumption once and holds its detached turn for Stop", async () => {
    vi.spyOn(agents, "steer").mockResolvedValue("started_new_turn");
    await steerQueuedMessage(tab, 0);
    const state = useChatStore.getState();
    expect(state.queues[tab]).toEqual(["second"]);
    expect(state.sessions[tab].steeringNeedsStop).toBe(true);
    expect(state.sessions[tab].status).toBe("running");
    expect(canSteer(state.sessions[tab], true)).toBe(false);
  });
});
