// @vitest-environment happy-dom
//
// ADR-0001 amendment, Rule 7, at the panel's choke point. The composer refuses
// a send into a session another process is writing, but chips, agent-switch
// handoffs and another agent's `ui_chat` send arrive as `atlas:chat-send` and
// call `ChatPanel.handleSend` directly; the queue drain does too. This suite
// pins that every one of those is held — kept in the queue, never dropped —
// and that "Send anyway" releases it.
//
// The panel's children are stubbed: what is under test is `handleSend` and the
// drain effect, not anything they render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as string[]);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  const agents = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "send"
          ? vi.fn(async (_key: unknown, prompt: string) => {
              sent.push(prompt);
            })
          : vi.fn(async () => ({})),
    },
  );
  return { ...real, agents, ensureAgent: vi.fn(async () => ({})), resetAgent: vi.fn() };
});
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./session-sidebar", () => ({ SessionSidebar: Null }));
vi.mock("./chat-header", () => ({ ChatHeader: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./chat-comments-controller", () => ({ ChatCommentsController: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
vi.mock("./transcript", () => ({ Transcript: Null }));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChatStore } from "../stores/chat-store";
import { useLiveElsewhereStore } from "../stores/live-elsewhere-store";
import { ChatPanel } from "./chat-panel";
import { ensureAgent } from "../lib/agents-api";
import type { ComponentProps } from "react";

const TAB = "tab-1";
const SESSION = "sess-live";

const queue = () => useChatStore.getState().queues[TAB] ?? [];
/** `sent` holds wire prompts, which carry an appended directive. */
const sentTexts = () => sent.map((p) => p.split("\n")[0]);

beforeEach(() => {
  sent.length = 0;
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useChatStore.setState((s) => {
    s.sessions[TAB].acpAgentId = "agent-1";
    s.sessions[TAB].acpSessionId = SESSION;
  });
  useLiveElsewhereStore.setState({ live: {}, overridden: {} });
});
afterEach(cleanup);

function mount(personal?: ComponentProps<typeof ChatPanel>["personal"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} personal={personal} />
    </QueryClientProvider>,
  );
}

function chatSend(text: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent("atlas:chat-send", { detail: { tabId: TAB, text } }));
  });
}

describe("ChatPanel holds every send into a session live elsewhere", () => {
  it("preserves personal sends while the controller is busy and drains once ready", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const personal = {
      messages: [],
      busy: true,
      onSend: vi.fn(async () => {}),
      onReconnect: async () => {},
      onRememberMessage: () => {},
      actions: null,
      notice: null,
    };
    const view = render(
      <QueryClientProvider client={client}>
        <ChatPanel tabId={TAB} personal={personal} />
      </QueryClientProvider>,
    );
    chatSend("Keep this message");
    await waitFor(() => expect(queue()).toEqual(["Keep this message"]));
    expect(personal.onSend).not.toHaveBeenCalled();
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatPanel tabId={TAB} personal={{ ...personal, busy: false }} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(personal.onSend).toHaveBeenCalledTimes(1));
    expect(queue()).toEqual([]);
  });

  it("uses personal lifecycle instead of binding a project session", async () => {
    useChatStore.getState().actions.clearSession(TAB);
    vi.mocked(ensureAgent).mockClear();
    const onSend = vi.fn(async () => {});
    mount({
      messages: [],
      busy: false,
      onSend,
      onReconnect: async () => {},
      onRememberMessage: () => {},
      actions: null,
      notice: null,
    });
    chatSend("A personal obligation");
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("A personal obligation", [], undefined),
    );
    expect(ensureAgent).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("does not rotate a personal queue when busy ends during a running turn or after failure", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const personal = {
      messages: [],
      busy: true,
      onSend: vi.fn(async () => {}),
      onReconnect: async () => {},
      onRememberMessage: () => {},
      actions: null,
      notice: null,
    };
    useChatStore.getState().actions.updateSessionStatus(TAB, "running");
    const view = render(
      <QueryClientProvider client={client}>
        <ChatPanel tabId={TAB} personal={personal} />
      </QueryClientProvider>,
    );
    act(() => {
      useChatStore.getState().actions.enqueueMessage(TAB, "first");
      useChatStore.getState().actions.enqueueMessage(TAB, "second");
    });
    view.rerender(
      <QueryClientProvider client={client}>
        <ChatPanel tabId={TAB} personal={{ ...personal, busy: false }} />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue()).toEqual(["first", "second"]);
    expect(personal.onSend).not.toHaveBeenCalled();
    act(() => useChatStore.getState().actions.updateSessionStatus(TAB, "error"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue()).toEqual(["first", "second"]);
    expect(personal.onSend).not.toHaveBeenCalled();
    view.unmount();
    mount({ ...personal, busy: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queue()).toEqual(["first", "second"]);
    expect(personal.onSend).not.toHaveBeenCalled();
  });

  it("keeps personal sends behind the shared live-elsewhere gate", async () => {
    const onSend = vi.fn(async () => {});
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    mount({
      messages: [],
      busy: false,
      onSend,
      onReconnect: async () => {},
      onRememberMessage: () => {},
      actions: null,
      notice: null,
    });
    chatSend("A personal obligation");
    await waitFor(() => expect(queue()).toEqual(["A personal obligation"]));
    expect(onSend).not.toHaveBeenCalled();
    act(() => useLiveElsewhereStore.getState().actions.sendAnyway(SESSION));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  });

  it("keeps next-step instructions in the Agent prompt", async () => {
    mount();
    chatSend("继续");
    await waitFor(() => expect(sentTexts()).toEqual(["继续"]));
    expect(sent[0]).toContain("═══ Atlas next-steps ═══");
  });

  it("sends an atlas:chat-send normally while the session is not live", async () => {
    mount();
    chatSend("status?");
    await waitFor(() => expect(sentTexts()).toEqual(["status?"]));
  });

  it("holds an atlas:chat-send in the queue, and sends it after Send anyway", async () => {
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    mount();

    chatSend("status?");
    // Held, not lost: it sits in the composer's queue strip.
    await waitFor(() => expect(queue()).toEqual(["status?"]));
    expect(sent).toEqual([]);

    act(() => useLiveElsewhereStore.getState().actions.sendAnyway(SESSION));
    await waitFor(() => expect(sentTexts()).toEqual(["status?"]));
    expect(queue()).toEqual([]);
  });

  it("does not drain the queue at a turn end while held, and drains once the hold lifts", async () => {
    useChatStore.setState((s) => {
      s.sessions[TAB].status = "running";
    });
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    mount();
    act(() => {
      useChatStore.getState().actions.enqueueMessage(TAB, "next");
    });

    // The turn ends: normally the queue's head goes out now.
    act(() => useChatStore.getState().actions.updateSessionStatus(TAB, "idle"));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(queue()).toEqual(["next"]);

    // The other process goes quiet: the hold lifts and the queue drains.
    act(() => useLiveElsewhereStore.getState().actions.setLive([]));
    await waitFor(() => expect(sentTexts()).toEqual(["next"]));
    expect(queue()).toEqual([]);
  });
});
