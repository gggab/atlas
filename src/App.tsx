import { startTransition, useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AppLayout } from "@/features/layout/components/app-layout";
import { AppContextMenu } from "@/components/app-context-menu";
import { TooltipProvider } from "@/ui/tooltip";
import { CommandPalette } from "@/components/command-palette";
import { NewTabPalette } from "@/components/new-tab-palette";
import { LayoutSwitcher } from "@/features/layout/components/layout-switcher";
import { SearchOverlay } from "@/components/search-overlay";
import { useActionHotkeys } from "@/hooks/use-hotkey";
import {
  useKeybindingsStore,
  watchKeybindingsOnFocus,
} from "@/features/keybindings/stores/keybindings-store";
import { KeymapOnboarding } from "@/features/keybindings/components/keymap-onboarding";
import { useNativeCloseTabAccelerator } from "@/features/keybindings/lib/use-native-close-tab-accelerator";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import {
  useAppStore,
  setAppStateWritable,
  type AppStateWire,
} from "@/features/app/stores/app-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import {
  listenAgents,
  pluginIdForAgentId,
  resetAgentByAgentId,
} from "@/features/chat/lib/agents-api";
import type { PendingPermission } from "@/types/acp";
import type { AgentDelta } from "@/types/agents";
import { cycleChatAgent } from "@/features/chat/lib/switch-agent";
import { FilePicker } from "@/features/file-picker/components/file-picker";
import { HintOverlay } from "@/features/hint-nav/components/hint-overlay";
import { BrowserOverlayWatcher } from "@/features/browser/components/browser-overlay-watcher";
import {
  fileIndex,
  openFileIndex,
  markFileIndexClosed,
} from "@/features/file-picker/lib/file-picker-api";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { instructionSync } from "@/features/projects/lib/instruction-sync-api";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { pickAndAddProject } from "@/features/projects/lib/pick-project";
import { flushAll } from "@/features/projects/lib/flush-registry";
import { captureSnapshot } from "@/features/projects/lib/project-snapshot";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useGitStore } from "@/features/git/stores/git-store";
import { listen } from "@tauri-apps/api/event";
import {
  useRecentFilesStore,
  ensureRecentFilesListener,
  type RecentFile,
} from "@/features/chat/stores/recent-files-store";
import { useRecentChatsStore } from "@/features/projects/stores/recent-chats-store";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { pruneContextUsageCache } from "@/features/chat/lib/context-usage-cache";
import { isScrollHot } from "@/lib/scroll-hot";
import { isWindows, isLinux } from "@/lib/platform";
import { loadAppProfile, useAppProfile } from "@/lib/app-profile";
import type { CliStatus } from "@/features/settings/components/settings-panel";
import { basename } from "@/lib/paths";
import {
  hydrateAgentRegistry,
  setAgentUpdatePhase,
  startCatalogListener,
} from "@/features/agents/stores/agent-registry-store";
import { AgentOAuthModalHost } from "@/features/agents/components/agent-oauth-modal";
import { watchRemovedAgents } from "@/features/chat/lib/removed-agents";
import { AgentElicitationHost } from "@/features/chat/components/agent-elicitation-host";
import { initWindowFocusTracking, isWindowFocused } from "@/lib/window-focus";
import { initDockBadgeClearing } from "@/lib/dock-badge";
import { primeNativeNotificationPermission } from "@/lib/native-notify";
import {
  isStaleAgentTurn,
  notifyAgentEvent,
  resolveAgentPermission,
} from "@/features/notifications/lib/agent-notifier";
import { initSourceOpenedClearing } from "@/features/notifications/lib/source-opened";
import {
  notifyAgentUpdateFailed,
  startAppWarnings,
} from "@/features/notifications/lib/app-warning-notifier";
import { notifyModelDownload } from "@/features/notifications/lib/outcome-notifier";
import { logEvent } from "@/features/log/lib/log";
import { warmMarkdownWorker, primeMarkdownRenderer } from "@/lib/markdown-cache";
import { primeMarkdown } from "@/lib/markdown";
import { NotificationPanel } from "@/features/notifications/components/notification-panel";
import { StopAgentsDialog } from "@/features/projects/components/stop-agents-dialog";
import { RemoveAgentDialog } from "@/features/agents/components/remove-agent-dialog";

import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { Toaster, toast } from "sonner";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { IconThemeFonts } from "@/features/icon-theme/components/file-icon";
import { clampScale, SCALE_STEP, DEFAULT_SCALE } from "@/features/settings/lib/ui-scale";
import { listenModelDone } from "@/features/settings/lib/models-api";
import { useModelsStore } from "@/features/settings/stores/models-store";

// Interface-zoom helpers (⌘+/⌘-/⌘0). They read + write the persisted
// `uiScale` setting; `updateSettings` applies it to the native WebView zoom.
function stepZoom(delta: number) {
  const { settings, actions } = useSettingsStore.getState();
  actions.updateSettings({ uiScale: clampScale(settings.uiScale + delta) });
}
const zoomIn = () => stepZoom(SCALE_STEP);
const zoomOut = () => stepZoom(-SCALE_STEP);
const zoomReset = () =>
  useSettingsStore.getState().actions.updateSettings({ uiScale: DEFAULT_SCALE });

