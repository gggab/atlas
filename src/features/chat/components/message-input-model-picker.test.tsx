// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageInput } from "./message-input";
import { useChatStore } from "../stores/chat-store";
import { requestModelPicker } from "../lib/model-picker-events";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const TAB = "model-picker-integration";
beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(TAB, "codex");
  useChatStore.getState().actions.setAcpModels(TAB, "first", [
    { id: "first", name: "First model", provider: "OpenAI" },
    { id: "second", name: "Second model", provider: "Anthropic" },
  ]);
});
afterEach(cleanup);

it("opens only for its tab and switches models through the existing chat action", async () => {
  const setModel = vi.fn();
  const original = useChatStore.getState().actions.setAcpModel;
  useChatStore.setState((state) => ({ actions: { ...state.actions, setAcpModel: setModel } }));
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MessageInput tabId={TAB} onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    act(() => requestModelPicker("another-tab"));
    expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull();
    act(() => requestModelPicker(TAB));
    const search = await screen.findByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "Second" } });
    fireEvent.keyDown(search, { key: "Enter", code: "Enter" });
    expect(setModel).toHaveBeenCalledWith(TAB, "second");
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Search models" })).toBeNull(),
    );
  } finally {
    useChatStore.setState((state) => ({ actions: { ...state.actions, setAcpModel: original } }));
  }
});
