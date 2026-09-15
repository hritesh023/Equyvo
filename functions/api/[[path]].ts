// Pages Functions catch-all for /api/*
// Handles all API routes for the Equyvo app
//
// Production security model:
//  - Reads are public (feed/discover/search) with no-cache + CORS allowlist.
//  - Writes (create/update/delete/upload/tips/subs) REQUIRE a caller identity.
//  - A valid Cognito JWT (Authorization: Bearer) yields a *verified* identity.
//  - Unverified fallback (X-User-Id header / body userId) is ONLY allowed when
//    REQUIRE_VERIFIED_WRITES !== 'true' (local dev). In production it is
//    rejected with 401. This prevents anonymous spoofing.
//  - Secrets (Cloudinary API secret, R2 keys, billing keys) NEVER leave the
//    server. The frontend only ever sees: public URLs, key_id+order_id for
//    Razorpay, and its own JWT. See frontend audit in DEPLOYMENT notes.
//  - Monetization: server-side plan catalog is the source of truth for
//    storage quotas + upload limits. Client plan labels are display-only.
//  - Media: R2 is the intended warehouse (zero egress). Cloudinary is used
//    SELECTIVELY for transformations/variants. Until R2 is bound, Cloudinary
//    remains the store and the code paths are R2-ready (see MEDIA_STORE).

export interface Env {
  EQUYVO_KV: KVNamespace;
  // Optional R2 bucket for permanent media warehouse (zero egress).
  // Bind in wrangler.toml / Pages dashboard as EQUYVO_R2.
  EQUYVO_R2?: R2Bucket;
  // Public delivery base for R2 (e.g. https://cdn.equyvo.com). If unset,
  // delivery falls back to Cloudinary URLs.
  R2_PUBLIC_BASE?: string;
  CLOUDINARY_CLOUD_NAME?: string;
  CLOUDINARY_UPLOAD_PRESET?: string;
  CLOUDINARY_API_KEY?: string;
  CLOUDINARY_API_SECRET?: string;
  AWS_USER_POOL_ID?: string;
  MAX_UPLOAD_MB?: string;
  // Centralized billing (Acronous) for server-side entitlement checks.
  BILLING_BASE_URL?: string;
  // When 'true', unverified X-User-Id fallback is rejected (production).
  REQUIRE_VERIFIED_WRITES?: string;
  // Comma-separated allowed origins for CORS. Defaults to safe list below.
  ALLOWED_ORIGINS?: string;
  APP_VERSION?: string;
}

const KEYS = {
  POSTS: 'posts:list',
  POST: (id) => 'post:' + id,
  THOUGHTS: 'thoughts:list',
  THOUGHT: (id) => 'thought:' + id,
  STORIES: 'stories:list',
  STORY: (id) => 'story:' + id,
  MOMENTS: 'moments:list',
  MOMENT: (id) => 'moment:' + id,
  PROFILE: (userId) => 'profile:' + userId,
  CONTENT_INDEX: 'content:index',
  NEXT_ID: 'next:id',
  HAS_REAL_USERS: 'has_real_users',
  RATE: (kind, actorId, bucket) => 'rl:' + kind + ':' + actorId + ':' + bucket,
  // Monetization / quotas / creator economy
  USAGE: (userId) => 'usage:' + userId,
  PLAN_CACHE: (userId) => 'plan:' + userId,
  HASH: (sha256) => 'mediahash:' + sha256,
  CREATOR: (userId) => 'creator:' + userId,
  // Maps Cloudinary publicId -> { bytes, r2Key } so deletes can purge R2 and
  // refund quotas even though content items only carry publicId/resourceType.
  MEDIA: (publicId) => 'media:' + publicId,
  TIPS_LIST: 'tips:list',
  TIP: (id) => 'tip:' + id,
  SUBS_LIST: 'subs:list',
  SUB: (id) => 'sub:' + id,
  BIZ: (userId) => 'biz:' + userId,
};

// ---------------------------------------------------------------------------
// Plan catalog — SERVER-SIDE source of truth. Frontend plans.ts is display-only
// and must never be trusted for enforcement. Prices in INR/month.
// Storage quotas enforce the "free is affordable, power users pay" model:
//   Free 5GB / Plus 50GB / Premium 250GB / Creator 500GB / Creator Pro 1TB / Biz 2TB
// ---------------------------------------------------------------------------
const GB = 1024 * 1024 * 1024;
const PLAN_CATALOG = {
  eq_free:        { id: 'eq_free',        label: 'Free',        priceInr: 0,   storageBytes: 5 * GB,   maxUploadMB: 20,  maxVideoSec: 60,  monthlyUploads: 100,  quality: 'auto-low',  ads: true },
  eq_plus:        { id: 'eq_plus',        label: 'Plus',        priceInr: 49,  storageBytes: 50 * GB,  maxUploadMB: 100, maxVideoSec: 180, monthlyUploads: 500,  quality: 'auto-good', ads: 'light' },
  eq_premium:     { id: 'eq_premium',     label: 'Premium',     priceInr: 149, storageBytes: 250 * GB, maxUploadMB: 500, maxVideoSec: 600, monthlyUploads: 2000, quality: 'auto-best', ads: false },
  eq_creator:     { id: 'eq_creator',     label: 'Creator',     priceInr: 399, storageBytes: 500 * GB, maxUploadMB: 1024, maxVideoSec: 1800, monthlyUploads: 5000, quality: 'auto-best', ads: false, creator: true },
  eq_creator_pro: { id: 'eq_creator_pro', label: 'Creator Pro', priceInr: 799, storageBytes: 1024 * GB, maxUploadMB: 2048, maxVideoSec: 7200, monthlyUploads: 20000, quality: 'original', ads: false, creator: true },
  eq_business:    { id: 'eq_business',    label: 'Business',    priceInr: null, storageBytes: 2048 * GB, maxUploadMB: 2048, maxVideoSec: 7200, monthlyUploads: 50000, quality: 'original', ads: false, creator: true, business: true },
};
const DEFAULT_PLAN_ID = 'eq_free';
const PLAN_IDS = new Set(Object.keys(PLAN_CATALOG));

// Platform fee for creator earnings (tips / paid subs / digital products).
const PLATFORM_FEE_BPS = 1000; // 10%

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://equyvo.pages.dev',
  'https://equyvo.com',
  'https://www.equyvo.com',
  'https://equyvo.acronous.com',
];

