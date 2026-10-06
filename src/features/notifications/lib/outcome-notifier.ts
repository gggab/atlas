/**
 * Outcome notifications for app work that finishes out of sight: a staged
 * update, a model download, a git push / pull / fetch. Each entry point is
 * called from a lib / App-level boundary (never a store) and never throws.
 *
 * User-initiated vs background is decided by the call site: only the git
 * panel's toolbar buttons call `notifyGitRemoteOp`; the scheduled auto-fetch
 * (Rust `git_autofetch`) and the merge dialog's implicit fetch do not, so
 * their successes are silent by construction.
 */
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useModelsStore } from "@/features/settings/stores/models-store";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { isWindowFocused, lastInteraction } from "@/lib/window-focus";
import { computeAway, type NotificationEnv } from "./decide";
import { deliverNotification } from "./deliver";
import { decideGitOp, decideModelDownload, type GitRemoteOp } from "./outcome-notifier-rules";
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

let gitSeq = 0;

/** A user-started push / pull / fetch / publish settled. `error` is null on
 *  success. `startedAt` is `Date.now()` from when the user pressed the button. */
export function notifyGitRemoteOp(
  op: GitRemoteOp,
  repoPath: string | null,
  startedAt: number,
  error: string | null,
): void {
  try {
    const ws = useProjectStore.getState();
    const project = ws.projects.find((p) => p.path === repoPath);
    if (!project) return;
    const projectActive = project.id === ws.activeProjectId;
    const rp = useLayoutStore.getState().rightPanel;
    const panelShowing =
      rp.visible && rp.mode === "source-control" && rp.activeSection === "changes";
    const decision = decideGitOp(
      {
        op,
        projectId: project.id,
        projectName: project.name,
        projectActive,
        durationMs: Date.now() - startedAt,
        error,
        seq: ++gitSeq,
      },
      envFor(projectActive && panelShowing, projectActive),
      prefs(),
    );
    if (decision) deliverNotification(decision);
  } catch (err) {
    console.warn("git notification failed:", err);
  }
}

/** Text of whatever a failed git invoke threw. */
export function gitErrorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const { message, rawStderr } = e as { message?: unknown; rawStderr?: unknown };
    if (typeof message === "string" && message) return message;
    if (typeof rawStderr === "string" && rawStderr) return rawStderr;
  }
  return String(e);
}
