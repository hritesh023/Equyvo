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
  effectiveInterstitialAdUnitId,
  effectiveRewardedAdUnitId,
  TEST_REWARDED_AD_UNIT_ID,
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
      await plugin.initialize(options as unknown as Record<string, unknown>).catch(() => undefined);
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

// ── Interstitial (full-screen, natural breaks only) ────────────────────────
// Shown at most once per cooldown window, only for free users, and never
// while content (video/fullscreen/story) is being watched. The actual show
// decision + content guards live in useInterstitialAds; this service only
// handles SDK mechanics and frequency capping.

let interstitialState: 'idle' | 'prepared' | 'showing' = 'idle';
let interstitialAdId: string | null = null;
let lastInterstitialShownAt = 0;
const INTERSTITIAL_MIN_INTERVAL_MS = 90 * 1000; // 90 seconds between shows

/** Prepare an interstitial ad (idempotent). */
export async function prepareInterstitial(): Promise<boolean> {
  try {
    if (!isNativePlatform()) return false;
    const adId = effectiveInterstitialAdUnitId();
    if (!adId) return false;
    if (interstitialState === 'prepared' && interstitialAdId === adId) return true;
    await initializeAds();
    const { plugin } = await loadPlugin();
    if (!plugin?.prepareInterstitial) return false;
    await plugin.prepareInterstitial({
      adId,
      isTesting: isDevEnvironment(),
      npa: !personalizedAdsEnabled(),
    });
    interstitialState = 'prepared';
    interstitialAdId = adId;
    return true;
  } catch (e) {
    interstitialState = 'idle';
    interstitialAdId = null;
    try { console.warn('[AdMob] prepareInterstitial failed:', e); } catch { /* ignore */ }
    return false;
  }
}

/** Show a prepared interstitial if the cooldown allows. */
export async function showInterstitial(): Promise<boolean> {
  try {
    if (!isNativePlatform()) return false;
    if (Date.now() - lastInterstitialShownAt < INTERSTITIAL_MIN_INTERVAL_MS) {
      return false;
    }
    if (interstitialState !== 'prepared') {
      const ok = await prepareInterstitial();
      if (!ok) return false;
    }
    const { plugin } = await loadPlugin();
    if (!plugin?.showInterstitial) return false;
    interstitialState = 'showing';
    try {
      await plugin.showInterstitial(
        interstitialAdId ? { adId: interstitialAdId } : undefined,
      );
    } catch (e) {
      interstitialState = 'idle';
      try { console.warn('[AdMob] showInterstitial failed:', e); } catch { /* ignore */ }
      return false;
    }
    lastInterstitialShownAt = Date.now();
    interstitialState = 'idle';
    interstitialAdId = null;
    // Preload the next one for the next natural break.
    void prepareInterstitial();
    return true;
  } catch {
    interstitialState = 'idle';
    return false;
  }
}

export function isInterstitialConfigured(): boolean {
  return effectiveInterstitialAdUnitId() !== '';
}

// ── Rewarded (watch-to-earn) ────────────────────────────────────────────────

/**
 * Show a rewarded ad and resolve true only when the user actually earns the
 * reward. Used by the subscription page "Watch ad to earn rewards" flow.
 */
export async function showRewardedAd(): Promise<boolean> {
  try {
    if (!isNativePlatform()) {
      // Web has no AdMob rewarded SDK; allow the reward flow to proceed so
      // the upload boost can be granted (the page already confirms intent).
      return true;
    }
    try {
      if (localStorage.getItem('equyvo_ads_disabled') === 'true') return false;
    } catch { /* ignore */ }
    await initializeAds();
    const { plugin } = await loadPlugin();
    if (!plugin?.prepareRewardVideoAd || !plugin?.showRewardVideoAd) return false;
    const units = [effectiveRewardedAdUnitId(), TEST_REWARDED_AD_UNIT_ID].filter(Boolean);
    for (const adId of units) {
      try {
        await plugin.prepareRewardVideoAd({
          adId,
          isTesting: adId === TEST_REWARDED_AD_UNIT_ID || isDevEnvironment(),
          npa: !personalizedAdsEnabled(),
        });
        const reward = await plugin.showRewardVideoAd();
        if (reward) return true;
      } catch { /* try next unit */ }
    }
    return false;
  } catch {
    return false;
  }
}
