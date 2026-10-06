import { describe, expect, it } from "vitest";
import type { NotificationTarget } from "./catalog";
import { encodeBannerPayload, targetForResponse } from "./native-routing";

const click = (payload: string | null, actionId: string | null = null) => ({
  tag: "t",
  actionId,
  payload,
});

describe("banner payload round trip", () => {
  it("rebuilds a terminal target in another project", () => {
    const target: NotificationTarget = {
      type: "terminal",
      tabId: "tab-1",
      terminalId: "pty-2",
      projectId: "proj-b",
      projectName: "b",
    };
    expect(targetForResponse(click(encodeBannerPayload(target)))).toEqual(target);
  });

  it("rebuilds an agent session target", () => {
    const target: NotificationTarget = { type: "session", tabId: "tab-9", sessionId: "s" };
    expect(targetForResponse(click(encodeBannerPayload(target)))).toEqual(target);
  });

  it("rebuilds the app-level targets (sign-in, Chat), which own no tab", () => {
    for (const target of [
      { type: "agent-sign-in", agentType: "cursor" },

      { type: "settings", section: "models" },
      { type: "settings", section: "agents" },
      { type: "config-file" },
      { type: "git-panel", projectId: "p1", projectName: "Atlas" },
    ] satisfies NotificationTarget[]) {
      expect(targetForResponse(click(encodeBannerPayload(target)))).toEqual(target);
    }
  });
});

describe("targetForResponse", () => {
  const good = encodeBannerPayload({ type: "session", tabId: "t" });

  it("ignores action-button responses", () => {
    expect(targetForResponse(click(good, "allow"))).toBeNull();
  });

  it("ignores missing, malformed and foreign payloads", () => {
    expect(targetForResponse(click(null))).toBeNull();
    expect(targetForResponse(click("{not json"))).toBeNull();
    expect(targetForResponse(click('"str"'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"session"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"terminal","tabId":"t"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"x","tabId":"t"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"git-panel"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"settings","section":"x"}}'))).toBeNull();
    expect(targetForResponse(click('{"target":{"type":"agent-sign-in"}}'))).toBeNull();
  });
});
