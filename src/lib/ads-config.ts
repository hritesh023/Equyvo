// ── Equyvo Ads configuration ────────────────────────────────────────────────
// AdMob IDs provided by the app owner. PUBLIC values (safe to ship in client).
// App ID goes in AndroidManifest / Info.plist. Ad unit is Native Advanced.

export const ADMOB_APP_ID =
  import.meta.env.VITE_ADMOB_APP_ID || 'ca-app-pub-8929153950560106~6452994138';

export const ADMOB_NATIVE_AD_UNIT_ID =
  import.meta.env.VITE_ADMOB_NATIVE_AD_UNIT ||
  'ca-app-pub-8929153950560106/1659832454';

// Google test IDs — automatically used in dev / localhost so real impressions
// are never generated during development (AdMob policy).
export const TEST_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
export const TEST_NATIVE_AD_UNIT_ID = 'ca-app-pub-3940256099942544/2247696110';
// Google's official banner test unit (used on native dev builds).
export const TEST_BANNER_AD_UNIT_ID = 'ca-app-pub-3940256099942544/6300978111';

/**
 * Banner ad unit for the adaptive feed banner (the format that actually
 * earns: the community Capacitor plugin supports banner/interstitial/
 * rewarded/app-open, but NOT Native Advanced). Defaults to the owner's
 * production banner unit; override with VITE_ADMOB_BANNER_AD_UNIT.
 * Empty = banner stays off.
 */
export const ADMOB_BANNER_AD_UNIT_ID =
  import.meta.env.VITE_ADMOB_BANNER_AD_UNIT ||
  'ca-app-pub-8929153950560106/2244247233';

/**
 * Interstitial ad unit (owner-provided). Shown ONLY at natural
 * content-session ends (after the user finishes watching video/stories),
 * never mid-watch, never pre-roll. Frequency-capped so it can never
 * irritate: first show waits for the session to mature, then a hard
 * minimum interval between two shows.
 */
export const ADMOB_INTERSTITIAL_AD_UNIT_ID =
  import.meta.env.VITE_ADMOB_INTERSTITIAL_AD_UNIT ||
  'ca-app-pub-8929153950560106/1150036266';
export const TEST_INTERSTITIAL_AD_UNIT_ID = 'ca-app-pub-3940256099942544/1033173712';

/** Advertising test-device IDs (comma-separated) for real-device testing. */
export function admobTestDevices(): string[] {
  const raw = import.meta.env.VITE_ADMOB_TEST_DEVICES || '';
  return raw
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
}

// ── AdSense for Web (the format that earns on equyvo.com) ─────────────────
// AdMob Native Advanced has NO web SDK — that is why the web build could only
// ever show the Equyvo house promo. On web, in-feed earning comes from
// AdSense (display ads inside <ins> slots). Native apps keep using AdMob.
export const ADSENSE_CLIENT_ID =
  import.meta.env.VITE_ADSENSE_CLIENT || '';
export const ADSENSE_SLOT =
  import.meta.env.VITE_ADSENSE_SLOT || '';

/** True when a real AdSense slot is configured (never true with test IDs). */
export function isAdSenseConfigured(): boolean {
  return (
    ADSENSE_CLIENT_ID.startsWith('ca-pub-') && ADSENSE_SLOT.trim() !== ''
  );
}

export const ADS_ENABLED =
  (import.meta.env.VITE_ADS_ENABLED ?? 'true') !== 'false';

/**
 * UX-first placement policy (the "no frustration" rules):
 * - NEVER pre-roll (no ad before a video starts)
 * - NEVER mid-roll (no ad interrupting playback, no overlay on video)
 * - ONLY in-feed native cards that look like regular posts and are
 *   clearly labelled "Sponsored", dismissible, and spaced out.
 * - First ad only after N organic items, then every M items, capped per feed.
 */
export const AD_POLICY = {
  /** Organic items before the first ad appears. */
  FIRST_AD_AFTER: 6,
  /** Gap between subsequent ads (organic items). */
  REPEAT_EVERY: 8,
  /** Max native ads per feed render (Free plan). */
  MAX_ADS_PER_FEED: 3,
  /** Ad-light (Plus plan) multiplier — ads are 2x sparser. */
  PLUS_SPACING_MULTIPLIER: 2,
  /** Min seconds between two counted impressions in the same session. */
  IMPRESSION_COOLDOWN_SEC: 90,
  /** Moments vertical feed: organic clips between sponsored slides. */
  MOMENTS_AD_EVERY: 8,
} as const;

export type PlanId =
  | 'eq_free'
  | 'eq_plus'
  | 'eq_premium'
  | 'eq_creator'
  | 'eq_creator_pro'
  | string;

const AD_FREE_PLANS = new Set(['eq_premium', 'eq_creator', 'eq_creator_pro']);
const AD_LIGHT_PLANS = new Set(['eq_plus']);

/** Premium / Creator plans never see ads. */
export function isAdFreePlan(plan?: string | null): boolean {
  if (!plan) return false;
  return AD_FREE_PLANS.has(plan);
}

/** Plus plan sees "ad-light" (half the density). */
export function isAdLightPlan(plan?: string | null): boolean {
  if (!plan) return false;
  return AD_LIGHT_PLANS.has(plan);
}

