// A history card over existing thread metadata and live chat status.

import { memo, useId, useSyncExternalStore } from "react";
import { Archive, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { Hint } from "@/ui/tooltip";
import {
  AgentMonogram,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
  ExternalAgentIcon,
  KiloIcon,
  OpenCodeIcon,
} from "@/components/agent-icons";
import { AtlasIcon } from "@/components/atlas-icon";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useChatStore } from "../stores/chat-store";
import { AGENT_TYPE_BY_SIDEBAR, type SidebarAgent } from "../lib/sidebar-agents";

/** Two-letter monogram for a project name: "northwind-shop" → "NS", "atlas" → "AT". */
export function projectMonogram(name: string): string {
  const words = name
    .trim()
    .split(/[\s\-_./]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** "45s", "7m", "1h 5m" — how long the current turn has run. */
export function formatWorkingDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

// ── One ticker for every running card ──────────────────────────────────────
//
// A module-level clock: one interval however many timers are on screen,
// running only while something listens and paused while the window is hidden
// (a hidden timer has nobody to show the second to; it catches up on return).

const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function tick() {
  tickNow = Date.now();
  for (const listener of tickListeners) listener();
}

function startTicking() {
  if (tickTimer !== null || document.hidden) return;
  tickTimer = setInterval(tick, 1000);
}

function stopTicking() {
  if (tickTimer === null) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

function onVisibilityChange() {
  if (document.hidden) {
    stopTicking();
  } else {
    tick();
    startTicking();
  }
}

function subscribeTicker(listener: () => void): () => void {
  tickListeners.add(listener);
  if (tickListeners.size === 1) {
    tickNow = Date.now();
    document.addEventListener("visibilitychange", onVisibilityChange);
    startTicking();
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0) {
      stopTicking();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

const getTickNow = () => tickNow;

/** Whether the shared ticker's interval is running — for tests. */
export function isTickerRunning(): boolean {
  return tickTimer !== null;
}

// ── Status ─────────────────────────────────────────────────────────────────

/** The running turn's start, as the chat store stamped it. */
function useTurnStartedAt(tabId: string | null): number | null {
  return useChatStore((s) => (tabId ? (s.sessions[tabId]?.turnStartedAt ?? null) : null));
}

function WorkingDuration({ startedAt }: { startedAt: number }) {
  const now = useSyncExternalStore(subscribeTicker, getTickNow);
  return <span className="tabular-nums">{formatWorkingDuration(now - startedAt)}</span>;
}

/** The dashed ring that turns while an agent works. */
function WorkingRing() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      // The motion scale (`duration-*`) is for transitions of 80–260ms; this
      // is a continuous, deliberately slow rotation — the stock `animate-spin`
      // at 1s reads as "loading" rather than "working" — and no slow-spin
      // token exists. Reduced motion stops it.
      className="size-3 shrink-0 animate-spin [animation-duration:3s] motion-reduce:animate-none"
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.6 2.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export type SessionLiveStatus = "running" | "waiting" | null;

/** The visible status. Hidden from assistive tech: the open button carries a
 *  static description instead, so the hover swap and the per-second timer
 *  never chatter. */
function StatusLabel({
  status,
  tabId,
  lastUpdated,
}: {
  status: SessionLiveStatus;
  tabId: string | null;
  lastUpdated: string | null;
}) {
  const startedAt = useTurnStartedAt(status === "running" ? tabId : null);
  if (status === "running") {
    return (
      <span className="flex items-center gap-1 text-2xs font-medium text-info">
        <WorkingRing />
        Working {startedAt !== null && <WorkingDuration startedAt={startedAt} />}
      </span>
    );
  }
  if (status === "waiting") {
    return (
      <span className="flex items-center gap-1 text-2xs font-medium text-warning">
        <span className="size-1.5 rounded-full bg-current" />
        Needs input
      </span>
    );
  }
  return (
    <span className="text-2xs tabular-nums text-muted-foreground">
      {timeAgo(lastUpdated, { suffix: true })}
    </span>
  );
}

function statusDescription(status: SessionLiveStatus, lastUpdated: string | null): string {
  if (status === "running") return "Working";
  if (status === "waiting") return "Needs input";
  return lastUpdated ? `Updated ${timeAgo(lastUpdated, { suffix: true })}` : "";
}

// ── Agent ──────────────────────────────────────────────────────────────────

/** The mark of the agent that ran a thread. */
export function SidebarAgentIcon({ agent }: { agent: SidebarAgent }) {
  if (agent === "codex") return <CodexIcon className="size-3" />;
  if (agent === "opencode") return <OpenCodeIcon className="size-3" />;
  if (agent === "cursor") return <CursorIcon className="size-3" />;
  if (agent === "kilo") return <KiloIcon className="size-3" />;
  if (agent === "atlas-agent") return <AtlasIcon size={12} />;
  if (agent === "claude") return <ClaudeIcon className="size-3" />;
  const meta = agentMeta(agent);
  return meta.iconDataUrl ? (
    <ExternalAgentIcon dataUrl={meta.iconDataUrl} size={12} />
  ) : (
    <AgentMonogram label={meta.label} size={12} />
  );
}

// ── Card ───────────────────────────────────────────────────────────────────

export interface SessionCardProps {
  /** Atlas's id for the thread — what the handlers are called with. */
  threadId: string;
  title: string;
  projectName: string;
  /** Name the project on the card: the thread belongs to a project other than
   *  the one the list is scoped to. */
  showProject: boolean;
  lastUpdated: string | null;
  status: SessionLiveStatus;
  /** The open tab hosting this thread, if any — the timer reads its turn. */
  liveTabId: string | null;
  active: boolean;
  agent: SidebarAgent;
  /** Stable across renders (the card is memoised); called with `threadId`. */
  onOpen: (threadId: string) => void;
  onArchive: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

export const SessionCard = memo(function SessionCard({
  threadId,
  title,
  projectName,
  showProject,
  lastUpdated,
  status,
  liveTabId,
  active,
  agent,
  onOpen,
  onArchive,
  onDelete,
}: SessionCardProps) {
  const descriptionId = useId();
  const agentLabel = agentMeta(AGENT_TYPE_BY_SIDEBAR[agent] ?? agent).label;
  const description = [
    showProject ? projectName : null,
    statusDescription(status, lastUpdated),
    agentLabel,
  ]
    .filter(Boolean)
    .join(", ");
  // The archive/delete actions take this slot's place on hover, so it is at
  // least as wide as they are (two 20px buttons and their gap, less the 4px
  // they sit further right): a short "2h" must not leave them over the title.
  const statusSlot = (
    <span className="flex min-w-10 shrink-0 justify-end transition-opacity duration-fast group-hover:opacity-0 group-focus-within:opacity-0">
      <StatusLabel status={status} tabId={liveTabId} lastUpdated={lastUpdated} />
    </span>
  );

  return (
    <div
      className={cn(
        "group relative flex select-none flex-col gap-1.5 rounded-xl px-2.5 py-2 text-left transition-colors duration-fast",
        active
          ? "bg-element-selected ring-1 ring-foreground/10"
          : "bg-card ring-1 ring-foreground/5 hover:bg-element-hover",
      )}
    >
      {/* The open target sits under its sibling action buttons. */}
      <button
        type="button"
        onClick={() => onOpen(threadId)}
        aria-current={active || undefined}
        aria-label={title}
        aria-describedby={descriptionId}
        className="absolute inset-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      />
      <span id={descriptionId} className="sr-only">
        {description}
      </span>

      {showProject && (
        <div aria-hidden className="pointer-events-none flex min-w-0 items-center gap-1.5">
          <span className="grid h-4 min-w-4 shrink-0 place-items-center rounded-sm bg-element-selected px-0.5 text-3xs font-semibold leading-none text-secondary-foreground">
            {projectMonogram(projectName)}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {projectName}
          </span>
          {statusSlot}
        </div>
      )}

      <div aria-hidden className="pointer-events-none flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "line-clamp-2 min-w-0 flex-1 text-sm leading-snug",
            active ? "text-foreground" : "text-secondary-foreground group-hover:text-foreground",
          )}
        >
          {title}
        </span>
        {!showProject && statusSlot}
      </div>

      <div className="pointer-events-none flex min-w-0 items-center justify-end">
        <span
          aria-hidden
          className="flex shrink-0 items-center text-secondary-foreground"
          title={agentLabel}
        >
          <SidebarAgentIcon agent={agent} />
        </span>
      </div>

      {/* Hover actions (archive, delete) — they take the status's place. Both
          work for every agent: the row is Atlas's, so neither depends on
          reaching the agent that produced it. */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
        <Hint label="Archive — keeps it in History">
          <button
            type="button"
            onClick={() => onArchive(threadId)}
            aria-label="Archive session"
            className="flex size-control-xs items-center justify-center rounded-sm text-muted-foreground hover:bg-element-active hover:text-foreground"
          >
            <Archive size={11} />
          </button>
        </Hint>
        <Hint label="Delete session">
          <button
            type="button"
            onClick={() => onDelete(threadId)}
            aria-label="Delete session"
            className="flex size-control-xs items-center justify-center rounded-sm text-muted-foreground hover:bg-element-active hover:text-error"
          >
            <X size={11} />
          </button>
        </Hint>
      </div>
    </div>
  );
});
