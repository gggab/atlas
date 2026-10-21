// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ChatMessage } from "@/types/agent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/layout/lib/use-tab-visible", () => ({ useIsTabVisible: () => true }));
vi.mock("../lib/use-thawed", () => ({ useThawed: () => true }));
vi.mock("../lib/use-transcript-scroll", async () => {
  const { useRef } = await import("react");
  return {
    useTranscriptScroll: () => ({
      more: false,
      onScroll: () => {},
      invalidate: () => {},
      atEndRef: useRef(false),
      growPending: useRef(false),
    }),
  };
});
vi.mock("@/components/gradual-blur", () => ({ GradualBlur: () => null }));
vi.mock("./transcript-rows", () => {
  const Null = () => null;
  return {
    UserRowView: Null,
    ProseRowView: Null,
    ThinkingRowView: Null,
    MarkerRowView: Null,
    MarkerGroupRowView: Null,
    SubagentRowView: Null,
    WorkHeaderRowView: Null,
    SeparatorRowView: Null,
    TurnFooterRowView: Null,
  };
});

import { Transcript } from "./transcript";

const messages: ChatMessage[] = [
  {
    id: "prompt",
    role: "user",
    content: "Find this prompt",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-20T00:00:00Z",
  },
];

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function thread(tabId: string) {
  return (
    <Transcript
      tabId={tabId}
      acpSessionId={`session-${tabId}`}
      messages={messages}
      isStreaming={false}
    />
  );
}

function scroller(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-row-id="u:prompt"]')!;
  expect(row).not.toBeNull();
  Object.defineProperty(row, "offsetTop", { configurable: true, value: 520 });
  return row.parentElement!.parentElement!;
}

function jump(tabId?: string) {
  act(() =>
    window.dispatchEvent(
      new CustomEvent("atlas:chat-jump", {
        detail: { index: 0, tabId, highlightRowIds: ["u:prompt"] },
      }),
    ),
  );
}

describe("mounted transcript jump isolation", () => {
  it("moves and highlights only the addressed conversation", () => {
    const a = render(thread("chat-a"));
    const b = render(thread("chat-b"));
    const aScroll = scroller(a.container),
      bScroll = scroller(b.container);
    aScroll.scrollTop = 110;
    bScroll.scrollTop = 220;
    jump("chat-a");
    expect(aScroll.scrollTop).toBe(496);
    expect(bScroll.scrollTop).toBe(220);
    expect(
      b.container.querySelector('[data-row-id="u:prompt"]')?.classList.contains("ring-1"),
    ).toBe(false);
  });

  it("ignores unaddressed jumps instead of broadcasting them", () => {
    const view = render(thread("chat-legacy"));
    const el = scroller(view.container);
    el.scrollTop = 110;
    jump();
    expect(el.scrollTop).toBe(110);
  });

  it("uses the current tab identity after a rerender", () => {
    const view = render(thread("chat-old"));
    view.rerender(thread("chat-new"));
    const el = scroller(view.container);
    el.scrollTop = 110;
    jump("chat-old");
    expect(el.scrollTop).toBe(110);
    jump("chat-new");
    expect(el.scrollTop).toBe(496);
  });
});
