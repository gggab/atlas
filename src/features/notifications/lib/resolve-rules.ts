/**
 * Clearing — the pure half. A notification that no longer needs the user
 * (its request was resolved, or the user opened what it was about) should stop
 * being shown: the toast, the OS banner and the unread center item. Given such
 * an event and what the OS notifier can do, `planResolved` / `planOpened` say
 * exactly what to take down; `resolve.ts` performs it.
 *
 * Banner removal is gated on the backend's declared `removal` capability — a
 * backend that cannot take a banner back is never asked to (ADR-0002: the
 * backend declares, the frontend never asks which platform it is).
 */
import {
  notificationTag,
  notificationToastId,
  targetGroupKey,
  type NotificationKind,
  type NotificationTarget,
} from "./catalog";
import type { NativeCapabilities } from "./native-capabilities";
import type { AppNotification } from "../stores/notifications-store";

/** One conjunctive match over a center item — every field given must agree. */
export interface ReadClause {
  kind?: NotificationKind;
  sessionId?: string;
  tabId?: string;
  terminalId?: string;

  agentType?: string;
  /** A center item whose target is this project's git panel. */
  projectId?: string;
}

/** Items to mark read: those matching ANY clause. */
export type ReadScope = ReadClause[];

export interface ClearPlan {
  toastIds: string[];
  /** OS banner tags to remove; empty when the backend cannot remove. */
  tags: string[];
  /** OS banner groups to remove; empty when the backend cannot remove. */
  groups: string[];
  markRead: ReadScope;
}

export const EMPTY_PLAN: ClearPlan = { toastIds: [], tags: [], groups: [], markRead: [] };

export function matchesClause(i: AppNotification, c: ReadClause): boolean {
  if (c.kind !== undefined && i.kind !== c.kind) return false;
  if (c.sessionId !== undefined && i.sessionId !== c.sessionId) return false;
  if (c.tabId !== undefined && i.tabId !== c.tabId) return false;
  if (c.terminalId !== undefined && i.terminalId !== c.terminalId) return false;

  if (c.agentType !== undefined) {
    if (i.target?.type !== "agent-sign-in" || i.target.agentType !== c.agentType) return false;
  }
  if (c.projectId !== undefined) {
    if (i.target?.type !== "git-panel" || i.target.projectId !== c.projectId) return false;
  }
  return true;
}

export const matchesScope = (i: AppNotification, scope: ReadScope): boolean =>
  scope.some((c) => matchesClause(i, c));

/** A specific notification no longer applies (its request was answered, the
 *  turn ended, the problem was fixed). Its toast and banner go, and its center
 *  items are marked read per `markRead` — empty when other notifications of the
 *  same scope are still live and must stay unread. */
export interface ResolvedEvent {
  kind: NotificationKind;
  target: NotificationTarget;
  dedupeKey: string;
  markRead: ReadScope;
}

export function planResolved(e: ResolvedEvent, caps: NativeCapabilities): ClearPlan {
  return {
    toastIds: [notificationToastId(e.target, e.dedupeKey)],
    tags: caps.removal ? [notificationTag(e.kind, e.dedupeKey)] : [],
    groups: [],
    markRead: e.markRead,
  };
}

/** What the user just brought on screen. */
export type OpenedSource =
  /** A thread tab; `sessionIds` are the ids its notifications may carry
   *  (the agent session id, falling back to the tab id). */
  | { type: "session"; tabId: string; sessionIds: string[] }
  /** The terminals visible in a terminal tab. */
  | { type: "terminal"; tabId: string; terminalIds: string[] };

/** The user is looking at the source: its delivered banners are stale and its
 *  center items are seen. Toasts are left alone — they time out on their own. */
export function planOpened(src: OpenedSource, caps: NativeCapabilities): ClearPlan {
  switch (src.type) {
    case "session": {
      const ids = [...new Set([...src.sessionIds, src.tabId])];
      return {
        toastIds: [],
        tags: [],
        groups: caps.removal
          ? ids.map((sessionId) => targetGroupKey({ type: "session", tabId: src.tabId, sessionId }))
          : [],
        markRead: [{ tabId: src.tabId }, ...src.sessionIds.map((sessionId) => ({ sessionId }))],
      };
    }
    case "terminal":
      return {
        toastIds: [],
        tags: [],
        groups: caps.removal
          ? src.terminalIds.map((terminalId) =>
              targetGroupKey({ type: "terminal", tabId: src.tabId, terminalId }),
            )
          : [],
        markRead: src.terminalIds.map((terminalId) => ({ terminalId })),
      };
  }
}

/** Whether anything in the plan does work (skip the badge refresh otherwise). */
export const isEmptyPlan = (p: ClearPlan): boolean =>
  p.toastIds.length === 0 &&
  p.tags.length === 0 &&
  p.groups.length === 0 &&
  p.markRead.length === 0;

/** Stable identity of a source, to tell "newly on screen" from "still on screen". */
export function sourceKey(s: OpenedSource): string {
  switch (s.type) {
    case "session":
      return `session:${s.tabId}`;
    case "terminal":
      return `terminal:${s.tabId}:${[...s.terminalIds].sort().join(",")}`;
  }
}

/** Of everything on screen now, what to clear: the sources that were not on
 *  screen before, or all of them on `sweep` (the window just regained focus —
 *  banners delivered while it was in the background are now stale). */
export function sourcesToClear(
  previous: ReadonlySet<string>,
  visible: readonly OpenedSource[],
  sweep: boolean,
): OpenedSource[] {
  return sweep ? [...visible] : visible.filter((s) => !previous.has(sourceKey(s)));
}
