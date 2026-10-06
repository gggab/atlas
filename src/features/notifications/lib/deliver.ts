/**
 * The one delivery step — every side effect of a notification happens here:
 * the in-app center, the toast (with its "Open" jump), the OS banner, the dock
 * badge and the sound. Input is a `NotificationDecision` from the pure
 * `decideNotification`; nothing here decides whether to speak, only how.
 *
 * Each dedupe key is delivered once (bounded memory), so a source that
 * re-emits the same occurrence cannot double-announce.
 */
import { toast } from "sonner";
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { jumpToTerminal } from "@/features/terminal/lib/jump-to-terminal";
import { isWindowFocused } from "@/lib/window-focus";
import { agentBannerIconPath } from "@/lib/notification-icon";
import {
  nativeCapabilities,
  primeNativeNotificationPermission,
  setNativeResponseHandler,
  showNativeNotification,
} from "@/lib/native-notify";
import { playChime } from "@/lib/chime";
import { setDockBadge } from "@/lib/dock-badge";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { notificationToastIcon } from "../components/notification-leading-icon";
import { useNotificationsStore } from "../stores/notifications-store";

import { promptSignIn } from "@/features/chat/lib/agent-signin";

import { openConfigFile } from "@/features/settings/lib/atlas-config-api";
import { openGitPanel } from "@/features/git/lib/open-git-panel";
import { openSettingsSection } from "@/features/settings/lib/open-settings";

import {
  catalogEntry,
  isTabTarget,
  notificationTag,
  notificationToastId,
  type NotificationTarget,
} from "./catalog";
import type { NotificationDecision } from "./decide";
import { encodeBannerPayload, targetForResponse } from "./native-routing";
import { answerPermissionFromBanner } from "./permission-actions";

const announced = new Set<string>();
const ANNOUNCED_CAP = 500;

/** Bring a notification's target into view, across projects. */
export function openNotificationTarget(t: NotificationTarget): void {
  switch (t.type) {
    case "terminal":
      void jumpToTerminal({ tabId: t.tabId, terminalId: t.terminalId, projectId: t.projectId });
      return;
    case "session":
      void jumpToSession(t.tabId);
      return;

    case "agent-sign-in":
      promptSignIn(t.agentType);
      return;

    case "settings":
      openSettingsSection(t.section);
      return;
    case "git-panel":
      void openGitPanel(t.projectId);
      return;
    case "config-file":
      void openConfigFile().catch((err) => console.warn("open config.toml failed:", err));
      return;
  }
}

export { notificationToastId };

// A click on an OS banner opens its exact source (thread tab or terminal pane),
// across projects. Registered at module load so a click that launched the app
// is routed as soon as the notifier flushes it. Permission action buttons
// answer the request in place; other actions have no owner yet and are ignored.
setNativeResponseHandler((response) => {
  if (response.actionId !== null) {
    answerPermissionFromBanner(response);
    return;
  }
  const target = targetForResponse(response);
  if (target) openNotificationTarget(target);
});

/** The agent a notification is about, for its leading icon. Resolved here from
 *  the target so every agent kind carries it without per-rule plumbing. */
function agentTypeOf(t: NotificationTarget): string | undefined {
  if (t.type === "agent-sign-in") return t.agentType;
  if (t.type === "session") return useChatStore.getState().sessions[t.tabId]?.agentType;
  return undefined;
}

/** The OS banner. Agent kinds carry the agent's icon where the backend can
 *  show an image; a missing icon just means no image. */
async function showBanner(d: NotificationDecision, agentType: string | undefined): Promise<void> {
  let imagePath: string | undefined;
  if (agentType) {
    await primeNativeNotificationPermission();
    if (nativeCapabilities().images) imagePath = await agentBannerIconPath(agentType);
  }
  await showNativeNotification({
    // Re-delivering a dedupe key replaces its banner; one group per thread/terminal.
    tag: notificationTag(d.kind, d.dedupeKey),
    group: d.groupKey,
    title: d.native.title,
    subtitle: d.native.subtitle,
    body: d.native.body,
    imagePath,
    sound: d.native.sound,
    urgency: d.tier === "needs-you" ? "high" : "normal",
    // Cut to the backend's capabilities by `showNativeNotification`.
    actions: d.native.actions,
    payload: encodeBannerPayload(d.target, d.native.permission),
  });
}

/** Perform a decision. Returns false when it was a duplicate. */
export function deliverNotification(d: NotificationDecision): boolean {
  if (announced.has(d.dedupeKey)) return false;
  announced.add(d.dedupeKey);
  if (announced.size > ANNOUNCED_CAP) {
    const first = announced.values().next().value;
    if (first) announced.delete(first);
  }

  const t = d.target;
  const agentType = catalogEntry(d.kind).source === "agent" ? agentTypeOf(t) : undefined;
  if (d.channels.center) {
    useNotificationsStore.getState().actions.add({
      kind: d.kind,
      source: catalogEntry(d.kind).source,
      title: d.title,
      body: d.body,
      tabId: isTabTarget(t) ? t.tabId : undefined,
      terminalId: t.type === "terminal" ? t.terminalId : undefined,
      sessionId: t.type === "session" ? t.sessionId : undefined,
      projectId: isTabTarget(t) ? t.projectId : undefined,
      agentType,
      orgId: isTabTarget(t) ? t.orgId : undefined,
      // App-level targets have no tab to jump to; the panel opens the target.
      target: isTabTarget(t) ? undefined : t,
    });
  }
  // Re-checked at delivery: the badge is for a window in the background now.
  if (d.channels.badge && !isWindowFocused()) {
    const unread = useNotificationsStore.getState().items.filter((i) => !i.read).length;
    setDockBadge(unread);
  }
  if (d.channels.toast) {
    const opts = {
      id: notificationToastId(t, d.dedupeKey),
      description: d.body,
      duration: d.toast.durationMs,
      icon: notificationToastIcon(d.kind, agentType),
      // A staged update's toast restarts into it; the click target is the prompt.
      action: { label: "Open", onClick: () => openNotificationTarget(t) },
    };
    if (d.toast.variant === "error") toast.error(d.title, opts);
    else if (d.toast.variant === "success") toast.success(d.title, opts);
    else toast(d.title, opts);
  }
  if (d.channels.native) {
    void showBanner(d, agentType);
  } else if (d.channels.sound) {
    playChime();
  }
  return true;
}
