// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./session-sidebar", () => ({ SessionSidebar: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
vi.mock("./transcript", () => ({ Transcript: Null }));
vi.mock("./chat-header", () => ({
  ChatHeader: (props: ComponentProps<typeof import("./chat-header").ChatHeader>) => (
    <>
      <button onClick={props.onOpenSearch}>Open search</button>
      <button onClick={props.onToggleBash}>Open commands</button>
      <button
        onClick={() => {
          const m = useChatStore.getState().sessions[props.tabId].messages[0];
          props.onJumpToPin({
            messageId: m.id,
            timestamp: m.timestamp,
            text: m.content,
            at: m.timestamp,
          });
        }}
      >
        Jump pin
      </button>
    </>
  ),
}));
vi.mock("./bash-history-panel", () => ({
  BashHistoryPanel: ({ onJump }: { onJump: (index: number) => void }) => (
    <button onClick={() => onJump(0)}>Jump command</button>
  ),
}));
vi.mock("./chat-search-palette", () => ({
  ChatSearchPalette: ({ onJump }: { onJump: (index: number) => void }) => (
    <button onClick={() => onJump(0)}>Jump search</button>
  ),
}));

import { useChatStore } from "../stores/chat-store";
import { ChatPanel } from "./chat-panel";

const TAB = "sender-tab";
beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    queues: {},
    pendingPermissions: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useChatStore.getState().actions.addMessage(TAB, "user", "Find this prompt");
});
afterEach(cleanup);

describe("ChatPanel jump senders", () => {
  it.each(["pin", "command", "search"])("addresses the %s jump to its own tab", async (source) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const personal = {
      messages: useChatStore.getState().sessions[TAB].messages,
      busy: false,
      onSend: vi.fn(async () => {}),
      onReconnect: async () => {},
      onRememberMessage: () => {},
      actions: null,
      notice: null,
    };
    render(
      <QueryClientProvider client={client}>
        <ChatPanel tabId={TAB} personal={personal} />
      </QueryClientProvider>,
    );
    const received: unknown[] = [];
    const receive = (event: Event) => received.push((event as CustomEvent).detail);
    window.addEventListener("atlas:chat-jump", receive);
    try {
      if (source === "command")
        fireEvent.click(screen.getByRole("button", { name: "Open commands" }));
      if (source === "search") fireEvent.click(screen.getByRole("button", { name: "Open search" }));
      fireEvent.click(await screen.findByRole("button", { name: `Jump ${source}` }));
      await waitFor(() => expect(received).toEqual([{ index: 0, tabId: TAB }]));
    } finally {
      window.removeEventListener("atlas:chat-jump", receive);
      client.clear();
    }
  });
});
