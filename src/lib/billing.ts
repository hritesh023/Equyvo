// Billing client for Equyvo.
// All payments run through orders created + verified server-side via this
// app's own /api routes. The app never handles card/UPI data or secrets.
import { getAuthToken, getToken } from './auth';

/** Thrown when checkout needs a fresh sign-in (never a dead-end toast).
 *  Kept for compat — buyPlan no longer requires sign-in (guest email works). */
export class AuthRequiredError extends Error {
  code = 'AUTH_REQUIRED';
  constructor(message = 'Please sign in again to continue with your subscription.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

// Same-origin API only — the server talks to the payment provider.
// Falls back to central billing if the same-origin function is missing
// (stale dist / Worker deploy without Functions) so payment buttons never
// dead-end on 404.
const API_BASE = '/api';
const CENTRAL_BILLING = 'https://api.acronous.com';

function centralPath(path: string): string | null {
  if (path.startsWith('/create-order')) return '/v1/billing/order';
  if (path.startsWith('/verify-payment')) return '/v1/billing/verify';
  if (path.startsWith('/billing/status')) return '/v1/billing/status?product=equyvo';
  return null;
}

async function centralReq<T>(path: string, init?: RequestInit): Promise<T> {
  const c = centralPath(path);
  if (!c) throw new Error('Request failed (404)');
  const t = (await getAuthToken()) || getToken();
  const r = await fetch(CENTRAL_BILLING + c, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: 'Bearer ' + t } : {}),
    },
  });
  const ct = r.headers.get('content-type') || '';
  const txt = await r.text();
  let j: unknown = null;
  try { j = JSON.parse(txt); } catch { j = null; }
  if (!j || (!ct.includes('json') && /<\s*html|<\s*!doctype/i.test(txt))) {
    throw new Error('Payment service is temporarily unavailable. Please try again.');
  }
  if (!r.ok) {
    throw new Error((j as { error?: string; response?: string }).error
      || (j as { response?: string }).response
      || `Request failed (${r.status})`);
  }
  // Guard: 200 HTML/empty order from a stale SPA fallback must not open Razorpay.
  if (path.startsWith('/create-order')) {
    const o = j as { order_id?: string; key_id?: string };
    if (!o.order_id || !o.key_id) throw new Error('Could not start checkout. Please try again.');
  }
  return j as T;
}

async function authHeaders(): Promise<Record<string, string>> {
  const t = (await getAuthToken()) || getToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + path, { ...init, headers: await authHeaders() });
  const ct = r.headers.get('content-type') || '';
  const txt = await r.text();
  let j: unknown = null;
  try { j = JSON.parse(txt); } catch { j = null; }
  // Stale SPA fallback serves index.html with 200 for missing /api routes —
  // that surfaced as "payment button → 404/blank". Retry central once.
  const isHtml = !j || (!ct.includes('json') && /<\s*html|<\s*!doctype/i.test(txt));
  if (isHtml) {
    try { return await centralReq<T>(path, init); }
    catch (e) { throw e instanceof Error ? e : new Error('Request failed (404)'); }
  }
  if (r.status === 404) {
    // Same-origin function missing (dev without dev:api, Worker deploy
    // without Functions, or BILLING_BASE_URL down). Try central directly.
    const cp = centralPath(path);
    if (cp) {
      try { return await centralReq<T>(path, init); }
      catch (e) { /* fall through to friendly 404 below */ }
    }
  }
  if (!r.ok) {
    // Friendly messages for common auth/billing failures.
    if (r.status === 401) {
      const err = new Error('Your session expired. Please sign in again.');
      (err as any).status = 401;
      throw err;
    }
    if (r.status === 402) {
      const err = new Error((j as { response?: string }).response || 'Quota exceeded. Please upgrade your plan.');
      (err as any).status = 402;
      (err as any).body = j;
      throw err;
    }
    if (r.status === 503) {
      const err = new Error('Payments are being switched on. Please try again in a bit.');
      (err as any).status = 503;
      throw err;
    }
    if (r.status >= 500) {
      const err = new Error('Payment service is temporarily unavailable. Please try again.');
      (err as any).status = r.status;
      throw err;
    }
    if (r.status === 404) {
      const err404 = new Error('Checkout service updating — please retry. If it persists, use acronous.com/pricing.html#eq.');
      (err404 as unknown as Record<string, unknown>).status = 404;
      throw err404;
    }
    throw new Error((j as { error?: string }).error || `Request failed (${r.status})`);
  }
  return j as T;
}

