import React, { useEffect, useRef, useState } from 'react';
import { ADSENSE_CLIENT_ID, isAdSenseConfigured, isBannerRoute, shouldShowBanner } from '@/lib/ads-config';
import { isNativePlatform } from '@/lib/admob-service';
import { useAdPlan } from '@/hooks/use-ad-plan';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

const DISMISS_KEY = 'equyvo_web_banner_dismissed_until';
/** Hide-for-2-hours on dismiss: present but never nagging. */
const DISMISS_MS = 2 * 60 * 60 * 1000;

/**
 * Web banner ad (AdSense) shown inside the app shell on every non-auth page.
 *
 * Non-intrusive by construction:
 *  - in-flow (never overlays content or the bottom nav)
 *  - one slot per page session (no refresh churn on every SPA navigation)
 *  - dismissible for 2 hours
 *  - paid plans never see it (ad-free perk)
 *  - never rendered on auth, or while a fullscreen video/story is open
 *    (shell-level hook suppresses native; this component is only in-flow)
 *
 * Native builds get the equivalent adaptive AdMob banner through
 * useFeedBanner(), so this component intentionally renders nothing there.
 */
const AdBanner: React.FC<{ pathname: string }> = ({ pathname }) => {
  const plan = useAdPlan();
  const insRef = useRef<HTMLModElement>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return Number(localStorage.getItem(DISMISS_KEY) || 0) > Date.now();
    } catch {
      return false;
    }
  });
  const [failed, setFailed] = useState(false);

  const adsense = isAdSenseConfigured();
  const allowed =
    !isNativePlatform() &&
    isBannerRoute(pathname) &&
    shouldShowBanner(plan) &&
    !dismissed &&
    (adsense ? !failed : true);

  useEffect(() => {
    if (!allowed || !adsense) return;
    let cancelled = false;

    const push = () => {
      try {
        if (cancelled || !insRef.current) return;
        if (insRef.current.getAttribute('data-adsbygoogle-status')) return;
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    const existing = document.querySelector('script[data-adsense]');
    if (!existing) {
      const s = document.createElement('script');
      s.async = true;
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ADSENSE_CLIENT_ID)}`;
      s.crossOrigin = 'anonymous';
      s.setAttribute('data-adsense', 'true');
      s.onerror = () => { if (!cancelled) setFailed(true); };
      document.head.appendChild(s);
      s.onload = () => push();
    } else {
      const raf = requestAnimationFrame(push);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }

    // No fill / blocked: collapse instead of leaving an empty strip.
    const timer = setTimeout(() => {
      if (!cancelled && insRef.current && !insRef.current.getAttribute('data-adsbygoogle-status')) {
        setFailed(true);
      }
    }, 7000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // One impression per mounted shell; `pathname` only gates visibility.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  if (!allowed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_MS)); } catch { /* ignore */ }
  };

  return (
    <aside
      className="w-full shrink-0 border-t bg-card/95 px-3 py-1.5"
      aria-label="Advertisement"
    >
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2">
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
          Ad
        </span>
        <div className="min-w-0 flex-1">
          {adsense ? (
            <ins
              ref={insRef}
              className="adsbygoogle"
              style={{ display: 'block', minHeight: 50 }}
              data-ad-client={ADSENSE_CLIENT_ID}
              data-ad-format="auto"
              data-full-width-responsive="true"
            />
          ) : (
            // House promotion keeps web monetisation/layout stable until an
            // AdSense client+slot is configured (no blank strip, no fake ad).
            <a
              href="/pricing"
              className="flex min-h-[42px] items-center justify-center gap-2 rounded-md bg-muted/60 px-2 text-center text-xs text-foreground/90 hover:bg-muted"
            >
              <span className="font-semibold">Equyvo Premium</span>
              <span className="hidden text-muted-foreground sm:inline">·</span>
              <span className="text-muted-foreground">ad-free, more uploads &amp; priority reach</span>
              <span className="font-semibold text-primary">See plans →</span>
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          aria-label="Hide ad"
          title="Hide ad for now"
        >
          Hide ✕
        </button>
      </div>
    </aside>
  );
};

export default AdBanner;
