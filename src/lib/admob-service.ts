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
  effectiveAdUnitId,
  effectiveInterstitialAdUnitId,
  effectiveRewardedAdUnitId,
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
  prepareRewardVideoAd?: (opts?: Record<string, unknown>) => Promise<unknown>;
  showRewardVideoAd?: (opts?: Record<string, unknown>) => Promise<unknown>;
  prepareInterstitial?: (opts?: Record<string, unknown>) => Promise<unknown>;
  showInterstitial?: (opts?: Record<string, unknown>) => Promise<void>;
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
let initPromise: Promise<boolean> | null = null;
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
          (mod as unknown as { AdMob?: AdMobPlugin } | null)?.AdMob ?? null;
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
    if (Capacitor.isNativePlatform()) return true;
  } catch { /* ignore */ }
  try {
    if (typeof navigator !== 'undefined' && /EquyvoApp/i.test(navigator.userAgent || '')) return true;
  } catch { /* ignore */ }
  return false;
}

/** Initialize Mobile Ads SDK once. A failed native initialization is retryable:
 *  caching that failure forever was why every later ad request could report
 *  that no content was loaded, even after the Activity/WebView became ready. */
export function initializeAds(): Promise<boolean> {
  if (!isNativePlatform()) return Promise.resolve(false);
  if (initPromise) return initPromise;
  const pending = (async (): Promise<boolean> => {
    try {
      // Destructure synchronously: `plugin` itself is never awaited or
      // returned (see loadPlugin) — only real method-call promises are.
      const { plugin } = await loadPlugin();
      if (!plugin?.initialize) return false;
      // Production must never enable Google's test mode or test devices.
      const options: AdMobInitializationOptions = {
        tagForChildDirectedTreatment: false,
        tagForUnderAgeOfConsent: false,
        maxAdContentRating: 'General' as MaxAdContentRating,
        initializeForTesting: false,
        testingDevices: [],
      };
      await plugin.initialize(options as unknown as Record<string, unknown>);
      // UMP consent (EEA/GDPR): resolves immediately where no Funding
      // Choices message is configured. Non-fatal everywhere.
      try {
        await plugin.requestConsentInfo?.();
      } catch {
        /* non-fatal */
      }
      return true;
    } catch (e) {
      try { console.warn('[AdMob] initialization failed (will retry):', e); } catch { /* ignore */ }
      return false;
    }
  })();
  initPromise = pending;
  void pending.then((ok) => {
    if (!ok && initPromise === pending) initPromise = null;
  });
  return pending;
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
    if (!(await initializeAds())) return null;
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

// ── Interstitial (full-screen, natural breaks only) ────────────────────────
// Shown at most once per cooldown window, only for free users, and never
// while content (video/fullscreen/story) is being watched. The actual show
// decision + content guards live in useInterstitialAds; this service only
// handles SDK mechanics and frequency capping.

let interstitialState: 'idle' | 'prepared' | 'showing' = 'idle';
let interstitialAdId: string | null = null;
let interstitialPreparePromise: Promise<boolean> | null = null;
let rewardedState: 'idle' | 'prepared' | 'showing' = 'idle';
let rewardedAdId: string | null = null;
let rewardedPreparePromise: Promise<boolean> | null = null;
let lastInterstitialShownAt = 0;
const INTERSTITIAL_MIN_INTERVAL_MS = 90 * 1000; // 90 seconds between shows

/** Prepare exactly one interstitial at a time. Multiple lifecycle hooks may
 *  request a preload together; they must await the same native ad instead of
 *  replacing each other's prepared slot. */
export async function prepareInterstitial(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  const configuredId = effectiveInterstitialAdUnitId();
  if (!configuredId) return false;
  if (interstitialState === 'prepared' && interstitialAdId === configuredId) return true;
  if (interstitialPreparePromise) return interstitialPreparePromise;
  const pending = (async (): Promise<boolean> => {
    try {
      if (!(await initializeAds())) return false;
      const { plugin } = await loadPlugin();
      if (!plugin?.prepareInterstitial) return false;
      const info = await plugin.prepareInterstitial({
        adId: configuredId,
        isTesting: false,
        npa: !personalizedAdsEnabled(),
      });
      interstitialAdId = (info && (info as { adUnitId?: string }).adUnitId) || configuredId;
      interstitialState = 'prepared';
      return true;
    } catch (e) {
      interstitialState = 'idle';
      interstitialAdId = null;
      try { console.warn('[AdMob] prepareInterstitial failed:', e); } catch { /* ignore */ }
      return false;
    }
  })();
  interstitialPreparePromise = pending;
  try {
    return await pending;
  } finally {
    if (interstitialPreparePromise === pending) interstitialPreparePromise = null;
  }
}

/** Show the exact prepared interstitial if the cooldown allows. */
export async function showInterstitial(): Promise<boolean> {
  try {
    if (!isNativePlatform() || interstitialState === 'showing') return false;
    if (Date.now() - lastInterstitialShownAt < INTERSTITIAL_MIN_INTERVAL_MS) return false;
    if (interstitialState !== 'prepared' || !interstitialAdId) {
      if (!(await prepareInterstitial())) return false;
    }
    const adId = interstitialAdId;
    if (!adId) return false;
    const { plugin } = await loadPlugin();
    if (!plugin?.showInterstitial) return false;
    interstitialState = 'showing';
    try {
      // prepareInterstitial() resolves only after the native SDK's onAdLoaded
      // callback. Passing this exact id selects that loaded object; omitting it
      // can target an expired/dismissed "most recent" slot after navigation.
      await plugin.showInterstitial({ adId });
    } catch (e) {
      interstitialState = 'idle';
      interstitialAdId = null;
      try { console.warn('[AdMob] showInterstitial failed:', e); } catch { /* ignore */ }
      return false;
    }
    lastInterstitialShownAt = Date.now();
    interstitialState = 'idle';
    interstitialAdId = null;
    // Do not preload a same-unit replacement while this ad is still visible:
    // the native plugin removes a unit-id slot when the old ad is dismissed,
    // which would otherwise delete the newly preloaded object. The next
    // natural navigation prepares a fresh ad after dismissal.
    return true;
  } catch (e) {
    interstitialState = 'idle';
    interstitialAdId = null;
    try { console.warn('[AdMob] interstitial lifecycle failed:', e); } catch { /* ignore */ }
    return false;
  }
}

export function isInterstitialConfigured(): boolean {
  return effectiveInterstitialAdUnitId() !== '';
}

// ── Rewarded (watch-to-earn) ────────────────────────────────────────────────

/** Preload a real rewarded ad when the rewards page opens. The click handler
 *  awaits this same request if it is still loading, then shows only the loaded
 *  ad id returned by the native SDK. */
export async function prepareRewardedAd(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  const configuredId = effectiveRewardedAdUnitId();
  if (!configuredId || rewardedState === 'showing') return false;
  if (rewardedState === 'prepared' && rewardedAdId === configuredId) return true;
  if (rewardedPreparePromise) return rewardedPreparePromise;
  const pending = (async (): Promise<boolean> => {
    try {
      if (!(await initializeAds())) return false;
      const { plugin } = await loadPlugin();
      if (!plugin?.prepareRewardVideoAd) return false;
      const info = await plugin.prepareRewardVideoAd({
        adId: configuredId,
        isTesting: false,
        npa: !personalizedAdsEnabled(),
      });
      rewardedAdId = (info && (info as { adUnitId?: string }).adUnitId) || configuredId;
      rewardedState = 'prepared';
      return true;
    } catch (e) {
      rewardedState = 'idle';
      rewardedAdId = null;
      try { console.warn('[AdMob] rewarded ad prepare failed:', e); } catch { /* ignore */ }
      return false;
    }
  })();
  rewardedPreparePromise = pending;
  try {
    return await pending;
  } finally {
    if (rewardedPreparePromise === pending) rewardedPreparePromise = null;
  }
}

/** Resolve true only for a real native reward. Web has no rewarded-AdMob SDK,
 *  so it must never claim a view or grant a boost without an advertisement. */
export async function showRewardedAd(): Promise<boolean> {
  if (!isNativePlatform()) return false;
  if (rewardedState === 'showing') return false;
  try {
    if (localStorage.getItem('equyvo_ads_disabled') === 'true') return false;
  } catch { /* ignore */ }
  if (!(await prepareRewardedAd()) || !rewardedAdId) return false;
  const adId = rewardedAdId;
  const { plugin } = await loadPlugin();
  if (!plugin?.showRewardVideoAd) {
    rewardedState = 'idle';
    rewardedAdId = null;
    return false;
  }

  // showRewardVideoAd() resolves on the reward. On Android it can remain
  // pending after an early dismissal, so dismissal/failure events also settle
  // the result and all listener handles are always removed.
  rewardedState = 'showing';
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const handles: Array<{ remove?: () => void }> = [];
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(safety);
      rewardedState = 'idle';
      rewardedAdId = null;
      for (const handle of handles) {
        try { handle.remove?.(); } catch { /* ignore */ }
      }
      resolve(value);
    };
    const register = async (event: string, cb: () => void) => {
      try {
        const handle = await plugin.addListener?.(event, cb);
        if (!handle) return;
        // A fast failure can settle before addListener's promise resolves.
        if (settled) {
          try { handle.remove?.(); } catch { /* ignore */ }
        } else {
          handles.push(handle);
        }
      } catch { /* listener support is optional; show() still reports reward */ }
    };
    const registrations = [
      register('onRewardedVideoAdReward', () => finish(true)),
      register('onRewardedVideoAdDismissed', () => finish(false)),
      register('onRewardedVideoAdFailedToShow', () => finish(false)),
    ];
    const safety = window.setTimeout(() => finish(false), 180000);
    void (async () => {
      await Promise.all(registrations);
      if (settled) return;
      try {
        await plugin.showRewardVideoAd?.({ adId });
        // Also true when the plugin resolves directly with AdMobRewardItem but
        // its reward event was consumed by another native listener.
        finish(true);
      } catch (e) {
        try { console.warn('[AdMob] rewarded ad show failed:', e); } catch { /* ignore */ }
        finish(false);
      }
    })();
  });
}

