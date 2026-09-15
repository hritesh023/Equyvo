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
const BASE_LIMITS: Record<string, number> = { posts: 10, thoughts: 20, stories: 10, moments: 10, profile: 5, upload: 5, index: 20, delete: 30 };
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
  if (await kv.get(SEED_PURGED_KEY)) return;

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
  const listJson = await env.EQUYVO_KV.get(listKey);
  if (!listJson) return [];
  const ids: string[] = JSON.parse(listJson);
  const valid: string[] = [];
  for (const id of ids) {
    const data = await env.EQUYVO_KV.get(getKey(id));
    if (data) valid.push(id);
  }
  if (valid.length !== ids.length) {
    await env.EQUYVO_KV.put(listKey, JSON.stringify(valid));
  }
  return valid;
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
  const newStory: Story = {
    ...story,
    id,
    createdAt: new Date().toISOString(),
  };
  await env.EQUYVO_KV.put(KEYS.STORY(id), JSON.stringify(newStory));
  
  const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.slice(0, 200)));
  await markHasRealUsers(env);
  
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
  const newMoment: Moment = {
    ...moment,
    id,
    createdAt: new Date().toISOString(),
  };
  await env.EQUYVO_KV.put(KEYS.MOMENT(id), JSON.stringify(newMoment));
  
  const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);
  
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

export async function searchContent(env: Env, query: string): Promise<{ results: ContentIndexItem[]; totalCount: number }> {
  const json = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (!json) return { results: [], totalCount: 0 };
  const index: ContentIndexItem[] = JSON.parse(json);
  
  if (!query.trim()) {
    return { results: index.slice(0, 20), totalCount: index.length };
  }
  
  const q = query.toLowerCase().trim();
  const scored = index.map(item => {
    let score = 0;
    const searchable = [item.title, item.description, item.content, item.category, item.creator, ...item.tags]
      .filter(Boolean).join(' ').toLowerCase();
    
    if (searchable.includes(q)) score += 100;
    if (item.title.toLowerCase().includes(q)) score += 50;
    if (item.category.toLowerCase().includes(q)) score += 40;
    if (item.creator.toLowerCase().includes(q)) score += 35;
    if (item.description.toLowerCase().includes(q)) score += 30;
    if (item.content?.toLowerCase().includes(q)) score += 25;
    
    const tagMatches = item.tags.filter(t => t.toLowerCase().includes(q)).length;
    score += tagMatches * 20;
    
    return { item, score };
  });
  
  const threshold = 10;
  const matching = scored.filter(s => s.score >= threshold);
  matching.sort((a, b) => b.score - a.score);
  
  if (matching.length === 0) {
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, 12).map(s => s.item), totalCount: index.length };
  }
  
  return { results: matching.slice(0, 20).map(s => s.item), totalCount: matching.length };
}

// --- Likes / Votes (stored in KV as counters) ---
export async function likePost(env: Env, postId: string): Promise<{ liked: boolean; likes_count: number }> {
  const postJson = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (!postJson) throw new Error('Post not found');
  const post = JSON.parse(postJson) as Post;
  post.likes += 1;
  await env.EQUYVO_KV.put(KEYS.POST(postId), JSON.stringify(post));
  return { liked: true, likes_count: post.likes };
}

export async function unlikePost(env: Env, postId: string): Promise<{ liked: boolean; likes_count: number }> {
  const postJson = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (!postJson) throw new Error('Post not found');
  const post = JSON.parse(postJson) as Post;
  post.likes = Math.max(0, post.likes - 1);
  await env.EQUYVO_KV.put(KEYS.POST(postId), JSON.stringify(post));
  return { liked: false, likes_count: post.likes };
}

export async function voteThought(env: Env, thoughtId: string, voteType: 'upvote' | 'downvote'): Promise<{ success: boolean }> {
  // For now, simple toggle in KV
  const thoughtJson = await env.EQUYVO_KV.get(KEYS.THOUGHT(thoughtId));
  if (!thoughtJson) throw new Error('Thought not found');
  const thought = JSON.parse(thoughtJson) as Thought;
  // Simple vote tracking
  await env.EQUYVO_KV.put(KEYS.THOUGHT(thoughtId), JSON.stringify(thought));
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
          deletedMoments++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(remaining));
  }

  // Remove from content index
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(
      index.filter((i: any) => i.creator?.toLowerCase() !== userId.toLowerCase() && i.id !== `profile-${userId}`)
    ));
  }

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
