import { Env } from './env';

// KV Keys
const KEYS = {
  POSTS: 'posts:list',
  POST: (id: string) => `post:${id}`,
  THOUGHTS: 'thoughts:list',
  THOUGHT: (id: string) => `thought:${id}`,
  STORIES: 'stories:list',
  STORY: (id: string) => `story:${id}`,
  MOMENTS: 'moments:list',
  MOMENT: (id: string) => `moment:${id}`,
  PROFILE: (userId: string) => `profile:${userId}`,
  CONTENT_INDEX: 'content:index',
  NEXT_ID: 'next:id',
  HAS_REAL_USERS: 'has_real_users',
  RATE: (kind: string, actorId: string, bucket: number) => `rl:${kind}:${actorId}:${bucket}`,
  USAGE: (userId: string) => `usage:${userId}`,
  PLAN_CACHE: (userId: string) => `plan:${userId}`,
  HASH: (sha256: string) => `mediahash:${sha256}`,
  CREATOR: (userId: string) => `creator:${userId}`,
  MEDIA: (publicId: string) => `media:${publicId}`,
  // AI interest graph (backend-only; no frontend changes required).
  INTERESTS: (userId: string) => `interests:${userId}`,
  POP: (itemId: string) => `pop:${itemId}`,
  ORPHAN_SWEEP_AT: 'maint:orphan_sweep_at',
  // Social graph / chat / notifications / safety (mirrors Pages Functions).
  FOLLOWING: (userId: string) => `following:${userId}`,
  FOLLOWERS: (userId: string) => `followers:${userId}`,
  FOLLOW_REQ: (userId: string) => `followreq:${userId}`,
  REPORTS_LIST: 'reports:list',
  REPORT: (id: string) => `report:${id}`,
  FLAGS: (kind: string, id: string) => `flags:${kind}:${id}`,
  MOD_QUEUE: 'mod:queue',
  CHAT: (a: string, b: string) => `chat:${a}:${b}`,
  NOTIF: (userId: string) => `notif:${userId}`,
  LIVE: 'live:now',
  // Comments: per-content ledgers with replies, likes, shares, pins + owner
  // settings. Mirrors Pages Functions; identity is always server-resolved.
  COMMENTS: (contentId: string) => `comments:${contentId}`,
  COMMENT: (id: string) => `comment:${id}`,
  CSETTINGS: (contentId: string) => `csettings:${contentId}`,
};

export { KEYS };

// --- Monetization: server-side plan catalog (source of truth) ---
const GB = 1024 * 1024 * 1024;
export const PLAN_CATALOG: Record<string, { id: string; label: string; priceInr: number | null; storageBytes: number; maxUploadMB: number; maxVideoSec: number; monthlyUploads: number; quality: string; ads: boolean | string; creator?: boolean; business?: boolean }> = {
  eq_free:        { id: 'eq_free',        label: 'Free',        priceInr: 0,    storageBytes: 5 * GB,    maxUploadMB: 20,   maxVideoSec: 60,   monthlyUploads: 100,   quality: 'auto-low',  ads: true },
  eq_plus:        { id: 'eq_plus',        label: 'Plus',        priceInr: 49,   storageBytes: 50 * GB,   maxUploadMB: 100,  maxVideoSec: 180,  monthlyUploads: 500,   quality: 'auto-good', ads: 'light' },
  eq_premium:     { id: 'eq_premium',     label: 'Premium',     priceInr: 149,  storageBytes: 250 * GB,  maxUploadMB: 500,  maxVideoSec: 600,  monthlyUploads: 2000,  quality: 'auto-best', ads: false },
  eq_creator:     { id: 'eq_creator',     label: 'Creator',     priceInr: 399,  storageBytes: 500 * GB,  maxUploadMB: 1024, maxVideoSec: 1800, monthlyUploads: 5000,  quality: 'auto-best', ads: false, creator: true },
  eq_creator_pro: { id: 'eq_creator_pro', label: 'Creator Pro', priceInr: 799,  storageBytes: 1024 * GB, maxUploadMB: 2048, maxVideoSec: 7200, monthlyUploads: 20000, quality: 'original',  ads: false, creator: true },
  eq_business:    { id: 'eq_business',    label: 'Business',    priceInr: null, storageBytes: 2048 * GB, maxUploadMB: 2048, maxVideoSec: 7200, monthlyUploads: 50000, quality: 'original',  ads: false, creator: true, business: true },
};
export const DEFAULT_PLAN_ID = 'eq_free';
export const PLATFORM_FEE_BPS = 1000;
const PLAN_IDS = new Set(Object.keys(PLAN_CATALOG));
export function planQuota(planId: string) { return PLAN_CATALOG[planId] || PLAN_CATALOG[DEFAULT_PLAN_ID]; }

function monthlyBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
export async function getUsage(env: Env, userId: string) {
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.USAGE(userId));
    if (!raw) return { bytes: 0, files: 0, month: monthlyBucket(), monthUploads: 0 };
    const u = JSON.parse(raw);
    if (u.month !== monthlyBucket()) return { bytes: Number(u.bytes || 0), files: Number(u.files || 0), month: monthlyBucket(), monthUploads: 0 };
    return { bytes: Number(u.bytes || 0), files: Number(u.files || 0), month: u.month, monthUploads: Number(u.monthUploads || 0) };
  } catch { return { bytes: 0, files: 0, month: monthlyBucket(), monthUploads: 0 }; }
}
export async function addUsage(env: Env, userId: string, bytes: number) {
  const u = await getUsage(env, userId);
  const next = { bytes: u.bytes + bytes, files: u.files + 1, month: monthlyBucket(), monthUploads: (u.month === monthlyBucket() ? u.monthUploads : 0) + 1 };
  await env.EQUYVO_KV.put(KEYS.USAGE(userId), JSON.stringify(next));
  return next;
}
export async function subtractUsage(env: Env, userId: string, bytes: number) {
  const u = await getUsage(env, userId);
  const next = { bytes: Math.max(0, u.bytes - (bytes || 0)), files: Math.max(0, u.files - 1), month: u.month, monthUploads: u.monthUploads };
  await env.EQUYVO_KV.put(KEYS.USAGE(userId), JSON.stringify(next));
  return next;
}
export async function resolvePlan(env: Env, actorId: string, bearerToken: string): Promise<{ planId: string; source: string }> {
  if (!actorId) return { planId: DEFAULT_PLAN_ID, source: 'fallback-free' };
  try {
    const cached = await env.EQUYVO_KV.get(KEYS.PLAN_CACHE(actorId));
    if (cached) {
      const p = JSON.parse(cached);
      if (p && PLAN_IDS.has(p.planId) && p.until > Date.now()) return { planId: p.planId, source: 'cache' };
    }
  } catch { /* ignore */ }
  const base = (env.BILLING_BASE_URL || 'https://api.acronous.com').replace(/\/$/, '');
  if (bearerToken) {
    try {
      const resp = await fetch(`${base}/v1/billing/status?product=equyvo`, { headers: { Authorization: `Bearer ${bearerToken}` } });
      if (resp.ok) {
        const s: any = await resp.json();
        const planId = s?.subscriptions?.equyvo?.plan || s?.access?.plan;
        if (planId && PLAN_IDS.has(planId)) {
          const until = Number(s?.subscriptions?.equyvo?.until || s?.access?.until || 0) || Date.now() + 5 * 60 * 1000;
          try { await env.EQUYVO_KV.put(KEYS.PLAN_CACHE(actorId), JSON.stringify({ planId, until }), { expirationTtl: 600 }); } catch { /* ignore */ }
          return { planId, source: 'billing' };
        }
      }
    } catch { /* free fallback */ }
  }
  return { planId: DEFAULT_PLAN_ID, source: 'fallback-free' };
}

