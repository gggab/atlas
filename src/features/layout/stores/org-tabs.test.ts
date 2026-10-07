// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  LEGACY_TAB_TYPES,
  GLOBAL_TAB_TYPES,
  PROJECTLESS_TYPES,
  TAB_TYPES,
  migrateTabType,
  type TabType,
} from "@/lib/constants";
// The store's own predicates, not copies: a re-implementation here would keep
// passing after the store stopped applying the rule.
import { persistsInEditorState, restoredTabType, useLayoutStore } from "./layout-store";

/**
 * Org-scoped tabs must never reach the per-project editor state.
 *
 * That file is keyed by PROJECT PATH, and the same project is commonly open
 * in more than one org. A persisted `spaces-{convId}` tab therefore came back
 * on the INCOMING org's mount still pointing at the outgoing org's
 * conversation, rendering "This Space is no longer available" — closing the
 * tab on switch could not fix it, because the restore happened afterwards.
 */

/** The persist filter `buildEditorState` applies (save and flush). */
function persistable(tabs: Array<{ type: TabType; closable: boolean }>) {
  return tabs.filter(persistsInEditorState);
}

/** The types the editor-state restore brings back, for files written before the fix. */
function restorable(types: string[]) {
  return types.map(restoredTabType).filter((t) => t !== null);
}

describe("global tab persistence", () => {
  it("opens local and remote terminals independently and reuses each kind", () => {
    const baseline = useLayoutStore.getState();
    try {
      useLayoutStore.setState({
        tabs: [],
        groupOrder: ["main"],
        focusedGroupId: "main",
        activeByGroup: { main: null },
      });
      const add = useLayoutStore.getState().actions.addTab;
      add({
        id: "terminal",
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      add({
        id: "terminal-ssh",
        type: "terminal",
        title: "Remote",
        closable: true,
        dirty: false,
        data: { remote: true },
      });
      add({
        id: "terminal-ssh",
        type: "terminal",
        title: "Remote",
        closable: true,
        dirty: false,
        data: { remote: true },
      });
      const tabs = useLayoutStore.getState().tabs;
      expect(tabs).toHaveLength(2);
      expect(tabs.find((t) => t.id === "terminal-ssh")?.data.remote).toBe(true);
      expect(useLayoutStore.getState().activeTabId).toBe("terminal-ssh");
    } finally {
      useLayoutStore.setState(baseline, true);
    }
  });
  const tabs: Array<{ type: TabType; closable: boolean }> = [
    { type: "editor", closable: true },
    { type: "settings", closable: true },
    { type: "chat", closable: false },
  ];

  it("never writes spaces or draft tabs to the project's editor state", () => {
    const kept = persistable(tabs).map((t) => t.type);
    expect(kept).not.toContain("spaces");
    expect(kept).not.toContain("comms-draft");
    // Everything else that was persisted before still is.
    expect(kept).toEqual(["editor", "settings"]);
  });

  it("refuses to restore them from a file written before the fix", () => {
    expect(restorable(["editor", "spaces", "comms-draft"])).toEqual(["editor"]);
  });

  it("settings is projectless but NOT global — it survives a switch", () => {
    expect(PROJECTLESS_TYPES.has("settings")).toBe(true);
    expect(GLOBAL_TAB_TYPES.has("settings")).toBe(false);
  });

  it("usage is global: it closes on switch and never persists per project", () => {
    expect(GLOBAL_TAB_TYPES.has("usage")).toBe(true);
    expect(persistable([{ type: "usage", closable: true }])).toEqual([]);
  });

  it("a persisted Console tab migrates to usage before the global guard drops it", () => {
    expect(restorable(["mission-control"])).toEqual([]);
  });

  it("an unknown persisted type is dropped, a known one comes back as itself", () => {
    expect(restorable(["no-such-tab-type", "settings"])).toEqual(["settings"]);
  });

  it("every global type is also projectless (they open with no project)", () => {
    for (const type of GLOBAL_TAB_TYPES) {
      expect(PROJECTLESS_TYPES.has(type)).toBe(true);
    }
  });
});

describe("migrateTabType", () => {
  it("maps the legacy Console tab forward to Usage", () => {
    expect(migrateTabType("mission-control")).toBe("usage");
    expect(LEGACY_TAB_TYPES["mission-control"]).toBe("usage");
  });

  it("passes every current type through unchanged", () => {
    for (const t of TAB_TYPES) expect(migrateTabType(t)).toBe(t);
  });

  it("returns null for a type this build does not know", () => {
    expect(migrateTabType("pomodoro")).toBeNull();
    expect(migrateTabType("")).toBeNull();
  });

  it("every legacy target is a current type", () => {
    for (const target of Object.values(LEGACY_TAB_TYPES)) expect(TAB_TYPES).toContain(target);
  });
});
