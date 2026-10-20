import { describe, expect, it } from "vitest";

import { committableTurn, formatDiffStat, hasChanges, tallyChanges } from "./thread-overview";
import type { ChatMessage, TurnFile } from "@/types/agent";

function file(over: Partial<TurnFile> & Pick<TurnFile, "path">): TurnFile {
  return { kind: "edit", added: 0, removed: 0, ...over };
}

function turn(files: TurnFile[], repoAtTurn = true, id = "m1"): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-17T00:00:00Z",
    turnSummary: { turnSeq: 1, files, repoAtTurn },
  } as ChatMessage;
}

describe("tallyChanges", () => {
  it("sums a file edited across several turns into one entry", () => {
    // The rail answers "what has this conversation done to the repo", so the
    // same path touched twice is one row, not two.
    const tally = tallyChanges([
      turn([file({ path: "a.ts", added: 10, removed: 2 })], true, "m1"),
      turn([file({ path: "a.ts", added: 5, removed: 1 })], true, "m2"),
    ]);
    expect(tally.files).toHaveLength(1);
    expect(tally.files[0]).toMatchObject({ path: "a.ts", added: 15, removed: 3 });
    expect(tally.added).toBe(15);
    expect(tally.removed).toBe(3);
  });

  it("keeps 'created' once set", () => {
    // Created then edited again is still the thread's to have created, and git
    // reports it as A.
    const tally = tallyChanges([
      turn([file({ path: "n.ts", added: 9, created: true })], true, "m1"),
      turn([file({ path: "n.ts", added: 1 })], true, "m2"),
    ]);
    expect(tally.files[0].created).toBe(true);
  });

  it("counts a read-then-edited path as an edit only", () => {
    // Counted in both, the figure beside the header disagrees with the list
    // under it.
    const tally = tallyChanges([
      turn(
        [file({ path: "a.ts", kind: "read" }), file({ path: "b.ts", kind: "read" })],
        true,
        "m1",
      ),
      turn([file({ path: "a.ts", added: 3 })], true, "m2"),
    ]);
    expect(tally.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(tally.readCount).toBe(1);
  });

  it("ignores a turn still running, which has no summary yet", () => {
    const live = { ...turn([], true, "m2") } as ChatMessage;
    delete (live as { turnSummary?: unknown }).turnSummary;
    expect(tallyChanges([turn([file({ path: "a.ts", added: 2 })]), live]).added).toBe(2);
  });

  it("is empty for a thread that touched nothing", () => {
    expect(tallyChanges([]).files).toEqual([]);
    expect(hasChanges([])).toBe(false);
    expect(hasChanges([turn([file({ path: "a.ts", kind: "read" })])])).toBe(false);
    expect(hasChanges([turn([file({ path: "a.ts", added: 1 })])])).toBe(true);
  });
});

describe("formatDiffStat", () => {
  it("renders nothing when nothing changed, so the slot can be omitted", () => {
    expect(formatDiffStat(0, 0)).toBe("");
    expect(formatDiffStat(58, 26)).toBe("+58 −26");
  });
});

describe("committableTurn", () => {
  it("is the last turn with edits, when the project was a repo then", () => {
    const m = committableTurn([
      turn([file({ path: "a.ts", added: 1 })], true, "m1"),
      turn([file({ path: "b.ts", added: 2 })], true, "m2"),
    ]);
    expect(m?.id).toBe("m2");
  });

  it("is nothing when the project was not a repo at the end of that turn", () => {
    // `repoAtTurn` is the only honest answer available later: a repo
    // initialised since has no claim on those edits.
    expect(committableTurn([turn([file({ path: "a.ts", added: 1 })], false)])).toBeNull();
  });

  it("is nothing when the last summarised turn only read", () => {
    expect(
      committableTurn([
        turn([file({ path: "a.ts", added: 1 })], true, "m1"),
        turn([file({ path: "b.ts", kind: "read" })], true, "m2"),
      ]),
    ).toBeNull();
  });
});
