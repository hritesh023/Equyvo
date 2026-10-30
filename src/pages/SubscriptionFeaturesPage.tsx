import React, { useEffect, useState } from 'react';
import { useEntitlements } from '@/hooks/use-entitlements';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Crown, Lock, Sparkles, Users, Key, Store, Megaphone, BarChart3, Wand2 } from 'lucide-react';

const API = '/api';

async function api(path: string, init?: RequestInit) {
  const token = localStorage.getItem('equyvo_cognito_token');
  const r = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(init?.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || 'Request failed');
  return j?.data;
}

const Gate: React.FC<{ ok: boolean; label: string; children: React.ReactNode }> = ({ ok, label, children }) => {
  if (ok) return <>{children}</>;
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
      <Lock className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{label}</p>
      <a href="/pricing"><Button variant="outline">Upgrade plan</Button></a>
    </div>
  );
};

const SubscriptionFeaturesPage: React.FC = () => {
  const { entitlements: ent, usage } = useEntitlements();
  const [tab, setTab] = useState('analytics');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const tabs = [
    { id: 'analytics', label: 'Analytics', icon: BarChart3, ok: !!ent?.analytics || !!ent?.businessProfile },
    { id: 'ai', label: 'AI Tools', icon: Wand2, ok: (ent?.aiCreditsMonthly || 0) > 0 },
    { id: 'marketplace', label: 'Marketplace', icon: Store, ok: !!ent?.marketplace },
    { id: 'api', label: 'API Access', icon: Key, ok: !!ent?.apiAccess },
    { id: 'team', label: 'Team', icon: Users, ok: !!ent?.teamCollab },
    { id: 'brand', label: 'Brand Tools', icon: Sparkles, ok: !!ent?.brandTools },
    { id: 'ads', label: 'Ads Manager', icon: Megaphone, ok: !!ent?.adsManager },
  ];

  useEffect(() => {
    setData(null);
    setLoading(true);
    (async () => {
      try {
        if (tab === 'analytics') {
          const endpoint = ent?.businessProfile ? '/business/analytics' : '/creator/analytics';
          setData(await api(endpoint));
        } else if (tab === 'api') {
          setData(await api('/apikeys'));
        } else if (tab === 'team') {
          setData(await api('/team'));
        } else if (tab === 'marketplace') {
          setData(await api('/marketplace'));
        } else if (tab === 'brand') {
          setData(await api('/brand/collabs'));
        } else if (tab === 'ads') {
          setData(await api('/ads/campaigns'));
        }
      } catch (e: any) {
        toast.error(e?.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [tab, ent]);

  const currentTab = tabs.find((t) => t.id === tab)!;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center gap-2 mb-6">
        <Crown className="h-5 w-5 text-pink-500" />
        <h1 className="text-2xl font-bold">Subscription features</h1>
        <span className="text-xs text-muted-foreground ml-2">{ent?.planLabel || ent?.planId}</span>
      </div>
      {usage?.aiCredits && (
        <Card className="mb-4">
          <CardContent className="py-3 flex items-center justify-between text-sm">
            <span>AI credits this month</span>
            <span className="font-medium">{usage.aiCredits.remaining} / {usage.aiCredits.quota} remaining</span>
          </CardContent>
        </Card>
      )}
      <div className="flex flex-wrap gap-2 mb-6">
        {tabs.map((t) => (
          <Button key={t.id} variant={tab === t.id ? 'default' : 'outline'} size="sm" onClick={() => setTab(t.id)}>
            <t.icon className="h-4 w-4 mr-1" /> {t.label} {!t.ok && <Lock className="h-3 w-3 ml-1" />}
          </Button>
        ))}
      </div>

      <Gate ok={currentTab.ok} label={`${currentTab.label} requires a higher plan.`}>
        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-4">
            {tab === 'analytics' && (
              <Card><CardHeader><CardTitle>Analytics</CardTitle></CardHeader><CardContent>
                <pre className="text-xs bg-muted p-3 rounded">{JSON.stringify(data, null, 2)}</pre>
              </CardContent></Card>
            )}
            {tab === 'ai' && (
              <Card><CardHeader><CardTitle>AI Tools</CardTitle></CardHeader><CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">Generate captions and thumbnails using your monthly credits.</p>
                <div className="flex gap-2">
                  <Button onClick={async () => {
                    try { const r = await api('/ai/caption', { method: 'POST', body: JSON.stringify({ text: 'My post' }) }); toast.success('Caption: ' + r.caption); }
                    catch (e: any) { toast.error(e.message); }
                  }}>Generate caption (1 credit)</Button>
                  <Button onClick={async () => {
                    try { const r = await api('/ai/thumbnail', { method: 'POST', body: JSON.stringify({}) }); toast.success('Thumbnail generated'); }
                    catch (e: any) { toast.error(e.message); }
                  }} disabled={!ent?.creator}>Generate thumbnail (2 credits)</Button>
                </div>
              </CardContent></Card>
            )}
            {tab === 'marketplace' && (
              <Card><CardHeader><CardTitle>Marketplace</CardTitle></CardHeader><CardContent className="space-y-3">
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  try {
                    await api('/marketplace', { method: 'POST', body: JSON.stringify({ title: fd.get('title'), description: fd.get('description'), priceInr: Number(fd.get('price')), type: 'digital' }) });
                    toast.success('Product added'); e.currentTarget.reset();
                    setData(await api('/marketplace'));
                  } catch (err: any) { toast.error(err.message); }
                }} className="flex flex-wrap gap-2">
                  <Input name="title" placeholder="Product title" required className="flex-1" />
                  <Input name="price" type="number" placeholder="Price ₹" required className="w-28" />
                  <Input name="description" placeholder="Description" className="flex-1" />
                  <Button type="submit">Add</Button>
                </form>
                <pre className="text-xs bg-muted p-3 rounded max-h-60 overflow-auto">{JSON.stringify(data, null, 2)}</pre>
              </CardContent></Card>
            )}
            {tab === 'api' && (
              <Card><CardHeader><CardTitle>API Keys</CardTitle></CardHeader><CardContent className="space-y-3">
                <Button onClick={async () => {
                  const label = prompt('Key label') || 'Key';
                  try { const r = await api('/apikeys', { method: 'POST', body: JSON.stringify({ label }) }); toast.success('Created: ' + r.key); setData(await api('/apikeys')); }
                  catch (e: any) { toast.error(e.message); }
                }}>Create key</Button>
                <pre className="text-xs bg-muted p-3 rounded max-h-60 overflow-auto">{JSON.stringify(data, null, 2)}</pre>
              </CardContent></Card>
            )}
            {tab === 'team' && (
              <Card><CardHeader><CardTitle>Team Members</CardTitle></CardHeader><CardContent className="space-y-3">
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  try {
                    await api('/team', { method: 'POST', body: JSON.stringify({ email: fd.get('email'), role: fd.get('role') }) });
                    toast.success('Invited'); e.currentTarget.reset();
                    setData(await api('/team'));
                  } catch (err: any) { toast.error(err.message); }
                }} className="flex flex-wrap gap-2">
                  <Input name="email" type="email" placeholder="email@example.com" required className="flex-1" />
                  <Input name="role" placeholder="role" className="w-28" />
                  <Button type="submit">Invite</Button>
                </form>
                <pre className="text-xs bg-muted p-3 rounded max-h-60 overflow-auto">{JSON.stringify(data, null, 2)}</pre>
              </CardContent></Card>
            )}
            {tab === 'brand' && (
              <Card><CardHeader><CardTitle>Brand Collaborations</CardTitle></CardHeader><CardContent className="space-y-3">
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  try {
                    await api('/brand/collabs', { method: 'POST', body: JSON.stringify({ brand: fd.get('brand'), campaign: fd.get('campaign') }) });
                    toast.success('Added'); e.currentTarget.reset();
                    setData(await api('/brand/collabs'));
                  } catch (err: any) { toast.error(err.message); }
                }} className="flex flex-wrap gap-2">
                  <Input name="brand" placeholder="Brand name" required className="flex-1" />
                  <Input name="campaign" placeholder="Campaign" className="flex-1" />
                  <Button type="submit">Add</Button>
                </form>
                <pre className="text-xs bg-muted p-3 rounded max-h-60 overflow-auto">{JSON.stringify(data, null, 2)}</pre>
              </CardContent></Card>
            )}
            {tab === 'ads' && (
              <Card><CardHeader><CardTitle>Ads Manager</CardTitle></CardHeader><CardContent className="space-y-3">
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  try {
                    await api('/ads/campaigns', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), budgetInr: Number(fd.get('budget')) }) });
                    toast.success('Campaign created'); e.currentTarget.reset();
                    setData(await api('/ads/campaigns'));
                  } catch (err: any) { toast.error(err.message); }
                }} className="flex flex-wrap gap-2">
                  <Input name="name" placeholder="Campaign name" required className="flex-1" />
                  <Input name="budget" type="number" placeholder="Budget ₹" required className="w-28" />
                  <Button type="submit">Create</Button>
                </form>
                <pre className="text-xs bg-muted p-3 rounded max-h-60 overflow-auto">{JSON.stringify(data, null, 2)}</pre>
              </CardContent></Card>
            )}
          </div>
        )}
      </Gate>
    </div>
  );
};

export default SubscriptionFeaturesPage;