/**
 * "A thread, terminal or conversation became visible" — the single choke point
 * for clearing what its notifications left behind (banners, unread center
 * items), whatever route the user took: banner click, sidebar, tab switch,
 * split-pane focus, project switch, or just coming back to the window.
 *
 * Stores never call other stores, so this subscribes to the layout, terminal
 * and comms stores at the app boundary (`initSourceOpenedClearing`, started
 * from App.tsx) and derives what is on screen. Pure planning lives in
 * `resolve-rules.ts`.
 */
import { useChatStore } from "@/features/chat/stores/chat-store";

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { collectPanes, useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { isWindowFocused, onWindowFocusChange } from "@/lib/window-focus";
import { clearOpened } from "./resolve";
import { sourceKey, sourcesToClear, type OpenedSource } from "./resolve-rules";

/** Everything the user can see right now. */
function visibleSources(): OpenedSource[] {
  const out: OpenedSource[] = [];
  const layout = useLayoutStore.getState();
  const shown = new Set<string>(
    [layout.activeTabId, ...Object.values(layout.activeByGroup)].filter((t): t is string => !!t),
  );
  for (const tabId of shown) {
    const tab = layout.tabs.find((t) => t.id === tabId);
    if (tab?.type === "chat") {
      const acp = useChatStore.getState().sessions[tabId]?.acpSessionId;
      out.push({ type: "session", tabId, sessionIds: acp ? [acp] : [] });
    } else if (tab?.type === "terminal") {
      const root = useTerminalStore.getState().tabs[tabId]?.root;
      const terminalIds = root
        ? collectPanes(root).flatMap((p) => (p.activeTerminalId ? [p.activeTerminalId] : []))
        : [];
      if (terminalIds.length > 0) out.push({ type: "terminal", tabId, terminalIds });
    }
  }

  return out;
}

/** Start clearing on visibility changes. Returns the unsubscribe. */
export function initSourceOpenedClearing(): () => void {
  let seen = new Set<string>();
  const run = (sweep: boolean) => {
    const visible = visibleSources();
    // Not looking: nothing is "opened". Keep `seen` so a return sweeps.
    if (!isWindowFocused()) return;
    for (const s of sourcesToClear(seen, visible, sweep)) clearOpened(s);
    seen = new Set(visible.map(sourceKey));
  };
  const onChange = () => run(false);
  const unsubs = [
    useLayoutStore.subscribe(onChange),
    useTerminalStore.subscribe(onChange),
    onWindowFocusChange((focused) => {
      if (focused) run(true);
    }),
  ];
  run(false);
  return () => unsubs.forEach((u) => u());
}
