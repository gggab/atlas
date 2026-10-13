// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
import { agents } from "../lib/agents-api";
import type { SessionSnapshot } from "@/types/agents";
import { MessageInput } from "./message-input";
import { useChatStore } from "../stores/chat-store";
const tab = "steering-composer";
beforeEach(() => {
  vi.restoreAllMocks();
  useChatStore.setState({ sessions: {}, queues: {} });
  const { actions } = useChatStore.getState();
  actions.createSession(tab, "codex");
  actions.setAcpBinding(tab, "agent", "session", "/tmp");
  actions.updateSessionStatus(tab, "running");
  actions.enqueueMessage(tab, "看看");
});
afterEach(cleanup);

it("hides the old capability immediately when the tab rebinds", async () => {
  const snapshot = vi
    .spyOn(agents, "snapshotMeta")
    .mockResolvedValue({ steering_supported: true } as SessionSnapshot);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MessageInput tabId={tab} running onSend={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("button", { name: "引导" })).toBeTruthy();
  let resolve!: (snapshot: SessionSnapshot) => void;
  snapshot.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  act(() => useChatStore.getState().actions.setAcpBinding(tab, "new-agent", "new-session", "/tmp"));
  expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
  await act(async () => resolve({ steering_supported: false } as SessionSnapshot));
  expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
});

it.each([true, false, undefined])(
  "uses the snapshot's capability (%s), not the Codex label",
  async (supported) => {
    const snapshot = vi
      .spyOn(agents, "snapshotMeta")
      .mockResolvedValue({ steering_supported: supported } as SessionSnapshot);
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageInput tabId={tab} running onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(snapshot).toHaveBeenCalled());
    if (supported) expect(await screen.findByRole("button", { name: "引导" })).toBeTruthy();
    else expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MessageInput tabId={tab} running stopping onSend={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "引导" })).toBeNull();
  },
);
