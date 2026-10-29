// Country-aware price display for Equyvo.
//
// HOW BILLING ACTUALLY WORKS: every order is created server-side (central
// Acronous billing via api.acronous.com) and charged in INR through Razorpay
// (UPI, cards, netbanking, wallets, international cards). International banks
// convert the INR amount to the buyer's card currency at checkout.
//
// WHAT THIS MODULE DOES: for visitors OUTSIDE India it shows an approximate
// price in their local currency next to the exact INR amount, so the page is
// readable world-wide while still charging exactly what the server prices.
// For India it shows the INR amount only (that IS the charged amount). The
// INR base price always stays visible so what you pay equals what you saw.

// Approximate reference FX rates (1 INR = rate X of currency). Static, in-code
// table on purpose: no paid FX API, works offline, and the primary price is
// always INR so a stale rate can never mislead billing. Periodically refreshed.
// Updated: 2026-10.
const INR_PER = {
  USD: 1 / 88.0,
  EUR: 1 / 95.0,
  GBP: 1 / 105.0,
  AUD: 1 / 58.0,
  CAD: 1 / 63.0,
  SGD: 1 / 66.5,
  AED: 1 / 24.0,
  SAR: 1 / 23.5,
};

const CURRENCY_FOR_COUNTRY: Record<string, string> = {
  // India — billed and displayed in INR directly.
  IN: 'INR',
  // Major billing countries → local approximation.
  US: 'USD', EC: 'USD', PR: 'USD',
  GB: 'GBP', IE: 'EUR',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR',
  PT: 'EUR', GR: 'EUR', FI: 'EUR', LU: 'EUR', CY: 'EUR', MT: 'EUR', SK: 'EUR',
  SI: 'EUR', EE: 'EUR', LV: 'EUR', LT: 'EUR', HR: 'EUR', AD: 'EUR', MC: 'EUR',
  SM: 'EUR', VA: 'EUR', ME: 'EUR', XK: 'EUR',
  AU: 'AUD', NZ: 'AUD', CC: 'AUD', CX: 'AUD', NF: 'AUD', HM: 'AUD',
  CA: 'CAD',
  SG: 'SGD', BN: 'SGD',
  AE: 'AED', SA: 'SAR', QA: 'SAR', KW: 'SAR', BH: 'SAR', OM: 'SAR',
  // Everything else falls back to USD approximation.
};

export interface LocalPrice {
  /** Exact charged amount, INR formatted (e.g. "₹1,999"). */
  inr: string;
  /** Approximate local amount (e.g. "≈ $22.7") or null when INR only. */
  localApprox: string | null;
  /** ISO currency of the local approximation ("USD") when applicable. */
  localCurrency: string | null;
}

function formatInr(v: number): string {
  if (v === 0) return '₹0';
  return '₹' + Math.round(v).toLocaleString('en-IN');
}

function formatLocal(v: number, currency: string): string {
  const symbols: Record<string, string> = {
    USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$', SGD: 'S$', AED: 'AED ', SAR: 'SAR ',
  };
  const symbol = symbols[currency] || currency + ' ';
  const rate = (INR_PER as Record<string, number | undefined>)[currency] || (1 / 88.0);
  const amount = v * rate;
  const text = amount >= 100 ? amount.toFixed(0) : amount.toFixed(1);
  return '≈ ' + symbol + Number(text).toLocaleString('en-US');
}

/** Resolve the visitor's country: server geo (Cloudflare) first, then locale. */
export async function getUserCountry(): Promise<string> {
  let country = '';
  try {
    const r = await fetch('/api/geo', { headers: { Accept: 'application/json' } });
    if (r.ok) {
      const j = (await r.json()) as { country?: string };
      if (typeof j.country === 'string' && /^[A-Za-z]{2}$/.test(j.country)) {
        country = j.country.toUpperCase();
      }
    }
  } catch { /* fall through to locale */ }
  if (!country) {
    try {
      const loc = new Intl.DateTimeFormat().resolvedOptions().locale || '';
      const m = loc.match(/[-_]([A-Za-z]{2})\b/);
      if (m) country = m[1].toUpperCase();
    } catch { /* ignore */ }
  }
  if (!country) {
    try {
      // Intl.Locale countries where available (privacy-friendly, no network).
      // `region` is on Intl.Locale in modern engines; guard for older ones.
      const base = new Intl.Locale(Intl.NumberFormat().resolvedOptions().locale || 'en') as unknown as { region?: string };
      if (base.region) country = String(base.region).toUpperCase();
    } catch { /* ignore */ }
  }
  return /^[A-Za-z]{2}$/.test(country) ? country : 'IN';
}

export function localCurrencyFor(country: string): string | null {
  const code = (CURRENCY_FOR_COUNTRY[country] || '').toUpperCase();
  if (code === 'INR') return null; // India: INR is the actual charged currency
  return code || 'USD';
}

/** Build the display pair (exact INR + local approximation) for a plan price. */
export function priceForCountry(priceInr: number | null, country: string): LocalPrice {
  if (priceInr === null) return { inr: 'Custom', localApprox: null, localCurrency: null };
  const cur = localCurrencyFor(country);
  return {
    inr: formatInr(priceInr),
    localApprox: cur ? formatLocal(priceInr, cur) : null,
    localCurrency: cur,
  };
}

export const CURRENCY_DISCLAIMER =
  'Prices are shown in your local currency as an approximate guide. Payments are processed securely in INR (₹) through Razorpay — UPI, cards, netbanking, wallets and international cards (your bank converts the amount).';