export function App() {
  // Own model download listeners at app scope so completion notifications are
  // delivered even when Settings is closed.
  useEffect(() => {
    void useModelsStore.getState().actions.init();
    const off = listenModelDone(notifyModelDownload);
    return () => void off.then((f) => f());
  }, []);

  // App warnings (auto-fetch failing, behind remote, config.toml errors).
  useEffect(() => startAppWarnings(), []);

  // Keybinding profiles: load once, then pick up hand edits to
  // keybindings.json whenever the window regains focus.
  useEffect(() => {
    void useKeybindingsStore.getState().actions.load();
    return watchKeybindingsOnFocus();
  }, []);
  useNativeCloseTabAccelerator();

  // No Claude probe here any more. It used to run at boot to drive a banner
  // above the composer and hard-disable the input; both are gone, and probing
  // meant a fresh install spawned subprocesses for an agent it does not have
  // (ADR-0002). The one caller that still needs the answer — the post-auth
  // re-check in `agent-auth-hooks` — asks for it itself.
  useEffect(() => {
    // Agent identity registry (the native agent + registry-installed
    // externals):
    // hydrate once so pickers/glyphs/memory dropdown resolve external
    // metadata; the marketplace re-hydrates after installs.
    void hydrateAgentRegistry();
    // …and stay current: discovery finishes after boot, and installs /
    // acquisitions / settings toggles all change how an agent launches.
    startCatalogListener();
    // An uninstall drops the agent's connection with no delta to any tab on
    // it; the catalog shrinking is what settles those tabs.
    return watchRemovedAgents();
  }, []);

  // Refresh the `atlas` CLI helper at `~/.local/bin/atlas` on every
  // launch. Fire-and-forget; an older or hand-edited copy gets
  // replaced with the current version. Failures are non-fatal — the
  // app still works without the helper, the user just can't type
  // `atlas ./` in their terminal until they hit the install button
  // in Settings → General. Not on Windows: the helper is a bash script
  // (see `commands::cli::cli_install_helper`). On Linux, skip if a
  // system-wide /usr/bin/atlas exists so ~/.local/bin/atlas does not shadow it.
  // Not from the dev profile either: the helper is the released app's, and
  // Rust refuses to install it from a dev build (`cli_install_helper`).
  useEffect(() => {
    if (isWindows) return;
    void loadAppProfile()
      .then(async (profile) => {
        if (profile.dev) return;
        const status = await invoke<CliStatus>("cli_status");
        // If installed system-wide outside ~/.local/ (e.g. /usr/bin/atlas on Linux), don't shadow it
        if (status?.installed && status.path && !status.path.includes("/.local/")) return;
        // If already installed and up to date on Linux, skip (macOS re-runs to self-heal edited/deleted helpers)
        if (isLinux && status?.installed && status.installedVersion === status.currentVersion)
          return;
        return invoke("cli_install_helper");
      })
      .catch((e) => {
        console.warn("atlas CLI helper refresh failed:", e);
      });
  }, []);

  // Warm-launch CLI: when `atlas <path>` runs while Atlas is already open, the
  // Rust single-instance callback forwards the folder here. The app is already
  // hydrated, so we just ADD it to the project list and switch to it (no race
  // with hydration). `openProject` → `addProject` dedupes by path.
  useEffect(() => {
    const unlisten = listen<string>("atlas:cli-open-project", (event) => {
      const path = event.payload;
      if (!path) return;
      logEvent({
        source: "atlas",
        kind: "cli-launch-open-project",
        summary: `Adding project from CLI (warm launch): ${path}`,
        status: "success",
        payload: { path },
      });
      void useAppStore.getState().actions.openProject(path);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // Close-active-tab from the native menu (Cmd+W). The embedded browser is a
  // separate native webview, so its Cmd+W can't reach the React `useHotkeys`
  // handler — it falls through to the menu's "Close Tab" item, which emits this
  // event. Mirrors the Cmd+W hotkey: close whichever tab is active.
  useEffect(() => {
    const unlisten = listen("atlas:close-active-tab", () => {
      const current = useLayoutStore.getState().activeTabId;
      if (current) requestCloseTab(current);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  // NOTE: we intentionally do NOT wipe localStorage on boot anymore. Several
  // stores legitimately persist there via zustand `persist` — the project
  // "Chats" list (`atlas-recent-chats`), layout prefs (`atlas-layout-prefs`),
  // the review provider/model selection — and a blanket clear was silently
  // dropping all of them on every restart. Each store carries its own
  // `version`/`migrate`, so stale keys from old builds are handled per-store.

  // One-shot bootstrap of the Rust-owned `AppState` (currentProject +
  // recentProjects). Replaces the zustand `persist` middleware that used
  // to hydrate from localStorage. The Tauri invoke is async but fast
  // (~5–20 ms warm); until it resolves the WelcomeScreen and project-aware
  // panels render their empty/loading states.
  //
  // `startTransition` marks the welcome → project layout swap as non-urgent
  // so React can pause reconciliation between component subtrees and keep
  // the welcome UI interactive while the project layout mounts.
  //
  // Once hydration is done (success or failure) we dispatch `atlas:app-ready`
  // — the inline script in `index.html` listens for it and removes the
  // boot skeleton.
  useEffect(() => {
    let cancelled = false;
    const signalReady = () => {
      const flag = window as unknown as { __atlasAppReady?: boolean };
      if (flag.__atlasAppReady) return;
      flag.__atlasAppReady = true;
      window.dispatchEvent(new CustomEvent("atlas:app-ready"));
    };

    (async () => {
      // A terminal `atlas <path>` launch stashes the path in Rust (single-shot,
      // so a window reload won't re-trigger). Consume it BEFORE hydrating: the
      // CLI project must be ADDED to the project list and switched to, but
      // hydrate replaces that list and fires its own `switchTo` — which would
      // both clobber the CLI project and swallow the CLI switch (`switching`
      // guard). So we suppress hydrate's auto-switch when a CLI path is present
      // and perform the CLI open as the sole, final switch.
      const cliPath = await invoke<string | null>("cli_take_initial_project_path").catch(
        () => null,
      );
      // `bootstrap_app_state` is the only read of `state.json` Atlas ever
      // performs, so a failure here is NOT "start empty and carry on": the
      // stores keep their empty defaults, `AppState::apply_patch` replaces the
      // persisted lists wholesale, and the unconditional quit flush would then
      // write that emptiness over the user's real projects and orgs. Retry
      // first — a transient IPC hiccup shouldn't cost a session.
      let snapshot: AppStateWire | null = null;
      for (let attempt = 1; attempt <= 3 && !snapshot; attempt++) {
        try {
          snapshot = await invoke<AppStateWire>("bootstrap_app_state");
        } catch (e) {
          console.warn(`bootstrap_app_state attempt ${attempt} failed:`, e);
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
          }
        }
      }
      if (cancelled) return;
      try {
        if (snapshot) {
          const payload = snapshot;
          startTransition(() => {
            // The stores are about to hold the user's real state, so writing
            // them back is safe from here on. Before this line they hold empty
            // defaults and persistence is denied — see `appStateWritable`.
            setAppStateWritable(true);
            useAppStore.getState().actions.hydrate(payload, { skipActiveSwitch: !!cliPath });
          });
        } else {
          // Every attempt failed. Come up in an explicitly READ-ONLY session
          // rather than letting the empty stores overwrite `state.json`: the
          // user's projects and orgs are still on disk, and a restart is what
          // brings them back. Without this the app looks merely "empty" and
          // then makes that permanent on quit.
          setAppStateWritable(false);
          logEvent({
            source: "atlas",
            kind: "bootstrap-failed",
            summary: "bootstrap_app_state failed after 3 attempts; app-state writes suspended",
            status: "failure",
          });
          toast.error(
            "Atlas couldn't load your projects. Your saved data is safe on disk — restart Atlas to get it back.",
            { duration: Infinity },
          );
          startTransition(() => {
            useAppStore.getState().actions.hydrate(
              {
                currentProject: null,
                recentProjects: [],
                version: 1,
              },
              { skipActiveSwitch: !!cliPath },
            );
          });
        }
      } finally {
        if (!cancelled) {
          // Only open the CLI path when we actually have a snapshot. Without
          // one there is no org to own the project, so `addProject` would
          // refuse anyway — and its "no organisation" toast would bury the
          // boot-failure one that actually tells the user what to do.
          if (cliPath && snapshot) {
            logEvent({
              source: "atlas",
              kind: "cli-launch-open-project",
              summary: `Adding project from CLI argv: ${cliPath}`,
              status: "success",
              payload: { path: cliPath },
            });
            await useAppStore
              .getState()
              .actions.openProject(cliPath)
              .catch((err) => {
                logEvent({
                  source: "atlas",
                  kind: "cli-launch-open-project-failed",
                  summary: `openProject failed: ${String(err)}`,
                  status: "failure",
                  payload: { error: String(err) },
                });
              });
          }
          signalReady();
          // First paint is done — pull in the main-thread markdown renderer
          // now so the first small chat block still parses synchronously. It
          // is deliberately NOT a static import (it would land in the eager
          // entry chunk); see `primeMarkdownRenderer`.
          primeMarkdownRenderer();
          primeMarkdown();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [newTabPaletteOpen, setNewTabPaletteOpen] = useState(false);
  // The project rail's "Open module" row opens the same palette ⌘⌥N does.
  // The palette's state lives here, so the rail asks for it by event rather
  // than the state being lifted into a store for one caller.
  useEffect(() => {
    const open = () => setNewTabPaletteOpen(true);
    window.addEventListener("atlas:new-tab-palette", open);
    return () => window.removeEventListener("atlas:new-tab-palette", open);
  }, []);
  // Same arrangement for ⌘K: the rail's org-row search button asks for the
  // command palette by event, because the palette's open state lives here and
  // one caller does not justify lifting it into a store.
  useEffect(() => {
    const open = () => setCommandPaletteOpen(true);
    window.addEventListener("atlas:command-palette", open);
    return () => window.removeEventListener("atlas:command-palette", open);
  }, []);
  const [layoutSwitcherOpen, setLayoutSwitcherOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const {
    toggleLeftPanel,
    toggleRightPanel,

    toggleChatSidebar,
    toggleTabBar,
    addTab,
    setActiveTab,
    activateTabByIndex,
    cycleTab,
    addGroup,
    closeGroup,
    focusAdjacentGroup,
    toggleZenMode,
  } = useLayoutStore.use.actions();
  const tabs = useLayoutStore.use.tabs();
  const activeTabId = useLayoutStore.use.activeTabId();
  const groupOrder = useLayoutStore.use.groupOrder();
  const focusedGroupId = useLayoutStore.use.focusedGroupId();

  // ⌘J — toggle the terminal WITHIN the focused split column (not a global
  // instance), so it respects which pane you're working in.
  const toggleTerminal = () => {
    const st = useLayoutStore.getState();
    const g = st.focusedGroupId;
    const groupOf = (t: { groupId?: string }) => t.groupId ?? "main";
    const groupTabs = st.tabs.filter((t) => groupOf(t) === g);
    const activeTab = st.tabs.find((t) => t.id === st.activeByGroup[g]);

    const focusTerminalSoon = (tabId: string) => {
      useTerminalStore.getState().actions.requestTerminalFocus(tabId);
    };

    if (activeTab?.type === "terminal") {
      // Toggle away: the most-recent non-terminal tab in THIS column (history),
      // else the first non-terminal tab in the column.
      const back = [...st.tabHistory].reverse().find((id) => {
        const t = st.tabs.find((x) => x.id === id);
        return t && groupOf(t) === g && t.type !== "terminal";
      });
      const target = back ?? groupTabs.find((t) => t.type !== "terminal")?.id;
      if (target) setActiveTab(target);
      return;
    }

    const existing = groupTabs.find((t) => t.type === "terminal");
    if (existing) {
      setActiveTab(existing.id);
      focusTerminalSoon(existing.id);
    } else {
      const newTabId = `terminal-${Date.now()}`;
      addTab({
        id: newTabId,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      });
      focusTerminalSoon(newTabId);
    }
  };
  const currentProject = useAppStore.use.currentProject();

  // Global agent event bus. One listener routes atlas-agents SessionDelta
  // events into the chat-store, queues permission requests for the
  // PermissionModal, and resets the lazy agent handle on disconnect.
  //
  // ACP events arrive at the rate the agent streams them — for a
  // tool-heavy turn (e.g. "read 30 files") that's ~60 `tool_call` /
  // `tool_call_update` events plus a continuous text chunk stream. Per
  // event without batching: 1 immer draft + 1 subscriber notification
  // + 1 `MessagesList` re-render (and the virtualizer's
  // `measureElement` runs). On a fast turn that pegs the main thread.
  //
  // Coalesce every frame via RAF and apply the whole batch in ONE
  // immer pass through `applyAgentBatch`. Dedup `tool_call_upserted`
  // by `(session, tool_call.id)` (last-write-wins, original position
  // preserved) so a tool that flips through pending → running →
  // completed in a single frame only contributes once. Other deltas
  // go in strict wire order — `message_appended` before subsequent
  // tool calls so a new assistant message anchors them correctly,
  // etc.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    // All deltas — text/thinking chunks INCLUDED — buffer here in strict wire
    // order. Consecutive same-session text (or thinking) chunks coalesce into
    // the trailing entry, but a `message_appended`/tool delta between two text
    // runs breaks the run so ordering is preserved. (Previously text was
    // bucketed separately and applied BEFORE other deltas, which reordered the
    // anchoring `message_appended` after its text — invisible for ACP agents
    // whose IPC latency spread deltas across frames, but the in-process native
    // agent emits a whole turn in one frame and the text shattered into
    // mis-ordered fragments.)
    const pendingDeltas: AgentDelta[] = [];
    const toolDeltaPos = new Map<string, number>(); // dedup key → index in pendingDeltas
    const outputChunkPos = new Map<string, number>(); // live-output coalesce key → index
    let rafId: number | null = null;
    /** Timer drain that survives RAF being paused — see `schedule` below. */
    let backstopId: ReturnType<typeof setTimeout> | null = null;

    // Native window focus + the "cold wake" signal live in `src/lib/window-focus.ts`
    // now — the terminal notifier needs the same answer this file did.
    const stopFocusTracking = initWindowFocusTracking();
    const stopBadgeClearing = initDockBadgeClearing();
    // Opening a thread/terminal/conversation clears its stale banners + unread items.
    const stopSourceOpened = initSourceOpenedClearing();

    // ── Idle-while-focused cold wake ─────────────────────────────────────────
    // The focus/visibility edges above never fire when Atlas stays the focused,
    // visible window through a long idle stretch (the user steps away without
    // switching apps or Spaces). WebKit still throttles the idle main thread and
    // the OS can reclaim JIT/worker pages, so the first interactions on return
    // are cold and recover only gradually (the "slow for ~10-15s" symptom). Two
    // mitigations:
    //   1. Fire the same warm-up on the FIRST real interaction after an idle gap
    //      so the whole pipeline (chat virtualizer, graphs, markdown worker)
    //      warms at once instead of path-by-path as each is lazily exercised.
    //   2. While focused+visible, ping the markdown worker on an idle cadence so
    //      WebKit doesn't suspend it out from under us (a suspended worker costs
    //      a 3s watchdog → main-thread sync fallback on the first big message).
    const IDLE_RETURN_MS = 30_000;
    const KEEP_WARM_MS = 20_000;
    const signalActive = () => window.dispatchEvent(new CustomEvent("atlas:window-active"));
    let lastActivityAt = Date.now();
    const onUserActivity = () => {
      const now = Date.now();
      if (now - lastActivityAt > IDLE_RETURN_MS) signalActive();
      lastActivityAt = now;
    };
    // Discrete inputs only (not pointermove) to keep this effectively free.
    window.addEventListener("pointerdown", onUserActivity, { passive: true });
    window.addEventListener("keydown", onUserActivity, { passive: true });
    window.addEventListener("wheel", onUserActivity, { passive: true });
    const keepWarm = window.setInterval(() => {
      if (isWindowFocused() && document.visibilityState === "visible") {
        warmMarkdownWorker();
      }
    }, KEEP_WARM_MS);

    // Housekeeping, well off the startup critical path: sweep stale
    // per-session context-usage gauges out of localStorage (they had no
    // other removal path and grew one key per session forever).
    const pruneTimer = window.setTimeout(() => pruneContextUsageCache(), 15_000);

    // Establish notification permission EAGERLY at startup (see native-notify.ts
    // for why lazy asking lost the first real background notification).
    void primeNativeNotificationPermission();
    /** Longest a batch may be held for an active scroll gesture. Bounded so a
     *  continuous fling can never starve the stream — worst case the reader
     *  sees updates land ~2-3× per second instead of per frame while flicking. */
    const SCROLL_HOLD_MAX_MS = 400;
    /** When the oldest un-flushed delta was buffered (null = buffer empty). */
    let oldestBufferedAt: number | null = null;

    const flush = (force = false) => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (backstopId !== null) {
        clearTimeout(backstopId);
        backstopId = null;
      }
      if (pendingDeltas.length === 0) {
        oldestBufferedAt = null;
        return;
      }
      // Mid-fling, hold the batch: applying it re-renders ChatPanel →
      // Transcript → a reconcile of every mounted row, and when that lands in
      // a momentum-scroll frame WKWebView misses tile deadlines — the
      // viewport blanks. Deltas keep buffering; they land the moment the
      // gesture goes quiet or the hold cap expires.
      if (
        !force &&
        isScrollHot() &&
        oldestBufferedAt !== null &&
        performance.now() - oldestBufferedAt < SCROLL_HOLD_MAX_MS
      ) {
        backstopId = setTimeout(flush, 100);
        return;
      }
      oldestBufferedAt = null;
      const deltas = pendingDeltas.slice();
      pendingDeltas.length = 0;
      toolDeltaPos.clear();
      outputChunkPos.clear();
      try {
        useChatStore.getState().actions.applyAgentBatch({ texts: [], thoughts: [], deltas });
      } catch (e) {
        // The batch is already out of the buffer, so it is lost either way —
        // re-queueing a batch that throws would just loop on it forever. What
        // must NOT happen is the exception escaping into the RAF/timer callback
        // and taking the scheduler down with it: every later delta would then
        // buffer against a drain that never runs again, which presents as the
        // thread freezing mid-turn.
        console.error("applyAgentBatch failed; dropped", deltas.length, "deltas:", e);
      }
    };
    // Coalesce a streaming text/thinking chunk into the trailing pendingDeltas
    // entry when it's the same kind + session; otherwise append in order. Keeps
    // the per-frame coalescing win without divorcing text from its wire order.
    const bufferChunk = (env: AgentDelta) => {
      const last = pendingDeltas[pendingDeltas.length - 1];
      if (
        last &&
        (last.kind === "text_chunk" || last.kind === "thinking_chunk") &&
        last.kind === env.kind &&
        last.session_id === env.session_id
      ) {
        pendingDeltas[pendingDeltas.length - 1] = {
          ...last,
          delta: last.delta + (env as typeof last).delta,
        };
      } else {
        pendingDeltas.push(env);
      }
    };
    // Two independent drains, because RAF alone is not a guarantee that the
    // buffer is ever emptied.
    //
    // WebKit pauses `requestAnimationFrame` whenever the WKWebView isn't
    // frontmost — not just when it's hidden. A user who leaves Atlas on screen
    // while working in another app is watching a window whose RAF queue is
    // stopped: deltas keep arriving over IPC and keep buffering, and NOTHING
    // renders. The whole turn then lands in one batch the instant something
    // wakes the webview, which reads as "it was stuck, then it caught up".
    // `atlas:window-active` covered part of this, but only on a focus/visibility
    // edge — it can't help a reader watching an unfocused window.
    //
    // `setTimeout` is throttled in that state (to roughly a second) but never
    // paused, so it is the drain that always eventually fires. When RAF is
    // healthy it wins every race and clears the backstop, so this costs one
    // cancelled timer per frame and changes nothing about normal streaming.
    const BACKSTOP_MS = 250;
    const schedule = () => {
      if (oldestBufferedAt === null) oldestBufferedAt = performance.now();
      if (rafId === null) rafId = requestAnimationFrame(() => flush());
      if (backstopId === null) backstopId = setTimeout(flush, BACKSTOP_MS);
    };

    // When the webview is hidden/throttled, requestAnimationFrame is paused, so
    // buffered deltas (incl. a turn's terminal + the next turn's "running") sit
    // unapplied until the next frame. Flush immediately on wake so status
    // ordering is applied promptly and a stale "done" can't visibly linger.
    const flushOnWake = () => flush();
    window.addEventListener("atlas:window-active", flushOnWake);

    const bufferDelta = (env: AgentDelta) => {
      // Coalesce same-id `tool_call_upserted` events: replace the
      // entry at the position the tool first appeared so the latest
      // state lands and ordering vs other events stays correct.
      if (env.kind === "tool_call_upserted") {
        const key = `${env.session_id}::${env.tool_call.id}`;
        const existing = toolDeltaPos.get(key);
        if (existing !== undefined) {
          pendingDeltas[existing] = env;
          return;
        }
        toolDeltaPos.set(key, pendingDeltas.length);
      }
      pendingDeltas.push(env);
    };

    // Coalesce incremental live tool output. Priority order matters for
    // correctness, not just batching:
    // 1. A full `tool_call_upserted` snapshot for this tool is already
    //    buffered — fold the delta into ITS `result`. A separate chunk entry
    //    would double-apply: a later snapshot replaces that buffer slot with
    //    a result that already contains every earlier chunk, and the stray
    //    chunk entry would then append the same bytes again.
    // 2. This tool's previous buffered entry is a chunk — concatenate.
    // 3. Fresh chunk entry. (Chunks buffered BEFORE a tool's first snapshot
    //    of the frame stay safe: they apply first and the later snapshot
    //    replaces the result wholesale.)
    const bufferOutputChunk = (env: Extract<AgentDelta, { kind: "tool_call_output_chunk" }>) => {
      const key = `${env.session_id}::${env.tool_call_id}`;
      const upsertAt = toolDeltaPos.get(key);
      if (upsertAt !== undefined) {
        const entry = pendingDeltas[upsertAt];
        if (entry?.kind === "tool_call_upserted") {
          pendingDeltas[upsertAt] = {
            ...entry,
            tool_call: {
              ...entry.tool_call,
              result: (entry.tool_call.result ?? "") + env.delta,
            },
          };
          return;
        }
      }
      const chunkAt = outputChunkPos.get(key);
      const prev = chunkAt !== undefined ? pendingDeltas[chunkAt] : undefined;
      if (prev?.kind === "tool_call_output_chunk" && chunkAt !== undefined) {
        pendingDeltas[chunkAt] = { ...prev, delta: prev.delta + env.delta };
        return;
      }
      outputChunkPos.set(key, pendingDeltas.length);
      pendingDeltas.push(env);
    };

    // Record a chat into the sidebar "Chats" (recently-invoked) list whenever a
    // session sees meaningful activity. Resolves project + title from the chat
    // session that owns this acpSessionId.
    const recordRecentChat = (acpSessionId: string) => {
      const sessions = useChatStore.getState().sessions;
      for (const [tabId, s] of Object.entries(sessions)) {
        if (s.acpSessionId !== acpSessionId) continue;
        const path = s.workingDirectory;
        if (!path) return;
        useRecentChatsStore.getState().actions.record({
          tabId,
          projectPath: path,
          projectName: basename(path),
          // Strip any Atlas-injected memory scaffolding the title may carry
          // (resumed sessions); a dirty fragment cleans to "" → fall back.
          title: stripInjectedContext(s.title) || "Chat",
          status: s.status,
          agentType: s.agentType,
          acpSessionId: s.acpSessionId,
          updatedAt: Date.now(),
        });
        return;
      }
    };

    listenAgents((env) => {
      if (cancelled) return;
      const actions = useChatStore.getState().actions;
      // Session-less: the manager's per-plugin install/launch progress. Not a
      // delta, so it never enters the RAF buffer — the label it drives is a
      // single store write per change, and every tab on that agent reads it.
      if (env.kind === "loading_status") {
        actions.setAgentStartingStatus(env.plugin_id, env.status);
        return;
      }
      // Session-less too: an installed agent was updated on a registry bump.
      // Rust waited for it to go idle before restarting it, so nothing was
      // cut off; open chats already got `agent_disconnected` and reconnect on
      // their next send. The toast is the only place an update is announced.
      if (env.kind === "agent_update") {
        const name = agentMeta(env.plugin_id).label;
        if (env.phase === "waiting" || env.phase === "restarting" || env.phase === "installing") {
          setAgentUpdatePhase(env.plugin_id, { phase: env.phase, version: env.version });
          if (env.phase === "restarting") actions.noteAgentUpdated(env.plugin_id, env.version);
          return;
        }
        setAgentUpdatePhase(env.plugin_id, null);
        if (env.phase === "ready") {
          // Same id as the marketplace's own Update toast: a manual update can
          // also be installed by the background pass, and that is one update.
          toast.success(`${name} updated to v${env.version}`, {
            id: `agent-update:${env.plugin_id}:${env.version}`,
          });
        } else {
          notifyAgentUpdateFailed({
            pluginId: env.plugin_id,
            name,
            version: env.version,
            error: env.error ?? null,
          });
        }
        return;
      }
      if (
        env.kind === "status" ||
        env.kind === "message_appended" ||
        env.kind === "turn_finished"
      ) {
        recordRecentChat(env.session_id);
      }
      switch (env.kind) {
        case "text_chunk":
          bufferChunk(env);
          schedule();
          return;
        case "thinking_chunk":
          bufferChunk(env);
          schedule();
          return;
        case "tool_call_output_chunk":
          bufferOutputChunk(env);
          schedule();
          return;
        case "permission_request": {
          // Permission requests block the agent waiting for the user
          // — apply synchronously so the modal opens on the very next
          // tick, not the next RAF (which can be ~16 ms away or more
          // if the frame is busy with a flush of accumulated chunks).
          actions.pushPermission({
            agentId: env.agent_id,
            acpSessionId: env.session_id,
            requestId: env.request_id,
            toolCall: env.tool_call as PendingPermission["toolCall"],
            options: env.options as PendingPermission["options"],
          });
          notifyAgentEvent(env);
          return;
        }
        case "permission_resolved":
          actions.popPermission(env.session_id, env.request_id);
          // Answered anywhere (in-app, another path, cancelled): its banner goes too.
          resolveAgentPermission(env.session_id, String(env.request_id));
          return;
        case "agent_disconnected":
          // Flush whatever's buffered before tearing the agent down
          // so we don't lose a final chunk to the post-disconnect
          // discard. `flush` cancels both pending drains itself.
          // Forced: teardown correctness outranks the scroll-hold.
          flush(true);
          notifyAgentEvent(env);
          actions.clearPermissionsForAgent(env.agent_id);
          // Tabs still waiting to be bound on this agent have no session id
          // for the reducer to route by; fail them by plugin instead. Read
          // the pairing BEFORE the cache reset below forgets it.
          {
            const pluginId = pluginIdForAgentId(env.agent_id);
            if (pluginId) actions.failPendingBinds(pluginId, env.reason);
          }
          // Reset the spawn cache for the plugin that actually died — the old
          // resetDefaultAgent() only ever cleared claude-code-ts, so a crashed
          // Codex adapter stayed cached-dead until app restart (H4).
          resetAgentByAgentId(env.agent_id);
          // Let the reducer flag the affected session (drives the Restart
          // affordance + rebind-on-next-send).
          bufferDelta(env);
          schedule();
          logEvent({
            source: "atlas",
            kind: "agent-disconnected",
            summary: "Agent process disconnected; its spawn cache was reset",
            status: "failure",
            payload: { agentId: env.agent_id, reason: env.reason },
          });
          return;
        case "turn_finished":
          // Still pass through to the chat-store so session.status
          // flips back to "idle" (see chat-store.ts:591).
          bufferDelta(env);
          schedule();
          // Superseded by a newer send → the store ignores the idle flip; skip
          // the memory reindex and log too (the notifier checks this itself).
          if (isStaleAgentTurn(env.session_id, env.turn_seq)) return;
          // Keep the native agent's project memory fresh (debounced, cheap).
          logEvent({
            source: "atlas",
            kind: "agent-turn-finished",
            summary: `Agent turn finished (${env.stop_reason})`,
            status: env.stop_reason === "cancelled" ? "failure" : "success",
            payload: {
              agentId: env.agent_id,
              sessionId: env.session_id,
              stopReason: env.stop_reason,
            },
          });
          // The banner quotes the final message and the turn's stats, which the
          // store only holds once this delta (and the text before it) is
          // applied — drain the buffer now rather than at the next frame.
          // The pipeline skips cancelled and stale turns itself.
          flush(true);
          notifyAgentEvent(env);
          return;
        case "turn_failed":
          bufferDelta(env);
          schedule();
          notifyAgentEvent(env);
          return;
        case "elicitation_requested":
          // The agent is blocked on the user's answer — same as a permission
          // request, tell them (center, toast, banner) as well as render it.
          bufferDelta(env);
          schedule();
          notifyAgentEvent(env);
          return;
        case "context_usage":
        case "rate_limits":
        case "retry_status":
          // Warning-tier notifications (context window, quota, retrying).
          bufferDelta(env);
          schedule();
          notifyAgentEvent(env);
          return;
        default:
          bufferDelta(env);
          schedule();
          return;
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });

    // Agent spawn is deferred until the user first focuses the message input
    // (see `MessageInput`'s focus handler). `npx -y @zed-industries/claude-code-acp`
    // can take 10–30s on a cold npm cache; doing it at app boot adds visible
    // latency to first paint and races the project-rehydration cascade. The
    // user is unlikely to send a prompt within the first few hundred ms of
    // focusing the composer, so the spawn finishes in the background while
    // they type.

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (backstopId !== null) clearTimeout(backstopId);
      window.removeEventListener("atlas:window-active", flushOnWake);
      stopFocusTracking();
      stopBadgeClearing();
      stopSourceOpened();
      window.removeEventListener("pointerdown", onUserActivity);
      window.removeEventListener("keydown", onUserActivity);
      window.removeEventListener("wheel", onUserActivity);
      window.clearInterval(keepWarm);
      window.clearTimeout(pruneTimer);
      unlisten?.();
    };
  }, []);

  // Live file-tree updates. The fileindex watcher (started in
  // `fileindex_open_project`) emits `atlas:explorer:changed` with the
  // set of parent directories touched in each debounced batch. We
  // reconcile each loaded directory in place — agent-side file writes
  // appear in the tree without the user touching a refresh button.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    type Payload = {
      workspaceId?: string;
      dirs: string[];
      fullRefresh: boolean;
    };
    listen<Payload>("atlas:explorer:changed", (e) => {
      if (cancelled) return;
      // Ignore changes from a backgrounded project's resident watcher —
      // only the active project's explorer should reconcile.
      const active = activeProjectId();
      if (e.payload.workspaceId && active && e.payload.workspaceId !== active) {
        return;
      }
      const actions = useExplorerStore.getState().actions;
      const { dirs, fullRefresh } = e.payload;
      if (fullRefresh) {
        void actions.refresh();
        return;
      }
      for (const dir of dirs) {
        void actions.reconcileDirectory(dir);
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Auto-save editor state when tabs change
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!currentProject) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      useLayoutStore.getState().actions.saveEditorState(currentProject.path);
    }, 1000);
    return () => clearTimeout(saveTimerRef.current);
  }, [tabs.length, activeTabId, groupOrder, focusedGroupId, currentProject]);

  // Maintain the chat-mention picker's "recent files" queue. Push whenever
  // an editor/media/unsupported tab appears whose data.filePath we haven't
  // seen yet in this session. Centralizing here means every call site that
  // opens a file (FilePicker, explorer, message-item link, analysis,
  // git diff, …) feeds the recents list without each having to remember to.
  const seenFileTabsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const projectPath = currentProject?.path ?? "";
    for (const t of tabs) {
      if (t.type !== "editor" && t.type !== "media" && t.type !== "unsupported") continue;
      const absPath = (t.data as Record<string, unknown> | undefined)?.filePath as
        | string
        | undefined;
      if (!absPath) continue;
      if (seenFileTabsRef.current.has(absPath)) continue;
      seenFileTabsRef.current.add(absPath);
      const rel =
        projectPath && absPath.startsWith(projectPath + "/")
          ? absPath.slice(projectPath.length + 1)
          : (absPath.split("/").pop() ?? absPath);
      useRecentFilesStore.getState().actions.push({ absPath, rel });
    }
  }, [tabs, currentProject?.path]);

  // FileIndex lifecycle: open the backend file index on project change,
  // close on project clear. The backend handles fs-watch and incremental
  // updates from that point — Cmd+P queries against the live index.
  useEffect(() => {
    if (!currentProject) {
      fileIndex.closeProject().catch(() => {});
      markFileIndexClosed();
      // Deliberately does NOT stop git watchers. This branch runs whenever the
      // *current* project becomes null, but watchers are per-project and a
      // backgrounded project must keep watching — its commits still need
      // linking to its Sessions. Tearing one down is `teardownHot`'s job, with
      // the project id it actually owns.
      // Auto-fetch, by contrast, only follows the project on screen.
      void useGitStore
        .getState()
        .actions.setAutoFetchProject(null)
        .catch(() => {});
      void invoke("recent_files_close_project").catch(() => {});
      // Drop the mention cache so the @-picker doesn't briefly
      // surface the previous project's notes / symbols on a fresh
      // open. Replays land via knowledge/analysis store hydration.
      void invoke("mention_cache_clear").catch(() => {});
      return;
    }
    // Deliberately NOT `markFileIndexClosed()` here: switching projects keeps
    // every hot project's Rust index resident (`fileindex_open_project` is
    // idempotent for a live one), so previously-confirmed roots stay valid —
    // clearing them made the first Cmd+P/@ after every switch pay a status
    // round-trip. Roots are forgotten where indexes actually die: project
    // close (above) and project teardown (`markFileIndexClosedFor`).
    const projectId = activeProjectId();
    void openFileIndex(currentProject.path);
    // Git watcher: emits `atlas:git-changed` on commit / checkout /
    // branch ops. Replaces the 3-second polling that git-graph-panel
    // used to do via `refetchInterval` on `git_graph_signature`.
    // Keyed by project so each open project keeps its own resident watcher.
    void invoke("git_watch_start", {
      projectPath: currentProject.path,
      workspaceId: projectId,
    }).catch((e) => console.warn("git watch start failed:", e));
    // Mirrored instructions: tells Rust which project this window works in.
    // With `instructionSync` on it syncs and watches it; off, Rust only
    // remembers it as the project to act on when the setting is switched on.
    void instructionSync
      .start(currentProject.path, projectId)
      .catch((e) => console.warn("instruction sync start failed:", e));
    // Background fetch follows the project this window shows, so its Pull
    // badge reflects the remote (Rust `git_autofetch`).
    void useGitStore
      .getState()
      .actions.setAutoFetchProject(currentProject.path)
      .catch(() => {});
    // Capture: a bound Project just became active — open its store (which
    // also heals a folder rename) and kick its transcript import and drain.
    // A no-op for Projects that never enabled capture.
    void invoke("capture_activate", { projectPath: currentProject.path }).catch((e) =>
      console.warn("capture activate failed:", e),
    );
    // Clear the global recents mirror SYNCHRONOUSLY before the async reload so
    // there's no window where it still shows the previous project's files
    // (the picker also filters by project as a belt-and-suspenders guard).
    useRecentFilesStore.getState().actions.hydrate([]);
    // Recent-files state: Rust loads `<project>/.atlas/recent-files.json`
    // and returns the list. We hydrate the JS mirror with it so the
    // mention picker's "Recent files" section is correct from the
    // first render of the new project.
    void invoke<RecentFile[]>("recent_files_open_project", {
      projectPath: currentProject.path,
      workspaceId: projectId,
    })
      .then((items) => {
        useRecentFilesStore.getState().actions.hydrate(items);
      })
      .catch((e) => console.warn("recent_files_open_project failed:", e));
  }, [currentProject?.path]);

  // Native window title: `projectName - Atlas` while a project is open,
  // plain `Atlas` otherwise. This is what macOS shows on the window-menu,
  // on minimize, and on title hover — and the taskbar and Alt-Tab on Windows,
  // which is why the dev profile's window says `Atlas Dev` here.
  const { productName } = useAppProfile();
  useEffect(() => {
    const title = currentProject ? `${currentProject.name} - ${productName}` : productName;
    void invoke("set_window_title", { title }).catch(() => {});
  }, [currentProject?.name, productName]);

  // Install the singleton listener for `atlas:recent-files-changed`
  // once — every push from Rust patches the mirror in place.
  useEffect(() => {
    ensureRecentFilesListener();
  }, []);

  // Quit durability: per-switch flushes are fire-and-forget, so on window
  // close flush the ACTIVE project's pending writes (background projects
  // were already flushed when we left them). beforeunload can't await, but it
  // cancels the debounce and kicks the write immediately.
  useEffect(() => {
    const onBeforeUnload = () => {
      const wsId = useProjectStore.getState().activeProjectId;
      const path = useAppStore.getState().currentProject?.path ?? null;
      // Capture first so the flush dedup compares against the CURRENT state
      // (not a stale capture from the last switch-away).
      if (wsId) captureSnapshot(wsId);
      void flushAll({ projectId: wsId, path });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Chords live in the active keybinding profile (Settings → Keybindings);
  // this is only the action-id → behaviour map. See
  // `src/features/keybindings/lib/actions.ts` for the registry.
  useActionHotkeys({
    // ⌘⇧N — "new project": pick a folder and add it as a project in
    // this window (Atlas is single-window now; this replaces the old
    // "open a new native window" behaviour).
    "workspace.add": () => {
      void pickAndAddProject();
    },
    // ⌘⇧. — toggle the Arc-like project sidebar. (⌘. alone is the macOS
    // system "Cancel" chord and gets swallowed before reaching the webview.)
    "workspace.toggleSidebar": () => useProjectStore.getState().actions.toggleSidebar(),
    "nav.commandPalette": () => setCommandPaletteOpen(true),
    "nav.filePicker": () => setFilePickerOpen(true),
    "nav.search": () => setSearchOpen(true),
    "panels.left": toggleLeftPanel,
    "panels.right": toggleRightPanel,
    "panels.terminal": toggleTerminal,
    "panels.agentSidebar": toggleChatSidebar,
    // ⌥J — open the Knowledge Base, or jump to it if already open, WITHIN
    // the focused split column.
    "panels.knowledge": () => {
      const st = useLayoutStore.getState();
      const g = st.focusedGroupId;
      const existing = st.tabs.find((t) => (t.groupId ?? "main") === g && t.type === "knowledge");
      if (existing) {
        setActiveTab(existing.id);
        return;
      }
      addTab({
        id: `knowledge-${Date.now()}`,
        type: "knowledge",
        title: "Knowledge",
        closable: true,
        dirty: false,
        data: {},
      });
    },
    "panels.tabBar": toggleTabBar,
    // ⌘1–8 select by index; ⌘9 always jumps to the LAST tab (browser
    // convention) — the store treats i<0 as "last".
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `tabs.focus${i + 1}`,
        i === 8 ? () => activateTabByIndex(-1) : () => activateTabByIndex(i),
      ]),
    ),
    "tabs.close": () => {
      const current = useLayoutStore.getState().activeTabId;
      if (current) requestCloseTab(current);
    },
    "tabs.prev": () => cycleTab(-1),
    "tabs.next": () => cycleTab(1),
    // ── Split view ──
    "split.new": () => addGroup(),
    "split.focusLeft": () => focusAdjacentGroup(-1),
    "split.focusRight": () => focusAdjacentGroup(1),
    // Close the focused split column (tabs move to the left neighbour).
    "split.close": () => closeGroup(useLayoutStore.getState().focusedGroupId),
    // Zen mode: Knowledge │ Chat │ Browser, side panels hidden. Again restores.
    "panels.zen": () => {
      if (currentProject) toggleZenMode();
    },
    // ⌥/ — cycle the coding agent (Claude Code → Codex → Atlas → …). A
    // session is paired to one agent: an empty chat flips in place; a started
    // chat opens a NEW chat bound to the next agent (per the pairing rule).
    "chat.cycleAgent": () => {
      const layout = useLayoutStore.getState();
      const tab = layout.tabs.find((t) => t.id === layout.activeTabId);
      if (!tab || tab.type !== "chat") return;
      cycleChatAgent(tab.id);
    },
    // ⌘T — new agent chat. Singleton: focuses the existing chat tab and resets
    // it to a fresh session rather than opening a second chat tab.
    "tabs.newChat": () => openNewAgentChat(),
    // ⌘N — new untitled editor. The synthetic `untitled:<ts>` path
    // tells the editor to start with an empty buffer and to fall
    // into the save-as flow on ⌘S (see `editor-panel.tsx`).
    "tabs.newUntitled": () => {
      const ts = Date.now();
      addTab({
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      });
    },
    // Keyboard-first equivalent of the `+` button's dropdown.
    "nav.newTabPalette": () => setNewTabPaletteOpen(true),
    "nav.layoutSwitcher": () => setLayoutSwitcherOpen(true),
    "tabs.newTerminal": () =>
      addTab({
        id: `terminal-${Date.now()}`,
        type: "terminal",
        title: "Terminal",
        closable: true,
        dirty: false,
        data: {},
      }),
    "app.settings": () =>
      addTab({
        id: "settings",
        type: "settings",
        title: "Settings",
        closable: true,
        dirty: false,
        data: {},
      }),
    // The org's Usage dashboard — a singleton tab, so re-running focuses it.
    "usage.open": () =>
      addTab({
        id: "usage",
        type: "usage",
        title: "Usage",
        closable: true,
        dirty: false,
        data: {},
      }),
    // Session Capture (the popover behind the titlebar's project pill). Local
    // `captureOpen` state lives in `ProjectLabel`, so this reaches it via the
    // same `atlas:open-capture` event the command palette entry dispatches.
    "app.capture": () => window.dispatchEvent(new CustomEvent("atlas:open-capture")),
    // ── Interface zoom ──
    "view.zoomIn": zoomIn,
    "view.zoomOut": zoomOut,
    "view.zoomReset": zoomReset,
  });

  return (
    // One provider at the root so every tooltip in the app shares a delay and
    // a SKIP group: hovering along a facepile shows each name instantly after
    // the first, instead of re-waiting per avatar.
    <TooltipProvider>
      <AppContextMenu>
        <div className="h-screen w-screen" onContextMenu={(e) => e.preventDefault()}>
          <AppLayout />
        </div>
      </AppContextMenu>
      <CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} />
      <NewTabPalette open={newTabPaletteOpen} onOpenChange={setNewTabPaletteOpen} />
      <LayoutSwitcher open={layoutSwitcherOpen} onOpenChange={setLayoutSwitcherOpen} />
      <SearchOverlay open={searchOpen} onOpenChange={setSearchOpen} />
      <FilePicker open={filePickerOpen} onOpenChange={setFilePickerOpen} />
      <HintOverlay />
      <AgentOAuthModalHost />
      {/* Sign-in asks questions of its own (device codes, login URLs), and they
          arrive before the agent has any session to route them by. */}
      <AgentElicitationHost />
      <NotificationPanel />
      <KeymapOnboarding />
      <StopAgentsDialog />
      <RemoveAgentDialog />
      <BrowserOverlayWatcher />
      {/* Renders nothing at all until a glyph-based icon theme is in use, and
          so costs an SVG theme (including the bundled default) nothing. */}
      <IconThemeFonts />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--foreground)",
            fontSize: "var(--text-sm)",
          },
        }}
      />
    </TooltipProvider>
  );
}
