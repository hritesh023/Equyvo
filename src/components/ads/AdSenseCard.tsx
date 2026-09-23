import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ADSENSE_CLIENT_ID, ADSENSE_SLOT, isAdSenseConfigured } from '@/lib/ads-config';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

interface AdSenseCardProps {
  placement: string;
  className?: string;
}

/**
 * Web in-feed display ad (AdSense). Calm by design:
 * - looks like a regular feed card, labelled "Sponsored"
 * - never auto-plays, never overlays video, always dismissible
 * - renders NOTHING when AdSense is not configured (caller falls back to
 *   the house promo) and collapses gracefully on ad-block / no-fill.
 */
const AdSenseCard: React.FC<AdSenseCardProps> = ({ placement, className = '' }) => {
  const insRef = useRef<HTMLModElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isAdSenseConfigured() || dismissed) return;
    let cancelled = false;

    const push = () => {
      try {
        if (cancelled || !insRef.current) return;
        // Skip if an ad is already rendered in this slot.
        if (insRef.current.getAttribute('data-adsbygoogle-status')) return;
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    // Load the AdSense script once per page.
    const existing = document.querySelector('script[data-adsense]');
    if (!existing) {
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT_ID)}`;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-adsense', 'true');
      s.onerror = () => {
        if (!cancelled) setFailed(true);
      };
      document.head.appendChild(s);
      s.onload = () => push();
    } else {
      // Script already present — push on next frame so layout is ready.
      const raf = requestAnimationFrame(push);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }

    // If no fill happens within 6s (ad-block / unapproved site), collapse
    // so the feed never shows a blank gap.
    const timer = setTimeout(() => {
      if (!cancelled && insRef.current && !insRef.current.getAttribute('data-adsbygoogle-status')) {
        setFailed(true);
      }
    }, 6000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [placement, dismissed]);

  if (dismissed || failed || !isAdSenseConfigured()) return null;

  return (
    <Card className={`overflow-hidden border-dashed ${className}`} aria-label="Sponsored content">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-semibold tracking-wide">
            SPONSORED
          </Badge>
          <button
            onClick={() => setDismissed(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-label="Dismiss ad"
          >
            Hide this ad ✕
          </button>
        </div>
        <div className="mt-3 min-h-[120px]">
          <ins
            ref={insRef}
            className="adsbygoogle"
            style={{ display: 'block', textAlign: 'center' }}
            data-ad-layout="in-article"
            data-ad-format="fluid"
            data-ad-client={ADSENSE_CLIENT_ID}
            data-ad-slot={ADSENSE_SLOT}
          />
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Ad · <a href="/pricing" className="underline hover:text-foreground">Go ad-free with Premium</a>
        </p>
      </CardContent>
    </Card>
  );
};

export default AdSenseCard;
