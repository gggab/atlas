import { describe, expect, it } from "vitest";
import { countChangedLines, countEditLines, getEditParts, isFileCreated } from "./tool-files";

describe("tool-reported changed lines", () => {
  it.each([
    ["", "", 0, 0],
    ["", "a\nb\nc", 3, 0],
    ["", "a\nb\nc\n", 3, 0],
    ["a\nb\nc\n", "", 0, 3],
    ["", "a\n\n", 2, 0],
    ["", "\n", 1, 0],
    ["a\nb\n", "a\nb\n", 0, 0],
    ["a", "a\n", 0, 0],
    ["a\r\nb\r\n", "a\r\nc\r\n", 1, 1],
  ] as const)("counts %j to %j as +%i/-%i", (old, neu, added, removed) => {
    expect(countChangedLines(old, neu)).toEqual({ added, removed });
  });

  it("recognizes an edit by ACP kind when its tool name is a display title", () => {
    const args = { file_path: "/repo/x.ts", content: "a\nb\nc\n" };
    expect(countEditLines("Write src/x.ts", args, "edit")).toEqual({ added: 3, removed: 0 });
    expect(getEditParts("Write src/x.ts", args, "edit")).toEqual([{ old: "", neu: args.content }]);
    expect(isFileCreated("Write src/x.ts", args, "edit")).toBe(true);
    for (const kind of ["read", null, undefined]) {
      expect(countEditLines("Write src/x.ts", args, kind)).toEqual({ added: 0, removed: 0 });
      expect(isFileCreated("Write src/x.ts", args, kind)).toBe(false);
    }
  });

  it("prefers replacement text over an edit's content field", () => {
    const args = { old_string: "old\n", new_string: "new\n", content: "unrelated" };
    expect(countEditLines("Edit src/x.ts", args, "edit")).toEqual({ added: 1, removed: 1 });
    expect(isFileCreated("Edit src/x.ts", args, "edit")).toBe(false);
  });

  it("keeps legacy tool names working without ACP kind", () => {
    expect(countEditLines("Write", { content: "a\n" })).toEqual({ added: 1, removed: 0 });
  });
});
