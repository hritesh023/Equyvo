import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { isNativePlatform, prepareInterstitial, showInterstitial } from '@/lib/admob-service';
import { shouldShowAds } from '@/lib/ads-config';
import { useAdPlan } from './use-ad-plan';

/**
 * Show an interstitial ad at natural breaks (tab navigation) for free users
 * only. Never interrupts content playback: suppressed while a fullscreen
 * viewer / story is open or while any <video> is playing.
 */
export function useInterstitialAds(): void {
  const plan = useAdPlan();
  const location = useLocation();
  const contentOpenRef = useRef(false);
  const hasNavigatedRef = useRef(false);
  const lastPathRef = useRef(location.pathname);
  const showingRef = useRef(false);

  useEffect(() => {
    const onOpen = () => {
      contentOpenRef.current = true;
    };
    const onClose = () => {
      contentOpenRef.current = false;
    };
    const events: Array<[string, () => void]> = [
      ['fullscreenViewerOpened', onOpen],
      ['fullscreenViewerClosed', onClose],
      ['storyViewerOpened', onOpen],
      ['storyViewerClosed', onClose],
    ];
    events.forEach(([name, fn]) => window.addEventListener(name, fn));
    return () => events.forEach(([name, fn]) => window.removeEventListener(name, fn));
  }, []);

  useEffect(() => {
    const native = isNativePlatform() || (typeof navigator !== 'undefined' && /EquyvoApp/i.test(navigator.userAgent || ''));
    if (!native) return;
    // Interstitials are a free-tier format (Plus/Premium are ad-light or
    // ad-free and must never be interrupted by a full-screen ad).
    const isFreeTier = !plan || plan === 'eq_free';
    if (!isFreeTier) return;
    if (!shouldShowAds(plan)) return;
    const path = location.pathname;
    if (path === '/auth' || path.startsWith('/auth/')) return;
    if (path === '/pricing' || path === '/app/pricing') return;

    if (path !== lastPathRef.current) {
      hasNavigatedRef.current = true;
      lastPathRef.current = path;
      contentOpenRef.current = false;
    }
    // Let the user settle in before the first interstitial.
    if (!hasNavigatedRef.current) return;
    if (contentOpenRef.current) return;

    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.some((v) => !v.paused && !v.ended)) return;

    const timer = window.setTimeout(async () => {
      if (showingRef.current) return;
      if (contentOpenRef.current) return;
      const vids = Array.from(document.querySelectorAll('video'));
      if (vids.some((v) => !v.paused && !v.ended)) return;
      showingRef.current = true;
      try {
        await prepareInterstitial();
        await showInterstitial();
      } finally {
        showingRef.current = false;
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [location.pathname, plan]);

  useEffect(() => {
    const native = isNativePlatform() || (typeof navigator !== 'undefined' && /EquyvoApp/i.test(navigator.userAgent || ''));
    if (!native) return;
    const isFreeTier = !plan || plan === 'eq_free';
    if (!isFreeTier) return;
    if (!shouldShowAds(plan)) return;
    void prepareInterstitial();
  }, [plan]);

  // Prepare as early as possible on native (not only on plan change) so the
  // first natural break actually has an ad ready to show.
  useEffect(() => {
    const native = isNativePlatform() || (typeof navigator !== 'undefined' && /EquyvoApp/i.test(navigator.userAgent || ''));
    if (!native) return;
    void prepareInterstitial();
  }, []);
}