// ── AdMob service: Native Advanced loader with graceful web fallback ───────
// Design goals:
//  - On Capacitor native (Android/iOS) with @capacitor-community/admob
//    installed: load a real Native Advanced ad for the configured unit.
//  - On web / when the plugin is missing / when fill fails: resolve null so
//    the UI renders a tasteful house promo (e.g. Equyvo Premium) in the same
//    native-styled slot. Layout never jumps, video is never interrupted.
//  - Frequency capping + single initialization + consent-aware.

import { Capacitor } from '@capacitor/core';
import type {
  AdMobInitializationOptions,
  MaxAdContentRating,
} from '@capacitor-community/admob';
import {
  AD_POLICY,
  admobTestDevices,
  effectiveAdUnitId,
  effectiveBannerAdUnitId,
  isDevEnvironment,
  personalizedAdsEnabled,
} from './ads-config';

export interface NativeAdData {
  headline: string;
  body?: string;
  advertiser?: string;
  callToAction?: string;
  iconUrl?: string;
  imageUrl?: string;
  starRating?: number;
  store?: string;
  price?: string;
  clickUrl?: string;
}

type AdMobPlugin = {
  initialize?: (opts?: Record<string, unknown>) => Promise<void>;
  requestConsentInfo?: (opts?: Record<string, unknown>) => Promise<unknown>;
  showBanner?: (opts?: Record<string, unknown>) => Promise<void>;
  hideBanner?: () => Promise<void>;
  resumeBanner?: () => Promise<void>;
  removeBanner?: () => Promise<void>;
  addListener?: (
    event: string,
    cb: (info?: unknown) => void,
  ) => Promise<{ remove: () => void }>;
  setRequestConfiguration?: (opts?: Record<string, unknown>) => Promise<void>;
  loadNativeAd?: (opts?: Record<string, unknown>) => Promise<unknown>;
  showNativeAd?: (opts?: Record<string, unknown>) => Promise<void>;
  hideNativeAd?: () => Promise<void>;
};

let pluginPromise: Promise<{ plugin: AdMobPlugin | null }> | null = null;
let initPromise: Promise<void> | null = null;
let lastImpressionAt = 0;

/**
 * Load the AdMob bridge WITHOUT ever letting Capacitor's plugin proxy cross
 * a promise boundary. The proxy answers ANY property read (including
 * `.then`) with a method wrapper, so `await proxy` / `return proxy` from an
 * async function makes the runtime *call* `proxy.then()` → CapacitorException
 * `"AdMob.then()" is not implemented` — on web AND on native. The proxy is
 * therefore always carried inside a plain `{ plugin }` holder (awaiting the
 * holder is safe) and only ever touched synchronously afterwards: property
 * reads and method *calls* are fine; awaiting the proxy itself is not.
 */
function loadPlugin(): Promise<{ plugin: AdMobPlugin | null }> {
  // Web has no AdMob bridge: don't even import the module (skips the stub,
  // its chunk, and any chance of touching the proxy on web).
  if (!isNativePlatform()) return Promise.resolve({ plugin: null });
  if (!pluginPromise) {
    pluginPromise = import('@capacitor-community/admob').then(
      (mod) => {
        const candidate =
          (mod as { AdMob?: AdMobPlugin } | null)?.AdMob ?? null;
        return {
          plugin:
            candidate && typeof candidate === 'object' ? candidate : null,
        };
      },
      () => ({ plugin: null }),
    );
  }
  return pluginPromise;
}



export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Initialize Mobile Ads SDK once (safe to call repeatedly). */
export function initializeAds(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      // Destructure synchronously: `plugin` itself is never awaited or
      // returned (see loadPlugin) — only real method-call promises are.
      const { plugin } = await loadPlugin();
      if (!plugin?.initialize) return;
      const testDevices = admobTestDevices();
      const options: AdMobInitializationOptions = {
        tagForChildDirectedTreatment: false,
        tagForUnderAgeOfConsent: false,
        maxAdContentRating: 'General' as MaxAdContentRating,
        ...(testDevices.length > 0
          ? { testingDevices: testDevices, initializeForTesting: true }
          : {}),
      };
      await plugin.initialize(options).catch(() => undefined);
      // UMP consent (EEA/GDPR): resolves immediately where no Funding
      // Choices message is configured. Non-fatal everywhere.
      try {
        await plugin.requestConsentInfo?.();
      } catch {
        /* non-fatal */
      }
    } catch {
      /* ads are optional — app must work without them */
    }
  })();
  return initPromise;
}

