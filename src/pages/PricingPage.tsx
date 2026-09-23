import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Check, Loader2, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EQUYVO_PLANS, formatINR } from '@/lib/plans';
import { AuthRequiredError, buyPlan, getBillingStatus } from '@/lib/billing';
import { getStoredUser } from '@/lib/auth';
import { toast } from 'sonner';

const PLAN_KEY = 'equyvo_active_plan';

const PricingPage: React.FC = () => {
  const navigate = useNavigate();
  const [activePlan, setActivePlan] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PLAN_KEY);
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // True when checkout can't proceed without a fresh sign-in (expired or
  // missing token). Shows a re-sign-in CTA instead of a dead-end toast.
  const [needsAuth, setNeedsAuth] = useState(false);

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
        setNeedsAuth(false);
      })
      .catch(() => {
        // Billing unreachable / signed out: fall back to cached plan so the
        // page stays useful, and let checkout decide about re-auth.
      })
      .finally(() => setLoading(false));
  }, []);

  const goSignIn = () => {
    navigate('/auth?next=' + encodeURIComponent('/pricing'));
  };

  const buy = async (planId: string) => {
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
      setNeedsAuth(false);
      toast.success('Payment verified. Your plan is active.');
    } catch (e: unknown) {
      if (e instanceof AuthRequiredError) {
        // Signed-in user with an expired session, or signed-out visitor:
        // route to sign-in and bring them back to finish checkout.
        setNeedsAuth(true);
        const who = getStoredUser() ? 'Your session expired. Sign in again to continue.' : 'Sign in to continue with your subscription.';
        toast.info(who);
        return;
      }
      const msg = e instanceof Error ? e.message : 'Payment failed.';
      if (msg !== 'payment_cancelled') toast.error(msg);
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

      {needsAuth && !loading && (
        <div className="mb-6 mx-auto max-w-xl rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 flex flex-col sm:flex-row items-center gap-3 text-center sm:text-left">
          <div className="flex-1">
            <p className="font-semibold text-sm">Sign in to continue</p>
            <p className="text-xs text-muted-foreground mt-1">
              {getStoredUser()
                ? 'Your session expired, so checkout was paused. Sign in again — you’ll land right back here.'
                : 'Checkout needs an account. Sign in (or create one) and you’ll return here to finish.'}
            </p>
          </div>
          <Button size="sm" onClick={goSignIn} className="shrink-0">
            <LogIn className="h-4 w-4 mr-1.5" /> Sign in
          </Button>
        </div>
      )}

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
                    <Button variant="outline" className="w-full" disabled={active}>{active ? 'Current plan' : 'Free forever'}</Button>
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
