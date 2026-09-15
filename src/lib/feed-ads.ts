// ── In-feed ad insertion helper ─────────────────────────────────────────────
// Pure function: splice native-ad slots into an organic list WITHOUT ever
// touching video playback. Ads are just list items — no pre-roll, no mid-roll,
// no overlay. The renderer decides how an { kind: 'ad' } row looks.

import { spacingForPlan } from './ads-config';

export type FeedRow<T> =
  | { kind: 'content'; value: T; key: string }
  | { kind: 'ad'; key: string; placement: string };

interface InsertOpts {
  plan?: string | null;
  placement: string;
  /** Override for special surfaces (e.g. Moments every 8). */
  firstAfter?: number;
  repeatEvery?: number;
  maxAds?: number;
  keyOf?: (item: unknown, index: number) => string;
}

export function withInFeedAds<T>(items: T[], opts: InsertOpts): FeedRow<T>[] {
  const { placement, keyOf } = opts;
  const spacing = spacingForPlan(opts.plan ?? null);
  const firstAfter = opts.firstAfter ?? spacing.firstAfter;
  const repeatEvery = opts.repeatEvery ?? spacing.repeatEvery;
  const maxAds = opts.maxAds ?? spacing.maxAds;

  if (!items || items.length === 0) return [];
  if (maxAds <= 0) {
    return items.map((value, i) => ({
      kind: 'content' as const,
      value,
      key: keyOf ? keyOf(value, i) : `content-${i}`,
    }));
  }

  const rows: FeedRow<T>[] = [];
  let adsInserted = 0;
  let sinceLastAd = 0;

  items.forEach((value, index) => {
    rows.push({
      kind: 'content',
      value,
      key: keyOf ? keyOf(value, index) : `content-${index}`,
    });
    sinceLastAd += 1;

    const isFirstSlot = adsInserted === 0 && sinceLastAd >= firstAfter;
    const isRepeatSlot = adsInserted > 0 && sinceLastAd >= repeatEvery;
    const hasMoreContentAfter = index < items.length - 1;

    if (
      adsInserted < maxAds &&
      (isFirstSlot || isRepeatSlot) &&
      hasMoreContentAfter
    ) {
      rows.push({
        kind: 'ad',
        key: `ad-${placement}-${adsInserted}-${index}`,
        placement,
      });
      adsInserted += 1;
      sinceLastAd = 0;
    }
  });

  return rows;
}
