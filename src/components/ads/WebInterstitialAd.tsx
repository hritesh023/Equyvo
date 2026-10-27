import React, { useEffect, useRef, useState } from 'react';
import { ADSENSE_CLIENT_ID, ADSENSE_SLOT, isAdSenseConfigured, shouldShowInterstitial } from '@/lib/ads-config';
import { isNativePlatform } from '@/lib/admob-service';
import { useAdPlan } from '@/hooks/use-ad-plan';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

const LAST_SHOWN_KEY = 'equyvo_web_interstitial_at';
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const WARMUP_MS = 90 * 1000;
const MIN_NAVIGATIONS = 4;
const CALM_ROUTES = new Set([
  '/auth',
  '/pricing',
  '/app/pricing',
  '/app/create',
  '/create',
  '/app/moments',
  '/moments',
]);

function isCalmRoute(pathname: string): boolean {
  if (!pathname) return true;
  if (CALM_ROUTES.has(pathname)) return true;
  return pathname.startsWith('/auth/') || pathname.startsWith('/create/');
}

/**
 * Web interstitial (AdSense), the "every page, never irritating" version:
 *  - native builds use the AdMob interstitial (use-interstitial + service)
 *  - web shows at most one calm, dismissible card per 10 minutes
 *  - never on auth, pricing/checkout, composer, or the Moments video rail
 *  - never before 90s of app use or before the 4th navigation
 *  - free plan only; closed by the X, backdrop click or Escape
 *
 * The ad loads inside the card only after it opens, so a blocked or no-fill
 * request collapses the card instead of leaving an empty overlay.
 */
const WebInterstitialAd: React.FC<{ pathname: string }> = ({ pathname }) => {
  const plan = useAdPlan();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const insRef = useRef<HTMLModElement>(null);
  const mountedAt = useRef(Date.now());
  const navCount = useRef(0);
  const prevPath = useRef(pathname);

  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    navCount.current += 1;

    if (!isAdSenseConfigured() || isNativePlatform()) return;
    if (isCalmRoute(pathname)) return;
    if (navCount.current < MIN_NAVIGATIONS) return;
    if (Date.now() - mountedAt.current < WARMUP_MS) return;
    if (!shouldShowInterstitial(plan)) return;
    try {
      const last = Number(localStorage.getItem(LAST_SHOWN_KEY) || 0);
      if (Date.now() - last < MIN_INTERVAL_MS) return;
      localStorage.setItem(LAST_SHOWN_KEY, String(Date.now()));
    } catch {
      // Storage unavailable: fall back to once per session.
      if ((window as any).__equyvoInterstitialShown) return;
      (window as any).__equyvoInterstitialShown = true;
    }
    setFailed(false);
    setOpen(true);
  }, [pathname, plan]);

  useEffect(() => {
    if (!open) return;
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

    const timer = setTimeout(() => {
      if (!cancelled && insRef.current && !insRef.current.getAttribute('data-adsbygoogle-status')) {
        setFailed(true);
      }
    }, 7000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open]);

  // Escape closes immediately — no forced view time.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // No fill / blocked ad: collapse the whole overlay (never an empty modal).
  useEffect(() => {
    if (failed) setOpen(false);
  }, [failed]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Sponsored message"
      onClick={() => setOpen(false)}
    >
      <div
        className="relative w-full max-w-md overflow-hidden rounded-2xl border bg-card p-3 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Sponsored
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded px-2 py-1 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close ad"
          >
            Continue ✕
          </button>
        </div>
        <ins
          ref={insRef}
          className="adsbygoogle"
          style={{ display: 'block', minHeight: 250 }}
          data-ad-client={ADSENSE_CLIENT_ID}
          data-ad-slot={ADSENSE_SLOT}
          data-ad-layout="in-article"
          data-ad-format="fluid"
        />
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Ads keep Equyvo free ·{' '}
          <a href="/pricing" className="underline hover:text-foreground">Go ad-free</a>
        </p>
      </div>
    </div>
  );
};

export default WebInterstitialAd;
