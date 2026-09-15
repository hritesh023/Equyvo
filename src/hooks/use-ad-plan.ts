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
    return () => {
      cancelled = true;
    };
  }, []);

  return plan;
}
