// Equyvo pricing catalog — DISPLAY ONLY. Quotas, upload caps and
// entitlements are enforced server-side. Never trust these values for access
// control in the browser. Checkout orders are created + verified server-side;
// the browser only handles the payment sheet.

export interface PlanDef {
  id: string;
  label: string;
  priceInr: number | null;
  tagline: string;
  features: string[];
  popular?: boolean;
  creatorPick?: boolean;
  // Quota hints (mirror server PLAN_CATALOG; server is authoritative)
  storageGB: number;
  maxUploadMB: number;
  maxVideoSec: number;
  monthlyUploads: number;
}

export const EQUYVO_PLANS: PlanDef[] = [
  { id: 'eq_free', label: 'Free', priceInr: 0, tagline: 'Everyone', storageGB: 5, maxUploadMB: 20, maxVideoSec: 60, monthlyUploads: 100, features: ['Posts, videos, photos', 'Moments & Thoughts', 'Communities & messaging', 'Discovery', 'Basic creator tools', '5 GB storage · 20 MB uploads', '2 profile name changes · unlimited photo updates'] },
  { id: 'eq_plus', label: 'Plus', priceInr: 49, tagline: 'Enhanced user', storageGB: 50, maxUploadMB: 100, maxVideoSec: 180, monthlyUploads: 500, features: ['50 GB storage · 100 MB uploads', 'Enhanced customization', 'Better privacy controls', 'Ad-light experience', 'Higher media limits', '+2 profile name changes per purchase'] },
  { id: 'eq_premium', label: 'Premium', priceInr: 149, tagline: 'Power user', popular: true, storageGB: 250, maxUploadMB: 500, maxVideoSec: 600, monthlyUploads: 2000, features: ['250 GB storage · 500 MB uploads', 'Ad-free', 'Higher-quality uploads', 'Advanced profile & privacy', 'Advanced analytics', 'AI content tools', 'Priority processing', '+2 profile name changes per purchase'] },
  { id: 'eq_creator', label: 'Creator', priceInr: 399, tagline: 'Creator', creatorPick: true, storageGB: 500, maxUploadMB: 1024, maxVideoSec: 1800, monthlyUploads: 5000, features: ['500 GB storage · 1 GB uploads', 'Creator analytics & audience insights', 'AI captions & content generation', 'AI thumbnails', 'Scheduling & 4K media', 'Subscriber & monetization tools (10% platform fee)', 'Creator marketplace', '+2 profile name changes per purchase'] },
  { id: 'eq_creator_pro', label: 'Creator Pro', priceInr: 799, tagline: 'Professional creator', storageGB: 1024, maxUploadMB: 2048, maxVideoSec: 7200, monthlyUploads: 20000, features: ['1 TB storage · 2 GB uploads', 'AI editing & automated workflows', 'Multiple profiles, team collaboration', 'Brand collaboration tools', 'API access', 'Advanced monetization (10% platform fee)', '+2 profile name changes per purchase'] },
];

export const EQUYVO_PRODUCT = 'equyvo';

export function formatINR(v: number | null): string {
  if (v === null) return 'Custom';
  if (v === 0) return '₹0';
  return '₹' + v.toLocaleString('en-IN');
}