function getAllowedOrigins(env) {
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function corsFor(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = getAllowedOrigins(env);
  const allowOrigin = allowed.has(origin) ? origin : [...allowed][0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-User-Email',
    'Access-Control-Max-Age': '86400',
  };
}

// Prevent Cloudflare edge caching of API responses + baseline security headers.
// CSP/HSTS are enforced at the hosting layer; these are defense-in-depth for API.
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function json(data, status = 200, cors = undefined) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...(cors || {}), ...NO_CACHE_HEADERS, ...SECURITY_HEADERS },
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function clamp(n, min, max) {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function computeRelativeTime(createdAt) {
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

// Apply computed time and other transformations to items before returning
function transformItem(item) {
  if (!item) return item;
  if (item.createdAt) {
    item.time = computeRelativeTime(item.createdAt);
  }
  return item;
}

// Clean orphaned IDs from a list (IDs whose KV entries no longer exist)
async function cleanOrphans(env, listKey, getKey) {
  const listJson = await env.EQUYVO_KV.get(listKey);
  if (!listJson) return [];
  const ids = JSON.parse(listJson);
  const valid = [];
  for (const id of ids) {
    const data = await env.EQUYVO_KV.get(getKey(id));
    if (data) valid.push(id);
  }
  if (valid.length !== ids.length) {
    await env.EQUYVO_KV.put(listKey, JSON.stringify(valid));
  }
  return valid;
}

// Filter out seed/bot/test content when real users exist.
// Checks the isSeed flag, the seed-* ID prefix, and media URLs that point to
// the legacy demo media (Google sample-video bucket / picsum seed placeholders)
// so legacy seeded search-index items are hidden too.
//
// Robustness: an item is ALWAYS considered real (never dropped/purged) if it
// carries real user-uploaded media (a Cloudinary URL), because such media can
// only have come from a real user upload. This guarantees the seed filter can
// never wipe genuine user content regardless of its text.
const TEST_TEXT_PATTERNS = [/@test\.com$/i, /^pwsrc_/i];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/;

function isSeedItem(item) {
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
    ...(Array.isArray(item.media)
      ? item.media.map((m) => m && m.url).filter(Boolean)
      : []),
  ].filter(Boolean);
  if (refs.some((r) => String(r).includes('res.cloudinary.com/'))) return false;
  // Legacy demo media (Google sample-video bucket / picsum seed placeholders)
  if (refs.some((r) =>
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
  ].filter((t) => typeof t === 'string');
  if (authorSignals.some((t) => TEST_TEXT_PATTERNS.some((re) => re.test(t)))) return true;
  // Legacy seeded search-index entries store relative timestamps, not ISO dates
  if (typeof item.publishedAt === 'string' && !ISO_DATE_RE.test(item.publishedAt)) return true;
  return false;
}

async function filterSeed(env, items) {
  const hasReal = await env.EQUYVO_KV.get(KEYS.HAS_REAL_USERS);
  if (hasReal === 'true') {
    return items.filter(i => !isSeedItem(i));
  }
  return items;
}

// One-time purge of legacy seeded/test content from KV. Runs lazily on the
// first request after real users exist, then marks itself done. This removes
// the demo posts/thoughts/stories/moments, the seeded search index, and the
// seeded bot profiles from storage entirely (not just from responses).
const SEED_PURGED_KEY = 'seed_purged';

const SEED_PROFILE_IDS = new Set(['user1', 'user2']);

async function purgeSeedData(env) {
  const kv = env.EQUYVO_KV;
  if (await kv.get(SEED_PURGED_KEY)) return;

  const removedUserIds = new Set();

  const removeFromList = async (listKey, getKey) => {
    const listJson = await kv.get(listKey);
    if (!listJson) return;
    const ids = JSON.parse(listJson);
    const remaining = [];
    for (const id of ids) {
      const raw = await kv.get(getKey(id));
      let item = null;
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
    const remaining = index.filter((i) => !isSeedItem(i));
    await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(remaining));
  }

  for (const pid of SEED_PROFILE_IDS) {
    await kv.delete(KEYS.PROFILE(pid));
  }
  for (const uid of removedUserIds) {
    await kv.delete(KEYS.PROFILE(uid));
  }

  await kv.put(SEED_PURGED_KEY, 'true');
}

// Hex SHA-1 digest for Cloudinary signature generation
async function sha1Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Derive a Cloudinary resource type from a stored record
function deriveResourceType(parsed) {
  if (parsed?.resourceType) return parsed.resourceType;
  if (parsed?.mediaType === 'video' || parsed?.type === 'video') return 'video';
  if (parsed?.videoUrl && String(parsed.videoUrl).startsWith('http')) return 'video';
  return 'image';
}

// Delete a Cloudinary asset (best-effort). Skips silently when no public id
// is stored or when API credentials are not configured on the server.
async function deleteCloudinaryMedia(env, parsed) {
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
    const result = await resp.json();
    return { ok: resp.ok, result };
  } catch (err) {
    return { skipped: true, reason: 'error', message: String(err?.message || err) };
  }
}

// =============== Cognito JWT verification ===============
// Verifies AWS Cognito ID tokens against the pool's published JWKS.
// Used to upgrade a caller from "identified" to "verified".

const DEFAULT_POOL_ID = 'eu-north-1_z141VJjsi';

let cachedJwks = null;
let cachedJwksAt = 0;

function getPoolId(env) {
  return env.AWS_USER_POOL_ID || DEFAULT_POOL_ID;
}

function getRegion(env) {
  return (getPoolId(env).split('_')[0] || 'eu-north-1');
}

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getJwks(env) {
  if (cachedJwks && Date.now() - cachedJwksAt < 60 * 60 * 1000) return cachedJwks;
  const poolId = getPoolId(env);
  const region = getRegion(env);
  const url = `https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    cachedJwks = data.keys || [];
    cachedJwksAt = Date.now();
  } catch {
    return null;
  }
  return cachedJwks;
}

async function verifyCognitoToken(token, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub) return null;
    if (payload.exp && payload.exp < now) return null;
    const poolId = getPoolId(env);
    const region = getRegion(env);
    const iss = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
    if (payload.iss && payload.iss !== iss) return null;
    const keys = await getJwks(env);
    if (!keys || !keys.length) return null;
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) return null;
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: key.kty, n: key.n, e: key.e, alg: key.alg, use: key.use, kid: key.kid },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = b64urlDecode(sigB64);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      sigBytes,
      new TextEncoder().encode(headerB64 + '.' + payloadB64)
    );
    if (!valid) return null;
    return {
      id: payload.sub,
      email: payload.email || '',
      username: payload['cognito:username'] || (payload.email ? payload.email.split('@')[0] : ''),
      verified: true,
    };
  } catch {
    return null;
  }
}

// Resolve the caller identity.
// 1) Valid Bearer JWT -> verified user (always accepted).
// 2) X-User-Id / body userId -> UNVERIFIED fallback, only when
//    REQUIRE_VERIFIED_WRITES !== 'true'. Production sets it to 'true',
//    so spoofed headers cannot write as someone else.
// Returns null when no identity can be established.
function requiresVerifiedWrites(env) {
  return String(env.REQUIRE_VERIFIED_WRITES || '').toLowerCase() === 'true';
}
async function getActor(request, env, body) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const user = await verifyCognitoToken(token, env);
      if (user) return user;
      // A present-but-invalid Bearer token is an auth failure, not a
      // fallback opportunity: reject rather than trusting headers.
      if (requiresVerifiedWrites(env)) return null;
    }
  }
  if (requiresVerifiedWrites(env)) return null;
  const headerId = request.headers.get('X-User-Id') || request.headers.get('X-User-Email') || '';
  let bodyId = '';
  if (body && typeof body === 'object') {
    bodyId = body.userId || body.user_id || body.creator || '';
  }
  const id = String(headerId || bodyId || '').slice(0, 200);
  if (!id) return null;
  return { id, email: id.includes('@') ? id : '', username: '', verified: false };
}

function actorResponse(actor, env, cors) {
  if (actor) return null;
  const msg = requiresVerifiedWrites(env)
    ? 'Authentication required (valid Bearer token)'
    : 'Authentication required';
  return json({ error: msg }, 401, cors);
}

// =============== Payload sanitization ===============

const MAX_JSON_BYTES = 100 * 1024; // 100 KB
const MAX_STRING_LEN = 5000;
const MAX_ARRAY_LEN = 30;
const MAX_DEPTH = 6;

async function readJson(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    throw httpError(400, 'Invalid request body');
  }
  if (!text || !text.trim()) throw httpError(400, 'Invalid request body');
  if (text.length > MAX_JSON_BYTES) throw httpError(413, 'Request body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

function sanitizeValue(value, depth) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LEN);
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LEN).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === 'object' && depth < MAX_DEPTH) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = sanitizeValue(value[key], depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'Invalid request body');
  }
  return sanitizeValue(body, 0) || {};
}

// =============== Rate limiting ===============
// Per-identity sliding-minute counters stored in KV. Paid plans get higher
// write throughput so power users/creators are not throttled like free users.

const RATE_LIMITS = {
  posts: 10,
  thoughts: 20,
  stories: 10,
  moments: 10,
  profile: 5,
  upload: 5,
  index: 20,
  delete: 30,
  tips: 10,
  subs: 10,
};

function rateLimitFor(planId, kind) {
  const base = RATE_LIMITS[kind] || 20;
  if (planId === 'eq_creator_pro' || planId === 'eq_business') return base * 4;
  if (planId === 'eq_creator' || planId === 'eq_premium') return base * 2;
  return base;
}

async function rateLimit(kv, kind, actorId, limitOverride) {
  const limit = limitOverride || RATE_LIMITS[kind] || 20;
  if (!actorId) return { ok: true };
  const bucket = Math.floor(Date.now() / 60000);
  const key = KEYS.RATE(kind, actorId, bucket);
  const raw = await kv.get(key);
  const count = raw ? (parseInt(raw, 10) || 0) : 0;
  if (count >= limit) return { ok: false };
  await kv.put(key, String(count + 1), { expirationTtl: 150 });
  return { ok: true };
}

// =============== Entitlements (server-side plan resolution) ===============
// Trust hierarchy: KV plan cache (written only after verified billing check)
// > live billing status via BILLING_BASE_URL > free fallback. The client NEVER
// decides its own quota.

async function resolvePlan(env, actor, bearerToken) {
  const fallback = { planId: DEFAULT_PLAN_ID, source: 'fallback-free' };
  if (!actor) return fallback;
  try {
    const cached = await env.EQUYVO_KV.get(KEYS.PLAN_CACHE(actor.id));
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && PLAN_IDS.has(parsed.planId) && parsed.until && parsed.until > Date.now()) {
        return { planId: parsed.planId, source: 'cache', until: parsed.until };
      }
    }
  } catch { /* ignore cache errors */ }
  const base = (env.BILLING_BASE_URL || 'https://api.acronous.com').replace(/\/$/, '');
  if (bearerToken) {
    try {
      const resp = await fetch(base + '/v1/billing/status?product=equyvo', {
        headers: { Authorization: 'Bearer ' + bearerToken },
      });
      if (resp.ok) {
        const s = await resp.json();
        const sub = (s && (s.subscriptions?.equyvo || s.access)) || null;
        const planId = sub?.plan;
        if (planId && PLAN_IDS.has(planId)) {
          const until = Number(sub.until || 0) || Date.now() + 5 * 60 * 1000;
          try {
            await env.EQUYVO_KV.put(KEYS.PLAN_CACHE(actor.id), JSON.stringify({ planId, until }), { expirationTtl: 600 });
          } catch { /* ignore */ }
          return { planId, source: 'billing', until };
        }
      }
    } catch { /* billing unreachable -> free */ }
  }
  return fallback;
}

function planQuota(planId) {
  return PLAN_CATALOG[planId] || PLAN_CATALOG[DEFAULT_PLAN_ID];
}

function bearerFrom(request) {
  const auth = request.headers.get('Authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

// =============== Storage accounting ===============
// Tracks bytes stored per user so free users stay affordable and power users
// pay for what they use. Usage is incremented on upload, decremented on
// delete (best-effort; Cloudinary destroy is also best-effort).

async function getUsage(env, userId) {
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.USAGE(userId));
    if (!raw) return { bytes: 0, files: 0, month: monthlyBucket(), monthUploads: 0 };
    const u = JSON.parse(raw);
    if (u.month !== monthlyBucket()) return { bytes: Number(u.bytes || 0), files: Number(u.files || 0), month: monthlyBucket(), monthUploads: 0 };
    return { bytes: Number(u.bytes || 0), files: Number(u.files || 0), month: u.month, monthUploads: Number(u.monthUploads || 0) };
  } catch {
    return { bytes: 0, files: 0, month: monthlyBucket(), monthUploads: 0 };
  }
}

function monthlyBucket() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

async function addUsage(env, userId, bytes) {
  const u = await getUsage(env, userId);
  const next = { bytes: u.bytes + bytes, files: u.files + 1, month: monthlyBucket(), monthUploads: (u.month === monthlyBucket() ? u.monthUploads : 0) + 1 };
  await env.EQUYVO_KV.put(KEYS.USAGE(userId), JSON.stringify(next));
  return next;
}

async function subtractUsage(env, userId, bytes) {
  const u = await getUsage(env, userId);
  const next = { bytes: Math.max(0, u.bytes - (bytes || 0)), files: Math.max(0, u.files - 1), month: u.month, monthUploads: u.monthUploads };
  await env.EQUYVO_KV.put(KEYS.USAGE(userId), JSON.stringify(next));
  return next;
}

// =============== Media helpers: dedupe + selective Cloudinary variants =====
// Dedupe by SHA-256 so re-uploads of the same bytes don't burn Cloudinary
// credits. Variants keep Cloudinary as the *transformation* layer while R2
// remains the intended warehouse (see R2 migration note in upload handler).

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cloudinaryVariants(secureUrl, resourceType, quality) {
  // Returns cheap, cache-friendly derived URLs. Original stays authoritative.
  if (!secureUrl || !secureUrl.includes('res.cloudinary.com/')) return null;
  const isVideo = resourceType === 'video';
  const q = quality === 'original' ? '' : quality === 'auto-low' ? 'q_auto:low,f_auto/' : 'q_auto,f_auto/';
  try {
    if (isVideo) {
      const thumb = secureUrl.replace('/video/upload/', '/video/upload/w_400,' + q + 'so_0/').replace(/\.[^.]+$/, '.jpg');
      const sd = secureUrl.replace('/video/upload/', '/video/upload/w_640,c_limit,' + q + '/');
      const hd = secureUrl.replace('/video/upload/', '/video/upload/w_1280,c_limit,' + q + '/');
      return { thumbnail: thumb, sd, hd, optimized: sd };
    }
    const thumb = secureUrl.replace('/image/upload/', '/image/upload/w_400,c_limit,' + q + '/');
    const optimized = secureUrl.replace('/image/upload/', '/image/upload/w_1080,c_limit,' + q + '/');
    return { thumbnail: thumb, optimized, sd: optimized, hd: secureUrl };
  } catch {
    return null;
  }
}

const ALLOWED_MIME_PREFIXES = ['image/', 'video/'];
function mimeAllowed(mime) {
  return typeof mime === 'string' && ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p));
}

// =============== R2 media warehouse (zero egress) ==========================
// R2 is the PRIMARY store for originals. Cloudinary is used SELECTIVELY for
// derived variants (thumbnails, optimized renditions). Delivery prefers R2:
// R2_PUBLIC_BASE (custom domain / R2.dev) when set, else same-origin
// /api/media/<key> proxy below (works with zero DNS setup).

function r2KeyFor(actorId, hash, ext) {
  const safe = String(actorId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'anon';
  const d = new Date();
  const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  const e = String(ext || 'bin').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
  return 'u/' + safe + '/' + ym + '/' + String(hash).slice(0, 32) + '.' + e;
}

function extFromFile(file) {
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

function r2DeliveryUrl(request, env, key) {
  const base = String(env.R2_PUBLIC_BASE || '').replace(/\/$/, '');
  if (base) return base + '/' + key;
  return new URL(request.url).origin + '/api/media/' + key;
}

function validMediaKey(key) {
  if (typeof key !== 'string' || !key || key.length > 300) return false;
  if (key.includes('..') || key.startsWith('/') || key.includes('\\')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key);
}

// Range-aware R2 delivery with immutable caching. Supports video seeking
// (bytes=N-, bytes=N-M, bytes=-N) and HEAD. Public (Hotlinking can be locked
// down later via R2_PUBLIC_BASE + signed URLs if abuse appears).
async function serveR2(request, env, key, cors, method) {
  if (!env.EQUYVO_R2) {
    return json({ error: 'Media warehouse not bound. Enable R2 (see wrangler.toml) — Cloudinary URLs remain authoritative until then.' }, 503, cors);
  }
  if (!validMediaKey(key)) return json({ error: 'Invalid media key' }, 400, cors);
  let head = null;
  try {
    head = await env.EQUYVO_R2.head(key);
  } catch {
    return json({ error: 'Media fetch failed' }, 500, cors);
  }
  if (!head) return json({ error: 'Not found' }, 404, cors);

  const contentType = (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream';
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...cors,
    ...SECURITY_HEADERS,
  };
  if (head.etag) baseHeaders['ETag'] = head.etag;

  if (method === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(head.size) } });
  }

  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) {
    const obj = await env.EQUYVO_R2.get(key);
    if (!obj) return json({ error: 'Not found' }, 404, cors);
    return new Response(obj.body, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(obj.size) } });
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': 'bytes */' + head.size } });
  }
  let offset, length;
  if (m[1] === '') {
    const suffix = Math.min(parseInt(m[2], 10), head.size);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': 'bytes */' + head.size } });
    }
    offset = head.size - suffix;
    length = suffix;
  } else {
    offset = parseInt(m[1], 10);
    const end = m[2] === '' ? head.size - 1 : Math.min(parseInt(m[2], 10), head.size - 1);
    if (!Number.isFinite(offset) || offset < 0 || offset >= head.size || end < offset) {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': 'bytes */' + head.size } });
    }
    length = end - offset + 1;
  }
  const obj = await env.EQUYVO_R2.get(key, { range: { offset, length } });
  if (!obj) return json({ error: 'Not found' }, 404, cors);
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Length': String(length),
      'Content-Range': 'bytes ' + offset + '-' + (offset + length - 1) + '/' + head.size,
    },
  });
}

// Resolve stored-media bookkeeping (r2Key + bytes) for a content item, via
// the item itself or the publicId -> media index written at upload time.
async function resolveStoredMedia(env, parsed) {
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

// Best-effort purge from BOTH stores + drop the media index entry.
async function purgeStoredMedia(env, parsed) {
  const { r2Key, publicId } = await resolveStoredMedia(env, parsed);
  await deleteCloudinaryMedia(env, parsed);
  try {
    if (env.EQUYVO_R2 && r2Key) await env.EQUYVO_R2.delete(r2Key);
  } catch { /* ignore */ }
  try {
    if (publicId) await env.EQUYVO_KV.delete(KEYS.MEDIA(publicId));
  } catch { /* ignore */ }
}

// =============== Shared write logic ===============

function owns(item, actor) {
  if (!actor) return false;
  const owner = item && (item.userId || item.user_id || item.creator || '');
  return !!owner && owner === actor.id;
}

async function createItem(context, kind, listKey, itemKey, cors) {
  const { request, env } = context;
  const kv = env.EQUYVO_KV;
  const body = await readJson(request);
  const actor = await getActor(request, env, body);
  const denied = actorResponse(actor, env, cors);
  if (denied) return denied;
  const { planId } = await resolvePlan(env, actor, bearerFrom(request));
  const rl = await rateLimit(kv, kind, actor.id, rateLimitFor(planId, kind));
  if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);

  const now = new Date().toISOString();
  let id = generateId();
  if (typeof body.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(body.id)) {
    const existing = await kv.get(itemKey(body.id));
    if (!existing) id = body.id;
  }

  const clean = sanitizeBody(body);
  delete clean.id;
  const item = { ...clean, id, createdAt: now };
  if (kind === 'thoughts') {
    item.created_at = now;
    item.updated_at = now;
  }

  await kv.put(itemKey(id), JSON.stringify(item));
  const listJson = await kv.get(listKey);
  const ids = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await kv.put(listKey, JSON.stringify(ids.slice(0, 500)));
  await kv.put(KEYS.HAS_REAL_USERS, 'true');
  return json({ data: transformItem(item), error: null }, 201, cors);
}

async function deleteItem(context, listKey, itemKey, id, cors) {
  const { request, env } = context;
  const kv = env.EQUYVO_KV;
  const actor = await getActor(request, env);
  const denied = actorResponse(actor, env, cors);
  if (denied) return denied;

  const raw = await kv.get(itemKey(id));
  if (!raw) return json({ error: 'Not found' }, 404, cors);
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    // fall through with empty parsed
  }

  const owner = parsed && (parsed.userId || parsed.user_id || parsed.creator || '');
  const canDelete = owns(parsed, actor) || (actor.verified && (!owner || owner === 'anonymous'));
  if (!canDelete) return json({ error: 'Forbidden' }, 403, cors);

  const { planId } = await resolvePlan(env, actor, bearerFrom(request));
  const rl = await rateLimit(kv, 'delete', actor.id, rateLimitFor(planId, 'delete'));
  if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);

  await purgeStoredMedia(env, parsed);
  // Refund storage accounting so quotas stay accurate.
  try {
    const ownerId = String(owner || actor.id);
    const { bytes } = await resolveStoredMedia(env, parsed);
    if (bytes > 0) await subtractUsage(env, ownerId, bytes);
  } catch { /* ignore */ }
  await kv.delete(itemKey(id));

  const listJson = await kv.get(listKey);
  if (listJson) {
    const ids = JSON.parse(listJson);
    await kv.put(listKey, JSON.stringify(ids.filter((i) => i !== id)));
  }
  const idxJson = await kv.get(KEYS.CONTENT_INDEX);
  if (idxJson) {
    const idx = JSON.parse(idxJson);
    await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.filter((i) => i && i.id !== id)));
  }
  return json({ data: { success: true }, error: null }, 200, cors);
}

// =============== Request handler ===============

export const onRequest = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const cors = corsFor(request, env);
  const requestId = generateId();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });
  }

  try {
    // Ensure seed data is always filtered out
    await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
    // Physically remove legacy seeded/test content from KV (runs once)
    await purgeSeedData(env);

    const kv = env.EQUYVO_KV;

    // HEALTH (public, versioned for deploy verification)
    if (path === '/api/health' && method === 'GET') {
      return json({ status: 'ok', version: env.APP_VERSION || '1.0.0', requestId, timestamp: new Date().toISOString() }, 200, cors);
    }

    // PLANS (public catalog — quotas only, no secrets)
    if (path === '/api/plans' && method === 'GET') {
      const plans = Object.values(PLAN_CATALOG).map((p) => ({
        id: p.id, label: p.label, priceInr: p.priceInr,
        storageGB: Math.round(p.storageBytes / GB),
        maxUploadMB: p.maxUploadMB, maxVideoSec: p.maxVideoSec,
        monthlyUploads: p.monthlyUploads, ads: p.ads,
        creator: !!p.creator, business: !!p.business,
      }));
      return json({ data: { plans, platformFeeBps: PLATFORM_FEE_BPS }, error: null }, 200, cors);
    }

    // ME/USAGE (authenticated: quota + usage so UI can show upgrade prompts)
    if (path === '/api/me/usage' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId, source } = await resolvePlan(env, actor, bearerFrom(request));
      const quota = planQuota(planId);
      const usage = await getUsage(env, actor.id);
      return json({ data: {
        planId, planLabel: quota.label, source,
        usedBytes: usage.bytes, quotaBytes: quota.storageBytes,
        usedPct: quota.storageBytes ? Math.round((usage.bytes / quota.storageBytes) * 1000) / 10 : 0,
        files: usage.files,
        monthlyUploads: usage.monthUploads, monthlyCap: quota.monthlyUploads,
        maxUploadMB: quota.maxUploadMB, maxVideoSec: quota.maxVideoSec,
      }, error: null }, 200, cors);
    }

    // POSTS
    if (path === '/api/posts' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '50', 10), 1, 100);
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      const recent = ids.slice(0, limit);
      const posts = (await Promise.all(recent.map(async (id) => {
        const p = await kv.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, posts), error: null }, 200, cors);
    }

    if (path === '/api/posts' && method === 'POST') {
      return await createItem(context, 'posts', KEYS.POSTS, KEYS.POST, cors);
    }

    // THOUGHTS
    if (path === '/api/thoughts' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 100);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const ids = await cleanOrphans(env, KEYS.THOUGHTS, KEYS.THOUGHT);
      const page = ids.slice(offset, offset + limit);
      const thoughts = (await Promise.all(page.map(async (id) => {
        const t = await kv.get(KEYS.THOUGHT(id));
        return t ? transformItem(JSON.parse(t)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, thoughts), error: null }, 200, cors);
    }

    if (path === '/api/thoughts' && method === 'POST') {
      return await createItem(context, 'thoughts', KEYS.THOUGHTS, KEYS.THOUGHT, cors);
    }

    // STORIES
    if (path === '/api/stories' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 100);
      const ids = await cleanOrphans(env, KEYS.STORIES, KEYS.STORY);
      const recent = ids.slice(0, limit);
      const stories = (await Promise.all(recent.map(async (id) => {
        const s = await kv.get(KEYS.STORY(id));
        return s ? transformItem(JSON.parse(s)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, stories), error: null }, 200, cors);
    }

    if (path === '/api/stories' && method === 'POST') {
      return await createItem(context, 'stories', KEYS.STORIES, KEYS.STORY, cors);
    }

    // MOMENTS
    if (path === '/api/moments' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 100);
      const ids = await cleanOrphans(env, KEYS.MOMENTS, KEYS.MOMENT);
      const recent = ids.slice(0, limit);
      const moments = (await Promise.all(recent.map(async (id) => {
        const m = await kv.get(KEYS.MOMENT(id));
        return m ? transformItem(JSON.parse(m)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, moments), error: null }, 200, cors);
    }

    if (path === '/api/moments' && method === 'POST') {
      return await createItem(context, 'moments', KEYS.MOMENTS, KEYS.MOMENT, cors);
    }

    // PROFILE
    if (path.match(/^\/api\/profile\//) && method === 'GET') {
      const userId = decodeURIComponent(path.split('/api/profile/')[1] || '');
      if (SEED_PROFILE_IDS.has(userId)) {
        return json({ data: null, error: 'Profile not found' }, 404, cors);
      }
      const profile = await kv.get(KEYS.PROFILE(userId));
      if (!profile) return json({ data: null, error: 'Profile not found' }, 404, cors);
      return json({ data: JSON.parse(profile), error: null }, 200, cors);
    }

    if (path === '/api/profile' && method === 'PUT') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const id = (typeof body.id === 'string' && body.id) || actor.id;
      if (id !== actor.id) return json({ error: 'Forbidden' }, 403, cors);
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'profile', actor.id, rateLimitFor(planId, 'profile'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const clean = sanitizeBody(body);
      clean.id = id;
      await kv.put(KEYS.PROFILE(id), JSON.stringify(clean));
      return json({ data: clean, error: null }, 200, cors);
    }

    // SEARCH
    if (path === '/api/search' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const indexJson = await kv.get(KEYS.CONTENT_INDEX);
      if (!indexJson) return json({ data: { results: [], totalCount: 0, isAiRecommended: false } }, 200, cors);
      const index = JSON.parse(indexJson);
      // Filter out seed content from search when real users exist
      const hasReal = await kv.get(KEYS.HAS_REAL_USERS);
      const filtered = hasReal === 'true' ? index.filter(i => !isSeedItem(i)) : index;
      if (!query.trim()) {
        return json({ data: { results: filtered.slice(0, 20).map(transformItem), totalCount: filtered.length, isAiRecommended: false } }, 200, cors);
      }
      const q = query.toLowerCase();
      const matches = filtered.filter((item) =>
        [item.title, item.description, item.content, item.category, item.creator, ...(item.tags || [])]
          .filter(Boolean).some((text) => text.toLowerCase().includes(q))
      );
      return json({ data: { results: matches.slice(0, 20).map(transformItem), totalCount: matches.length, isAiRecommended: matches.length === 0 } }, 200, cors);
    }

    // DELETE ENDPOINTS
    if (path.match(/^\/api\/posts\//) && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/api/posts/')[1] || '');
      return await deleteItem(context, KEYS.POSTS, KEYS.POST, id, cors);
    }

    if (path.match(/^\/api\/thoughts\//) && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/api/thoughts/')[1] || '');
      return await deleteItem(context, KEYS.THOUGHTS, KEYS.THOUGHT, id, cors);
    }

    if (path.match(/^\/api\/stories\//) && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/api/stories/')[1] || '');
      return await deleteItem(context, KEYS.STORIES, KEYS.STORY, id, cors);
    }

    if (path.match(/^\/api\/moments\//) && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/api/moments/')[1] || '');
      return await deleteItem(context, KEYS.MOMENTS, KEYS.MOMENT, id, cors);
    }

    // DELETE ALL USER DATA
    if (path.match(/^\/api\/user\//) && path.endsWith('/data') && method === 'DELETE') {
      const userId = decodeURIComponent(path.split('/api/user/')[1].replace('/data', ''));
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      if (actor.id !== userId) return json({ error: 'Forbidden' }, 403, cors);
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'delete', actor.id, rateLimitFor(planId, 'delete'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);

      let deletedPosts = 0, deletedThoughts = 0, deletedStories = 0, deletedMoments = 0;

      const filterList = async (listKey, getKey, delKey) => {
        const listJson = await kv.get(listKey);
        if (!listJson) return 0;
        const ids = JSON.parse(listJson);
        const remaining = [];
        let deleted = 0;
        for (const id of ids) {
          const item = await kv.get(getKey(id));
          if (item) {
            const parsed = JSON.parse(item);
            if (parsed.userId === userId || parsed.user_id === userId) {
              await purgeStoredMedia(env, parsed);
              try {
                const { bytes } = await resolveStoredMedia(env, parsed);
                if (bytes > 0) await subtractUsage(env, userId, bytes);
              } catch { /* ignore */ }
              await kv.delete(delKey(id));
              deleted++;
            } else {
              remaining.push(id);
            }
          }
        }
        await kv.put(listKey, JSON.stringify(remaining));
        return deleted;
      };

      // Delete profile
      await kv.delete(KEYS.PROFILE(userId));

      // Delete all user content
      deletedPosts = await filterList(KEYS.POSTS, KEYS.POST, KEYS.POST);
      deletedThoughts = await filterList(KEYS.THOUGHTS, KEYS.THOUGHT, KEYS.THOUGHT);
      deletedStories = await filterList(KEYS.STORIES, KEYS.STORY, KEYS.STORY);
      deletedMoments = await filterList(KEYS.MOMENTS, KEYS.MOMENT, KEYS.MOMENT);

      // Remove from content index
      const idxJson = await kv.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(
          idx.filter(i => i.creator?.toLowerCase() !== userId.toLowerCase() && i.id !== `profile-${userId}`)
        ));
      }

      return json({ data: { success: true, deletedPosts, deletedThoughts, deletedStories, deletedMoments }, error: null }, 200, cors);
    }

    // MEDIA UPLOAD — R2 primary warehouse (zero egress), Cloudinary selective.
    // Flow: auth -> plan quota -> mime + per-plan size -> sha256 dedupe ->
    // R2 put (original, required when bound) -> Cloudinary (variants,
    // best-effort when bound) -> usage accounting. secureUrl is ALWAYS the
    // best delivery URL (R2 when available), so the frontend needs no changes.
    if (path === '/api/upload' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const bearer = bearerFrom(request);
      const { planId } = await resolvePlan(env, actor, bearer);
      const quota = planQuota(planId);
      const rl = await rateLimit(kv, 'upload', actor.id, rateLimitFor(planId, 'upload'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);

      let formData;
      try {
        formData = await request.formData();
      } catch {
        return json({ error: 'Invalid form data' }, 400, cors);
      }
      const file = formData.get('file');
      const folder = String(formData.get('folder') || 'equyvo/uploads')
        .replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 120);

      if (!file || typeof file === 'string') return json({ error: 'No file provided' }, 400, cors);
      if (!mimeAllowed(file.type)) return json({ error: 'Only images and videos are allowed' }, 415, cors);

      // Per-plan size cap wins over the global MAX_UPLOAD_MB env.
      const envCapMB = parseInt(env.MAX_UPLOAD_MB, 10) || quota.maxUploadMB;
      const maxBytes = Math.min(quota.maxUploadMB, envCapMB) * 1024 * 1024;
      if (file.size > maxBytes) {
        return json({ error: `File too large for ${quota.label} (max ${Math.min(quota.maxUploadMB, envCapMB)}MB). Upgrade for higher limits.`, code: 'QUOTA_FILE_SIZE', planId }, 413, cors);
      }
      if (file.size <= 0) return json({ error: 'Empty file' }, 400, cors);

      // Storage quota + monthly upload caps: free stays affordable.
      const usage = await getUsage(env, actor.id);
      if (usage.bytes + file.size > quota.storageBytes) {
        return json({ error: `Storage quota exceeded for ${quota.label} (${Math.round(quota.storageBytes / GB)}GB). Delete media or upgrade.`, code: 'QUOTA_STORAGE', planId, usage }, 402, cors);
      }
      if (usage.monthUploads >= quota.monthlyUploads) {
        return json({ error: `Monthly upload limit reached for ${quota.label}. Upgrades reset limits.`, code: 'QUOTA_MONTHLY', planId }, 402, cors);
      }

      // Duplicate detection: same bytes -> same asset, no new Cloudinary cost.
      let bytes = null;
      let hash = '';
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
        hash = await sha256Hex(bytes);
        const existing = await kv.get(KEYS.HASH(hash));
        if (existing) {
          const hit = JSON.parse(existing);
          return json({ data: { ...hit, deduped: true, planId }, error: null }, 200, cors);
        }
      } catch { /* dedupe best-effort; continue to upload */ }

      const cloudName = env.CLOUDINARY_CLOUD_NAME;
      const uploadPreset = env.CLOUDINARY_UPLOAD_PRESET;
      const hasR2 = !!env.EQUYVO_R2;
      const cloudConfigured = !!(cloudName && uploadPreset);
      if (!hasR2 && !cloudConfigured) {
        return json({ error: 'Media storage not configured on server' }, 500, cors);
      }

      // 1) R2 put (primary). Key embeds the content hash, so re-uploads of
      // the same bytes by the same user converge on one object.
      let r2Key = null;
      if (hasR2 && bytes) {
        r2Key = r2KeyFor(actor.id, hash, extFromFile(file));
        try {
          await env.EQUYVO_R2.put(r2Key, bytes, {
            httpMetadata: {
              contentType: file.type || 'application/octet-stream',
              cacheControl: 'public, max-age=31536000, immutable',
            },
            customMetadata: { uploader: String(actor.id).slice(0, 128), sha256: hash },
          });
        } catch (err) {
          // R2 write failed: fall through to Cloudinary-only rather than
          // failing the upload outright.
          r2Key = null;
        }
      }

      // 2) Cloudinary (selective transforms). Best-effort when R2 already
      // holds the original; required when there is no R2 copy.
      let result = null;
      if (cloudConfigured) {
        const cloudForm = new FormData();
        // Re-wrap bytes so the upstream upload works even after hashing.
        const upFile = bytes ? new File([bytes], file.name || 'upload', { type: file.type }) : file;
        cloudForm.append('file', upFile);
        cloudForm.append('upload_preset', uploadPreset);
        cloudForm.append('folder', folder);

        const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
          method: 'POST',
          body: cloudForm,
        });

        result = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          if (!r2Key) {
            return json({ error: result.error?.message || 'Upload failed' }, 500, cors);
          }
          // R2 holds the original: degrade gracefully without variants.
          result = null;
        }
      }

      const resourceType = result?.resource_type
        || (String(file.type).startsWith('video/') ? 'video' : 'image');
      const variants = result ? cloudinaryVariants(result.secure_url, result.resource_type, quota.quality) : null;
      const r2Url = r2Key ? r2DeliveryUrl(request, env, r2Key) : null;
      const payload = {
        publicId: result?.public_id || null,
        // Best delivery URL first: R2 (zero egress) -> Cloudinary fallback.
        secureUrl: r2Url || result?.secure_url,
        originalUrl: r2Url || result?.secure_url,
        delivery: r2Url ? 'r2' : 'cloudinary',
        resourceType,
        format: result?.format || extFromFile(file),
        bytes: result?.bytes || file.size || 0,
        width: result?.width,
        height: result?.height,
        createdAt: result?.created_at || new Date().toISOString(),
        duration: result?.duration,
        variants,
        r2Key,
        store: r2Key && result ? 'r2+cloudinary' : r2Key ? 'r2' : 'cloudinary',
        planId,
      };
      try {
        if (hash) await kv.put(KEYS.HASH(hash), JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 90 });
        if (payload.publicId) {
          await kv.put(KEYS.MEDIA(payload.publicId), JSON.stringify({ bytes: payload.bytes, r2Key }), { expirationTtl: 60 * 60 * 24 * 365 });
        }
      } catch { /* ignore */ }
      const nextUsage = await addUsage(env, actor.id, Number(payload.bytes || 0));

      return json({
        data: payload,
        usage: { usedBytes: nextUsage.bytes, quotaBytes: quota.storageBytes },
        error: null,
      }, 200, cors);
    }

    // R2 MEDIA DELIVERY — public GET/HEAD with Range + immutable cache.
    // Works with zero DNS setup (same-origin proxy). Set R2_PUBLIC_BASE to a
    // custom domain / R2.dev URL and uploads will hand out those URLs
    // directly, bypassing this proxy for even cheaper delivery.
    if ((path === '/api/media' || path.startsWith('/api/media/')) && (method === 'GET' || method === 'HEAD')) {
      const key = decodeURIComponent(path.slice('/api/media/'.length));
      return await serveR2(request, env, key, cors, method);
    }

    // USER POSTS
    if (path.match(/^\/api\/users\//) && path.endsWith('/posts') && method === 'GET') {
      const userId = decodeURIComponent(path.split('/api/users/')[1].replace('/posts', ''));
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      const posts = (await Promise.all(ids.map(async (id) => {
        const p = await kv.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      const userPosts = posts.filter(p =>
        p.userId === userId || p.id === userId
      );
      return json({ data: await filterSeed(env, userPosts), error: null }, 200, cors);
    }

    // CONTENT INDEX
    if (path === '/api/content-index' && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'index', actor.id, rateLimitFor(planId, 'index'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const clean = sanitizeBody(body);
      clean.id = String(clean.id || generateId()).slice(0, 64);
      const indexJson = await kv.get(KEYS.CONTENT_INDEX);
      const index = indexJson ? JSON.parse(indexJson) : [];
      const existingIdx = index.findIndex((i) => i && i.id === clean.id);
      if (existingIdx >= 0) index[existingIdx] = clean;
      else index.unshift(clean);
      await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(index.slice(0, 1000)));
      return json({ data: { success: true }, error: null }, 200, cors);
    }

    // ---- CREATOR ECONOMY MVP (V3): tips + paid subscriptions ledger ----
    // Money movement itself stays in Razorpay (api.acronous.com verify).
    // Equyvo records *verified* intents + takes PLATFORM_FEE_BPS. Never trust
    // client amounts: amounts are re-validated server-side (positive ints).
    if (path === '/api/creator/setup' && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const quota = planQuota(planId);
      if (!quota.creator) return json({ error: 'Creator plan required', code: 'UPGRADE_CREATOR', planId }, 402, cors);
      const clean = sanitizeBody(body);
      const settings = {
        userId: actor.id,
        displayName: String(clean.displayName || actor.username || '').slice(0, 80),
        bio: String(clean.bio || '').slice(0, 500),
        tipEnabled: clean.tipEnabled !== false,
        subPriceInr: clamp(Math.floor(Number(clean.subPriceInr || 0)), 0, 100000),
        updatedAt: new Date().toISOString(),
      };
      await kv.put(KEYS.CREATOR(actor.id), JSON.stringify(settings));
      return json({ data: settings, error: null }, 200, cors);
    }

    if (path.match(/^\/api\/creator\//) && method === 'GET') {
      const userId = decodeURIComponent(path.split('/api/creator/')[1] || '');
      const raw = await kv.get(KEYS.CREATOR(userId));
      if (!raw) return json({ data: null, error: null }, 200, cors);
      return json({ data: JSON.parse(raw), error: null }, 200, cors);
    }

    if (path === '/api/tips' && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'tips', actor.id, rateLimitFor(planId, 'tips'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const clean = sanitizeBody(body);
      const to = String(clean.to || clean.creator || '').slice(0, 200);
      const amountInr = Math.floor(Number(clean.amountInr || 0));
      if (!to || to === actor.id) return json({ error: 'Invalid recipient' }, 400, cors);
      if (!Number.isFinite(amountInr) || amountInr < 10 || amountInr > 100000) {
        return json({ error: 'Tip must be ₹10–₹1,00,000' }, 400, cors);
      }
      const fee = Math.floor((amountInr * PLATFORM_FEE_BPS) / 10000);
      const tip = {
        id: generateId(), from: actor.id, to, amountInr,
        platformFeeInr: fee, creatorGetsInr: amountInr - fee,
        // Payment itself is completed via Razorpay verify on api.acronous.com;
        // this ledger entry is 'pending' until the client posts verify proof.
        status: 'pending',
        paymentId: String(clean.paymentId || '').slice(0, 100),
        createdAt: new Date().toISOString(),
      };
      await kv.put(KEYS.TIP(tip.id), JSON.stringify(tip));
      const listJson = await kv.get(KEYS.TIPS_LIST);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(tip.id);
      await kv.put(KEYS.TIPS_LIST, JSON.stringify(ids.slice(0, 1000)));
      return json({ data: tip, error: null }, 201, cors);
    }

    if (path === '/api/subscriptions' && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'subs', actor.id, rateLimitFor(planId, 'subs'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const clean = sanitizeBody(body);
      const creator = String(clean.creator || '').slice(0, 200);
      const plan = String(clean.plan || 'monthly').slice(0, 20);
      const amountInr = Math.floor(Number(clean.amountInr || 0));
      if (!creator || creator === actor.id) return json({ error: 'Invalid creator' }, 400, cors);
      if (!Number.isFinite(amountInr) || amountInr < 29 || amountInr > 100000) {
        return json({ error: 'Subscription must be ₹29–₹1,00,000' }, 400, cors);
      }
      const fee = Math.floor((amountInr * PLATFORM_FEE_BPS) / 10000);
      const sub = {
        id: generateId(), fan: actor.id, creator, plan, amountInr,
        platformFeeInr: fee, creatorGetsInr: amountInr - fee,
        status: 'pending', paymentId: String(clean.paymentId || '').slice(0, 100),
        createdAt: new Date().toISOString(),
      };
      await kv.put(KEYS.SUB(sub.id), JSON.stringify(sub));
      const listJson = await kv.get(KEYS.SUBS_LIST);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(sub.id);
      await kv.put(KEYS.SUBS_LIST, JSON.stringify(ids.slice(0, 2000)));
      return json({ data: sub, error: null }, 201, cors);
    }

    // ---- BUSINESS (V4 stub): gated by eq_business ----
    if (path === '/api/business/profile' && (method === 'POST' || method === 'PUT')) {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      if (planId !== 'eq_business') return json({ error: 'Business plan required', code: 'UPGRADE_BUSINESS', planId }, 402, cors);
      const clean = sanitizeBody(body);
      clean.userId = actor.id;
      clean.updatedAt = new Date().toISOString();
      await kv.put(KEYS.BIZ(actor.id), JSON.stringify(clean));
      return json({ data: clean, error: null }, 200, cors);
    }

    // ---- ADS (V4 stub): free users are ad-eligible; paid users opt out ----
    if (path === '/api/ads/eligibility' && method === 'GET') {
      const actor = await getActor(request, env);
      const planId = actor ? (await resolvePlan(env, actor, bearerFrom(request))).planId : DEFAULT_PLAN_ID;
      const quota = planQuota(planId);
      const ads = quota.ads === true ? 'ads' : quota.ads === 'light' ? 'ad-light' : 'ad-free';
      return json({ data: { planId, ads, showAds: ads !== 'ad-free' }, error: null }, 200, cors);
    }

    return json({ error: 'Not found: ' + method + ' ' + path }, 404, cors);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return json({ error: (err && err.message) || 'Internal error', requestId }, status, cors);
  }
};
