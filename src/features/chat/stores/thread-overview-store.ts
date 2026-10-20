// State for the thread overview — the rail docked to the right of a chat.
//
// Its own store, for the same reason `detail-panel-store` is: opening,
// resizing or collapsing a section must not re-render a single transcript row.
// Rows never subscribe here, and the rail never subscribes to the transcript's
// projection — the two surfaces share the chat store's data and nothing else.
//
// What the rail is FOR: the questions a long turn raises that the thread
// itself answers badly because the answer is scattered through it — how many
// children are running, what this turn has changed, what it remembered, where
// the checkpoints are. Claude Desktop's right rail ("Background tasks · 3
// running") and t3code's thread details panel are the two references.

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createSelectors } from "@/lib/create-selectors";

/**
 * The sections the rail can show, in the order it shows them.
 *
 * A closed vocabulary, like `RowKind`: a new section is a deliberate addition
 * here, not a branch inside the panel. The order is the reading order — live
 * work first (it changes while you watch), the record of the turn after it,
 * actions last.
 */
export const OVERVIEW_SECTIONS = ["subagents", "changes"] as const;

export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number];

/** Titles live with the vocabulary so a section cannot be added without one. */
export const SECTION_TITLE: Record<OverviewSection, string> = {
  subagents: "Subagents",
  changes: "Changes",
};

// Not here yet, deliberately: CHECKPOINTS. A chat tab is keyed by its ACP
// session; a checkpoint is keyed by the CAPTURED session the Timeline records,
// and the two are joined through `AnchorEntry` rather than being the same id.
// Until that join is read on this path a checkpoints section would render
// empty for every chat, which is worse than not offering it.

interface ThreadOverviewState {
  /** Open, keyed by chat tab id — each tab owns its own rail, like the detail
   *  panel. Absent means closed. */
  open: Record<string, true>;
  /** Shared across tabs: a column width is a property of the window, and a
   *  rail that changed width per tab would jump on every tab switch. */
  width: number;
  /** Collapsed sections, shared across tabs and persisted — which sections a
   *  reader cares about is a preference, not a per-chat fact. */
  collapsed: Partial<Record<OverviewSection, true>>;
  actions: {
    toggle: (tabId: string) => void;
    open_: (tabId: string) => void;
    close: (tabId: string) => void;
    setWidth: (w: number) => void;
    toggleSection: (section: OverviewSection) => void;
    /** Drop a tab's rail state when its chat tab closes. */
    forget: (tabId: string) => void;
  };
}

export const OVERVIEW_MIN_WIDTH = 240;
export const OVERVIEW_MAX_WIDTH = 480;
const DEFAULT_WIDTH = 300;

const clampWidth = (w: number) =>
  Math.min(OVERVIEW_MAX_WIDTH, Math.max(OVERVIEW_MIN_WIDTH, Math.round(w)));

export const useThreadOverviewStore = createSelectors(
  create<ThreadOverviewState>()(
    persist(
      (set) => ({
        open: {},
        width: DEFAULT_WIDTH,
        collapsed: {},
        actions: {
          toggle: (tabId) =>
            set((s) => {
              const open = { ...s.open };
              if (open[tabId]) delete open[tabId];
              else open[tabId] = true;
              return { open };
            }),
          open_: (tabId) => set((s) => ({ open: { ...s.open, [tabId]: true } })),
          close: (tabId) =>
            set((s) => {
              const open = { ...s.open };
              delete open[tabId];
              return { open };
            }),
          setWidth: (w) => set({ width: clampWidth(w) }),
          toggleSection: (section) =>
            set((s) => {
              const collapsed = { ...s.collapsed };
              if (collapsed[section]) delete collapsed[section];
              else collapsed[section] = true;
              return { collapsed };
            }),
          forget: (tabId) =>
            set((s) => {
              if (!s.open[tabId]) return s;
              const open = { ...s.open };
              delete open[tabId];
              return { open };
            }),
        },
      }),
      {
        name: "atlas.chat.thread-overview",
        // `open` is deliberately NOT persisted: tab ids are per-run, so a
        // restored map would be a set of keys no tab answers to, and a rail
        // that reopens itself on launch is a surface the user did not ask for
        // in this session. Width and collapse state are preferences and do
        // survive.
        partialize: (s) => ({ width: s.width, collapsed: s.collapsed }),
      },
    ),
  ),
);
