import { useEffect, useState } from 'react';
import { getBillingStatus } from '@/lib/billing';

const PLAN_KEY = 'equyvo_active_plan';

/** Resolve the user's billing plan (cached) for ad gating. */
export function useAdPlan(): string | null {
  const [plan, setPlan] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PLAN_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    getBillingStatus()
      .then((s) => {
        const p =
          s.subscriptions?.['equyvo']?.plan ?? s.access?.plan ?? null;
        if (!cancelled && p) {
          setPlan(p);
          try {
            localStorage.setItem(PLAN_KEY, p);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => {
        /* offline / signed out — stay on free-tier ad behaviour */
      });
    // Instant update the moment a purchase (or plan change) lands, without
    // waiting for the next billing fetch or app restart.
    const onPlanChanged = (e: Event) => {
      const p = (e as CustomEvent).detail?.plan as string | undefined;
      if (p && !cancelled) {
        setPlan(p);
      } else if (!cancelled) {
        try {
          setPlan(localStorage.getItem(PLAN_KEY));
        } catch {
          /* ignore */
        }
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === PLAN_KEY && !cancelled) setPlan(e.newValue);
    };
    window.addEventListener('planChanged', onPlanChanged);
    window.addEventListener('storage', onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener('planChanged', onPlanChanged);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return plan;
}
