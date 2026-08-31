const TASK_RING_OFFSET_PARAM = "taskRingOffset";

/**
 * Read the temporary TaskRing tuning knob without ever accepting it in a
 * production build. The numeric conversion also prevents a query value from
 * becoming part of a CSS declaration verbatim.
 */
export function readDevTaskRingOffset(
  search: string,
  isDev: boolean,
): number | null {
  if (!isDev) return null;

  const raw = new URLSearchParams(search).get(TASK_RING_OFFSET_PARAM);
  if (raw === null || raw.trim() === "") return null;

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Replace the current pixel term when the dev tuning knob is present. The
 * existing callers pass either no top offset (the card's CSS `-2% + 8px`)
 * or `calc(6% + 8px)` (the detail pane), so preserving the anchor and only
 * replacing that pixel term keeps the production geometry bit-for-bit.
 */
export function taskRingTopWithDevOffset(
  topOffset: string | undefined,
  devOffset: number | null,
): string | undefined {
  if (devOffset === null || !Number.isFinite(devOffset)) return topOffset;

  const anchor = topOffset ?? "-2%";
  const currentPixelTerm = /^calc\((.*)\s*\+\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)px\)$/;
  const anchorWithoutPixelTerm = anchor.match(currentPixelTerm)?.[1] ?? anchor;
  const sign = devOffset < 0 ? "-" : "+";
  const magnitude = Math.abs(devOffset);
  return `calc(${anchorWithoutPixelTerm} ${sign} ${magnitude}px)`;
}
