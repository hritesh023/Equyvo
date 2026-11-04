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
  { id: 'eq_free', label: 'Free', priceInr: 0, tagline: 'Everyone', storageGB: 1, maxUploadMB: 150, maxVideoSec: 300, monthlyUploads: 100, features: [
    'Posts, photos, videos, Moments and Thoughts',
    'Communities, messaging and Discover',
    'Basic creator tools',
    '1 GB storage',
    '150 MB maximum upload',
    'Basic profile customization',
    'Ad-supported experience',
  ] },
  { id: 'eq_plus', label: 'Plus', priceInr: 79, tagline: 'Enhanced User', storageGB: 10, maxUploadMB: 300, maxVideoSec: 1800, monthlyUploads: 500, features: [
    '10 GB storage',
    '300 MB maximum upload',
    'Enhanced profile customization',
    'Better privacy controls',
    'Reduced advertising',
    'Higher media limits',
    'One username change every 30 days',
  ] },
  { id: 'eq_premium', label: 'Premium', priceInr: 149, tagline: 'Power User', popular: true, storageGB: 30, maxUploadMB: 750, maxVideoSec: 3600, monthlyUploads: 2000, features: [
    '30 GB storage',
    '750 MB maximum upload',
    'Ad-free experience',
    'Higher-quality media uploads',
    'Advanced profile and privacy options',
    'Advanced personal analytics',
    'AI content tools with monthly credits',
    'Priority media processing',
  ] },
  { id: 'eq_creator', label: 'Creator', priceInr: 499, tagline: 'Content Creator', creatorPick: true, storageGB: 150, maxUploadMB: 1500, maxVideoSec: 7200, monthlyUploads: 5000, features: [
    '150 GB storage',
    '1.5 GB maximum upload',
    'Creator analytics and audience insights',
    'AI captions and content generation credits',
    'AI thumbnail generation credits',
    'Content scheduling',
    '4K media support subject to processing limits',
    'Subscriber and monetization tools',
    'Creator marketplace access',
    'SuperChat from audience in comment sections (15% platform fee)',
    'Live Moments in portrait mode',
    '15% Equyvo platform fee, subject to payment and store charges',
    'Ad-free experience',
  ] },
  { id: 'eq_creator_pro', label: 'Creator Pro', priceInr: 1499, tagline: 'Professional Creator', storageGB: 500, maxUploadMB: 3072, maxVideoSec: 14400, monthlyUploads: 20000, features: [
    '500 GB storage',
    '3 GB maximum upload',
    'Advanced AI editing credits and workflows',
    'Multiple profiles and team collaboration',
    'Brand collaboration tools',
    'Advanced creator analytics',
    'API access with usage limits',
    'Advanced monetization tools',
    'SuperChat from audience in comment sections (15% platform fee)',
    'Live Moments in portrait mode',
    'Priority support',
    'Verification eligibility subject to identity/business verification',
    'Ad-free experience',
  ] },
];

export const EQUYVO_PRODUCT = 'equyvo';

export const STORAGE_ADDONS = [
  { id: 'addon_25gb', label: 'Additional 25 GB', priceInr: 99 },
  { id: 'addon_100gb', label: 'Additional 100 GB', priceInr: 299 },
];

export function formatINR(v: number | null): string {
  if (v === null) return 'Custom';
  if (v === 0) return '₹0';
  return '₹' + v.toLocaleString('en-IN');
}