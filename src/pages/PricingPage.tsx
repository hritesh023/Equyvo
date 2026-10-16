import React, { useEffect, useState } from 'react';
import { Crown, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EQUYVO_PLANS, formatINR } from '@/lib/plans';
import { buyPlan, claimBilling, getBillingStatus } from '@/lib/billing';
import { getAuthToken, getToken } from '@/lib/auth';
import { toast } from 'sonner';

const PLAN_KEY = 'equyvo_active_plan';

const PricingPage: React.FC = () => {
  const [activePlan, setActivePlan] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PLAN_KEY);
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getBillingStatus()
      .then((s) => {
        const sub = s.subscriptions?.['equyvo'] ?? s.access;
        if (sub?.plan) {
          setActivePlan(sub.plan);
          try {
            localStorage.setItem(PLAN_KEY, sub.plan);
          } catch { /* ignore */ }
        }
      })
      .catch(() => {
        // Billing unreachable / signed out: fall back to cached plan so the
        // page stays useful, and let checkout decide about re-auth.
      })
      .finally(() => setLoading(false));
    // Link guest-paid plans (paid without sign-in, same email) on arrival.
    claimBilling().then((c) => {
      if (c && c.granted.length) {
        setActivePlan(c.granted[0]);
        try { localStorage.setItem(PLAN_KEY, c.granted[0]); } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: c.granted[0] } }));
        toast.success('Your plan is now active. Welcome back.');
      }
    });
  }, []);

  const chooseFree = () => {
    // Catalog id is eq_free (see worker/src/kv.ts PLAN_CATALOG). The old
    // 'free' value matched nothing server-side, so the ad-gate/quotas
    // disagreed with the UI after choosing Free.
    setActivePlan('eq_free');
    try {
      localStorage.setItem(PLAN_KEY, 'eq_free');
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: 'eq_free' } }));
    toast.success('You are on the Free plan.');
  };

  const buy = async (planId: string) => {
    // No sign-in wall: signed-out buyers go straight to the hosted Razorpay
    // checkout (email links the plan when they sign in next).
    try {
      const t = (await getAuthToken()) || getToken();
      if (!t) {
        window.open('https://acronous.com/checkout.html?plan=' + encodeURIComponent(planId), '_blank', 'noopener');
        toast.info('Opening secure Razorpay checkout…');
        return;
      }
    } catch { /* fall through to in-app checkout */ }
    setBusy(planId);
    try {
      toast.info('Opening secure Razorpay checkout…');
      const v = await buyPlan(planId);
      const plan = v.plan || planId;
      setActivePlan(plan);
      // Persist instantly + notify the ad gate so sponsored slots vanish
      // the moment Premium/Creator activates (no app restart needed).
      try {
        localStorage.setItem(PLAN_KEY, plan);
      } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan } }));
      if (v.guest && !v.claimed) {
        toast.success('Payment verified. It activates when you sign in with your payment email.');
      } else {
        toast.success('Payment verified. Your plan is active.');
      }
      if (v.nameGrant && v.nameGrant.granted > 0) {
        toast.success(`+${v.nameGrant.granted} profile name changes added (${v.nameGrant.remaining} available).`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Payment failed.';
      if (msg === 'payment_cancelled') return;
      // Same-origin + central both unreachable (stale deploy / 404): fall
      // through to the hosted Razorpay checkout on acronous.com so the
      // payment button NEVER dead-ends on 404 — it always reaches Razorpay.
      if (/404|updating|unavailable|Bad payment response|Could not start checkout/i.test(msg)) {
        try {
          const t = localStorage.getItem('equyvo_cognito_token') || '';
          const url = 'https://acronous.com/checkout.html?plan=' + encodeURIComponent(planId) + (t ? '&token=' + encodeURIComponent(t) : '');
          toast.info('Opening secure checkout on acronous.com…');
          window.open(url, '_blank', 'noopener');
        } catch { /* ignore */ }
      }
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 text-sm text-muted-foreground border rounded-full px-4 py-1.5 mb-4">
          <Crown className="h-4 w-4 text-pink-500" /> Equyvo plans · secured by Razorpay
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Social stays free. Creators get superpowers.</h1>
        <p className="text-muted-foreground mt-2 max-w-xl mx-auto">
          Most people stay on Free forever. Upgrade for premium experience — or to earn as a creator.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EQUYVO_PLANS.map((p) => {
            const active = activePlan === p.id;
            return (
              <div key={p.id} className={`rounded-2xl border p-6 flex flex-col relative ${p.popular || p.creatorPick ? 'border-pink-500/60 shadow-lg shadow-pink-500/10' : 'border-border'}`}>
                {(p.popular || p.creatorPick) && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[11px] font-bold tracking-wide bg-gradient-to-r from-pink-500 to-violet-500 text-white px-3 py-1 rounded-full whitespace-nowrap">
                    {p.popular ? 'MOST POPULAR' : 'CREATOR PICK'}
                  </span>
                )}
                <h3 className="font-bold text-lg">{p.label}</h3>
                <p className="text-xs text-muted-foreground">{p.tagline}</p>
                <p className="text-3xl font-extrabold mt-2">{formatINR(p.priceInr)}<span className="text-sm font-medium text-muted-foreground">{p.priceInr ? '/mo' : ''}</span></p>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />{f}</li>
                  ))}
                </ul>
                <div className="mt-5">
                  {p.priceInr === 0 ? (
                    <Button variant="outline" className="w-full" disabled={active} onClick={active ? undefined : chooseFree} title={active ? 'Your current plan' : 'Stay on the Free plan'}>
                      {active ? 'Current plan' : 'Free forever'}
                    </Button>
                  ) : (
                    <Button className="w-full" variant={active ? 'outline' : 'default'} disabled={busy !== null || active} onClick={() => buy(p.id)}>
                      {busy === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : active ? 'Current plan' : `Choose ${p.label}`}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="rounded-2xl border border-border p-6 flex flex-col">
            <h3 className="font-bold text-lg">Business</h3>
            <p className="text-xs text-muted-foreground">Brands / businesses</p>
            <p className="text-3xl font-extrabold mt-2">Custom</p>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground flex-1">
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Everything in Creator Pro</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Brand suite + ads manager</li>
            </ul>
            <div className="mt-5"><a href="mailto:enterprise@acronous.com?subject=Equyvo%20Business" className="block"><Button variant="outline" className="w-full">Contact us</Button></a></div>
          </div>
        </div>
      )}
      <p className="text-center text-xs text-muted-foreground mt-8">UPI · Cards · Netbanking · Wallets · International cards — via Razorpay. Cancel anytime; plan stays till month-end.</p>
    </div>
  );
};

export default PricingPage;
