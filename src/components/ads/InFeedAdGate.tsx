import React from 'react';
import NativeAdCard from './NativeAdCard';
import AdSenseCard from './AdSenseCard';
import { useAdPlan } from '@/hooks/use-ad-plan';
import { isAdSenseConfigured, shouldShowAds } from '@/lib/ads-config';
import { isNativePlatform } from '@/lib/admob-service';

/**
 * Gate that renders ONE calm in-feed slot only when ads are allowed:
 * hidden for Premium/Creator (ad-free — subscription removes ads),
 * sparser for Plus (handled by the insertion helper), hidden when disabled.
 *
 * Platform routing (the actual earning fix):
 * - Native (Android/iOS): AdMob banner/native via NativeAdCard.
 * - Web (equyvo.com): AdSense display via AdSenseCard when configured;
 *   otherwise the house promo fallback inside NativeAdCard (never blank).
 */
const InFeedAdGate: React.FC<{
  placement: string;
  compact?: boolean;
  className?: string;
}> = ({ placement, compact, className }) => {
  const plan = useAdPlan();
  if (!shouldShowAds(plan)) return null;
  // Web + AdSense configured → real Google fill (collapses silently on
  // ad-block / no-fill so the feed never shows a gap). Otherwise the calm
  // house promo (Premium upsell) keeps the slot stable.
  if (!isNativePlatform() && isAdSenseConfigured()) {
    return <AdSenseCard placement={placement} className={className} />;
  }
  return <NativeAdCard placement={placement} compact={compact} className={className} />;
};

export default InFeedAdGate;
