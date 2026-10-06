/**
 * Turning a Highlight-tool drag into the rectangle that gets stored.
 *
 * All geometry is normalized 0..1 of the page (see `pdf-annotation-store`).
 *
 * A highlighter is used the way a highlighter pen is: dragged ALONG a line of
 * text. That drag is wide and almost perfectly flat, and requiring it to also
 * be tall — the old rule — threw every such stroke away, so the tool appeared
 * to do nothing. A flat drag is therefore read as "this line": it takes the
 * vertical extent of the text line under the stroke, or a nominal line band
 * where there is no text (a scanned page has no text layer).
 */

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A text line's vertical extent on the page, normalized. */
export interface LineBand {
  top: number;
  bottom: number;
}

/** Below this, a dimension is a stray tap rather than a drag. */
export const MIN_HIGHLIGHT = 0.005;

/** The band a flat drag gets where no text line is under it: about one line
 *  of 11pt body text on a Letter page, which is the common case. */
export const NOMINAL_LINE_HEIGHT = 0.018;

/** Air above and below the glyph box, as a fraction of the line's height, so
 *  the highlight reads as covering the line rather than clipping it. */
const LINE_PAD = 0.2;

export function highlightRect(drag: NormRect, lines: readonly LineBand[]): NormRect | null {
  if (drag.w <= MIN_HIGHLIGHT) return null;
  // A box drag is taken exactly as drawn.
  if (drag.h > MIN_HIGHLIGHT) return drag;

  const mid = drag.y + drag.h / 2;
  const line = lines.find((l) => l.top <= mid && mid <= l.bottom);
  let top: number;
  let bottom: number;
  if (line) {
    const pad = (line.bottom - line.top) * LINE_PAD;
    top = line.top - pad;
    bottom = line.bottom + pad;
  } else {
    top = mid - NOMINAL_LINE_HEIGHT / 2;
    bottom = mid + NOMINAL_LINE_HEIGHT / 2;
  }
  top = Math.max(0, top);
  bottom = Math.min(1, bottom);
  return { x: drag.x, y: top, w: drag.w, h: bottom - top };
}
