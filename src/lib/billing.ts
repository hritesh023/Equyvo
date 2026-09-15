// Centralized billing client for Equyvo.
// All payments run through Razorpay orders created + verified server-side at
// https://api.acronous.com. The app never handles card/UPI data or secrets.
import { getToken } from './auth';

const API_BASE = 'https://api.acronous.com';

function authHeaders(): Record<string, string> {
  const t = getToken();
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(API_BASE + path, { ...init, headers: authHeaders() });
  const j = await r.json().catch(() => ({ error: 'bad_response' }));
  if (!r.ok) throw new Error((j as { error?: string }).error || `Request failed (${r.status})`);
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
  return req<BillingStatus>('/v1/billing/status?product=equyvo');
}

/** Full checkout: create order -> Razorpay (UPI/cards/netbanking) -> verify. */
export async function buyPlan(plan: string): Promise<{ ok: boolean; plan: string }> {
  if (!getToken()) throw new Error('Please sign in first.');
  const order = await req<{ order_id: string; amount: number; currency: string; key_id: string }>(
    '/v1/billing/order', { method: 'POST', body: JSON.stringify({ plan }) });
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
  return req('/v1/billing/verify', {
    method: 'POST',
    body: JSON.stringify({
      razorpay_order_id: razor.razorpay_order_id,
      razorpay_payment_id: razor.razorpay_payment_id,
      razorpay_signature: razor.razorpay_signature,
      plan,
    }),
  });
}
