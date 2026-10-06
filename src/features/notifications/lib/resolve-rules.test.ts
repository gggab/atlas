import { describe, expect, it } from "vitest";
import { NO_NATIVE_CAPABILITIES, type NativeCapabilities } from "./native-capabilities";
import {
  matchesScope,
  planOpened,
  planResolved,
  sourceKey,
  sourcesToClear,
  type OpenedSource,
} from "./resolve-rules";
import type { AppNotification } from "../stores/notifications-store";

const CAN_REMOVE: NativeCapabilities = { ...NO_NATIVE_CAPABILITIES, removal: true };

const item = (p: Partial<AppNotification>): AppNotification => ({
  id: "1",
  kind: "permission",
  title: "t",
  body: "b",
  timestamp: "",
  source: "agent",
  read: false,
  ...p,
});

describe("planResolved", () => {
  const e = {
    kind: "permission" as const,
    target: { type: "session" as const, tabId: "t1", sessionId: "s1" },
    dedupeKey: "s1:r1:permission",
    markRead: [{ kind: "permission" as const, sessionId: "s1" }],
  };

  it("dismisses the toast, removes the banner by tag, marks the center read", () => {
    expect(planResolved(e, CAN_REMOVE)).toEqual({
      toastIds: ["bg-session-s1:r1:permission"],
      tags: ["permission:s1:r1:permission"],
      groups: [],
      markRead: e.markRead,
    });
  });

  it("leaves banners alone on a backend without removal, still clearing the rest", () => {
    const p = planResolved(e, NO_NATIVE_CAPABILITIES);
    expect(p.tags).toEqual([]);
    expect(p.toastIds).toHaveLength(1);
    expect(p.markRead).toEqual(e.markRead);
  });
});

describe("planOpened", () => {
  it("removes a thread's group under both its session id and tab id", () => {
    const p = planOpened({ type: "session", tabId: "t1", sessionIds: ["s1"] }, CAN_REMOVE);
    expect(p.groups).toEqual(["session:s1", "session:t1"]);
    expect(p.markRead).toEqual([{ tabId: "t1" }, { sessionId: "s1" }]);
  });

  it("works for a thread that has no session id yet", () => {
    const p = planOpened({ type: "session", tabId: "t1", sessionIds: [] }, CAN_REMOVE);
    expect(p.groups).toEqual(["session:t1"]);
  });

  it("removes each visible terminal's group", () => {
    const p = planOpened({ type: "terminal", tabId: "t", terminalIds: ["a", "b"] }, CAN_REMOVE);
    expect(p.groups).toEqual(["terminal:a", "terminal:b"]);
    expect(p.markRead).toEqual([{ terminalId: "a" }, { terminalId: "b" }]);
  });

  it("removes no group without the removal capability but still marks read", () => {
    const p = planOpened(
      { type: "terminal", tabId: "t", terminalIds: ["a"] },
      NO_NATIVE_CAPABILITIES,
    );
    expect(p.groups).toEqual([]);
    expect(p.markRead).toEqual([{ terminalId: "a" }]);
  });
});

describe("matchesScope", () => {
  it("matches by any clause, every field of a clause must agree", () => {
    const scope = [{ kind: "permission" as const, sessionId: "s1" }, { terminalId: "x" }];
    expect(matchesScope(item({ sessionId: "s1" }), scope)).toBe(true);
    expect(matchesScope(item({ sessionId: "s1", kind: "agent-done" }), scope)).toBe(false);
    expect(matchesScope(item({ kind: "terminal-failed", terminalId: "x" }), scope)).toBe(true);
    expect(matchesScope(item({ sessionId: "s2" }), scope)).toBe(false);
  });

  it("matches vendor sign-in items through their target", () => {
    const si = item({ kind: "agent-sign-in", target: { type: "agent-sign-in", agentType: "a" } });
    expect(matchesScope(si, [{ kind: "agent-sign-in", agentType: "a" }])).toBe(true);
    expect(matchesScope(si, [{ agentType: "b" }])).toBe(false);
  });

  it("matches a git-panel item by project", () => {
    const behind = item({
      kind: "git-behind",
      target: { type: "git-panel", projectId: "p1", projectName: "Atlas" },
    });
    expect(matchesScope(behind, [{ kind: "git-behind", projectId: "p1" }])).toBe(true);
    expect(matchesScope(behind, [{ kind: "git-behind", projectId: "p2" }])).toBe(false);
    expect(matchesScope(item({ kind: "git-behind" }), [{ projectId: "p1" }])).toBe(false);
  });

  it("matches nothing for an empty scope", () => {
    expect(matchesScope(item({}), [])).toBe(false);
  });
});

describe("sourcesToClear", () => {
  const a: OpenedSource = { type: "session", tabId: "a", sessionIds: [] };
  const b: OpenedSource = { type: "terminal", tabId: "b", terminalIds: ["x"] };

  it("clears only what was not already on screen", () => {
    expect(sourcesToClear(new Set([sourceKey(a)]), [a, b], false)).toEqual([b]);
  });

  it("clears everything on a sweep", () => {
    expect(sourcesToClear(new Set([sourceKey(a)]), [a, b], true)).toEqual([a, b]);
  });

  it("treats a terminal whose visible pane changed as newly opened", () => {
    const b2: OpenedSource = { type: "terminal", tabId: "b", terminalIds: ["y"] };
    expect(sourcesToClear(new Set([sourceKey(b)]), [b2], false)).toEqual([b2]);
  });
});