// --- Auth (Cognito JWT verify, production requires verified writes) ---
const DEFAULT_POOL_ID = 'eu-north-1_z141VJjsi';
let cachedJwks: any[] | null = null;
let cachedJwksAt = 0;
function getPoolId(env: Env) { return env.AWS_USER_POOL_ID || DEFAULT_POOL_ID; }
function b64urlDecode(str: string): Uint8Array {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function verifyCognitoToken(token: string, env: Env): Promise<{ id: string; email: string; username: string; verified: boolean } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [hb, pb, sb] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(hb)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(pb)));
    if (!payload.sub) return null;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    const poolId = getPoolId(env);
    const region = poolId.split('_')[0] || 'eu-north-1';
    if (payload.iss && payload.iss !== `https://cognito-idp.${region}.amazonaws.com/${poolId}`) return null;
    if (cachedJwks && Date.now() - cachedJwksAt < 3600000) { /* use cache */ } else {
      try {
        const r = await fetch(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`);
        if (r.ok) { const d: any = await r.json(); cachedJwks = d.keys || []; cachedJwksAt = Date.now(); }
      } catch { return null; }
    }
    const key = (cachedJwks || []).find((k: any) => k.kid === header.kid);
    if (!key) return null;
    const ck = await crypto.subtle.importKey('jwk', { kty: key.kty, n: key.n, e: key.e, alg: key.alg, use: key.use, kid: key.kid } as any, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', ck, b64urlDecode(sb), new TextEncoder().encode(`${hb}.${pb}`));
    if (!ok) return null;
    return { id: payload.sub, email: payload.email || '', username: payload['cognito:username'] || '', verified: true };
  } catch { return null; }
}
export function requiresVerifiedWrites(env: Env): boolean {
  return String(env.REQUIRE_VERIFIED_WRITES || '').toLowerCase() === 'true';
}
export async function getActor(request: Request, env: Env, body?: any) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const u = await verifyCognitoToken(token, env);
      if (u) return u;
      if (requiresVerifiedWrites(env)) return null;
    }
  }
  if (requiresVerifiedWrites(env)) return null;
  const h = request.headers.get('X-User-Id') || request.headers.get('X-User-Email') || '';
  const b = body && typeof body === 'object' ? (body.userId || body.user_id || body.creator || '') : '';
  const id = String(h || b || '').slice(0, 200);
  if (!id) return null;
  return { id, email: id.includes('@') ? id : '', username: '', verified: false };
}
export function bearerFrom(request: Request): string {
  const a = request.headers.get('Authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}
// --- Sanitization + rate limiting (mirrors Pages Functions) ---
const MAX_STRING_LEN = 5000;
const MAX_ARRAY_LEN = 30;
function sanitizeValue(v: any, depth: number): any {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, MAX_STRING_LEN);
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY_LEN).map((x) => sanitizeValue(x, depth + 1));
  if (typeof v === 'object' && depth < 6) {
    const out: any = {};
    for (const k of Object.keys(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = sanitizeValue(v[k], depth + 1);
    }
    return out;
  }
  return null;
}
export function sanitizeBody(body: any): any {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request body');
  return sanitizeValue(body, 0) || {};
}
const BASE_LIMITS: Record<string, number> = { posts: 10, thoughts: 20, stories: 10, moments: 10, profile: 5, upload: 5, index: 20, delete: 30, engagement: 60, suggest: 60 };
export function rateLimitFor(planId: string, kind: string): number {
  const base = BASE_LIMITS[kind] || 20;
  if (planId === 'eq_creator_pro' || planId === 'eq_business') return base * 4;
  if (planId === 'eq_creator' || planId === 'eq_premium') return base * 2;
  return base;
}
export async function rateLimit(env: Env, kind: string, actorId: string, limit: number): Promise<{ ok: boolean }> {
  if (!actorId) return { ok: true };
  const bucket = Math.floor(Date.now() / 60000);
  const key = KEYS.RATE(kind, actorId, bucket);
  const raw = await env.EQUYVO_KV.get(key);
  const count = raw ? (parseInt(raw, 10) || 0) : 0;
  if (count >= limit) return { ok: false };
  await env.EQUYVO_KV.put(key, String(count + 1), { expirationTtl: 150 });
  return { ok: true };
}
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function cloudinaryVariants(secureUrl: string, resourceType: string, quality: string) {
  if (!secureUrl || !secureUrl.includes('res.cloudinary.com/')) return null;
  const q = quality === 'original' ? '' : quality === 'auto-low' ? 'q_auto:low,f_auto/' : 'q_auto,f_auto/';
  try {
    if (resourceType === 'video') {
      return {
        thumbnail: secureUrl.replace('/video/upload/', `/video/upload/w_400,${q}so_0/`).replace(/\.[^.]+$/, '.jpg'),
        sd: secureUrl.replace('/video/upload/', `/video/upload/w_640,c_limit,${q}/`),
        hd: secureUrl.replace('/video/upload/', `/video/upload/w_1280,c_limit,${q}/`),
      };
    }
    const thumb = secureUrl.replace('/image/upload/', `/image/upload/w_400,c_limit,${q}/`);
    const optimized = secureUrl.replace('/image/upload/', `/image/upload/w_1080,c_limit,${q}/`);
    return { thumbnail: thumb, optimized, sd: optimized, hd: secureUrl };
  } catch { return null; }
}

// --- ID Generation ---
export async function getNextId(env: Env): Promise<string> {
  const val = await env.EQUYVO_KV.get(KEYS.NEXT_ID);
  const next = val ? parseInt(val, 10) + 1 : 1;
  await env.EQUYVO_KV.put(KEYS.NEXT_ID, next.toString());
  return next.toString();
}

// --- Posts ---
export interface Post {
  id: string;
  userId: string;
  user: string;
  avatar?: string;
  time: string;
  content: string;
  image?: string;
  media?: string;
  videoUrl?: string;
  thumbnail?: string;
  likes: number;
  reacts: number;
  comments: number;
  shares: number;
  type: 'post' | 'thought' | 'moment' | 'video' | 'story';
  tags?: string[];
  categories?: string[];
  createdAt: string;
  isSeed?: boolean;
  upvotes_count?: number;
  downvotes_count?: number;
  user_vote?: 'upvote' | 'downvote' | null;
}

async function hasRealUsers(env: Env): Promise<boolean> {
  const val = await env.EQUYVO_KV.get(KEYS.HAS_REAL_USERS);
  return val === 'true';
}

export async function markHasRealUsers(env: Env): Promise<void> {
  await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
}

function computeRelativeTime(createdAt: string | undefined): string {
  if (!createdAt) return 'just now';
  const diffMs = Date.now() - new Date(createdAt).getTime();
  if (diffMs < 0) return 'just now';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 30) return `${Math.floor(day / 7)}w ago`;
  if (day < 365) return `${Math.floor(day / 30)}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function transformItem<T extends Record<string, any>>(item: T): T {
  if (!item) return item;
  if (item.createdAt) {
    (item as any).time = computeRelativeTime(item.createdAt);
  }
  if (item.created_at) {
    (item as any).time = computeRelativeTime(item.created_at);
  }
  return item;
}

const TEST_TEXT_PATTERNS = [/@test\.com$/i, /^pwsrc_/i];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;

function isSeedItem(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  if (item.isSeed) return true;
  if (item.id && typeof item.id === 'string' && item.id.startsWith('seed-')) return true;
  // Any item backed by real uploaded media is real user content — never seed.
  const refs = [
    item.thumbnail,
    item.image,
    item.imageUrl,
    item.media,
    item.videoUrl,
    item.src,
    ...(Array.isArray(item.media) ? item.media.map((m: any) => m && m.url).filter(Boolean) : []),
  ].filter(Boolean);
  if (refs.some((r: any) => String(r).includes('res.cloudinary.com/'))) return false;
  if (refs.some((r: any) =>
    String(r).includes('gtv-videos-bucket/sample/') ||
    String(r).includes('picsum.photos/seed/')
  )) return true;
  // Automated test/bot content: only the author email and the Playwright id
  // prefix are reliable signals. Deliberately NOT matching content/id/user so a
  // real post whose text starts with "Test " or similar is never dropped.
  const authorSignals = [
    item.email,
    item.userId,
    item.user_id,
    item.creator,
    item.username,
    item.handle,
  ].filter((t: any) => typeof t === 'string');
  if (authorSignals.some((t: string) => TEST_TEXT_PATTERNS.some((re) => re.test(t)))) return true;
  if (typeof item.publishedAt === 'string' && !ISO_DATE_RE.test(item.publishedAt)) return true;
  return false;
}

export const SEED_PROFILE_IDS = new Set(['user1', 'user2']);
export const SEED_PURGED_KEY = 'seed_purged';

export async function purgeSeedData(env: Env): Promise<void> {
  const kv = env.EQUYVO_KV;
  // Fast path: single KV read. The old code ran a full multi-list scan on
  // EVERY request (hundreds of KV reads) which made every feed/search slow.
  // Now the scan runs at most once ever (flag) and callers should fire it
  // via waitUntil so it never blocks the response.
  let flag: string | null = null;
  try {
    flag = await kv.get(SEED_PURGED_KEY);
  } catch { return; }
  if (flag) return;

  const removedUserIds = new Set<string>();

  const removeFromList = async (listKey: string, getKey: (id: string) => string) => {
    const listJson = await kv.get(listKey);
    if (!listJson) return;
    const ids: string[] = JSON.parse(listJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const raw = await kv.get(getKey(id));
      let item: any = null;
      if (raw) {
        try { item = JSON.parse(raw); } catch { /* keep */ }
      }
      if (raw && isSeedItem(item)) {
        for (const uid of [item.userId, item.user_id, item.creator, item.user]) {
          if (typeof uid === 'string' && uid) removedUserIds.add(uid);
        }
        await kv.delete(getKey(id));
      } else {
        remaining.push(id);
      }
    }
    if (remaining.length !== ids.length) {
      await kv.put(listKey, JSON.stringify(remaining));
    }
  };

  await removeFromList(KEYS.POSTS, KEYS.POST);
  await removeFromList(KEYS.THOUGHTS, KEYS.THOUGHT);
  await removeFromList(KEYS.STORIES, KEYS.STORY);
  await removeFromList(KEYS.MOMENTS, KEYS.MOMENT);

  const indexJson = await kv.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => !isSeedItem(i))));
  }

  for (const pid of SEED_PROFILE_IDS) {
    await kv.delete(KEYS.PROFILE(pid));
  }
  for (const uid of removedUserIds) {
    await kv.delete(KEYS.PROFILE(uid));
  }

  await kv.put(SEED_PURGED_KEY, 'true');
}

function filterSeed<T>(items: T[], hasReal: boolean): T[] {
  if (hasReal) return items.filter(i => !isSeedItem(i));
  return items;
}

