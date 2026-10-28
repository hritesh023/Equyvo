/**
 * Engagement counters (likes, shares, reacts, upvotes, downvotes, comments…)
 *
 * Counts reach the UI as numbers, numeric strings, "1.2K", undefined or null
 * depending on the writer (legacy localStorage items, server rows, mock data).
 * Doing arithmetic on any non-numeric value silently produced `NaN` in the UI
 * ("NaN likes" right after the first like). Every read of a counter and every
 * optimistic increment must go through here so a count can never be NaN/blank:
 *
 *   toCount(undefined)          → 0
 *   toCount('7')                → 7
 *   bumpCount(undefined, +1)    → 1
 *   bumpCount('1.2K', -1)       → 1199  (K/M suffixes expanded first)
 */
export function toCount(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return 0;
    // Sparse suffixes ("1.2K", "3.4M") common in cached legacy rows.
    const m = /^([\d.]+)\s*([kKmM])$/.exec(raw);
    const n = m
      ? parseFloat(m[1]) * (m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000)
      : parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return 0;
}

/** Optimistically adjust a count by +1/−1 (or any delta), never below 0. */
export function bumpCount(current: unknown, delta: number): number {
  return Math.max(0, toCount(current) + delta);
}

/** A re-display safe copy: every rendered counter calls this. */
export function showCount(value: unknown): number {
  return toCount(value);
}
