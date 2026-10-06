/** Local attachment optimization; external CLI request limits are vendor-specific. */
export const PER_IMAGE_BUDGET_BYTES = 512 * 1024;
export const MAX_EDGE_PX = 1568;

/** Base64 encodes three bytes as four characters. */
export function encodedSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/**
 * The size an image should be drawn at, or `null` when it is already fine.
 *
 * Aspect ratio is preserved: distorting a screenshot to hit a budget makes it
 * harder to read, which defeats the point of sending it.
 */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE_PX,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Whether an attachment of this encoded size needs shrinking at all.
 *
 * Measured on the base64 length rather than the raw bytes, because base64 is
 * what actually travels over ACP.
 */
export function exceedsBudget(base64Length: number): boolean {
  return base64Length > PER_IMAGE_BUDGET_BYTES;
}

/**
 * Successively lower JPEG qualities to try.
 *
 * Re-encoding a screenshot as JPEG is lossy in a way PNG is not, which is the
 * trade being made: a legible 400 KB JPEG beats a pristine 6 MB PNG that the
 * requires more transport bandwidth.
 */
export const QUALITY_LADDER = [0.85, 0.7, 0.55, 0.4] as const;
