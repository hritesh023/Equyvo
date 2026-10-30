import { useEffect, useState } from 'react';
import { getBillingStatus } from '@/lib/billing';

const PLAN_KEY = 'equyvo_active_plan';

export interface Entitlements {
  planId: string;
  planLabel?: string;
  adFree?: boolean;
  adLight?: boolean;
  storageBytes?: number;
  maxUploadMB?: number;
  maxVideoSec?: number;
  monthlyUploads?: number;
  creator?: boolean;
  business?: boolean;
  verifiedEligible?: boolean;
  aiCreditsMonthly?: number;
  scheduling?: boolean;
  analytics?: boolean;
  marketplace?: boolean;
  apiAccess?: boolean;
  teamCollab?: boolean;
  brandTools?: boolean;
  businessProfile?: boolean;
  adsManager?: boolean;
  prioritySupport?: boolean;
}

export interface UsageInfo {
  planId: string;
  planLabel: string;
  usedBytes: number;
  quotaBytes: number;
  usedPct: number;
  files: number;
  monthlyUploads: number;
  monthlyCap: number;
  maxUploadMB: number;
  maxVideoSec: number;
  entitlements: Entitlements;
  aiCredits: { used: number; quota: number; remaining: number; month: string };
}

const DEFAULT_ENTITLEMENTS: Entitlements = { planId: 'eq_free' };

/** Resolve the current user's plan entitlements + usage from the server. */
export function useEntitlements(): { entitlements: Entitlements; usage: UsageInfo | null; loading: boolean } {
  const [entitlements, setEntitlements] = useState<Entitlements>(() => {
    try {
      const p = localStorage.getItem(PLAN_KEY);
      return p ? { planId: p } : DEFAULT_ENTITLEMENTS;
    } catch {
      return DEFAULT_ENTITLEMENTS;
    }
  });
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = localStorage.getItem('equyvo_cognito_token');
        const r = await fetch('/api/me/usage', {
          headers: token ? { Authorization: 'Bearer ' + token } : {},
        });
        if (!r.ok) throw new Error('usage fetch failed');
        const j = await r.json();
        if (cancelled) return;
        if (j?.data) {
          setUsage(j.data as UsageInfo);
          if (j.data.entitlements) setEntitlements(j.data.entitlements as Entitlements);
          else if (j.data.planId) setEntitlements({ planId: j.data.planId });
        }
      } catch {
        // offline/signed-out: fall back to cached plan
        try {
          const p = localStorage.getItem(PLAN_KEY);
          if (p) setEntitlements({ planId: p });
        } catch { /* ignore */ }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const onPlanChanged = (e: Event) => {
      const p = (e as CustomEvent).detail?.plan as string | undefined;
      if (p) setEntitlements((prev) => ({ ...prev, planId: p }));
    };
    window.addEventListener('planChanged', onPlanChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('planChanged', onPlanChanged);
    };
  }, []);

  return { entitlements, usage, loading };
}

export function hasFeature(e: Entitlements | null | undefined, feature: keyof Entitlements): boolean {
  if (!e) return false;
  const v = e[feature];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0;
  return false;
}