export interface BillingStatus {
  subscriptions?: Record<string, { plan: string; until: number }>;
  access?: { plan: string; until: number } | null;
  api_credits?: number;
}

declare global {
  interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open(): void; on(ev: string, cb: (r?: { error?: { description?: string } }) => void): void } }
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Razorpay Checkout.'));
    document.head.appendChild(s);
  });
}

export function getBillingStatus(): Promise<BillingStatus> {
  return req<BillingStatus>('/billing/status?product=equyvo');
}

/** Link a guest-paid plan to this account (same email). Silent no-op otherwise. */
export async function claimBilling(): Promise<{ granted: string[] } | null> {
  try {
    const r = await req<{ ok: boolean; granted: string[] }>('/claim-billing', { method: 'POST', body: JSON.stringify({}) });
    return { granted: r.granted || [] };
  } catch {
    return null;
  }
}

/** Full checkout: create order -> Razorpay (UPI/cards/netbanking) -> verify.
 *  No sign-in wall: signed-out buyers pay as guests with an email; the plan
 *  links when they sign in with the same email (claimed automatically). */
export async function buyPlan(plan: string, email?: string): Promise<{ ok: boolean; plan: string; guest?: boolean; claimed?: boolean; nameGrant?: { granted: number; quota: number; used: number; remaining: number } }> {
  const token = (await getAuthToken()) || getToken();
  const cleanEmail = !token && email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim()) ? email.trim() : undefined;
  if (!token && !cleanEmail) throw new Error('EMAIL_REQUIRED');
  const order = await req<{ order_id: string; amount: number; currency: string; key_id: string }>(
    '/create-order', { method: 'POST', body: JSON.stringify(cleanEmail ? { plan, email: cleanEmail } : { plan }) });
  await loadRazorpay();
  const razor = await new Promise<{ razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }>((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: order.key_id,
      amount: order.amount,
      currency: order.currency || 'INR',
      name: 'Acronous',
      description: 'Equyvo plan',
      order_id: order.order_id,
      theme: { color: '#ec4899' },
      modal: { ondismiss: () => reject(new Error('payment_cancelled')) },
      handler: (resp: unknown) => resolve(resp as { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }),
    });
    rzp.on('payment.failed', (r) => reject(new Error(r?.error?.description || 'Payment failed.')));
    rzp.open();
  });
  return req<{ ok: boolean; plan: string; guest?: boolean; claimed?: boolean; nameGrant?: { granted: number; quota: number; used: number; remaining: number } }>('/verify-payment', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: razor.razorpay_order_id,
      razorpay_payment_id: razor.razorpay_payment_id,
      razorpay_signature: razor.razorpay_signature,
      plan,
      ...(cleanEmail ? { email: cleanEmail } : {}),
    }),
  }).then((v) => {
    // Persist instantly so ads/quotas update without reload, and notify the
    // whole app (PricingPage also writes equyvo_active_plan + planChanged).
    try {
      const out = v as { ok: boolean; plan: string };
      const active = out.plan || plan;
      localStorage.setItem('equyvo_active_plan', active);
      localStorage.setItem('equyvo_last_plan', JSON.stringify({ plan: active, at: new Date().toISOString() }));
      window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: active } }));
      window.dispatchEvent(new CustomEvent('equyvo:plan-active', { detail: { plan: active } }));
    } catch { /* ignore */ }
    return v;
  });
}
