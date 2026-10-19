import { useEffect, useRef, useState } from 'react';
import { isBannerRoute, shouldShowBanner } from '@/lib/ads-config';
import {
  hideFeedBanner,
  isNativePlatform,
  setBannerWanted,
  showFeedBanner,
} from '@/lib/admob-service';

interface FeedBannerOpts {
  pathname: string;
  plan: string | null;
}

/**
 * Route-aware adaptive banner: visible ONLY on feed screens for the Free
 * tier. Hidden on Moments / fullscreen video / stories / composer / pricing
 * / auth — video playback is never interrupted or overlaid.
 */
export function useFeedBanner({ pathname, plan }: FeedBannerOpts): void {
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const lastAllowed = useRef<boolean | null>(null);

  useEffect(() => {
    const onOpen = () => setTakeoverOpen(true);
    const onClose = () => setTakeoverOpen(false);
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
  }, []);

  useEffect(() => {
    if (!isNativePlatform()) return;
    const allowed =
      isBannerRoute(pathname) && shouldShowBanner(plan) && !takeoverOpen;
    if (allowed === lastAllowed.current) return;
    lastAllowed.current = allowed;
    // Publish the decision so failed-load retries and app-foreground
    // re-shows only ever run while an allowed screen is active.
    setBannerWanted(allowed);
    if (allowed) {
      void showFeedBanner();
    } else {
      void hideFeedBanner();
    }
  }, [pathname, plan, takeoverOpen]);

  useEffect(() => {
    return () => {
      setBannerWanted(false);
      void hideFeedBanner();
    };
  }, []);
}
