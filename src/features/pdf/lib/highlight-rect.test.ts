import { describe, expect, it } from "vitest";
import { NOMINAL_LINE_HEIGHT, highlightRect } from "./highlight-rect";

const LINES = [
  { top: 0.2288, bottom: 0.2427 },
  { top: 0.249, bottom: 0.2629 },
];

describe("highlightRect", () => {
  it("drops a tap", () => {
    expect(highlightRect({ x: 0.3, y: 0.23, w: 0.002, h: 0.002 }, LINES)).toBeNull();
  });

  it("keeps a box drag exactly as drawn", () => {
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
    expect(highlightRect(box, LINES)).toEqual(box);
  });

  it("reads a flat drag along a line as that line", () => {
    const r = highlightRect({ x: 0.12, y: 0.236, w: 0.25, h: 0 }, LINES);
    expect(r).not.toBeNull();
    expect(r!.x).toBe(0.12);
    expect(r!.w).toBe(0.25);
    // Covers the whole glyph box of the first line, and nothing of the second.
    expect(r!.y).toBeLessThan(0.2288);
    expect(r!.y + r!.h).toBeGreaterThan(0.2427);
    expect(r!.y + r!.h).toBeLessThan(0.249);
  });

  it("gives a flat drag over no text a nominal line band centred on it", () => {
    const r = highlightRect({ x: 0.1, y: 0.5, w: 0.2, h: 0.001 }, LINES);
    expect(r!.h).toBeCloseTo(NOMINAL_LINE_HEIGHT);
    expect(r!.y + r!.h / 2).toBeCloseTo(0.5005);
  });

  it("keeps the nominal band on the page at its edges", () => {
    const r = highlightRect({ x: 0.1, y: 0, w: 0.2, h: 0 }, []);
    expect(r!.y).toBe(0);
    expect(r!.h).toBeCloseTo(NOMINAL_LINE_HEIGHT / 2);
  });
});
