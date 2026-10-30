import React, { useEffect, useState } from 'react';
import { Crown, Check, Loader2, BadgeCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EQUYVO_PLANS, formatINR } from '@/lib/plans';
import { priceForCountry, CURRENCY_DISCLAIMER, getUserCountry } from '@/lib/currency';
import { buyPlan, claimBilling, getBillingStatus } from '@/lib/billing';
import { getAuthToken, getToken, getStoredUser } from '@/lib/auth';
import { toast } from 'sonner';

const PLAN_KEY = 'equyvo_active_plan';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Auth-shaped failure (expired/invalid session): retry as guest, never
 *  dead-end into a sign-in wall. */
function isAuthCheckoutError(e: unknown): boolean {
  const st = (e as { status?: number } | null)?.status;
  if (st === 401 || st === 403) return true;
  const m = e instanceof Error ? e.message : '';
  return /session expired|sign in|log ?in/i.test(m);
}

/** Service unavailable (stale deploy / upstream down): offer the hosted
 *  Razorpay checkout so the button still reaches Razorpay. */
function isServiceCheckoutError(e: unknown): boolean {
  const st = (e as { status?: number } | null)?.status;
  const m = e instanceof Error ? e.message : '';
  return st === 404 || st >= 500 || /404|unavailable|updating|Bad payment response|Could not start checkout/i.test(m);
}

