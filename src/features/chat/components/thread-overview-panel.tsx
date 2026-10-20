// The thread overview — a rail docked to the right of the conversation.
//
// It answers the questions a long turn raises that the thread itself answers
// badly, because the answer is scattered through it: how many children are
// running, what this conversation has changed, what it remembered. Claude
// Desktop's right rail ("Background tasks · 3 running") and t3code's thread
// details panel are the two references.
//
// Like the comments panel it is DOCKED, not an overlay: it takes layout space
// and the transcript reflows narrower beside it. An overlay over a transcript
// the reader is following would cover the thing the rail is describing.
//
// Contract with the transcript, inherited from `detail-panel`: opening,
// resizing or collapsing a section must not re-render a single transcript row.
// Nothing here writes to the chat store, and the rail's own state lives in
// `thread-overview-store`.

import { useMemo } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

import { openDetail } from "../stores/detail-panel-store";
import { HEADER_INSET } from "../lib/row-metrics";
import { useChatStore } from "../stores/chat-store";
import {
  OVERVIEW_SECTIONS,
  SECTION_TITLE,
  useThreadOverviewStore,
  type OverviewSection,
} from "../stores/thread-overview-store";
import { useSubagents } from "../hooks/use-subagents";
import { elapsedMs, isRunning, tallySubagents } from "../lib/subagents";
import { formatDiffStat, tallyChanges } from "../lib/thread-overview";
import { LiveElapsed, settledFigure } from "./transcript-rows";

// ── Section chrome ─────────────────────────────────────────────────────────

/**
 * One section, as its own card.
 *
 * Separate cards rather than a bordered panel of stacked rows, which is how
 * Claude Desktop's rail reads and why it reads well: the sections are
 * unrelated — a subagent has nothing to do with a diff stat — and a shared
 * frame implies they belong to one list you read top to bottom. Floating each
 * one lets a reader take in just the card they came for, and lets a section
 * with nothing in it simply not be there.
 *
 * The title row always carries its count, open or collapsed. That count is
 * the whole value of a collapsed card: a section that hid it would have to be
 * opened before it said anything.
 */
function Section({
  id,
  status,
  children,
}: {
  id: OverviewSection;
  /** The right-hand figure: "3 running", "+58 −26". Empty hides the slot. */
  status: string;
  children: React.ReactNode;
}) {
  const collapsed = useThreadOverviewStore((s) => Boolean(s.collapsed[id]));
  const { toggleSection } = useThreadOverviewStore.use.actions();
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)]">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => toggleSection(id)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left hover:bg-[var(--muted)]"
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--secondary-foreground)]">
          {SECTION_TITLE[id]}
        </span>
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-[var(--muted-foreground)] transition-transform",
            collapsed && "-rotate-90",
          )}
        />
        {status && (
          <span className="ml-1 shrink-0 font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums">
            {status}
          </span>
        )}
      </button>
      {!collapsed && <div className="px-1 pb-1.5">{children}</div>}
    </section>
  );
}

/** What a section says when it has nothing — one muted line, never an empty
 *  box with a heading over it. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1 text-2xs text-[var(--atlas-text-disabled)]">{children}</p>;
}

// ── Sections ───────────────────────────────────────────────────────────────

function SubagentsSection({ tabId }: { tabId: string }) {
  const children = useSubagents(tabId);
  const tally = useMemo(() => tallySubagents(children), [children]);
  // "3 running" while any is live, else the total — which is the figure
  // Claude Desktop puts beside its own Background tasks header, and the only
  // one that changes while you watch.
  const status =
    tally.running > 0 ? `${tally.running} running` : tally.total > 0 ? `${tally.total}` : "";

  return (
    <Section id="subagents" status={status}>
      {children.length === 0 ? (
        <Empty>No agents delegated to.</Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {children.map((child) => (
            <li key={child.toolCallId}>
              {/* Opens the child's own body beside the thread, the same target
                  its transcript row opens — one subagent, one place to read it. */}
              <button
                type="button"
                onClick={() =>
                  openDetail(tabId, { kind: "subagent", toolCallId: child.toolCallId })
                }
                // The hover rectangle is the row, so it carries the row's
                // padding: hanging it on a `py-0.5` line inside the card's own
                // padding put the highlight hard against the card's border
                // with the orb sitting on the edge of it.
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--muted)]"
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    child.status === "running"
                      ? "bg-[var(--primary)] atlas-marker-running"
                      : child.status === "failed"
                        ? "bg-[var(--atlas-status-error-foreground)]"
                        : "bg-[var(--atlas-text-disabled)]",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--secondary-foreground)]">
                  {child.name.trim() || "Subagent"}
                </span>
                <span className="shrink-0 font-mono text-2xs text-[var(--atlas-text-disabled)] tabular-nums">
                  {isRunning(child) ? (
                    <LiveElapsed startedAt={child.startedAtMs} minMs={1000} />
                  ) : (
                    settledFigure(elapsedMs(child, Date.now()))
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ChangesSection({ tabId }: { tabId: string }) {
  const messages = useChatStore((s) => s.sessions[tabId]?.messages);
  const tally = useMemo(() => tallyChanges(messages ?? []), [messages]);
  return (
    <Section id="changes" status={formatDiffStat(tally.added, tally.removed)}>
      {tally.files.length === 0 ? (
        <Empty>
          {tally.readCount > 0 ? `${tally.readCount} files read, none changed.` : "No changes yet."}
        </Empty>
      ) : (
        <ul className="m-0 list-none p-0">
          {tally.files.map((file) => (
            <li key={file.path} className="flex items-center gap-2 px-2 py-1">
              <span
                className="min-w-0 flex-1 truncate text-xs text-[var(--secondary-foreground)]"
                title={file.path}
              >
                {file.path.split("/").pop()}
              </span>
              <span className="shrink-0 font-mono text-2xs tabular-nums">
                {file.added > 0 && (
                  <span className="text-[var(--atlas-diff-added-text)]">+{file.added}</span>
                )}
                {file.removed > 0 && (
                  <span className="ml-1 text-[var(--atlas-status-error-foreground)]">
                    −{file.removed}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const SECTION_VIEW: Record<OverviewSection, (props: { tabId: string }) => React.ReactNode> = {
  subagents: SubagentsSection,
  changes: ChangesSection,
};

// ── Panel ──────────────────────────────────────────────────────────────────

export function ThreadOverviewPanel({ tabId }: { tabId: string }) {
  const width = useThreadOverviewStore.use.width();

  return (
    // No panel chrome: no border, no header, no fill of its own. The cards ARE
    // the surface, floating on the conversation's own background — which is
    // what lets the subagent view open OVER this as a full panel without two
    // competing frames on the same edge.
    <aside
      aria-label="Thread overview"
      // The header bar floats over the CONVERSATION column only, so a rail
      // starting at y=0 sits beside its icons rather than under them. Reserve
      // the bar's height here too and the first card begins on the same line
      // the transcript's first row does.
      style={{ width, paddingTop: HEADER_INSET }}
      className="hide-scrollbar flex h-full max-w-[50%] shrink-0 flex-col gap-2 overflow-y-auto px-2 pb-2"
    >
      {OVERVIEW_SECTIONS.map((id) => {
        const View = SECTION_VIEW[id];
        return <View key={id} tabId={tabId} />;
      })}
    </aside>
  );
}
