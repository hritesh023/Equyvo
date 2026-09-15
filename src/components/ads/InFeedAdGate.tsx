import React from 'react';
import NativeAdCard from './NativeAdCard';
import { useAdPlan } from '@/hooks/use-ad-plan';
import { shouldShowAds } from '@/lib/ads-config';

/**
 * Gate that renders a Native Advanced slot only when ads are allowed:
 * hidden for Premium/Creator (ad-free), sparser for Plus (handled by the
 * insertion helper), and hidden when globally disabled.
 */
const InFeedAdGate: React.FC<{
  placement: string;
  compact?: boolean;
  className?: string;
}> = ({ placement, compact, className }) => {
  const plan = useAdPlan();
  if (!shouldShowAds(plan)) return null;
  return <NativeAdCard placement={placement} compact={compact} className={className} />;
};

export default InFeedAdGate;