async function cleanOrphans(env: Env, listKey: string, getKey: (id: string) => string): Promise<string[]> {
  // Lag fix: the old code validated the ENTIRE list (up to 500 ids) with
  // sequential KV reads on every feed/search request → multi-second latency.
  // New behavior: validate only what we need for this page (first 120 ids)
  // inline, and run the full sweep in the background at most every 5 min.
  const listJson = await env.EQUYVO_KV.get(listKey);
  if (!listJson) return [];
  let ids: string[];
  try {
    ids = JSON.parse(listJson);
  } catch { return []; }
  if (!Array.isArray(ids)) return [];
  const HEAD = 120;
  const head = ids.slice(0, HEAD);
  const results = await Promise.all(
    head.map(async (id) => {
      try {
        const data = await env.EQUYVO_KV.get(getKey(id));
        return data ? id : null;
      } catch { return id; }
    })
  );
  const validHead = results.filter(Boolean) as string[];
  const tail = ids.slice(HEAD);
  const needsHeadFix = validHead.length !== head.length;
  if (needsHeadFix) {
    const fixed = [...validHead, ...tail];
    try {
      await env.EQUYVO_KV.put(listKey, JSON.stringify(fixed));
    } catch { /* ignore */ }
    return fixed;
  }
  // Background full sweep (throttled): repairs tail orphans without blocking.
  try {
    const last = await env.EQUYVO_KV.get(KEYS.ORPHAN_SWEEP_AT);
    const now = Date.now();
    if (!last || now - Number(last || 0) > 5 * 60 * 1000) {
      const sweep = (async () => {
        try {
          await env.EQUYVO_KV.put(KEYS.ORPHAN_SWEEP_AT, String(now));
          const full = await env.EQUYVO_KV.get(listKey);
          if (!full) return;
          const all: string[] = JSON.parse(full);
          const batch = 25;
          const valid: string[] = [];
          for (let i = 0; i < all.length; i += batch) {
            const slice = all.slice(i, i + batch);
            const got = await Promise.all(
              slice.map(async (id) => {
                try {
                  const d = await env.EQUYVO_KV.get(getKey(id));
                  return d ? id : null;
                } catch { return id; }
              })
            );
            for (const v of got) if (v) valid.push(v);
          }
          if (valid.length !== all.length) {
            await env.EQUYVO_KV.put(listKey, JSON.stringify(valid));
          }
        } catch { /* best-effort */ }
      })();
      // If a waitUntil-style hook is available the caller handles it; here we
      // just float the promise (KV is fast enough in batches).
      void sweep;
    }
  } catch { /* ignore */ }
  return ids;
}

async function sha1Hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function deriveResourceType(parsed: any): string {
  if (parsed?.resourceType) return parsed.resourceType;
  if (parsed?.mediaType === 'video' || parsed?.type === 'video') return 'video';
  if (parsed?.videoUrl && typeof parsed.videoUrl === 'string' && parsed.videoUrl.startsWith('http')) return 'video';
  return 'image';
}