export function shouldShowAds(plan?: string | null): boolean {
  if (!ADS_ENABLED) return false;
  if (typeof localStorage !== 'undefined') {
    // User-level kill switch (also used by tests).
    if (localStorage.getItem('equyvo_ads_disabled') === 'true') return false;
  }
  if (isAdFreePlan(plan)) return false;
  return true;
}

/** Effective spacing for a plan (Plus = sparser). */
export function spacingForPlan(plan?: string | null): {
  firstAfter: number;
  repeatEvery: number;
  maxAds: number;
} {
  if (isAdLightPlan(plan)) {
    return {
      firstAfter: AD_POLICY.FIRST_AD_AFTER * AD_POLICY.PLUS_SPACING_MULTIPLIER,
      repeatEvery: AD_POLICY.REPEAT_EVERY * AD_POLICY.PLUS_SPACING_MULTIPLIER,
      maxAds: 2,
    };
  }
  return {
    firstAfter: AD_POLICY.FIRST_AD_AFTER,
    repeatEvery: AD_POLICY.REPEAT_EVERY,
    maxAds: AD_POLICY.MAX_ADS_PER_FEED,
  };
}

/** Use Google test IDs on localhost / dev builds (AdMob policy). */
export function isDevEnvironment(): boolean {
  // Native app builds (Capacitor APK/iOS) are never "dev" for ad purposes,
  // even though their WebView origin is https://localhost. Real ad units must
  // be used on device; test units are only for browser/localhost development.
  try {
    const cap = (window as any)?.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      return false;
    }
  } catch { /* ignore */ }
  if (import.meta.env.DEV) return true;
  if (typeof window !== 'undefined') {
    const h = window.location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return true;
  }
  return false;
}

export function effectiveAdUnitId(): string {
  if (isDevEnvironment()) return TEST_NATIVE_AD_UNIT_ID;
  return ADMOB_NATIVE_AD_UNIT_ID;
}

/** Banner unit actually requested (test unit on dev builds). */
export function effectiveBannerAdUnitId(): string {
  if (isDevEnvironment()) return TEST_BANNER_AD_UNIT_ID;
  return ADMOB_BANNER_AD_UNIT_ID;
}

/** Interstitial unit actually requested (test unit on dev builds). */
export function effectiveInterstitialAdUnitId(): string {
  if (isDevEnvironment()) return TEST_INTERSTITIAL_AD_UNIT_ID;
  return ADMOB_INTERSTITIAL_AD_UNIT_ID;
}

/**
 * Banner policy: Free tier only. Plus skips the banner (ad-light perk, still
 * sees sparse in-feed cards); Premium/Creator see nothing (ad-free).
 * Unknown plan (loading/signed-out) defaults to true — the auth gate keeps
 * signed-out users off banner routes anyway.
 */
export function shouldShowBanner(plan?: string | null): boolean {
  if (!ADS_ENABLED) return false;
  if (typeof localStorage !== 'undefined') {
    if (localStorage.getItem('equyvo_ads_disabled') === 'true') return false;
  }
  if (!plan) return true;
  if (isAdFreePlan(plan) || isAdLightPlan(plan)) return false;
  return true;
}

/**
 * Interstitial policy — the strict "never irritate" rules:
 *  - Free tier only (the same audiences as the banner; paid plans never see
 *    one, PLUS included: the perk of paying is a calmer app).
 *  - Never during playback: only fired when a watch session (fullscreen
 *    viewer / story / moments run) ENDS, and only if that session lasted
 *    long enough to be real watching (see hook).
 *  - Hard frequency caps: nothing in the first INTERSTITIAL_WARMUP_SEC of a
 *    session, and at least INTERSTITIAL_MIN_INTERVAL_SEC between two shows.
 */
export const INTERSTITIAL_POLICY = {
  /** Seconds after app start before the first interstitial can ever fire. */
  WARMUP_SEC: 90,
  /** Minimum seconds between two interstitial shows. */
  MIN_INTERVAL_SEC: 240,
  /** A watch session must last at least this long to unlock a show. */
  MIN_WATCH_SEC: 8,
  /** Skip showing right after a plan upgrade (paid = immediately calm). */
  POST_PURCHASE_GRACE_SEC: 600,
} as const;

export function shouldShowInterstitial(plan?: string | null): boolean {
  if (!ADS_ENABLED) return false;
  if (typeof localStorage !== 'undefined') {
    if (localStorage.getItem('equyvo_ads_disabled') === 'true') return false;
  }
  if (!plan) return true;
  // Only the free plan sees interstitials — Plus/Premium/Creator never do.
  return !isAdFreePlan(plan) && !isAdLightPlan(plan);
}

/**
 * Route policy for the adaptive banner. The product rule is "every page
 * except authentication": the banner is a passive, in-flow native view that
 * never covers content, and fullscreen video/story takeovers still suppress
 * it while open (see use-feed-banner). Auth is intentionally ad-free so the
 * sign-in/sign-up flow is never interrupted.
 */
export function isBannerRoute(pathname: string): boolean {
  if (!pathname) return true;
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return false;
  // Preview/diagnostic routes should not monetise.
  if (pathname.startsWith('/__')) return false;
  return true;
}

/** Personalized-ads consent flag (GDPR/ePrivacy friendly, default on). */
export function personalizedAdsEnabled(): boolean {
  try {
    return localStorage.getItem('equyvo_ads_personalized') !== 'false';
  } catch {
    return true;
  }
}