/** Session-level cooldown so impressions stay sparse (UX protection). */
export function canCountImpression(): boolean {
  const now = Date.now();
  const elapsed = (now - lastImpressionAt) / 1000;
  if (elapsed < AD_POLICY.IMPRESSION_COOLDOWN_SEC) return false;
  lastImpressionAt = now;
  return true;
}

function normalizeNativeAd(raw: unknown): NativeAdData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // @capacitor-community/admob shapes differ by version — accept several.
  const nested =
    (r.ad as Record<string, unknown> | undefined) ??
    (r.nativeAd as Record<string, unknown> | undefined) ??
    r;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const headline =
    str(nested.headline) ?? str(nested.title) ?? str((nested as { name?: unknown }).name);
  if (!headline) return null;
  return {
    headline,
    body: str(nested.body) ?? str(nested.description),
    advertiser: str(nested.advertiser) ?? str(nested.sponsor),
    callToAction: str(nested.callToAction) ?? str(nested.cta) ?? 'Learn more',
    iconUrl: str(nested.iconUrl) ?? str(nested.icon) ?? str(nested.logoUrl),
    imageUrl:
      str(nested.imageUrl) ?? str(nested.image) ?? str(nested.mediaUrl),
    starRating:
      typeof nested.starRating === 'number' ? nested.starRating : undefined,
    store: str(nested.store),
    price: str(nested.price),
    clickUrl: str(nested.clickUrl) ?? str(nested.url),
  };
}

/**
 * Load ONE Native Advanced ad. NOTE: @capacitor-community/admob exposes no
 * NativeAd API (banner/interstitial/rewarded/app-open only), so this
 * resolves null today and callers render the house-promo fallback (Premium
 * upsell). Real Google fill flows through the adaptive feed banner below.
 * Kept as the seam for a future first-party native-asset plugin.
 */
export async function loadNativeAd(
  placement = 'in-feed',
): Promise<NativeAdData | null> {
  try {
    if (!isNativePlatform()) return null;
    const { plugin } = await loadPlugin();
    if (!plugin?.loadNativeAd) return null;
    await initializeAds();
    const raw = await plugin
      .loadNativeAd({
        adId: effectiveAdUnitId(),
        // Keep native templates quiet: no video, no audio.
        adChoicesPlacement: 'topRight',
        mediaAspectRatio: 'landscape',
        personalized: personalizedAdsEnabled(),
        placement,
      })
      .catch(() => null);
    return normalizeNativeAd(raw);
  } catch {
    return null;
  }
}

/** House promo shown when there is no AdMob fill (web, dev, ad-block). */
export function housePromoAd(placement: string): NativeAdData {
  void placement;
  return {
    headline: 'Equyvo Premium — zero interruptions',
    body: 'Go ad-free, unlock higher-quality uploads and AI creator tools. Your feed stays fast and calm.',
    advertiser: 'Equyvo',
    callToAction: 'See plans',
    clickUrl: '/pricing',
  };
}

// ── Adaptive feed banner (the real-earning format) ─────────────────────────
// The community plugin supports banner/interstitial/rewarded/app-open — but
// NOT Native Advanced. So: in-feed native-styled slots carry house promos
// (Premium upsell), while this slim adaptive banner on feed-only screens
// serves actual Google ads. Never shown on video surfaces.

let bannerState: 'hidden' | 'shown' = 'hidden';
let bannerAdId: string | null = null;
let bannerListenersAttached = false;
// Whether the current screen WANTS a banner (route/plan/takeover decision
// owned by use-feed-banner). Retries and app-foreground re-shows only ever
// run while this is true — the banner never reappears on video surfaces,
// composer/pricing/auth or for paying plans.
let bannerWanted = false;
let bannerFailures = 0;
let bannerRetryTimer: ReturnType<typeof setTimeout> | null = null;
let bannerVisibilityHooked = false;

const BANNER_RETRY_BASE_MS = 30_000; // first retry after 30s
const BANNER_RETRY_MAX_MS = 5 * 60_000; // never retry sooner than every 5 min

/** Exponential backoff for failed loads (30s → 60s → 120s → 240s → 5min cap). */
function bannerRetryDelay(): number {
  const ms = BANNER_RETRY_BASE_MS * Math.pow(2, Math.max(0, bannerFailures - 1));
  return Math.min(Number.isFinite(ms) ? ms : BANNER_RETRY_MAX_MS, BANNER_RETRY_MAX_MS);
}

/**
 * Tell the service whether the active screen should show the banner. Called
 * from useFeedBanner on every route/plan change.
 */
export function setBannerWanted(wanted: boolean): void {
  bannerWanted = wanted;
  if (!wanted && bannerRetryTimer) {
    clearTimeout(bannerRetryTimer);
    bannerRetryTimer = null;
  }
  hookBannerVisibility();
}