interface VerifyResult {
  ok: boolean;
  plan: string;
  guest?: boolean;
  claimed?: boolean;
  nameGrant?: { granted: number; quota: number; used: number; remaining: number };
}

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
  // Country-aware display: exact INR price primary; local-currency
  // approximation secondary (outside India). IN does not affect pricing.
  const [country, setCountry] = useState<string>(() => {
    try {
      return localStorage.getItem('equyvo_geo_country') || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    getUserCountry()
      .then((c) => {
        setCountry(c);
        try { localStorage.setItem('equyvo_geo_country', c); } catch { /* ignore */ }
      })
      .catch(() => { /* keep INR display as fallback */ });
  }, []);

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

  // ── Guest checkout (the "tap a plan → straight to Razorpay" flow) ──────
  const [payPlan, setPayPlan] = useState<string | null>(null);
  const [payEmail, setPayEmail] = useState('');
  const [payError, setPayError] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payEmailOpen, setPayEmailOpen] = useState(false);

  const applyPurchase = (v: VerifyResult) => {
    const plan = v.plan || payPlan || '';
    if (plan) setActivePlan(plan);
    // Persist instantly + notify the ad gate so sponsored slots and the
    // banner vanish the moment a paid tier activates (no app restart).
    try {
      localStorage.setItem(PLAN_KEY, plan);
    } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan } }));
    if (v.guest && !v.claimed) {
      toast.success('Payment verified. It activates when you sign in with your payment email.');
    } else {
      toast.success('Payment verified. Your plan is active. Ads are off.');
    }
    if (v.nameGrant && v.nameGrant.granted > 0) {
      toast.success(`+${v.nameGrant.granted} profile name changes added (${v.nameGrant.remaining} available).`);
    }
  };

  const confirmGuestCheckout = async () => {
    if (!payPlan) return;
    const email = payEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setPayError('Enter a valid email address.');
      return;
    }
    setPayError(null);
    setPayBusy(true);
    try {
      toast.info('Opening secure Razorpay checkout…');
      const v = await buyPlan(payPlan, email);
      setPayEmailOpen(false);
      applyPurchase(v as VerifyResult);
    } catch (e: unknown) {
      if (e instanceof Error && e.message === 'payment_cancelled') { setPayEmailOpen(false); return; }
      const msg = e instanceof Error ? e.message : 'Payment failed.';
      if (isServiceCheckoutError(e)) {
        // Same-origin + central both unreachable: the hosted Razorpay
        // checkout on acronous.com is the last resort (web only — the
        // native shell cannot open new tabs, it retries in place).
        try {
          const url = 'https://acronous.com/checkout.html?plan=' + encodeURIComponent(payPlan) + '&email=' + encodeURIComponent(email);
          const isNative = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
          if (isNative) {
            setPayError('Payment service is busy right now. Please try again in a moment.');
          } else {
            setPayEmailOpen(false);
            toast.info('Opening secure checkout on acronous.com…');
            window.location.href = url;
          }
        } catch { setPayError('Payment service is busy right now. Please try again.'); }
        return;
      }
      setPayError(msg);
    } finally {
      setPayBusy(false);
    }
  };

  const buy = async (planId: string) => {
    // DIRECT-TO-RAZORPAY policy: no sign-in wall on any plan card. Signed-in
    // users checkout with their session; everyone else pays as a guest with
    // an email (the plan links to that email, auto-claimed on sign-in).
    let token: string | null = null;
    try { token = (await getAuthToken()) || getToken(); } catch { token = getToken(); }
    if (token) {
      setBusy(planId);
      try {
        toast.info('Opening secure Razorpay checkout…');
        const v = await buyPlan(planId);
        applyPurchase(v as VerifyResult);
        return;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Payment failed.';
        if (msg === 'payment_cancelled') return;
        if (!isAuthCheckoutError(e)) {
          if (isServiceCheckoutError(e)) {
            try {
              const url = 'https://acronous.com/checkout.html?plan=' + encodeURIComponent(planId)
                + (localStorage.getItem('equyvo_cognito_token') ? '&token=' + encodeURIComponent(localStorage.getItem('equyvo_cognito_token') as string) : '');
              const isNative = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
              if (isNative) {
                toast.error('Payment service is busy. Please try again in a moment.');
              } else {
                toast.info('Opening secure checkout on acronous.com…');
                window.location.href = url;
              }
            } catch { /* ignore */ }
          }
          toast.error(msg);
          return;
        }
        // Session expired mid-checkout: do NOT bounce to the sign-in wall —
        // finish the purchase as a guest with the account email prefilled.
        toast.info('Session expired — completing checkout as guest.');
      } finally {
        setBusy(null);
      }
    }
    // Guest path: one email → straight into Razorpay (in-app, same window).
    const stored = getStoredUser();
    const storedEmail = stored?.email && EMAIL_RE.test(stored.email) ? stored.email : '';
    if (storedEmail) {
      setBusy(planId);
      try {
        toast.info('Opening secure Razorpay checkout...');
        const v = await buyPlan(planId, storedEmail);
        applyPurchase(v as VerifyResult);
        return;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Payment failed.';
        if (msg === 'payment_cancelled') return;
        if (isServiceCheckoutError(e)) {
          try {
            const url = 'https://acronous.com/checkout.html?plan=' + encodeURIComponent(planId) + '&email=' + encodeURIComponent(storedEmail);
            const isNative = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
            if (!isNative) { toast.info('Opening secure checkout on acronous.com...'); window.location.href = url; return; }
          } catch { /* ignore */ }
        }
        toast.error(msg);
        return;
      } finally {
        setBusy(null);
      }
    }
    setPayPlan(planId);
    setPayEmail('');
    setPayError(null);
    setPayEmailOpen(true);
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
            const priceLocal = country ? priceForCountry(p.priceInr, country).localApprox : null;
            return (
              <div key={p.id} className={`rounded-2xl border p-6 flex flex-col relative ${p.popular || p.creatorPick ? 'border-pink-500/60 shadow-lg shadow-pink-500/10' : 'border-border'}`}>
                {(p.popular || p.creatorPick) && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[11px] font-bold tracking-wide bg-gradient-to-r from-pink-500 to-violet-500 text-white px-3 py-1 rounded-full whitespace-nowrap">
                    {p.popular ? 'MOST POPULAR' : 'CREATOR PICK'}
                  </span>
                )}
                <h3 className="font-bold text-lg">{p.label}</h3>
                <p className="text-xs text-muted-foreground">{p.tagline}</p>
                <div className="mt-2">
                  <p className="text-3xl font-extrabold">
                    {formatINR(p.priceInr)}
                    <span className="text-sm font-medium text-muted-foreground">{p.priceInr ? '/mo' : ''}</span>
                  </p>
                  {priceLocal && (
                    <p className="text-sm text-muted-foreground">{priceLocal}/mo</p>
                  )}
                </div>
                {p.id === 'eq_creator_pro' && (
                  <p className="mt-2 flex items-start gap-2 rounded-lg border border-pink-500/40 bg-pink-500/10 px-3 py-2 text-xs text-foreground">
                    <BadgeCheck className="h-4 w-4 shrink-0 text-pink-500 mt-0.5" />
                    <span><strong>Verified badge</strong> — the verified tick is granted to your registered name once, is globally unique to your account, and renames are limited to once a month.</span>
                  </p>
                )}
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
            <p className="text-sm text-muted-foreground">Suggested from ₹2,999/mo</p>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground flex-1">
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Business and brand profiles</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Business analytics</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Equyvo Ads Manager</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Multiple team members and administrators</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Campaign and promotion tools</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Custom storage and upload allowances</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />API and business integrations</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Dedicated support options</li>
              <li className="flex gap-2"><Check className="h-4 w-4 text-pink-500 shrink-0 mt-0.5" />Ad-free experience</li>
            </ul>
            <div className="mt-5"><a href="mailto:enterprise@acronous.com?subject=Equyvo%20Business" className="block"><Button variant="outline" className="w-full">Contact us</Button></a></div>
          </div>
        </div>
      )}
      <p className="text-center text-xs text-muted-foreground mt-8">UPI · Cards · Netbanking · Wallets · International cards — via Razorpay. Cancel anytime; plan stays till month-end.</p>
      <p className="text-center text-[11px] text-muted-foreground/80 mt-2 max-w-xl mx-auto">{CURRENCY_DISCLAIMER}</p>

      {/* Guest checkout: one email → straight into Razorpay. No account
          needed; the plan links to this email and auto-claims on sign-in. */}
      <Dialog open={payEmailOpen} onOpenChange={(o) => { if (!payBusy) setPayEmailOpen(o); }}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>Where should we send your plan?</DialogTitle>
            <DialogDescription>
              No account needed to pay. Your plan activates on this email — sign in with it later and everything (ads off, quotas, badges) links automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="guest-pay-email">Email for the receipt</Label>
              <Input
                id="guest-pay-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={payEmail}
                onChange={(e) => { setPayEmail(e.target.value); if (payError) setPayError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !payBusy) void confirmGuestCheckout(); }}
                disabled={payBusy}
              />
              {payError && <p className="text-xs text-destructive">{payError}</p>}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" disabled={payBusy} onClick={() => setPayEmailOpen(false)}>Cancel</Button>
            <Button disabled={payBusy} onClick={() => void confirmGuestCheckout()}>
              {payBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {payBusy ? 'Opening Razorpay…' : 'Pay securely'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PricingPage;