async function deleteCloudinaryMedia(env: Env, parsed: any): Promise<{ skipped: boolean; reason?: string }> {
  try {
    const publicId = parsed?.publicId || parsed?.cloudinaryPublicId || '';
    if (!publicId) return { skipped: true, reason: 'no-public-id' };
    const cloudName = env.CLOUDINARY_CLOUD_NAME;
    const apiKey = env.CLOUDINARY_API_KEY;
    const apiSecret = env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) return { skipped: true, reason: 'not-configured' };
    const resourceType = deriveResourceType(parsed);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params = { public_id: publicId, timestamp };
    const paramStr = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const signature = await sha1Hex(paramStr + apiSecret);
    const body = new URLSearchParams({ ...params, api_key: apiKey, signature });
    const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`, {
      method: 'POST',
      body,
    });
    await resp.json();
    return { skipped: false };
  } catch (err) {
    return { skipped: true, reason: 'error' };
  }
}

// --- R2 media warehouse (zero egress): primary store for originals ---
export function r2KeyFor(actorId: string, hash: string, ext: string): string {
  const safe = String(actorId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'anon';
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const e = String(ext || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
  return `u/${safe}/${ym}/${String(hash).slice(0, 32)}.${e}`;
}

export function extFromFile(file: any): string {
  const name = String(file?.name || '');
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const e = name.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    if (e) return e.toLowerCase();
  }
  const mime = String(file?.type || '');
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/quicktime') return 'mov';
  return 'bin';
}

export function r2DeliveryUrl(request: Request, env: Env, key: string): string {
  const base = String(env.R2_PUBLIC_BASE || '').replace(/\/$/, '');
  if (base) return `${base}/${key}`;
  return `${new URL(request.url).origin}/api/media/${key}`;
}

export function validMediaKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 300) return false;
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key);
}

export async function resolveStoredMedia(env: Env, parsed: any): Promise<{ r2Key: string; bytes: number; publicId: string }> {
  let r2Key = (parsed && (parsed.r2Key || parsed.r2_key)) || '';
  let bytes = Number((parsed && (parsed.bytes || parsed.mediaBytes)) || 0) || 0;
  const publicId = (parsed && (parsed.publicId || parsed.cloudinaryPublicId)) || '';
  if ((!r2Key || !bytes) && publicId) {
    try {
      const raw = await env.EQUYVO_KV.get(KEYS.MEDIA(publicId));
      if (raw) {
        const idx = JSON.parse(raw);
        r2Key = r2Key || idx.r2Key || '';
        bytes = bytes || Number(idx.bytes || 0) || 0;
      }
    } catch { /* best-effort */ }
  }
  return { r2Key, bytes, publicId };
}
export async function purgeStoredMedia(env: Env, parsed: any): Promise<void> {
  const { r2Key, publicId } = await resolveStoredMedia(env, parsed);
  await deleteCloudinaryMedia(env, parsed);
  try {
    if (env.EQUYVO_R2 && r2Key) await env.EQUYVO_R2.delete(r2Key);
  } catch { /* ignore */ }
  try {
    if (publicId) await env.EQUYVO_KV.delete(KEYS.MEDIA(publicId));
  } catch { /* ignore */ }
}

// Refund a deleted item's bytes against its owner's quota.
export async function refundStoredMedia(env: Env, ownerId: string, parsed: any): Promise<void> {
  if (!ownerId) return;
  try {
    const { bytes } = await resolveStoredMedia(env, parsed);
    if (bytes > 0) await subtractUsage(env, ownerId, bytes);
  } catch { /* ignore */ }
}

export async function getPosts(env: Env, limit = 50): Promise<Post[]> {
  const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
  const recent = ids.slice(0, limit);
  const posts = (await Promise.all(
    recent.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.POST(id));
      return json ? transformItem(JSON.parse(json) as Post) : null;
    })
  )).filter(Boolean) as Post[];
  const hasReal = await hasRealUsers(env);
  return filterSeed(posts, hasReal);
}

export async function getUserPosts(env: Env, userId: string): Promise<Post[]> {
  const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
  const posts = (await Promise.all(
    ids.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.POST(id));
      return json ? transformItem(JSON.parse(json) as Post) : null;
    })
  )).filter(Boolean) as Post[];
  const hasReal = await hasRealUsers(env);
  return filterSeed(posts.filter(p => p.userId === userId || (p as any).user_id === userId), hasReal);
}

export async function createPost(env: Env, post: Omit<Post, 'id' | 'time' | 'createdAt'>): Promise<Post> {
  const id = (post as any).id || await getNextId(env);
  const now = new Date().toISOString();
  const newPost: Post = {
    ...post,
    id,
    time: computeRelativeTime(now),
    createdAt: now,
  };
  await env.EQUYVO_KV.put(KEYS.POST(id), JSON.stringify(newPost));
  
  // Prepend to list
  const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);
  
  // Also index in search
  await indexContent(env, {
    id,
    title: post.content.slice(0, 100),
    description: post.content,
    type: post.type || 'post',
    creator: post.user,
    creatorAvatar: post.avatar || '',
    views: '0',
    thumbnail: post.image || post.media || '',
    imageUrl: post.image || post.media,
    videoUrl: post.videoUrl,
    category: (post.categories && post.categories[0]) || 'General',
    tags: post.tags || [],
    publishedAt: now,
    content: post.content,
    likes: 0,
    comments: 0,
  });
  
  try { void fanOutUpload(env, String((newPost as any).userId || ''), String((newPost as any).user || ''), String((newPost as any).content || '').slice(0, 120)); } catch { /* ignore */ }
  return newPost;
}

// --- Thoughts ---
export interface Thought {
  id: string;
  user_id: string;
  content: string;
  platform: string;
  tags: string[];
  comments_count: number;
  shares_count: number;
  retweets_count: number;
  media?: { type: string; url: string; thumbnail?: string; duration?: number }[];
  likes_count: number;
  created_at: string;
  updated_at: string;
  user_vote?: 'upvote' | 'downvote' | null;
  user_has_liked?: boolean;
  isSeed?: boolean;
}

export async function getThoughts(env: Env, limit = 20, offset = 0): Promise<Thought[]> {
  const ids = await cleanOrphans(env, KEYS.THOUGHTS, KEYS.THOUGHT);
  const page = ids.slice(offset, offset + limit);
  const thoughts = (await Promise.all(
    page.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
      return json ? transformItem(JSON.parse(json) as Thought) : null;
    })
  )).filter(Boolean) as Thought[];
  const hasReal = await hasRealUsers(env);
  return filterSeed(thoughts, hasReal);
}

export async function createThought(env: Env, thought: Omit<Thought, 'id' | 'created_at' | 'updated_at'>): Promise<Thought> {
  const id = (thought as any).id || await getNextId(env);
  const now = new Date().toISOString();
  const newThought: Thought = {
    ...thought,
    id,
    created_at: now,
    updated_at: now,
  };
  await env.EQUYVO_KV.put(KEYS.THOUGHT(id), JSON.stringify(newThought));

  const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);

  // Index thoughts so search + AI feed see them (posts-only index was a gap).
  try {
    const text = String((newThought as any).content || '').slice(0, 500);
    await indexContent(env, {
      id,
      title: text.slice(0, 100) || 'Thought',
      description: text.slice(0, 300),
      type: 'thought',
      creator: String((newThought as any).user_id || (newThought as any).userId || ''),
      creatorAvatar: '',
      views: '0',
      thumbnail: String((newThought as any).media?.[0]?.url || ''),
      category: String(((newThought as any).tags && (newThought as any).tags[0]) || 'General'),
      tags: Array.isArray((newThought as any).tags) ? (newThought as any).tags.slice(0, 10) : [],
      publishedAt: now,
      content: text,
      likes: Number((newThought as any).likes_count || 0),
      comments: Number((newThought as any).comments_count || 0),
    });
  } catch { /* best-effort */ }

  try { void fanOutUpload(env, String((newThought as any).user_id || ''), String((newThought as any).user_id || ''), String((newThought as any).content || '').slice(0, 120)); } catch { /* ignore */ }
  return newThought;
}

// --- Stories ---
export interface Story {
  id: string;
  user: string;
  avatar?: string;
  image: string;
  video?: string;
  type: 'image' | 'video';
  time?: string;
  userId?: string;
  createdAt?: string;
  isSeed?: boolean;
}

export async function getStories(env: Env, limit = 20): Promise<Story[]> {
  const ids = await cleanOrphans(env, KEYS.STORIES, KEYS.STORY);
  const recent = ids.slice(0, limit);
  const stories = (await Promise.all(
    recent.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.STORY(id));
      return json ? transformItem(JSON.parse(json) as Story) : null;
    })
  )).filter(Boolean) as Story[];
  const hasReal = await hasRealUsers(env);
  return filterSeed(stories, hasReal);
}

export async function createStory(env: Env, story: Omit<Story, 'id'>): Promise<Story> {
  const id = (story as any).id || await getNextId(env);
  const now = new Date().toISOString();
  const newStory: Story = {
    ...story,
    id,
    createdAt: now,
  };
  await env.EQUYVO_KV.put(KEYS.STORY(id), JSON.stringify(newStory));

  const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.slice(0, 200)));
  await markHasRealUsers(env);

  try {
    await indexContent(env, {
      id,
      title: `Story by ${String((newStory as any).user || 'creator').slice(0, 60)}`,
      description: '',
      type: 'story',
      creator: String((newStory as any).user || (newStory as any).userId || ''),
      creatorAvatar: String((newStory as any).avatar || ''),
      views: '0',
      thumbnail: String((newStory as any).image || ''),
      category: 'Stories',
      tags: [],
      publishedAt: now,
      content: '',
      likes: 0,
      comments: 0,
    });
  } catch { /* best-effort */ }

  try { void fanOutUpload(env, String((newStory as any).userId || (newStory as any).user || ''), String((newStory as any).user || ''), 'New story'); } catch { /* ignore */ }
  return newStory;
}

// --- Moments ---
export interface Moment {
  id: string;
  user: string;
  content: string;
  media: string;
  thumbnail?: string;
  mediaType: 'video' | 'image';
  videoUrl?: string;
  likes: number;
  comments: number;
  views: number;
  time?: string;
  userId?: string;
  createdAt?: string;
  isSeed?: boolean;
}

export async function getMoments(env: Env, limit = 20): Promise<Moment[]> {
  const ids = await cleanOrphans(env, KEYS.MOMENTS, KEYS.MOMENT);
  const recent = ids.slice(0, limit);
  const moments = (await Promise.all(
    recent.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.MOMENT(id));
      return json ? transformItem(JSON.parse(json) as Moment) : null;
    })
  )).filter(Boolean) as Moment[];
  const hasReal = await hasRealUsers(env);
  return filterSeed(moments, hasReal);
}

export async function createMoment(env: Env, moment: Omit<Moment, 'id'>): Promise<Moment> {
  const id = (moment as any).id || await getNextId(env);
  const now = new Date().toISOString();
  const newMoment: Moment = {
    ...moment,
    id,
    createdAt: now,
  };
  await env.EQUYVO_KV.put(KEYS.MOMENT(id), JSON.stringify(newMoment));

  const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);

  try {
    const text = String((newMoment as any).content || '').slice(0, 500);
    await indexContent(env, {
      id,
      title: text.slice(0, 100) || 'Moment',
      description: text.slice(0, 300),
      type: String((newMoment as any).mediaType || 'video'),
      creator: String((newMoment as any).user || (newMoment as any).userId || ''),
      creatorAvatar: '',
      views: String((newMoment as any).views ?? '0'),
      thumbnail: String((newMoment as any).thumbnail || (newMoment as any).media || ''),
      videoUrl: String((newMoment as any).videoUrl || ''),
      category: 'Moments',
      tags: [],
      publishedAt: now,
      content: text,
      likes: Number((newMoment as any).likes || 0),
      comments: Number((newMoment as any).comments || 0),
    });
  } catch { /* best-effort */ }

  try { void fanOutUpload(env, String((newMoment as any).userId || ''), String((newMoment as any).user || ''), String((newMoment as any).content || '').slice(0, 120) || 'New moment'); } catch { /* ignore */ }
  return newMoment;
}

// --- Profiles ---
export interface UserProfile {
  id: string;
  name: string;
  username: string;
  avatar: string;
  bio: string;
  followers: number;
  following: number;
  email?: string;
  _userEmail?: string;
}

export async function getProfile(env: Env, userId: string): Promise<UserProfile | null> {
  const json = await env.EQUYVO_KV.get(KEYS.PROFILE(userId));
  return json ? JSON.parse(json) : null;
}

// --- Display-name change quota (mirrors Pages Functions) ---
// Free accounts get 2 display-name changes; each verified paid purchase
// grants +2 more. Avatars, bios and usernames stay unlimited. Enforcement
// lives here so no client can bypass it.
export const NAME_CHANGE_BASE_QUOTA = 2;
export const NAME_CHANGE_GRANT_PER_PURCHASE = 2;
const NAME_PAID_PLAN_IDS = new Set([
  'eq_plus', 'eq_premium', 'eq_creator', 'eq_creator_pro', 'eq_business',
]);

export interface NameQuotaState {
  used: number;
  quota: number;
  remaining: number;
  grants: string[];
  bonusPlans: string[];
}

export function nameQuotaState(profile: any): NameQuotaState {
  const p = profile && typeof profile === 'object' ? profile : {};
  const usedRaw = Number(p.nameChangesUsed);
  const used = Number.isFinite(usedRaw) && usedRaw > 0 ? Math.floor(usedRaw) : 0;
  const quotaRaw = Number(p.nameChangeQuota);
  const quota = Number.isFinite(quotaRaw) && quotaRaw > 0 ? Math.floor(quotaRaw) : NAME_CHANGE_BASE_QUOTA;
  const grants = Array.isArray(p.nameGrantPayments)
    ? (p.nameGrantPayments as unknown[]).filter((x): x is string => typeof x === 'string').slice(-50)
    : [];
  const bonusPlans = Array.isArray(p.nameBonusPlans)
    ? (p.nameBonusPlans as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { used, quota, remaining: Math.max(0, quota - used), grants, bonusPlans };
}

/**
 * Merge a client profile update into the stored profile, enforcing the
 * display-name quota. Only an actual change of `name` consumes quota (first
 * set on a fresh profile is free); avatar/bio/username are unlimited.
 * Returns `{ profile }` on success or `{ quotaError }` when exhausted
 * (caller must answer 402 without saving).
 */
export function prepareProfileUpdate(
  prev: any,
  clean: Record<string, any>,
  livePlanId?: string,
): { profile: UserProfile; quotaError?: { used: number; quota: number } } {
  const base = prev && typeof prev === 'object' ? prev : {};
  const st = nameQuotaState(base);
  let used = st.used;
  let quota = st.quota;
  const bonusPlans = [...st.bonusPlans];
  const prevName = typeof base.name === 'string' ? base.name : '';
  const nextName = typeof clean.name === 'string' ? clean.name : prevName;
  const nameChanged = prevName ? nextName.trim() !== prevName.trim() : false;
  if (nameChanged) {
    if (livePlanId && NAME_PAID_PLAN_IDS.has(livePlanId) && !bonusPlans.includes(livePlanId)) {
      quota += NAME_CHANGE_GRANT_PER_PURCHASE;
      bonusPlans.push(livePlanId);
    }
    if (used >= quota) return { profile: base as UserProfile, quotaError: { used, quota } };
    used += 1;
  }
  return {
    profile: {
      ...(base as object),
      ...clean,
      nameChangesUsed: used,
      nameChangeQuota: quota,
      nameGrantPayments: st.grants,
      nameBonusPlans: bonusPlans,
    } as unknown as UserProfile,
  };
}

export async function upsertProfile(env: Env, profile: UserProfile): Promise<UserProfile> {
  await env.EQUYVO_KV.put(KEYS.PROFILE(profile.id), JSON.stringify(profile));
  return profile;
}

// --- Search Index ---
export interface ContentIndexItem {
  id: string;
  title: string;
  description: string;
  type: string;
  creator: string;
  creatorAvatar: string;
  views: string;
  thumbnail: string;
  imageUrl?: string;
  videoUrl?: string;
  category: string;
  tags: string[];
  duration?: string;
  publishedAt: string;
  content?: string;
  likes?: number;
  comments?: number;
  isSeed?: boolean;
}

export async function indexContent(env: Env, item: ContentIndexItem): Promise<void> {
  const json = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  const index: ContentIndexItem[] = json ? JSON.parse(json) : [];
  // Replace if exists, else add
  const existingIdx = index.findIndex(i => i.id === item.id);
  if (existingIdx >= 0) {
    index[existingIdx] = item;
  } else {
    index.unshift(item);
  }
  // Keep max 1000 items
  await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.slice(0, 1000)));
}

// ── Backend AI: interest graph + smart search/feed (no frontend changes) ──
// Interests are a counted map {token -> weight} persisted per user in KV.
// Tokens come from engagement (views/likes/comments/shares/saves), explicit
// ?interests= params, and profile categories. Search + feed boost items whose
// category/tags/creator match the user's top interests.

export type InterestMap = Record<string, number>;

const SYNONYMS: Record<string, string[]> = {
  photo: ['photography', 'camera', 'picture', 'pics'],
  photography: ['photo', 'camera', 'picture'],
  video: ['film', 'vlog', 'reels', 'clips'],
  music: ['song', 'songs', 'beat', 'audio', 'singer'],
  food: ['recipe', 'recipes', 'cooking', 'cuisine', 'restaurant'],
  fitness: ['workout', 'gym', 'yoga', 'health', 'exercise'],
  travel: ['trip', 'vacation', 'tourism', 'vlog'],
  tech: ['technology', 'gadgets', 'ai', 'software', 'coding'],
  ai: ['artificial intelligence', 'machine learning', 'tech'],
  fashion: ['style', 'outfit', 'clothing', 'trend'],
  art: ['drawing', 'design', 'painting', 'illustration'],
  game: ['gaming', 'games', 'esports', 'play'],
};

function normToken(s: string): string {
  return String(s || '').toLowerCase().trim().replace(/^#+/, '').slice(0, 40);
}

function tokenize(s: string): string[] {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9#\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^#+/, '').trim())
    .filter((t) => t.length >= 2 && t.length <= 30)
    .slice(0, 20);
}

function expandQueryTokens(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    const syns = SYNONYMS[t];
    if (syns) for (const s of syns.slice(0, 3)) out.add(s);
    // prefix token for partial matches ("phot" → "photo")
    if (t.length >= 4) out.add(t.slice(0, Math.max(3, t.length - 1)));
  }
  return [...out].slice(0, 30);
}

function editDist1(a: string, b: string): boolean {
  // cheap fuzzy: equal, prefix, or single-edit distance for short tokens
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let diff = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      diff++;
      if (diff > 1) return false;
    }
  }
  return diff <= 1;
}

export async function getInterests(env: Env, userId: string): Promise<InterestMap> {
  if (!userId) return {};
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.INTERESTS(userId));
    if (!raw) return {};
    const m = JSON.parse(raw);
    return m && typeof m === 'object' ? (m as InterestMap) : {};
  } catch { return {}; }
}

export async function recordEngagement(
  env: Env,
  userId: string,
  signals: { category?: string; tags?: string[]; creator?: string; action?: string }
): Promise<InterestMap> {
  if (!userId) return {};
  const actionW: Record<string, number> = { view: 1, like: 3, unlike: -2, comment: 4, share: 5, save: 4, create: 5, vote: 2 };
  const w = actionW[String(signals.action || 'view').toLowerCase()] ?? 1;
  const tokens: string[] = [];
  if (signals.category) tokens.push(normToken(signals.category));
  if (signals.creator) tokens.push(normToken(signals.creator));
  for (const t of signals.tags || []) {
    const n = normToken(t);
    if (n) tokens.push(n);
  }
  if (!tokens.length) return getInterests(env, userId);
  let cur: InterestMap = {};
  try {
    cur = await getInterests(env, userId);
    for (const t of tokens.slice(0, 8)) {
      cur[t] = Math.max(-10, Math.min(100, (Number(cur[t] || 0) + w)));
    }
    // cap map size: keep top 60
    const entries = Object.entries(cur).sort((a, b) => b[1] - a[1]).slice(0, 60);
    cur = Object.fromEntries(entries);
    await env.EQUYVO_KV.put(KEYS.INTERESTS(userId), JSON.stringify(cur));
  } catch { /* best-effort */ }
  return cur;
}

export async function bumpPopularity(env: Env, itemId: string, delta = 1): Promise<void> {
  if (!itemId) return;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.POP(itemId));
    const cur = raw ? parseInt(raw, 10) || 0 : 0;
    await env.EQUYVO_KV.put(KEYS.POP(itemId), String(Math.max(0, cur + delta)), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch { /* ignore */ }
}

async function popMap(env: Env, ids: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    ids.slice(0, 100).map(async (id) => {
      try {
        const raw = await env.EQUYVO_KV.get(KEYS.POP(id));
        if (raw) out[id] = parseInt(raw, 10) || 0;
      } catch { /* ignore */ }
    })
  );
  return out;
}

function popularityOf(item: any, pops: Record<string, number>): number {
  const kv = Number(pops[item?.id] || 0);
  const likes = Number(item?.likes ?? item?.likes_count ?? 0) || 0;
  const comments = Number(item?.comments ?? item?.comments_count ?? 0) || 0;
  const reacts = Number(item?.reacts ?? 0) || 0;
  const views = Number(String(item?.views ?? '0').replace(/[^0-9]/g, '') || 0) || 0;
  return kv * 2 + likes + reacts * 2 + comments * 3 + Math.min(50, views / 20);
}

function recencyBoost(publishedAt?: string): number {
  if (!publishedAt) return 0;
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const hours = (Date.now() - t) / 3600000;
  if (hours < 0) return 8;
  if (hours < 6) return 8;
  if (hours < 24) return 5;
  if (hours < 72) return 3;
  if (hours < 168) return 1;
  return 0;
}

function interestBoost(item: any, interests: InterestMap): number {
  if (!interests || Object.keys(interests).length === 0) return 0;
  const top = Object.entries(interests)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k]) => k);
  if (!top.length) return 0;
  const hay = [
    String(item?.category || ''),
    ...((item?.tags as string[]) || []),
    String(item?.creator || item?.user || ''),
    String(item?.title || '').split(/\s+/).slice(0, 6).join(' '),
  ].join(' ').toLowerCase();
  let s = 0;
  for (const t of top) {
    if (t && hay.includes(t)) s += 6;
  }
  return Math.min(30, s);
}

export async function ensureContentIndex(env: Env): Promise<ContentIndexItem[]> {
  // Backfill: old deployments only indexed posts. Thoughts/stories/moments
  // were invisible to search. If the index is missing/small, rebuild from
  // the source lists (bounded: newest 200 of each) without blocking writes.
  let index: ContentIndexItem[] = [];
  try {
    const json = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
    if (json) {
      try { index = JSON.parse(json) || []; } catch { index = []; }
    }
  } catch { index = []; }
  if (index.length >= 20) return index;
  try {
    const getList = async (k: string) => {
      try {
        const j = await env.EQUYVO_KV.get(k);
        return j ? (JSON.parse(j) as string[]).slice(0, 200) : [];
      } catch { return []; }
    };
    const [postIds, thoughtIds, momentIds, storyIds] = await Promise.all([
      getList(KEYS.POSTS), getList(KEYS.THOUGHTS), getList(KEYS.MOMENTS), getList(KEYS.STORIES),
    ]);
    const byId = new Map<string, ContentIndexItem>();
    for (const it of index) if (it && it.id) byId.set(it.id, it);
    const pull = async (ids: string[], get: (id: string) => string, kind: string) => {
      const batch = 20;
      for (let i = 0; i < ids.length; i += batch) {
        const slice = ids.slice(i, i + batch);
        const rows = await Promise.all(
          slice.map(async (id) => {
            try {
              const raw = await env.EQUYVO_KV.get(get(id));
              return raw ? { id, raw } : null;
            } catch { return null; }
          })
        );
        for (const r of rows) {
          if (!r || byId.has(r.id)) continue;
          try {
            const o = JSON.parse(r.raw);
            if (isSeedItem(o)) continue;
            const text = String(o.content || o.title || o.description || '').slice(0, 500);
            byId.set(r.id, {
              id: r.id,
              title: String(o.title || text.slice(0, 100) || kind),
              description: text.slice(0, 300),
              type: kind,
              creator: String(o.user || o.creator || o.user_id || o.userId || ''),
              creatorAvatar: String(o.avatar || ''),
              views: String(o.views ?? '0'),
              thumbnail: String(o.thumbnail || o.image || o.media || ''),
              category: String((o.categories && o.categories[0]) || o.category || 'General'),
              tags: Array.isArray(o.tags) ? o.tags.slice(0, 10) : [],
              publishedAt: String(o.createdAt || o.created_at || new Date().toISOString()),
              content: text,
              likes: Number(o.likes ?? o.likes_count ?? 0) || 0,
              comments: Number(o.comments ?? o.comments_count ?? 0) || 0,
            });
          } catch { /* skip */ }
        }
        if (byId.size >= 400) break;
      }
    };
    await pull(postIds, KEYS.POST, 'post');
    await pull(thoughtIds, KEYS.THOUGHT, 'thought');
    await pull(momentIds, KEYS.MOMENT, 'moment');
    await pull(storyIds, KEYS.STORY, 'story');
    index = [...byId.values()].slice(0, 1000);
    if (index.length) {
      try { await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return index;
}

export async function searchContent(
  env: Env,
  query: string,
  opts: { interests?: InterestMap; limit?: number } = {}
): Promise<{ results: ContentIndexItem[]; totalCount: number; personalized: boolean }> {
  const limit = Math.min(50, Math.max(1, opts.limit || 20));
  const index = await ensureContentIndex(env);
  if (!index.length) return { results: [], totalCount: 0, personalized: false };
  const interests = opts.interests || {};

  if (!query.trim()) {
    // Empty query = personalized popular feed, not raw index order.
    const pops = await popMap(env, index.map((i) => i.id));
    const ranked = [...index]
      .map((item) => ({
        item,
        score: popularityOf(item, pops) + recencyBoost(item.publishedAt) * 2 + interestBoost(item, interests),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.item);
    return { results: ranked, totalCount: index.length, personalized: Object.keys(interests).length > 0 };
  }

  const tokens = tokenize(query);
  const expanded = expandQueryTokens(tokens);
  const q = query.toLowerCase().trim();
  const pops = await popMap(env, index.map((i) => i.id));
  const scored = index.map((item) => {
    let score = 0;
    const title = String(item.title || '').toLowerCase();
    const desc = String(item.description || '').toLowerCase();
    const content = String(item.content || '').toLowerCase();
    const cat = String(item.category || '').toLowerCase();
    const creator = String(item.creator || '').toLowerCase();
    const tags = (item.tags || []).map((t) => String(t).toLowerCase());
    const hayTokens = tokenize(`${item.title} ${item.description} ${item.content} ${item.category} ${item.creator} ${(item.tags || []).join(' ')}`);

    if (`${title} ${desc} ${content} ${cat} ${creator} ${tags.join(' ')}`.includes(q)) score += 100;
    if (title.includes(q)) score += 50;
    if (cat === q) score += 45;
    else if (cat.includes(q)) score += 30;
    if (creator.includes(q)) score += 25;
    if (desc.includes(q)) score += 20;
    if (content.includes(q)) score += 15;
    for (const t of tags) if (t.includes(q) || q.includes(t)) score += 20;

    // Token-level (multi-word queries, typos, synonyms)
    let tokHits = 0;
    for (const tok of expanded) {
      let hit = false;
      if (title.includes(tok)) { score += 12; hit = true; }
      else if (cat.includes(tok)) { score += 10; hit = true; }
      else if (tags.some((tg) => tg.includes(tok))) { score += 10; hit = true; }
      else if (desc.includes(tok) || content.includes(tok) || creator.includes(tok)) { score += 6; hit = true; }
      else if (hayTokens.some((h) => editDist1(h, tok))) { score += 5; hit = true; }
      if (hit) tokHits++;
    }
    if (tokens.length > 1 && tokHits >= Math.min(tokens.length, 2)) score += 25;

    // Quality signals: popular + fresh + matches user interests rank higher.
    score += Math.min(20, popularityOf(item, pops) / 5);
    score += recencyBoost(item.publishedAt);
    score += interestBoost(item, interests);
    return { item, score };
  });

  const matching = scored.filter((s) => s.score >= 15).sort((a, b) => b.score - a.score);
  if (!matching.length) {
    // Honest empty: no invented fallback results (the app shows "No results found").
    return { results: [], totalCount: 0, personalized: Object.keys(interests).length > 0 };
  }
  return { results: matching.slice(0, limit).map((s) => s.item), totalCount: matching.length, personalized: Object.keys(interests).length > 0 };
}

export function brainBase(env: Env): string {
  const c = String((env as any).BRAIN_URL || (env as any).BRAIN_BASE_URL || '').trim().replace(/\/$/, '');
  if (c) return c;
  return 'https://brain.acronous.com';
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    } finally {
      clearTimeout(t);
    }
  } catch { return null; }
}

export async function brainSearchSuggest(env: Env, query: string): Promise<string[]> {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  const d = await fetchJson(`${brainBase(env)}/v1/suggest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, source: 'equyvo-search' }),
  }, 2500);
  const s = (d as any)?.suggestions;
  if (Array.isArray(s)) {
    return s.map((x: any) => String(x?.label || x || '').trim()).filter(Boolean).slice(0, 8);
  }
  return [];
}

