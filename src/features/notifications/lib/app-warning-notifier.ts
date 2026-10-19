/** App warnings for config errors and Agent update failures. */
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  getConfigInfo,
  onConfigChanged,
  onConfigError,
} from "@/features/settings/lib/atlas-config-api";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import {
  decideAgentUpdateFailed,
  decideConfigError,
  configErrorDedupeKey,
  evaluateConfigError,
  INITIAL_CONFIG_STATE,
  type ConfigWarnState,
} from "./app-warning-rules";
import { computeAway, type NotificationEnv } from "./decide";
import { deliverNotification } from "./deliver";
import { prefsFromSettings } from "./prefs";
import { clearResolved } from "./resolve";

function envFor(targetVisible: boolean, projectActive = true): NotificationEnv {
  const windowFocused = isWindowFocused();
  const sinceInputMs = Date.now() - lastInteraction();
  return {
    windowFocused,
    sinceInputMs,
    targetVisible,
    projectActive,
    away: computeAway(windowFocused, sinceInputMs),
  };
}

const prefs = () => prefsFromSettings(useSettingsStore.getState().settings);

function settingsShows(section: string): boolean {
  if (useSettingsNav.getState().shown !== section) return false;
  const layout = useLayoutStore.getState();
  const shown = [layout.activeTabId, ...Object.values(layout.activeByGroup)];
  return shown.some((id) => id && layout.tabs.find((t) => t.id === id)?.type === "settings");
}

// --- config.toml ----------------------------------------------------------

let configState: ConfigWarnState = INITIAL_CONFIG_STATE;

/** `error` is the parser's message; null when the file is valid. */
function noteConfig(error: string | null): void {
  try {
    const r = evaluateConfigError(configState, error);
    configState = r.state;
    if (r.warning) {
      const d = decideConfigError(r.warning.error, envFor(false), prefs());
      if (d) deliverNotification(d);
    }
    if (r.resolved !== null) {
      clearResolved({
        kind: "config-error",
        target: { type: "config-file" },
        dedupeKey: configErrorDedupeKey(r.resolved),
        markRead: [{ kind: "config-error" }],
      });
    }
  } catch (err) {
    console.warn("config warning failed:", err);
  }
}

// --- Agent updates --------------------------------------------------------

let updateSeq = 0;

/** An agent update failed (background install or the Update button). */
export function notifyAgentUpdateFailed(f: {
  pluginId: string;
  name: string;
  version: string;
  error: string | null;
}): void {
  try {
    const d = decideAgentUpdateFailed(
      { ...f, seq: ++updateSeq },
      envFor(settingsShows("agents")),
      prefs(),
    );
    if (d) deliverNotification(d);
  } catch (err) {
    console.warn("agent update notification failed:", err);
  }
}

let started = false;

/** Subscribe to the app-warning sources once. Returns an unsubscribe. */
export function startAppWarnings(): () => void {
  if (started) return () => {};
  started = true;
  const offs = [
    onConfigError(noteConfig),
    // A valid reload re-arms the config warning.
    onConfigChanged(() => noteConfig(null)),
  ];
  // A config that failed to load at startup is reported once, here: Rust only
  // emits `atlas:config-error` for later reloads.
  void getConfigInfo()
    .then((info) => {
      const status = info?.status;
      if (status && status.status !== "ok") noteConfig(status.error);
    })
    .catch(() => {});
  return () => {
    started = false;
    for (const off of offs) void off.then((f) => f());
  };
}
