import React, { useEffect, useState } from 'react';
import { Crown, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EQUYVO_PLANS, formatINR } from '@/lib/plans';
import { buyPlan, getBillingStatus } from '@/lib/billing';
import { toast } from 'sonner';

const PricingPage: React.FC = () => {
  const [activePlan, setActivePlan] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getBillingStatus()
      .then((s) => {
        const sub = s.subscriptions?.['equyvo'] ?? s.access;
        if (sub) setActivePlan(sub.plan);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const buy = async (planId: string) => {
    setBusy(planId);
    try {
      toast.info('Opening secure Razorpay checkout…');
      const v = await buyPlan(planId);
      setActivePlan(v.plan || planId);
      toast.success('Payment verified. Your plan is active.');
    } catch (e: unknown) {
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
