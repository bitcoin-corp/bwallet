/** Timing for the card-generating screen (CardGenerating.tsx). Pure. */

export const STATUS_LINES = [
  'Mixing the colours…',
  'Lighting the candles…',
  'Adding a little gold…',
  'Polishing the edges…',
  'Nearly there…',
] as const;

/** Ring progress for `s` seconds in: eases toward 0.9 by about 60 s and never passes it until done. */
export const ringProgress = (s: number, done = false): number =>
  done ? 1 : 0.9 * (1 - Math.exp(-Math.max(0, s) / 22));

/** Which friendly line to show at `s` seconds (every 8 s; the last one holds). */
export const statusLine = (s: number): string =>
  STATUS_LINES[Math.min(STATUS_LINES.length - 1, Math.floor(Math.max(0, s) / 8))];
