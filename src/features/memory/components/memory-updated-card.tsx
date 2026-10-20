// "Memory updated": what this chat session saved to shared memory, under its
// transcript, with a one-click Forget (memory plan M4). It makes an agent's
// writes visible where they happen, which is also the cheapest check against
// a bad memory: the user sees "always force-push" right after the turn that
// wrote it. Nothing renders until the session writes something.

import { useState } from "react";
import {
  Brain,
  ChevronRight,
  FileDiff,
  GitBranch,
  Info,
  Layers,
  ListTodo,
  SlidersHorizontal,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { sharedMemory } from "../lib/shared-memory-api";
import { useMemoryStore } from "../stores/memory-store";
import {
  useSessionMemoryWrites,
  writesSummary,
  type SessionWrite,
} from "../lib/use-session-memory-writes";

/** Matches the transcript's tool markers (`ICON_PX` / `ICON_STROKE`), because
 *  this block sits in the same column as them and reads as one of them. */
const ICON_PX = 14;
const ICON_STROKE = 1.5;

/**
 * What each kind of memory looks like, by its wire spelling
 * (`EntryKind::as_str`).
 *
 * An icon rather than the kind's name: the names are the column's own data and
 * they are not the same length, so a fixed-width label column either clipped
 * `ARCHITECTURE` or left a gap after `FACT` — and the version before this gave
 * it `w-16`, which the long ones overran straight into the content beside them.
 * An icon is one width by construction. The name stays reachable as the row's
 * tooltip, which is where a reader who does not know the glyph will look.
 */
const KIND_ICON: Record<string, LucideIcon> = {
  fact: Info,
  decision: GitBranch,
  failure: TriangleAlert,
  architecture: Layers,
  preference: SlidersHorizontal,
  plan: ListTodo,
  plan_set: ListTodo,
  file_changed: FileDiff,
};

/** The kind's own word, for the tooltip the icon stands in for. */
function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** Open the entry in Memory ▸ Shared ▸ Memories, expanded. The Memory tab is
 *  one per column, so this focuses the open one or opens it. */
function openEntry(id: number) {
  useMemoryStore.getState().actions.focusEntry(id);
  useLayoutStore.getState().actions.addTab({
    id: "memory",
    type: "memory",
    title: "Memory",
    closable: true,
    dirty: false,
    data: {},
  });
}

export function MemoryUpdatedCard({
  projectPath,
  sessionId,
  since = 0,
  className,
}: {
  projectPath: string | null;
  sessionId: string | null;
  since?: number;
  className?: string;
}) {
  const { writes, refresh, error } = useSessionMemoryWrites(projectPath, sessionId, since);
  const [open, setOpen] = useState(false);
  const [forgetting, setForgetting] = useState<SessionWrite | null>(null);
  if (!projectPath) return null;
  if (error)
    return (
      <div role="status" className="text-xs text-[var(--muted-foreground)]">
        Couldn't read memory updates: {error}{" "}
        <button onClick={() => void refresh()} className="underline">
          Retry
        </button>
      </div>
    );
  if (writes.length === 0) return null;

  const forget = async (w: SessionWrite) => {
    try {
      await sharedMemory.forgetEntry(projectPath, w.id);
    } catch (err) {
      toast.error(`Couldn't forget: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refresh();
    }
  };

  return (
    // The same centred column every transcript row uses
    // (`transcript-rows.tsx`'s `Column`): `max-w-[760px]` AND `px-6`. Without
    // the padding this block was 760px against every neighbour's 712px, so it
    // hung 24px past the turn above it on both sides.
    <div className={cn("mx-auto w-full max-w-[760px] px-6 py-1", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="atlas-marker group/memory w-full cursor-pointer text-left text-base text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]"
      >
        <span className="flex w-4 shrink-0 justify-center">
          <Brain size={ICON_PX} strokeWidth={ICON_STROKE} />
        </span>
        <span className="min-w-0 truncate">Memory updated: {writesSummary(writes)}</span>
        <ChevronRight
          size={ICON_PX}
          strokeWidth={ICON_STROKE}
          className={cn(
            "shrink-0",
            // Same reveal as a tool fold: the chevron is a hint, not chrome, so
            // it stays out of the line until the row is reached for.
            open
              ? "rotate-90 opacity-100"
              : "opacity-0 group-hover/memory:opacity-100 group-focus-visible/memory:opacity-100",
          )}
        />
      </button>

      {open && (
        <ul className="mt-0.5 flex flex-col">
          {writes.map((w) => {
            const Icon = KIND_ICON[w.kind] ?? Brain;
            return (
              <li
                key={w.rev}
                // A rule under each row and none around them: the group reads
                // as a list rather than as a stack of boxes, which is what the
                // bordered card it replaced looked like. `last:border-b-0`
                // keeps the group from drawing a line into the space below it.
                className="flex items-start gap-2.5 border-b border-[var(--border)] py-1.5 last:border-b-0"
              >
                <span
                  title={kindLabel(w.kind)}
                  className="flex w-4 shrink-0 justify-center pt-px text-[var(--muted-foreground)]"
                >
                  <Icon size={ICON_PX} strokeWidth={ICON_STROKE} aria-hidden />
                  <span className="sr-only">{kindLabel(w.kind)}</span>
                </span>

                {w.live ? (
                  <button
                    type="button"
                    onClick={() => openEntry(w.id)}
                    className="min-w-0 flex-1 break-words text-left text-xs text-[var(--foreground)] hover:underline"
                  >
                    {w.content}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 break-words text-xs text-[var(--foreground)]">
                    {w.content || "(forgotten)"}
                  </span>
                )}

                {w.live && w.state === "candidate" && (
                  <span className="shrink-0 pt-0.5 text-3xs uppercase text-[var(--muted-foreground)]">
                    candidate
                  </span>
                )}
                {/* Forgotten or archived since, by anyone: nothing left to forget. */}
                {!w.live && w.op !== "forget" && (
                  <span className="shrink-0 pt-0.5 text-3xs uppercase text-[var(--muted-foreground)]">
                    removed
                  </span>
                )}

                {w.live && (
                  <button
                    type="button"
                    aria-label="Forget"
                    title="Forget this memory"
                    onClick={() => setForgetting(w)}
                    className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--border)] text-[var(--muted-foreground)] transition-colors duration-fast hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
                  >
                    <X size={10} strokeWidth={ICON_STROKE} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <FileTreeConfirmDelete
        open={forgetting !== null}
        name={forgetting?.content ?? ""}
        isDir={false}
        title="Forget this memory?"
        body="Removed from shared memory and future retrieval. Revision history and existing conversations remain."
        confirmLabel="Forget"
        onConfirm={() => {
          if (forgetting) void forget(forgetting);
          setForgetting(null);
        }}
        onOpenChange={(v) => {
          if (!v) setForgetting(null);
        }}
      />
    </div>
  );
}
