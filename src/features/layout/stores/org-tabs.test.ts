// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
import { LAYOUT_TEMPLATES } from "../templates";

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
  it("reuses a local terminal within its split column", () => {
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
        id: "terminal-other",
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      const tabs = useLayoutStore.getState().tabs;
      expect(tabs).toHaveLength(1);
      expect(useLayoutStore.getState().activeTabId).toBe("terminal");
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

  it("personal assistant is global and available without a project", () => {
    expect(PROJECTLESS_TYPES.has("personal")).toBe(true);
    expect(GLOBAL_TAB_TYPES.has("personal")).toBe(true);
    expect(persistable([{ type: "personal", closable: true }])).toEqual([]);
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

describe.each(["diff", "browser"])("retired standalone %s tabs", (retiredType) => {
  it("drops the old module type while retaining editor and chat types", () => {
    expect(migrateTabType(retiredType)).toBeNull();
    expect(restorable([retiredType, "editor", "chat"])).toEqual(["editor", "chat"]);
  });

  it("drops a saved module tab from app preferences and keeps the other tabs", () => {
    const baseline = useLayoutStore.getState();
    const oldTab = {
      id: "retired:old",
      type: retiredType,
      title: retiredType,
      data: {},
      closable: true,
      dirty: false,
    };
    const restored = useLayoutStore.persist.getOptions().merge!(
      { tabs: [...baseline.tabs, oldTab], activeTabId: oldTab.id },
      baseline,
    );
    expect(restored.tabs).toEqual(baseline.tabs);
    expect(restored.activeTabId).toBe(baseline.tabs[0].id);
  });

  it("restores other project tabs when its previously active retired module was saved", async () => {
    const baseline = useLayoutStore.getState();
    vi.mocked(invoke).mockResolvedValue(
      JSON.stringify({
        tabs: [
          { id: "old-module", type: retiredType, title: retiredType, data: {} },
          { id: "kept-editor", type: "editor", title: "Notes", data: {} },
        ],
        activeByGroup: { main: "old-module" },
      }),
    );
    try {
      await useLayoutStore.getState().actions.loadEditorState("C:/test-project");
      const state = useLayoutStore.getState();
      expect(state.tabs.some((t) => t.id === "old-module")).toBe(false);
      expect(state.tabs.some((t) => t.id === "kept-editor")).toBe(true);
      expect(state.tabs.some((t) => t.id === state.activeTabId)).toBe(true);
      expect(state.activeTabId).not.toBe("old-module");
    } finally {
      useLayoutStore.setState(baseline, true);
      vi.clearAllMocks();
    }
  });
});

describe("Develop layout without new scratch buffers", () => {
  const develop = LAYOUT_TEMPLATES.find((template) => template.id === "develop")!;

  it("leaves the file column empty until a file is opened", () => {
    const baseline = useLayoutStore.getState();
    try {
      useLayoutStore.setState({ tabs: [] });
      baseline.actions.applyLayoutTemplate(develop);
      const state = useLayoutStore.getState();
      expect(state.groupOrder).toEqual(["main", "tpl-1"]);
      expect(state.activeByGroup.main).toBeNull();
      expect(state.tabs.map((tab) => tab.type)).toEqual(["chat"]);
      expect(state.tabs[0].id).toBe(state.activeByGroup["tpl-1"]);
    } finally {
      useLayoutStore.setState(baseline, true);
    }
  });

  it.each(["C:/repo/notes.md", "untitled:existing"])(
    "preserves an existing editor for %s",
    (filePath) => {
      const baseline = useLayoutStore.getState();
      const editor = {
        id: "existing",
        type: "editor" as const,
        title: "Notes",
        closable: true,
        dirty: true,
        data: { filePath },
        groupId: "main",
      };
      try {
        useLayoutStore.setState({ tabs: [editor] });
        baseline.actions.applyLayoutTemplate(develop);
        const state = useLayoutStore.getState();
        expect(state.tabs.filter((tab) => tab.type === "editor")).toEqual([editor]);
        expect(state.activeByGroup.main).toBe(editor.id);
      } finally {
        useLayoutStore.setState(baseline, true);
      }
    },
  );
});

describe("layouts without the embedded browser", () => {
  it("removes the Research preset and all browser columns", () => {
    expect(LAYOUT_TEMPLATES.map((template) => template.id)).not.toContain("research");
    expect(
      LAYOUT_TEMPLATES.flatMap((template) => template.columns.map((column) => column.type)),
    ).not.toContain("browser");
  });

  it("uses Knowledge and Chat for Zen mode and restores existing work on exit", () => {
    const baseline = useLayoutStore.getState();
    const editor = {
      id: "kept-editor",
      type: "editor" as const,
      title: "Draft",
      closable: true,
      dirty: true,
      data: { filePath: "untitled:draft" },
      groupId: "main",
    };
    try {
      useLayoutStore.setState({ tabs: [...baseline.tabs, editor] });
      baseline.actions.toggleZenMode();
      const zen = useLayoutStore.getState();
      expect(zen.groupOrder).toEqual(["zen-kb", "zen-chat"]);
      expect(
        zen.groupOrder.map((id) => zen.tabs.find((tab) => tab.id === zen.activeByGroup[id])?.type),
      ).toEqual(["knowledge", "chat"]);
      expect(zen.tabs.map((tab) => tab.type)).not.toContain("browser");
      baseline.actions.toggleZenMode();
      const restored = useLayoutStore.getState();
      expect(restored.zen).toBe(false);
      expect(restored.groupOrder).toEqual(baseline.groupOrder);
      expect(restored.activeByGroup).toEqual(baseline.activeByGroup);
      expect(restored.tabs.find((tab) => tab.id === editor.id)).toEqual(editor);
      expect(restored.leftPanel).toEqual(baseline.leftPanel);
      expect(restored.rightPanel).toEqual(baseline.rightPanel);
    } finally {
      useLayoutStore.setState(baseline, true);
    }
  });
});
