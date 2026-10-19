/** Outcome notifications for model downloads. */
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useModelsStore } from "@/features/settings/stores/models-store";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import { computeAway, type NotificationEnv } from "./decide";
import { deliverNotification } from "./deliver";
import { decideModelDownload } from "./outcome-notifier-rules";
import { prefsFromSettings } from "./prefs";

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

let modelSeq = 0;

/** A model download finished or failed (`atlas:model-download:done`). */
export function notifyModelDownload(done: {
  id: string;
  success: boolean;
  error: string | null;
}): void {
  try {
    const name = useModelsStore.getState().list.find((m) => m.id === done.id)?.name ?? done.id;
    const settingsShowsModels = useSettingsNav.getState().shown === "models" && settingsTabActive();
    const decision = decideModelDownload(
      { ...done, name, seq: ++modelSeq },
      envFor(settingsShowsModels),
      prefs(),
    );
    if (decision) deliverNotification(decision);
  } catch (err) {
    console.warn("model download notification failed:", err);
  }
}

function settingsTabActive(): boolean {
  const layout = useLayoutStore.getState();
  const shown = [layout.activeTabId, ...Object.values(layout.activeByGroup)];
  return shown.some((id) => id && layout.tabs.find((t) => t.id === id)?.type === "settings");
}