export async function brainFeedSuggest(env: Env, userId: string, interacted: string[]): Promise<string[]> {
  const d = await fetchJson(`${brainBase(env)}/v1/suggest/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId || 'default', userId: userId || 'default', interacted: (interacted || []).slice(0, 20), source: 'equyvo-feed' }),
  }, 2500);
  const s = (d as any)?.suggestions;
  if (Array.isArray(s)) return s.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 8);
  return [];
}

export function rankFeedItems(items: any[], interests: InterestMap, limit: number): { items: any[]; personalized: boolean } {
  const personalized = Object.keys(interests || {}).length > 0;
  const scored = (items || []).map((it) => {
    const likes = Number(it?.likes ?? it?.likes_count ?? 0) || 0;
    const reacts = Number(it?.reacts ?? 0) || 0;
    const comments = Number(it?.comments ?? it?.comments_count ?? 0) || 0;
    const engagement = (likes + reacts * 2 + comments * 3) / 10;
    const pop = Number((it as any)?.__pop || 0);
    let score = engagement + pop / 5 + recencyBoost(it?.createdAt || it?.created_at || it?.publishedAt) + interestBoost({
      category: it?.category || (it?.categories && it.categories[0]) || '',
      tags: it?.tags || [],
      creator: it?.user || it?.creator || '',
      title: it?.content || it?.title || '',
    }, interests);
    // tiny deterministic jitter-free tiebreak by id hash (no random lag spikes)
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return { items: scored.slice(0, limit).map((s) => s.it), personalized };
}

// --- Likes / Votes (stored in KV as counters + popularity for AI feed) ---
export async function likePost(env: Env, postId: string): Promise<{ liked: boolean; likes_count: number }> {
  const postJson = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (!postJson) throw new Error('Post not found');
  const post = JSON.parse(postJson) as Post;
  post.likes += 1;
  await env.EQUYVO_KV.put(KEYS.POST(postId), JSON.stringify(post));
  // Feed signal: popular items rank higher for everyone (best-effort).
  void bumpPopularity(env, postId, 3);
  return { liked: true, likes_count: post.likes };
}

export async function unlikePost(env: Env, postId: string): Promise<{ liked: boolean; likes_count: number }> {
  const postJson = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (!postJson) throw new Error('Post not found');
  const post = JSON.parse(postJson) as Post;
  post.likes = Math.max(0, post.likes - 1);
  await env.EQUYVO_KV.put(KEYS.POST(postId), JSON.stringify(post));
  void bumpPopularity(env, postId, -2);
  return { liked: false, likes_count: post.likes };
}

export async function voteThought(env: Env, thoughtId: string, voteType: 'upvote' | 'downvote'): Promise<{ success: boolean }> {
  // For now, simple toggle in KV
  const thoughtJson = await env.EQUYVO_KV.get(KEYS.THOUGHT(thoughtId));
  if (!thoughtJson) throw new Error('Thought not found');
  const thought = JSON.parse(thoughtJson) as Thought;
  // Simple vote tracking
  await env.EQUYVO_KV.put(KEYS.THOUGHT(thoughtId), JSON.stringify(thought));
  void bumpPopularity(env, thoughtId, voteType === 'upvote' ? 2 : -1);
  return { success: true };
}

// --- Delete Content ---
export async function deletePost(env: Env, postId: string): Promise<boolean> {
  // Remove media from Cloudinary (best-effort)
  const existing = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (existing) {
    const parsed = JSON.parse(existing);
    await purgeStoredMedia(env, parsed);
    await refundStoredMedia(env, String(parsed.userId || parsed.user_id || ''), parsed);
  }
  // Remove from KV
  await env.EQUYVO_KV.delete(KEYS.POST(postId));
  // Remove from list
  const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.filter(id => id !== postId)));
  }
  // Remove from content index
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== postId)));
  }
  return true;
}

export async function deleteThought(env: Env, thoughtId: string): Promise<boolean> {
  const existing = await env.EQUYVO_KV.get(KEYS.THOUGHT(thoughtId));
  if (existing) {
    const parsed = JSON.parse(existing);
    await purgeStoredMedia(env, parsed);
    await refundStoredMedia(env, String(parsed.user_id || parsed.userId || ''), parsed);
  }
  await env.EQUYVO_KV.delete(KEYS.THOUGHT(thoughtId));
  const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(ids.filter(id => id !== thoughtId)));
  }
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== thoughtId)));
  }
  return true;
}

export async function deleteStory(env: Env, storyId: string): Promise<boolean> {
  const existing = await env.EQUYVO_KV.get(KEYS.STORY(storyId));
  if (existing) {
    const parsed = JSON.parse(existing);
    await purgeStoredMedia(env, parsed);
    await refundStoredMedia(env, String(parsed.userId || parsed.user_id || ''), parsed);
  }
  await env.EQUYVO_KV.delete(KEYS.STORY(storyId));
  const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.filter(id => id !== storyId)));
  }
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== storyId)));
  }
  return true;
}

export async function deleteMoment(env: Env, momentId: string): Promise<boolean> {
  const existing = await env.EQUYVO_KV.get(KEYS.MOMENT(momentId));
  if (existing) {
    const parsed = JSON.parse(existing);
    await purgeStoredMedia(env, parsed);
    await refundStoredMedia(env, String(parsed.userId || parsed.user_id || ''), parsed);
  }
  await env.EQUYVO_KV.delete(KEYS.MOMENT(momentId));
  const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.filter(id => id !== momentId)));
  }
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== momentId)));
  }
  return true;
}

export async function deleteUserData(env: Env, userId: string): Promise<{ deletedPosts: number; deletedThoughts: number; deletedStories: number; deletedMoments: number }> {
  let deletedPosts = 0, deletedThoughts = 0, deletedStories = 0, deletedMoments = 0;
  // Index entries are keyed by item id, but carry the display name (not the
  // user id) as creator — so track every deleted item id and purge those
  // index rows explicitly. Creator-name matching alone misses them.
  const deletedIds = new Set<string>();

  // Delete profile
  await env.EQUYVO_KV.delete(KEYS.PROFILE(userId));

  // Delete all user's posts
  const postsJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (postsJson) {
    const ids: string[] = JSON.parse(postsJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const postJson = await env.EQUYVO_KV.get(KEYS.POST(id));
      if (postJson) {
        const post = JSON.parse(postJson);
        if (post.userId === userId || post.user_id === userId) {
          await purgeStoredMedia(env, post);
          await refundStoredMedia(env, userId, post);
          await env.EQUYVO_KV.delete(KEYS.POST(id));
          deletedIds.add(id);
          deletedPosts++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(remaining));
  }

  // Delete all user's thoughts
  const thoughtsJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  if (thoughtsJson) {
    const ids: string[] = JSON.parse(thoughtsJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const thoughtJson = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
      if (thoughtJson) {
        const thought = JSON.parse(thoughtJson);
        if (thought.user_id === userId || thought.userId === userId) {
          await purgeStoredMedia(env, thought);
          await refundStoredMedia(env, userId, thought);
          await env.EQUYVO_KV.delete(KEYS.THOUGHT(id));
          deletedIds.add(id);
          deletedThoughts++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(remaining));
  }

  // Delete all user's stories
  const storiesJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  if (storiesJson) {
    const ids: string[] = JSON.parse(storiesJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const storyJson = await env.EQUYVO_KV.get(KEYS.STORY(id));
      if (storyJson) {
        const story = JSON.parse(storyJson);
        if (story.userId === userId || story.user_id === userId) {
          await purgeStoredMedia(env, story);
          await refundStoredMedia(env, userId, story);
          await env.EQUYVO_KV.delete(KEYS.STORY(id));
          deletedIds.add(id);
          deletedStories++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(remaining));
  }

  // Delete all user's moments
  const momentsJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  if (momentsJson) {
    const ids: string[] = JSON.parse(momentsJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const momentJson = await env.EQUYVO_KV.get(KEYS.MOMENT(id));
      if (momentJson) {
        const moment = JSON.parse(momentJson);
        if (moment.userId === userId || moment.user_id === userId) {
          await purgeStoredMedia(env, moment);
          await refundStoredMedia(env, userId, moment);
          await env.EQUYVO_KV.delete(KEYS.MOMENT(id));
          deletedIds.add(id);
          deletedMoments++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(remaining));
  }

  // Remove from content index (by deleted item id AND creator match).
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(
      index.filter((i: any) => !deletedIds.has(i?.id) && i.creator?.toLowerCase() !== userId.toLowerCase() && i.id !== `profile-${userId}`)
    ));
  }
  // Drop the user's interest graph + popularity crumbs for deleted items.
  try {
    await env.EQUYVO_KV.delete(KEYS.INTERESTS(userId));
    await Promise.all([...deletedIds].slice(0, 100).map((id) => env.EQUYVO_KV.delete(KEYS.POP(id)).catch(() => {})));
  } catch { /* best-effort */ }

  return { deletedPosts, deletedThoughts, deletedStories, deletedMoments };
}

// --- CORS Helper (strict allowlist; never '*') ---
export function corsHeaders(origin?: string): Record<string, string> {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://equyvo.pages.dev',
    'https://equyvo.com',
    'https://www.equyvo.com',
    'https://equyvo.acronous.com',
  ];
  const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : 'https://equyvo.pages.dev';
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-User-Email',
    'Access-Control-Max-Age': '86400',
  };
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// --- Social graph / chat / notifications / reports (mirrors Pages Functions) ---
// Production serves Pages Functions; this standalone-Worker mirror stays in
// sync so either runtime behaves identically. Every list is bounded so reads
// stay fast (lag-free); notification writes are best-effort and never block.

export async function readIdList(env: Env, key: string): Promise<string[]> {
  try {
    const raw = await env.EQUYVO_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export interface SocialSummary {
  id: string; name: string; username: string; avatar: string;
  isPrivate?: boolean; verified?: boolean;
}

export function profileSummary(p: any, fallbackId: string): SocialSummary {
  const f = String(fallbackId || '');
  if (!p || typeof p !== 'object') {
    return { id: f, name: f.replace(/^@/, '') || 'user', username: f.startsWith('@') ? f : '@' + f, avatar: '' };
  }
  const id = String(p.id || f);
  const username = String(p.username || p.name || id);
  return {
    id,
    name: String(p.name || username),
    username: username.startsWith('@') ? username : '@' + username,
    avatar: String(p.avatar || ''),
    isPrivate: p.isPrivate === true,
    verified: p.verified === true,
  };
}

export async function isFollowingPair(env: Env, viewerId: string, authorId: string): Promise<boolean> {
  if (!viewerId || !authorId) return false;
  if (viewerId === authorId) return true;
  try {
    const [following, followers] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(viewerId)),
      readIdList(env, KEYS.FOLLOWERS(authorId)),
    ]);
    const t = String(authorId).toLowerCase();
    const v = String(viewerId).toLowerCase();
    if (following.some((x) => x.toLowerCase() === t)) return true;
    if (followers.some((x) => x.toLowerCase() === v)) return true;
    return false;
  } catch { return false; }
}

/** Light viewer for public reads: identity when present, null when anonymous. Never throws. */
export async function getViewer(request: Request, env: Env): Promise<{ id: string; email: string } | null> {
  try {
    const actor: any = await getActor(request, env);
    if (actor && actor.id) return { id: String(actor.id), email: String(actor.email || '') };
  } catch { /* anonymous */ }
  return null;
}

function chatPairKey(a: string, b: string): string {
  const x = String(a || ''), y = String(b || '');
  return (x < y ? KEYS.CHAT(x, y) : KEYS.CHAT(y, x));
}

export interface ChatRecord {
  id: string; from: string; to: string; text: string;
  type: string; fileUrl: string; fileName: string;
  status: string; createdAt: string;
}

export async function readChatMessages(env: Env, a: string, b: string, limit = 100): Promise<ChatRecord[]> {
  try {
    const raw = await env.EQUYVO_KV.get(chatPairKey(a, b));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    return list.slice(-Math.min(300, Math.max(1, limit)));
  } catch { return []; }
}

export async function writeChatMessages(env: Env, a: string, b: string, list: ChatRecord[]): Promise<void> {
  try { await env.EQUYVO_KV.put(chatPairKey(a, b), JSON.stringify(list.slice(-300))); } catch { /* best-effort */ }
}

export async function pushUserNotification(env: Env, userId: string, item: Record<string, any>): Promise<void> {
  if (!userId || !item) return;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.NOTIF(userId));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    list.unshift({ id: generateId(), at: new Date().toISOString(), read: false, ...item });
    await env.EQUYVO_KV.put(KEYS.NOTIF(userId), JSON.stringify(list.slice(0, 100)));
  } catch { /* never block on notify */ }
}

/** Gated 1:1 chat: allowed when EITHER side follows the other. Strangers get 403. */
export async function canChat(env: Env, viewerId: string, peerId: string): Promise<boolean> {
  if (!viewerId || !peerId) return false;
  if (viewerId === peerId) return true;
  try {
    const [mine, theirs] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(viewerId)),
      readIdList(env, KEYS.FOLLOWERS(viewerId)),
    ]);
    const t = String(peerId).toLowerCase();
    if (mine.some((x) => x.toLowerCase() === t)) return true;
    if (theirs.some((x) => x.toLowerCase() === t)) return true;
    const [pFollowing, pFollowers] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(peerId)),
      readIdList(env, KEYS.FOLLOWERS(peerId)),
    ]);
    const v = String(viewerId).toLowerCase();
    if (pFollowing.some((x) => x.toLowerCase() === v)) return true;
    if (pFollowers.some((x) => x.toLowerCase() === v)) return true;
    return false;
  } catch { return false; }
}

/** New-upload fan-out: followers get an in-app (+push) notification. Bounded, background-safe. */
export async function fanOutUpload(env: Env, actorId: string, author: string, title: string): Promise<void> {
  try {
    const followers = await readIdList(env, KEYS.FOLLOWERS(actorId));
    const head = followers.slice(0, 50);
    const a = String(author || actorId).slice(0, 80);
    const t = String(title || '').slice(0, 120) || 'New post';
    await Promise.all(head.map((fid) => pushUserNotification(env, fid, {
      kind: 'upload', title: 'New from ' + a, body: t,
      actorId, actorName: a,
    }).catch(() => {})));
  } catch { /* ignore */ }
}

function ownsItem(item: any, actor: { id: string; email?: string; username?: string }): boolean {
  if (!actor) return false;
  const norm = (v: any) => String(v || '').trim().toLowerCase();
  const owner = item && (item.ownerId || item.userId || item.user_id || '');
  if (owner) {
    const o = norm(owner);
    if (o && (o === norm(actor.id) || o === norm(actor.email) || (actor.username && o === norm(actor.username)))) return true;
  }
  return false;
}

const REPORT_TARGET_KEY: Record<string, (id: string) => string> = {
  post: (id) => KEYS.POST(id),
  thought: (id) => KEYS.THOUGHT(id),
  story: (id) => KEYS.STORY(id),
  moment: (id) => KEYS.MOMENT(id),
};

export interface FileReportInput {
  kind: string; id: string; reason: string; reasons: string[];
  details: string; reporter: string;
}

export async function fileReport(env: Env, input: FileReportInput): Promise<{ ok: boolean; count: number; skipped?: boolean }> {
  const getKey = REPORT_TARGET_KEY[input.kind];
  if (!getKey) throw new Error('Invalid report');
  const raw = await env.EQUYVO_KV.get(getKey(input.id));
  if (!raw) return { ok: true, count: 0, skipped: true };
  let parsed: any = {};
  try { parsed = JSON.parse(raw); } catch { return { ok: true, count: 0, skipped: true }; }
  const owner = String(parsed.ownerId || parsed.userId || parsed.user_id || '');
  if (owner && owner === input.reporter) return { ok: true, count: 0, skipped: true };
  const report = {
    id: generateId(), kind: input.kind, contentId: input.id,
    reason: input.reason, reasons: input.reasons,
    details: String(input.details || '').slice(0, 1000),
    reporter: input.reporter, createdAt: new Date().toISOString(),
  };
  await env.EQUYVO_KV.put(KEYS.REPORT(report.id), JSON.stringify(report));
  try {
    const listJson = await env.EQUYVO_KV.get(KEYS.REPORTS_LIST);
    const ids: string[] = listJson ? JSON.parse(listJson) : [];
    ids.unshift(report.id);
    await env.EQUYVO_KV.put(KEYS.REPORTS_LIST, JSON.stringify(ids.slice(0, 2000)));
  } catch { /* ignore */ }
  let count = 1;
  try {
    const flagRaw = await env.EQUYVO_KV.get(KEYS.FLAGS(input.kind, input.id));
    count = (flagRaw ? parseInt(flagRaw, 10) || 0 : 0) + 1;
    await env.EQUYVO_KV.put(KEYS.FLAGS(input.kind, input.id), String(count));
  } catch { /* ignore */ }
  // Auto-moderation mirrors Pages: 3+ quarantine (owner-only), 5+ remove.
  if (count >= 3) {
    const now = new Date().toISOString();
    parsed.moderation = { status: count >= 5 ? 'removed' : 'quarantined', at: now, reason: 'community' };
    parsed.visibility = 'private';
    try { await env.EQUYVO_KV.put(getKey(input.id), JSON.stringify(parsed)); } catch { /* ignore */ }
    try {
      const qRaw = await env.EQUYVO_KV.get(KEYS.MOD_QUEUE);
      const q = qRaw ? JSON.parse(qRaw) : [];
      q.unshift({ kind: input.kind, id: input.id, owner, reason: count >= 5 ? 'removed' : 'auto-review', at: now });
      await env.EQUYVO_KV.put(KEYS.MOD_QUEUE, JSON.stringify((Array.isArray(q) ? q : []).slice(0, 500)));
    } catch { /* ignore */ }
  }
  return { ok: true, count };
}

/** Newest reports with content snapshots for the dashboard monitor. Bounded. */
export async function listReports(env: Env, limit = 100): Promise<any[]> {
  let ids: string[] = [];
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.REPORTS_LIST);
    ids = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids)) ids = [];
  } catch { ids = []; }
  const out: any[] = [];
  const n = Math.min(200, Math.max(1, limit));
  for (const rid of ids.slice(0, n)) {
    try {
      const rraw = await env.EQUYVO_KV.get(KEYS.REPORT(rid));
      if (!rraw) continue;
      const r = JSON.parse(rraw);
      let snapshot: any = null;
      try {
        const getKey = REPORT_TARGET_KEY[r.kind];
        if (getKey) {
          const craw = await env.EQUYVO_KV.get(getKey(r.contentId));
          if (craw) {
            const c = JSON.parse(craw);
            snapshot = {
              owner: c.ownerId || c.userId || c.user_id || c.creator || c.user || '?',
              text: String(c.content || c.title || c.description || '').slice(0, 300),
              visibility: c.visibility || 'public',
              moderation: c.moderation || null,
              createdAt: c.createdAt || c.created_at || null,
            };
          }
        }
      } catch { /* snapshot best-effort */ }
      out.push({ ...r, snapshot });
    } catch { /* skip bad rows */ }
    if (out.length >= n) break;
  }
  return out;
}

// --- Comments (mirrors Pages Functions) ------------------------------------
// Persistent per-content discussions with replies, likes, shares, pins and
// owner controls. Identity is always resolved server-side from the verified
// caller + stored profile — never trusted from the client.

export interface CommentRecord {
  id: string; contentId: string; contentKind: string; parentId: string | null;
  authorId: string; authorName: string; authorUsername: string; authorAvatar: string;
  text: string; createdAt: string; updatedAt: string;
  likes: number; likedBy: string[]; shares: number; repliesCount: number;
  isPinned: boolean; isEdited: boolean;
}

export async function findContentById(env: Env, contentId: string): Promise<{ kind: string; id: string; item: any; getKey: (id: string) => string } | null> {
  const id = String(contentId || '').slice(0, 64);
  if (!id) return null;
  const kinds = [
    { kind: 'post', getKey: KEYS.POST },
    { kind: 'thought', getKey: KEYS.THOUGHT },
    { kind: 'story', getKey: KEYS.STORY },
    { kind: 'moment', getKey: KEYS.MOMENT },
  ];
  for (const k of kinds) {
    try {
      const raw = await env.EQUYVO_KV.get(k.getKey(id));
      if (raw) {
        const item = JSON.parse(raw);
        if (item && typeof item === 'object') return { ...k, id, item };
      }
    } catch { /* try next collection */ }
  }
  return null;
}

export async function getCommentSettings(env: Env, contentId: string, item: any): Promise<{ commentsEnabled: boolean }> {
  let enabled = !(item && item.commentsEnabled === false);
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.CSETTINGS(contentId));
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.commentsEnabled === 'boolean') enabled = s.commentsEnabled;
    }
  } catch { /* default stands */ }
  return { commentsEnabled: enabled };
}

// Real-data-only gate for comment identity: legacy seed/demo/bot avatar
// hosts are stripped to '' so no comment can ever carry a fake/bot picture;
// the client renders the account's real initials instead.
const FAKE_AVATAR_HOSTS = [
  'picsum.photos',
  'pravatar',
  'dicebear',
  'robohash',
  'unsplash',
  'placehold.co',
  'via.placeholder',
  'dummyimage',
  'loremflickr',
  'fakeimg',
  'thispersondoesnotexist',
];

export function cleanCommentAvatar(url: unknown): string {
  const s = String(url || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low.startsWith('data:image/')) return s;
  for (const h of FAKE_AVATAR_HOSTS) {
    if (low.includes(h)) return '';
  }
  return s;
}

export function cleanCommentName(name: unknown, actor: any): string {
  const n = String(name || '').trim().slice(0, 80);
  if (n && n.toLowerCase() !== 'user') return n;
  const a = String((actor && (actor.username || (actor.email ? String(actor.email).split('@')[0] : ''))) || '').trim().slice(0, 80);
  return a || 'User';
}

export async function resolveCommentAuthor(env: Env, actor: any): Promise<{ id: string; name: string; username: string; avatar: string }> {
  let profile: any = null;
  try { profile = await getProfile(env, String(actor.id)); } catch { profile = null; }
  const username = cleanCommentName(
    (profile && (profile.username || profile.name)) || actor.username,
    actor,
  );
  return { id: String(actor.id), name: username, username, avatar: cleanCommentAvatar(profile && profile.avatar) };
}

export function toPublicComment(c: any, viewerId: string): any {
  if (!c || typeof c !== 'object') return null;
  const likedBy = Array.isArray(c.likedBy) ? c.likedBy.map(String) : [];
  const { likedBy: _drop, ...rest } = c;
  void _drop;
  return { ...rest, likes: Number(c.likes || 0) || 0, hasLiked: viewerId ? likedBy.some((x) => x === String(viewerId)) : false };
}

export async function readCommentList(env: Env, contentId: string): Promise<string[]> {
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.COMMENTS(contentId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

export async function syncContentCommentCount(env: Env, found: { id: string; item: any; getKey: (id: string) => string } | null, count: number): Promise<void> {
  if (!found) return;
  const n = Math.max(0, Number(count) || 0);
  try {
    const it = { ...found.item };
    if ('comments_count' in it) (it as any).comments_count = n;
    if ('comments' in it) (it as any).comments = n;
    if (!('comments' in it) && !('comments_count' in it)) (it as any).comments = n;
    await env.EQUYVO_KV.put(found.getKey(found.id), JSON.stringify(it));
  } catch { /* counter is best-effort */ }
}
