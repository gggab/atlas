// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
const respondPermission = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  return { agents: { ...real.agents, respondPermission } };
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

const OPTIONS = [
  { optionId: "allow-once", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Decline", kind: "reject_once" },
];

function pending(toolName: string, title: string) {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "claude-acp", messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: "claude-acp",
          acpSessionId: "sess-1",
          requestId: "req-1",
          toolCall: {
            toolCallId: "call-1",
            title,
            kind: "other",
            toolName,
            rawInput: { to: "general", body: "deploy is green" },
            content: ["#general, a channel", "deploy is green"],
          },
          options: OPTIONS,
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

const picked = () =>
  (
    respondPermission.mock.calls as unknown as [unknown, unknown, unknown, { option_id?: string }][]
  ).map((call) => call[3].option_id ?? "cancelled");

beforeEach(() => respondPermission.mockClear());
afterEach(cleanup);

describe("keys on the permission card", () => {
  /// L7: the keys listen on the whole window, so an Enter meant for the
  /// composer as a permission card appeared would have posted in the user's
  /// name. Allow on that card is a click.

  /// Found in the live run: with Enter no longer taken as Allow, it fell
  /// through to the composer, where Enter on an empty field is Stop — the
  /// card was cancelled and the turn ended. The card keeps its keys.

  it("a permission card is allowed by a click, and declined by its digit", () => {
    pending("shell", "Run a command");
    fireEvent.keyDown(window, { key: "2" });
    expect(picked()).toEqual(["reject"]);
  });

  it("a permission card's Allow button still works", () => {
    pending("shell", "Run a command");
    fireEvent.click(screen.getByText("Allow"));
    expect(picked()).toEqual(["allow-once"]);
  });

  it("any other card keeps Enter for Allow", () => {
    pending("shell", "rm -rf build");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(picked()).toEqual(["allow-once"]);
  });
});
