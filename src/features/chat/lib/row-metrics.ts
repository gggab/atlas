// Shared numeric constants for transcript rows.
//
// This is what survives of the deterministic-height experiment. The transcript
// briefly predicted every row's height before layout so it could be virtualized;
// that lost to a plain windowed list (see the header of `transcript.tsx`), and
// with it went the height function, the canvas text measurement, and the dev
// drift assertion. Rows are real DOM now and the browser owns their size.
//
// What is left is the handful of numbers the components genuinely share with the
// stylesheet — currently just the user-bubble clamp, which has to agree with the
// `max-height` budget `useWholeLineClamp` (in `transcript-rows.tsx`) snaps to
// whole lines and with the "is this long enough to need a Show more" test.

/**
 * Height the floating chat header occupies.
 *
 * Shared because two surfaces have to agree with it and with each other: the
 * transcript pads its content by this much so the first row clears the bar,
 * and the overview rail reserves the same height so its first card begins
 * under the header's icons rather than beside them (the bar floats over the
 * conversation column only, so a rail starting at y=0 sits next to them).
 *
 * Here rather than in `chat-panel.tsx`: the rail is a lazily imported chunk,
 * and a static import of the panel to reach one number would pull the whole
 * panel into that chunk and make the split pointless.
 */
export const HEADER_INSET = 46;

/**
 * The conversation's content frame: centred, 760px at most, padded the same on
 * both sides.
 *
 * Transcript rows and permission cards share this frame, including when the
 * overview rail narrows the conversation column.
 */
export const CONTENT_COLUMN = "mx-auto w-full max-w-[760px] px-6";

export const M = {
  /** Lines a user prompt shows before clamping behind "Show more". */
  userMaxLines: 12,
  /** Line height (px) of a user bubble, and the unit its clamp is measured in.
   *  Must agree with `.atlas-prose--user` in `globals.css` — the clamp is a
   *  `max-height`, so a stylesheet-only change would silently cut a partial
   *  line. */
  userLineHeight: 22,
} as const;