/**
 * Re-attach the banner after a failed load — with backoff so repeated
 * async no-fill cycles can never spam the user with half-loaded bars.
 * This is what makes the banner reliably come back "every time the user
 * interacts" without ever turning reload spam into an irritation.
 */
function scheduleBannerRetry(): void {
  if (bannerRetryTimer || !bannerWanted) return;
  bannerRetryTimer = setTimeout(() => {
    bannerRetryTimer = null;
    if (bannerWanted && bannerState !== 'shown') void showFeedBanner();
  }, bannerRetryDelay());
}

/**
 * App lifecycle handling via visibilitychange: hide the banner while the
 * app is backgrounded (impressions shouldn't accumulate in the background),
 * and re-show/resume it the instant the user comes back and interacts.
 */
function hookBannerVisibility(): void {
  if (bannerVisibilityHooked || typeof document === 'undefined') return;
  bannerVisibilityHooked = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try {
        document.body.classList.remove('has-ad-banner');
      } catch { /* ignore */ }
      if (bannerRetryTimer) { clearTimeout(bannerRetryTimer); bannerRetryTimer = null; }
      // Hide without destroying the banner (cheap resume when they return).
      void hideFeedBanner();
      return;
    }
    if (bannerWanted) {
      // Visible again while on an allowed screen → the banner comes straight
      // back (resume if it still exists, fresh request otherwise).
      void showFeedBanner();
    }
  });
}

/** True when a banner unit is available to request (test unit in dev). */
export function isBannerConfigured(): boolean {
  return effectiveBannerAdUnitId() !== '';
}

async function attachBannerListeners(
  plugin: AdMobPlugin,
): Promise<void> {
  if (bannerListenersAttached || !plugin.addListener) return;
  bannerListenersAttached = true;
  try {
    await plugin.addListener('bannerAdFailedToLoad', () => {
      // No fill (common until AdMob approves the unit): collapse the slot
      // so no blank gap remains — then retry with backoff so the banner
      // reliably comes back the next time the user is active.
      bannerFailures += 1;
      bannerState = 'hidden';
      try {
        document.body.classList.remove('has-ad-banner');
      } catch {
        /* ignore */
      }
      scheduleBannerRetry();
    });
    await plugin.addListener('bannerAdLoaded', () => {
      // Successful fill — reset the backoff chain.
      bannerFailures = 0;
    });
  } catch {
    /* listeners are best-effort */
  }
}

/**
 * Show the adaptive banner (BOTTOM_CENTER, lifted above the bottom nav).
 * Resolves true when a request was issued. No-op on web / when the banner
 * unit is not configured yet.
 */
export async function showFeedBanner(): Promise<boolean> {
  try {
    if (!isNativePlatform()) return false;
    const adId = effectiveBannerAdUnitId();
    if (!adId) return false;
    if (!isDevEnvironment() && !isBannerConfigured()) return false;
    hookBannerVisibility();
    const { plugin } = await loadPlugin();
    if (!plugin?.showBanner) return false;
    await initializeAds();
    if (bannerState === 'shown' && bannerAdId === adId) {
      try {
        await plugin.resumeBanner?.();
      } catch {
        /* ignore */
      }
      return true;
    }
    if (bannerAdId && bannerAdId !== adId) {
      try {
        await plugin.removeBanner?.();
      } catch {
        /* ignore */
      }
      bannerAdId = null;
    }
    await attachBannerListeners(plugin);
    const narrow =
      typeof window !== 'undefined' && window.innerWidth < 768;
    try {
      await plugin.showBanner({
        adId,
        position: 'BOTTOM_CENTER',
        adSize: 'ADAPTIVE_BANNER',
        // Lift above the app bottom nav on phones.
        margin: narrow ? 70 : 0,
        isTesting: isDevEnvironment(),
        npa: !personalizedAdsEnabled(),
      });
      bannerState = 'shown';
      bannerAdId = adId;
      bannerFailures = 0;
      try {
        document.body.classList.add('has-ad-banner');
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      bannerState = 'hidden';
      try {
        document.body.classList.remove('has-ad-banner');
      } catch {
        /* ignore */
      }
      return false;
    }
  } catch {
    return false;
  }
}

/** Hide the banner without destroying it (cheap resume on return). */
export async function hideFeedBanner(): Promise<void> {
  try {
    document.body.classList.remove('has-ad-banner');
  } catch {
    /* ignore */
  }
  if (bannerState !== 'shown') return;
  bannerState = 'hidden';
  try {
    const { plugin } = await loadPlugin();
    await plugin?.hideBanner?.();
  } catch {
    /* ignore */
  }
}
