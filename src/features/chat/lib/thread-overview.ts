// Derivations for the thread overview rail.
//
// Pure, and over the chat store's own data — the rail asks the same thread the
// transcript does, from a different angle. Nothing here fetches, and nothing
// here is per-frame expensive: every pass is over `messages`, which is already
// the hot object, so each one is gated on the section actually being open.

import type { ChatMessage, TurnFile } from "@/types/agent";

export interface ChangeTally {
  files: TurnFile[];
  added: number;
  removed: number;
  /** Files the thread only READ. Kept apart from the edits because a reader
   *  scanning "what did this change" is not asking about them, and a list that
   *  mixes the two is mostly noise on a long turn. */
  readCount: number;
}

const EMPTY_CHANGES: ChangeTally = Object.freeze({
  files: [],
  added: 0,
  removed: 0,
  readCount: 0,
});

/**
 * Every file the thread has edited, newest turn last, one entry per path.
 *
 * Built from the per-turn summaries (`ChatMessage.turnSummary.files`) rather
 * than from tool calls, because that is where the counted lines already live —
 * the store froze them at `turn_finished` and the transcript footer renders
 * the same numbers. A file edited across several turns appears once, with its
 * line counts summed: the question the rail answers is "what has this
 * conversation done to the repo", not "what happened in turn four".
 *
 * A turn still running has no summary yet, so its edits appear when it ends.
 * That lag is honest — the counts do not exist until the turn is over — and
 * the live answer is the transcript, which is showing the edits as they land.
 */
export function tallyChanges(messages: readonly ChatMessage[]): ChangeTally {
  const edits = new Map<string, TurnFile>();
  const reads = new Set<string>();
  for (const message of messages) {
    const files = message.turnSummary?.files;
    if (!files) continue;
    for (const file of files) {
      if (file.kind === "read") {
        reads.add(file.path);
        continue;
      }
      const seen = edits.get(file.path);
      if (seen) {
        seen.added += file.added;
        seen.removed += file.removed;
        // "Created" survives: a file this thread created and then edited again
        // is still the thread's to have created, and git will report it as A.
        seen.created = seen.created || file.created;
      } else {
        edits.set(file.path, { ...file });
      }
    }
  }
  if (edits.size === 0 && reads.size === 0) return EMPTY_CHANGES;

  const files = [...edits.values()];
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  // A path that was read and later edited is an edit; it must not be counted
  // in both, or the two numbers beside the section header disagree with the
  // list under it.
  for (const path of edits.keys()) reads.delete(path);
  return { files, added, removed, readCount: reads.size };
}

/** Whether the thread has edited anything at all — the cheap read that decides
 *  whether the Changes section has a body, without building the list. */
export function hasChanges(messages: readonly ChatMessage[]): boolean {
  for (const message of messages) {
    const files = message.turnSummary?.files;
    if (files?.some((f) => f.kind === "edit")) return true;
  }
  return false;
}

/** "+58 −26", the shape git and every review surface uses. An empty string
 *  when nothing changed, so a caller can render the slot or not without
 *  testing two numbers. */
export function formatDiffStat(added: number, removed: number): string {
  if (added === 0 && removed === 0) return "";
  return `+${added} −${removed}`;
}

/**
 * The last turn that can be committed, if any.
 *
 * `repoAtTurn` is the gate: it records whether the project was a git
 * repository when the turn ENDED, which is the only honest answer available
 * later — a repo initialised since then has no claim on those edits, and one
 * removed since then cannot take them.
 */
export function committableTurn(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const summary = messages[i].turnSummary;
    if (!summary) continue;
    if (!summary.repoAtTurn) return null;
    return summary.files.some((f) => f.kind === "edit") ? messages[i] : null;
  }
  return null;
}
