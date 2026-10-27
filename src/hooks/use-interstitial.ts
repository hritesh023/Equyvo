import { useEffect, useRef } from 'react';
import { INTERSTITIAL_POLICY, shouldShowInterstitial } from '@/lib/ads-config';
import {
  isNativePlatform,
  maybeShowInterstitial,
  prepareInterstitial,
} from '@/lib/admob-service';

interface InterstitialOpts {
  pathname: string;
  plan: string | null;
}

/**
 * Interstitial triggers — the "never irritate" placement rules:
 *
 *  - Fires ONLY when a watch session ENDS: the user backs out of the
 *    fullscreen viewer / story viewer, or leaves the Moments video rail
 *    for a regular screen. Never pre-roll, never mid-playback, never
 *    while they are reading a feed.
 *  - The session must have lasted MIN_WATCH_SEC — quick taps in and out
 *    never trigger anything.
 *  - Frequency gating lives in maybeShowInterstitial: free plan only,
 *    warm-up delay, hard 4-minute interval between shows.
 *
 * Payments and pricing never trigger one, so the purchase flow stays calm
 * (ad-free anyway for paying users).
 */
export function useInterstitialTrigger({ pathname, plan }: InterstitialOpts): void {
  // Open watch sessions: fullscreen viewer / story viewer overlays.
  const watchingSince = useRef<number | null>(null);
  // Moments video rail visit start (route-based).
  const momentsSince = useRef<number | null>(null);
  // Page-transition interstitials: only after real app engagement, never on
  // auth/checkout/composer/video routes, and the service still applies the
  // free-plan + warm-up + hard-interval gates.
  const mountedAt = useRef(Date.now());
  const navCount = useRef(0);
  const prevPath = useRef(pathname);

  // Preload once per mount — the service is a singleton, safe to re-call.
  useEffect(() => {
    void prepareInterstitial();
  }, []);

  useEffect(() => {
    const onOpen = () => { watchingSince.current = Date.now(); };
    const onClose = () => {
      const since = watchingSince.current;
      watchingSince.current = null;
      if (since == null) return;
      const watchedSec = (Date.now() - since) / 1000;
      if (watchedSec < INTERSTITIAL_POLICY.MIN_WATCH_SEC) return; // quick peek, no ad
      if (!shouldShowInterstitial(plan)) return;
      void maybeShowInterstitial(plan);
    };
    const events: Array<[string, () => void]> = [
      ['fullscreenViewerOpened', onOpen],
      ['fullscreenViewerClosed', onClose],
      ['storyViewerOpened', onOpen],
      ['storyViewerClosed', onClose],
    ];
    events.forEach(([name, fn]) => window.addEventListener(name, fn));
    return () => {
      events.forEach(([name, fn]) => window.removeEventListener(name, fn));
    };
  }, [plan]);

  // Moments is a full-bleed video surface: leaving it for any other route
  // is a natural content-session end.
  useEffect(() => {
    const isMoments = pathname === '/app/moments' || pathname === '/moments';
    if (isMoments) {
      if (momentsSince.current == null) momentsSince.current = Date.now();
      return;
    }
    const since = momentsSince.current;
    momentsSince.current = null;
    if (since == null) return;
    const watchedSec = (Date.now() - since) / 1000;
    if (watchedSec < INTERSTITIAL_POLICY.MIN_WATCH_SEC) return;
    if (pathname === '/pricing' || pathname === '/app/pricing') return; // calm checkout
    if (!isNativePlatform()) return;
    if (!shouldShowInterstitial(plan)) return;
    void maybeShowInterstitial(plan);
  }, [pathname, plan]);

  // Page-transition interstitial (all non-calm pages): free plan only, after
  // real engagement (4 navigations + 90s warm-up), with the service's hard
  // interval preventing back-to-back shows. This is what makes ads reach
  // every page without ever interrupting playback or checkout.
  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    navCount.current += 1;
    if (navCount.current < 4) return;
    if (Date.now() - mountedAt.current < INTERSTITIAL_POLICY.WARMUP_SEC * 1000) return;
    const calm =
      pathname === '/auth' ||
      pathname.startsWith('/auth/') ||
      pathname === '/pricing' ||
      pathname === '/app/pricing' ||
      pathname === '/create' ||
      pathname === '/app/create' ||
      pathname === '/moments' ||
      pathname === '/app/moments';
    if (calm) return;
    if (!isNativePlatform()) return;
    if (!shouldShowInterstitial(plan)) return;
    void prepareInterstitial().then(() => maybeShowInterstitial(plan));
  }, [pathname, plan]);
}
