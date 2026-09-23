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
  // Contabo shared brain for AI search/feed suggestions (best-effort proxy).
  BRAIN_URL?: string;
  BRAIN_BASE_URL?: string;
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
  // Backend AI interest graph (no frontend changes required).
  INTERESTS: (userId) => 'interests:' + userId,
  POP: (itemId) => 'pop:' + itemId,
  ORPHAN_SWEEP_AT: 'maint:orphan_sweep_at',
  // Privacy: server-side follow graph (source of truth for private accounts).
  FOLLOWING: (userId) => 'following:' + userId,
  FOLLOWERS: (userId) => 'followers:' + userId,
  FOLLOW_REQ: (userId) => 'followreq:' + userId,
  // Safety: reports ledger + per-item flag counters + moderation queue.
  REPORTS_LIST: 'reports:list',
  REPORT: (id) => 'report:' + id,
  FLAGS: (kind, id) => 'flags:' + kind + ':' + id,
  MOD_QUEUE: 'mod:queue',
};

// ── Backend AI helpers (mirrors worker/src/kv.ts): interest graph + smart
// search/feed ranking. Kept dependency-free and bounded so Pages Functions
// stay fast (no per-request full-list scans, no blocking brain calls).
const AI_SYNONYMS = {
  photo: ['photography', 'camera', 'picture'], photography: ['photo', 'camera'],
  video: ['film', 'vlog', 'reels'], music: ['song', 'beat', 'audio'],
  food: ['recipe', 'cooking', 'cuisine'], fitness: ['workout', 'gym', 'yoga', 'health'],
  travel: ['trip', 'vacation', 'tourism'], tech: ['technology', 'gadgets', 'ai', 'software'],
  ai: ['artificial intelligence', 'tech'], fashion: ['style', 'outfit', 'clothing'],
  art: ['drawing', 'design', 'painting'], game: ['gaming', 'games', 'esports'],
};
function aiNormToken(s) { return String(s || '').toLowerCase().trim().replace(/^#+/, '').slice(0, 40); }
function aiTokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9#\s-]/g, ' ').split(/\s+/)
    .map((t) => t.replace(/^#+/, '').trim()).filter((t) => t.length >= 2 && t.length <= 30).slice(0, 20);
}
function aiExpand(tokens) {
  const out = new Set();
  for (const t of tokens) {
    out.add(t);
    const syns = AI_SYNONYMS[t];
    if (syns) for (const s of syns.slice(0, 3)) out.add(s);
    if (t.length >= 4) out.add(t.slice(0, Math.max(3, t.length - 1)));
  }
  return [...out].slice(0, 30);
}
function aiFuzzy(a, b) {
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i] !== b[i]) { d++; if (d > 1) return false; } }
  return d <= 1;
}
async function aiGetInterests(env, userId) {
  if (!userId) return {};
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.INTERESTS(userId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function aiParseInterests(v) {
  const out = {};
  if (!v) return out;
  for (const raw of String(v).split(',')) {
    const t = aiNormToken(raw);
    if (t) out[t] = 5;
  }
  return out;
}
function aiMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b || {})) out[k] = Math.min(100, (Number(out[k] || 0) + Number(b[k] || 0)));
  return out;
}
async function aiRecordEngagement(env, userId, sig) {
  if (!userId) return {};
  const wmap = { view: 1, like: 3, unlike: -2, comment: 4, share: 5, save: 4, create: 5, vote: 2 };
  const w = wmap[String(sig.action || 'view').toLowerCase()] ?? 1;
  const toks = [];
  if (sig.category) toks.push(aiNormToken(sig.category));
  if (sig.creator) toks.push(aiNormToken(sig.creator));
  for (const t of sig.tags || []) { const n = aiNormToken(t); if (n) toks.push(n); }
  if (!toks.length) return aiGetInterests(env, userId);
  try {
    const cur = await aiGetInterests(env, userId);
    for (const t of toks.slice(0, 8)) cur[t] = Math.max(-10, Math.min(100, (Number(cur[t] || 0) + w)));
    const top = Object.entries(cur).sort((a, b) => b[1] - a[1]).slice(0, 60);
    const next = Object.fromEntries(top);
    await env.EQUYVO_KV.put(KEYS.INTERESTS(userId), JSON.stringify(next));
    return next;
  } catch { return {}; }
}
async function aiBumpPop(env, itemId, delta) {
  if (!itemId) return;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.POP(itemId));
    const cur = raw ? parseInt(raw, 10) || 0 : 0;
    await env.EQUYVO_KV.put(KEYS.POP(itemId), String(Math.max(0, cur + delta)), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch {}
}
function aiPopOf(item, pops) {
  const kv = Number(pops[item?.id] || 0);
  const likes = Number(item?.likes ?? item?.likes_count ?? 0) || 0;
  const comments = Number(item?.comments ?? item?.comments_count ?? 0) || 0;
  const reacts = Number(item?.reacts ?? 0) || 0;
  return kv * 2 + likes + reacts * 2 + comments * 3;
}
function aiRecency(publishedAt) {
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const h = (Date.now() - t) / 3600000;
  if (h < 0 || h < 6) return 8;
  if (h < 24) return 5;
  if (h < 72) return 3;
  if (h < 168) return 1;
  return 0;
}
function aiInterestBoost(item, interests) {
  const top = Object.entries(interests || {}).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k);
  if (!top.length) return 0;
  const hay = [String(item?.category || ''), ...((item?.tags) || []), String(item?.creator || item?.user || ''), String(item?.title || '')].join(' ').toLowerCase();
  let s = 0;
  for (const t of top) if (t && hay.includes(t)) s += 6;
  return Math.min(30, s);
}
function aiBrainBase(env) {
  const c = String(env.BRAIN_URL || env.BRAIN_BASE_URL || '').trim().replace(/\/$/, '');
  return c || 'https://brain.acronous.com';
}
async function aiFetchJson(url, init, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      if (!r.ok) return null;
      return await r.json().catch(() => null);
    } finally { clearTimeout(t); }
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Privacy helpers — server-side visibility enforcement. The frontend only ever
// sends/receives the generic `visibility` field ('public' | 'followers' |
// 'private' | 'hidden'); all graph checks happen here, never in the client.
// ---------------------------------------------------------------------------

function normalizeVisibility(v, fallback = 'public') {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'public' || s === 'followers' || s === 'private' || s === 'hidden') return s;
  if (s === 'friends' || s === 'followers-only') return 'followers';
  if (s === 'only-me' || s === 'onlyme' || s === 'me') return 'private';
  return fallback;
}

function itemOwnerId(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.ownerId || item.userId || item.user_id || '');
}

function itemVisibility(item, authorProfile) {
  if (!item || typeof item !== 'object') return 'public';
  // Explicit per-item setting wins (incl. legacy flags).
  const raw = item.visibility || item.audience;
  if (raw) return normalizeVisibility(raw);
  if (item.isPrivate === true || item.hidden === true || item.hideFromPublic === true) {
    // Owner-only unless the author scoped it to followers.
    return 'private';
  }
  // Private accounts default new/legacy content to followers-only.
  if (authorProfile && authorProfile.isPrivate === true) return 'followers';
  return 'public';
}

function isRemovedItem(item) {
  if (!item || typeof item !== 'object') return false;
  const m = item.moderation;
  if (m && (m.status === 'removed' || m.status === 'quarantined')) return true;
  return item.removed === true;
}

async function getStoredProfile(env, userId) {
  if (!userId) return null;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.PROFILE(userId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function readIdList(env, key) {
  try {
    const raw = await env.EQUYVO_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

async function isFollowingPair(env, viewerId, authorId) {
  if (!viewerId || !authorId || viewerId === authorId) return viewerId === authorId;
  try {
    const [following, followers] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(viewerId)),
      readIdList(env, KEYS.FOLLOWERS(authorId)),
    ]);
    const vl = String(viewerId).toLowerCase();
    if (following.some((x) => String(x).toLowerCase() === String(authorId).toLowerCase())) return true;
    if (followers.some((x) => String(x).toLowerCase() === vl)) return true;
    return false;
  } catch { return false; }
}

// Light viewer resolution for PUBLIC reads: verified JWT when present,
// otherwise the plain X-User-Id header. Never rejects — anonymous viewers
// simply see public content only.
async function getViewer(request, env) {
  try {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (token) {
        const user = await verifyCognitoToken(token, env);
        if (user) return { id: user.id, email: user.email || '' };
      }
    }
  } catch { /* fall through to header */ }
  try {
    const h = request.headers.get('X-User-Id') || request.headers.get('X-User-Email') || '';
    const q = new URL(request.url).searchParams;
    const id = String(h || q.get('viewerId') || q.get('viewer') || q.get('userId') || q.get('user_id') || '').slice(0, 200);
    if (id) return { id, email: id.includes('@') ? id : '' };
  } catch { /* ignore */ }
  return null;
}

async function canViewerSeeItem(env, viewer, item, profileCache) {
  if (isRemovedItem(item)) {
    // Owners can still see their own quarantined item (so delete works);
    // everyone else cannot.
    const owner = itemOwnerId(item);
    if (viewer && owner && viewer.id === owner) return true;
    return false;
  }
  const owner = itemOwnerId(item);
  if (viewer && owner && viewer.id === owner) return true;
  const vis = itemVisibility(item, null);
  if (vis === 'private' || vis === 'hidden') return false; // owner-only (owner checked above)
  let authorProfile = null;
  if (owner) {
    if (profileCache && profileCache.has(owner)) authorProfile = profileCache.get(owner);
    else {
      authorProfile = await getStoredProfile(env, owner);
      if (profileCache) profileCache.set(owner, authorProfile);
    }
  }
  // Recompute visibility with the author profile (private accounts).
  const eff = itemVisibility(item, authorProfile);
  if (eff === 'private' || eff === 'hidden') return false;
  if (authorProfile && authorProfile.isPrivate === true) {
    if (!viewer) return false;
    return await isFollowingPair(env, viewer.id, owner);
  }
  if (eff === 'followers') {
    if (!viewer || !owner) return false;
    return await isFollowingPair(env, viewer.id, owner);
  }
  return true;
}

async function filterVisibleItems(env, viewer, items) {
  if (!Array.isArray(items)) return [];
  const cache = new Map();
  const out = [];
  for (const it of items) {
    try {
      if (await canViewerSeeItem(env, viewer, it, cache)) out.push(it);
    } catch { /* skip undecidable items */ }
  }
  return out;
}

// Public-safe profile subset for strangers viewing a private account.
// Mirrors Facebook/Instagram: avatar + basic details only, never media,
// email, or private fields.
function publicSafeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    avatar: profile.avatar || '',
    bio: typeof profile.bio === 'string' ? String(profile.bio).slice(0, 300) : '',
    isPrivate: true,
    restricted: true,
    followers: Number(profile.followers || 0) || 0,
    following: Number(profile.following || 0) || 0,
    verified: !!profile.verified,
  };
}

// ---------------------------------------------------------------------------
// Content-safety helpers — server-only. Blocklists, heuristics, and the shared
// Acronous brain check all run here. The client only ever receives a generic
// "violates community guidelines" message; internals are never exposed.
// ---------------------------------------------------------------------------

// Hard-block patterns: sexual content involving minors, bestiality,
// non-consensual / assault, terrorism / weapons of mass harm, CSAM-adjacent
// euphemisms, and direct threats. Matched content is rejected outright.
const SAFETY_BLOCK_PATTERNS = [
  /(\b|_)(child|kid|toddler|infant|minor|underage|teen|schoolgirl|schoolboy|loli|shota)(\b|_)?[^.]{0,40}?(sex|nude|naked|porn|xxx|explicit|erotic|nsfw)/i,
  /(sex|nude|naked|porn|xxx|explicit|erotic|nsfw)[^.]{0,40}?(\b|_)(child|kid|toddler|infant|minor|underage|loli|shota)/i,
  /\b(cp|csam|child\s?porn)\b/i,
  /\b(bestiality|zoophilia)\b/i,
  /\b(rape|gangbang|forced\s?sex|non[\s-]?consensual)\b/i,
  /\b(how to (make|build).{0,30}(bomb|explosive|bioweapon|chemical weapon|nuke|dirty bomb))\b/i,
  /\b(join (isis|al-?qaeda|terror))\b/i,
  /\b(i will kill you|i['’]m going to kill (you|them)|kill all (muslims|christians|jews|hindus|whites|blacks))\b/i,
  /\b(sell (drugs|cocaine|heroin|meth)|buy (cocaine|heroin|meth))\b/i,
];

// Review patterns: adult/sexual, graphic gore, self-harm, hate, scams.
// Matched content is quarantined (owner-only) pending automated re-check.
const SAFETY_REVIEW_PATTERNS = [
  /\b(porn|xxx|hentai|escort|onlyfans|nude|naked|sex\s?tape|erotic)\b/i,
  /\b(behead|gore|dismember|mutilat)\b/i,
  /\b(kill myself|suicide|self[\s-]?harm|cutting myself)\b/i,
  /\b(fuck (you|off)|slut|whore|retard|kike|chink|fag(got)?)\b/i,
  /\b(send money|wire transfer|gift card|crypto (doubling|giveaway)|you (have )?won (a|₹|\$))\b/i,
];

function moderateTextLocal(text) {
  const s = String(text || '');
  if (!s.trim()) return { verdict: 'allow' };
  if (s.length > 20000) return { verdict: 'review', reason: 'length' };
  for (const re of SAFETY_BLOCK_PATTERNS) {
    if (re.test(s)) return { verdict: 'block', reason: 'blocked' };
  }
  let hits = 0;
  for (const re of SAFETY_REVIEW_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(s)) hits++;
  }
  if (hits >= 2) return { verdict: 'block', reason: 'blocked' };
  if (hits === 1) return { verdict: 'review', reason: 'review' };
  return { verdict: 'allow' };
}

// Best-effort shared-brain safety survey: asks the Acronous brain (which
// continuously surveys the internet on content-safety guidance) to classify
// the text. Fail-open on timeout/error so uploads stay fast; the local
// blocklist above is always fail-closed.
async function brainSafetyCheck(env, text) {
  const s = String(text || '').slice(0, 2000);
  if (!s.trim()) return null;
  try {
    const base = aiBrainBase(env);
    const data = await aiFetchJson(base + '/v1/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: s, source: 'equyvo-safety' }),
    }, 2200);
    if (data && typeof data === 'object') {
      if (data.safe === false || data.block === true) return 'block';
      if (data.review === true || data.quarantine === true) return 'review';
      if (Array.isArray(data.categories) && data.categories.some((c) => /child|csam|terror|non-consensual|assault/i.test(String(c)))) return 'block';
    }
  } catch { /* fail-open */ }
  return null;
}

// Returns 'allow' | 'review' | 'block'. Throws a generic 400 on block so the
// API layer can surface a frontend-safe message.
async function moderateContent(env, fields) {
  const text = Object.values(fields || {}).filter((v) => typeof v === 'string').join('\n').slice(0, 8000);
  const local = moderateTextLocal(text);
  if (local.verdict === 'block') {
    const e = new Error('Content violates community guidelines and was not published.');
    e.status = 400; e.code = 'CONTENT_BLOCKED';
    throw e;
  }
  if (local.verdict === 'review') return 'review';
  try {
    const brain = await brainSafetyCheck(env, text);
    if (brain === 'block') {
      const e = new Error('Content violates community guidelines and was not published.');
      e.status = 400; e.code = 'CONTENT_BLOCKED';
      throw e;
    }
    if (brain === 'review') return 'review';
  } catch (e) {
    if (e && e.code === 'CONTENT_BLOCKED') throw e;
  }
  return 'allow';
}

async function enqueueModeration(env, entry) {
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.MOD_QUEUE);
    const q = raw ? JSON.parse(raw) : [];
    q.unshift({ ...entry, at: new Date().toISOString() });
    await env.EQUYVO_KV.put(KEYS.MOD_QUEUE, JSON.stringify(q.slice(0, 500)));
  } catch { /* best-effort */ }
}

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

// Clean orphaned IDs — lag fix: validate only the head inline (first 120)
// in parallel; the full sweep runs throttled in the background. The old code
// did up to 500 sequential KV reads on EVERY feed/search request.
async function cleanOrphans(env, listKey, getKey) {
  const listJson = await env.EQUYVO_KV.get(listKey);
  if (!listJson) return [];
  let ids;
  try { ids = JSON.parse(listJson); } catch { return []; }
  if (!Array.isArray(ids)) return [];
  const HEAD = 120;
  const head = ids.slice(0, HEAD);
  const got = await Promise.all(head.map(async (id) => {
    try { const d = await env.EQUYVO_KV.get(getKey(id)); return d ? id : null; }
    catch { return id; }
  }));
  const validHead = got.filter(Boolean);
  if (validHead.length !== head.length) {
    const fixed = [...validHead, ...ids.slice(HEAD)];
    try { await env.EQUYVO_KV.put(listKey, JSON.stringify(fixed)); } catch {}
    return fixed;
  }
  return ids;
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
  engagement: 60,
  suggest: 60,
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
  const norm = (v) => String(v || '').trim().toLowerCase();
  const owner = item && (item.ownerId || item.userId || item.user_id || '');
  // Account ids compared case-insensitively so legit owners never get a
  // false ownership rejection from casing differences.
  if (owner) {
    const o = norm(owner);
    if (o && (o === norm(actor.id) || o === norm(actor.email) || (actor.username && o === norm(actor.username)))) return true;
  }
  // Legacy items keyed ownership by display name; accept a match on the
  // human-readable creator field too so old uploads stay deletable.
  const named = item && (item.creator || item.user || item.username || '');
  if (named) {
    const n = norm(named);
    if (actor.username && n === norm(actor.username)) return true;
    if (actor.email && (n === norm(actor.email) || n === norm(String(actor.email).split('@')[0]))) return true;
  }
  return false;
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
  // Ownership is authoritative server-side: the verified caller owns the
  // item, regardless of what display-name fields the client sent. Only the
  // owning account can ever delete this item; other accounts may only hide
  // it from their own view (enforced in deleteItem + hide is per-viewer).
  const displayName = String(clean.user || clean.creator || actor.username || actor.email?.split('@')[0] || 'Unknown').slice(0, 80);
  // Per-item visibility: explicit client choice wins; otherwise inherit the
  // author's account type (private accounts default to followers-only).
  let visibility = 'public';
  try {
    const authorProfile = await getStoredProfile(env, actor.id);
    const fallback = authorProfile && authorProfile.isPrivate === true ? 'followers' : 'public';
    visibility = normalizeVisibility(clean.visibility || clean.audience || (clean.isPrivate === true ? 'private' : ''), fallback);
  } catch { visibility = normalizeVisibility(clean.visibility || clean.audience || 'public'); }
  // Content safety (server-only): illegal / child-unsafe content is rejected
  // with a generic message; suspicious content is quarantined to owner-only.
  let safety = 'allow';
  try {
    safety = await moderateContent(env, {
      text: String(clean.content || clean.title || clean.description || ''),
      tags: Array.isArray(clean.tags) ? clean.tags.join(' ') : String(clean.tags || ''),
      category: String(clean.category || (clean.categories && clean.categories[0]) || ''),
    });
  } catch (e) {
    const status = (e && e.status) || 400;
    return json({ error: (e && e.message) || 'Content violates community guidelines and was not published.' }, status, cors);
  }
  const item = {
    ...clean,
    id,
    createdAt: now,
    ownerId: actor.id,
    userId: actor.id,
    user: displayName,
    creator: String(clean.creator || displayName).slice(0, 80),
    visibility,
  };
  delete item.audience;
  if (safety === 'review') {
    // Quarantine: owner-only until review clears. Never exposed as an error
    // detail to the client beyond the generic visibility behavior.
    item.visibility = 'private';
    item.moderation = { status: 'quarantined', at: now };
    try { await enqueueModeration(env, { kind, id, owner: actor.id, reason: 'auto-review' }); } catch {}
  }
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
  // Index every content type so search + AI feed see thoughts/stories/moments
  // too (posts-only index left most content invisible). Best-effort.
  try {
    const text = String(item.content || item.title || item.description || '').slice(0, 500);
    const idxJson = await kv.get(KEYS.CONTENT_INDEX);
    const idx = idxJson ? JSON.parse(idxJson) : [];
    const entry = {
      id,
      title: String(item.title || text.slice(0, 100) || kind),
      description: text.slice(0, 300),
      type: kind === 'posts' ? 'post' : kind.replace(/s$/, ''),
      authorId: actor.id,
      visibility: item.visibility || 'public',
      creator: String(item.user || item.creator || item.user_id || item.userId || ''),
      creatorAvatar: String(item.avatar || ''),
      views: String(item.views ?? '0'),
      thumbnail: String(item.thumbnail || item.image || item.media || ''),
      category: String((item.categories && item.categories[0]) || item.category || (Array.isArray(item.tags) && item.tags[0]) || 'General'),
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 10) : [],
      publishedAt: now,
      content: text,
      likes: Number(item.likes ?? item.likes_count ?? 0) || 0,
      comments: Number(item.comments ?? item.comments_count ?? 0) || 0,
    };
    const ex = idx.findIndex((i) => i && i.id === id);
    if (ex >= 0) idx[ex] = entry; else idx.unshift(entry);
    await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.slice(0, 1000)));
  } catch {}
  // New content boosts the author's interest graph (zero frontend changes).
  try {
    if (actor && actor.id) await aiRecordEngagement(env, actor.id, { category: String(item.category || ''), tags: Array.isArray(item.tags) ? item.tags : [], creator: String(item.user || ''), action: 'create' });
  } catch {}
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

  // Strict owner-only delete: only the account that uploaded the content can
  // delete it from Equyvo. Other accounts may only hide it from their own
  // view (per-viewer hide lists live on the client; the server never deletes
  // on their behalf). The single exception is ownerless legacy items (no
  // account id stored at all), which a verified signer may clean up.
  const owner = parsed && (parsed.ownerId || parsed.userId || parsed.user_id || '');
  const namedOwner = parsed && (parsed.creator || parsed.user || '');
  const owned = owns(parsed, actor);
  const ownerless = !owner || owner === 'anonymous';
  const canDelete = owned || (actor.verified && ownerless && (!namedOwner || namedOwner === 'anonymous'));
  if (!canDelete) return json({ error: 'Only the account that posted this can delete it.' }, 403, cors);

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
    // Lag fix: never block responses on maintenance. One cheap flag read;
    // the one-time seed purge runs in the background via waitUntil.
    try {
      const purged = await env.EQUYVO_KV.get(SEED_PURGED_KEY);
      if (!purged) {
        const bg = (async () => {
          try { await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true'); } catch {}
          try { await purgeSeedData(env); } catch {}
        })();
        if (context && context.waitUntil) context.waitUntil(bg);
        else await bg;
      }
    } catch {}

    const kv = env.EQUYVO_KV;

    // HEALTH (public, versioned for deploy verification; honest KV check)
    if (path === '/api/health' && method === 'GET') {
      try {
        await kv.get(KEYS.NEXT_ID);
        return json({ status: 'ok', kv: 'up', version: env.APP_VERSION || '1.0.0', requestId, timestamp: new Date().toISOString() }, 200, cors);
      } catch {
        return json({ status: 'down', kv: 'down', version: env.APP_VERSION || '1.0.0', requestId, timestamp: new Date().toISOString() }, 503, cors);
      }
    }

    if (path === '/api/warmup' && method === 'GET') {
      try { await kv.get(KEYS.NEXT_ID); } catch {}
      return json({ status: 'ok', requestId, timestamp: new Date().toISOString() }, 200, cors);
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

    // RAZORPAY STANDARD CHECKOUT (same-origin proxy to central billing) ────
    //   POST /api/create-order   -> central /v1/billing/order
    //   POST /api/verify-payment -> central /v1/billing/verify
    // Secrets stay in the central billing worker — Equyvo holds none. The
    // caller's Bearer token is forwarded untouched; the browser only ever
    // sees key_id + order_id, and returns payment_id + signature for verify.
    if ((path === '/api/create-order' || path === '/api/verify-payment') && method === 'POST') {
      const bearer = bearerFrom(request);
      if (!bearer) return json({ error: 'Please sign in first.' }, 401, cors);
      let body: any = {};
      try { body = (await request.json()) || {}; } catch { return json({ error: 'Invalid JSON body.' }, 400, cors); }
      if (path === '/api/create-order' && body.amount != null && body.plan == null) {
        const amount = Math.floor(Number(body.amount));
        if (!Number.isFinite(amount) || amount < 100) {
          return json({ error: 'Amount must be an integer >= 100 paise.' }, 400, cors);
        }
      }
      if (path === '/api/verify-payment' && (!body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature)) {
        return json({ ok: false, error: 'Missing payment fields.' }, 400, cors);
      }
      const base = (env.BILLING_BASE_URL || 'https://api.acronous.com').replace(/\/$/, '');
      const target = base + (path === '/api/create-order' ? '/v1/billing/order' : '/v1/billing/verify');
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
          body: JSON.stringify(body),
        });
        const data = await upstream.json().catch(() => ({ error: 'Bad billing response.' }));
        return json(data, upstream.status, cors);
      } catch {
        return json({ error: 'Billing service unreachable. Please try again.' }, 502, cors);
      }
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

    // POSTS (interest-ranked when userId/sort present; plain otherwise —
    // existing frontend keeps working with zero changes).
    // Visibility-enforced: private/followers-only items are only returned to
    // authorized viewers; removed/quarantined items are owner-only.
    if (path === '/api/posts' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '50', 10), 1, 100);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || '').slice(0, 200);
      const sort = String(url.searchParams.get('sort') || '').toLowerCase();
      const viewer = await getViewer(request, env);
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      // Over-fetch to compensate for visibility filtering, then paginate.
      const recent = ids.slice(0, Math.min(ids.length, (limit + offset) * 3 + 20));
      const posts = (await Promise.all(recent.map(async (id) => {
        const p = await kv.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      const seedFiltered = await filterSeed(env, posts);
      const filtered = await filterVisibleItems(env, viewer, seedFiltered);
      const wantRank = sort === 'relevant' || sort === 'foryou' || !!userId || !!url.searchParams.get('interests');
      if (wantRank) {
        try {
          const interests = aiMerge(await aiGetInterests(env, userId), aiParseInterests(url.searchParams.get('interests')));
          const pops = {};
          await Promise.all(filtered.slice(0, 100).map(async (it) => {
            try { const r = await kv.get(KEYS.POP(it.id)); if (r) pops[it.id] = parseInt(r, 10) || 0; } catch {}
          }));
          const scored = filtered.map((it) => ({
            it,
            s: aiPopOf(it, pops) / 5 + aiRecency(it.createdAt || it.time) + aiInterestBoost({ category: (it.categories && it.categories[0]) || '', tags: it.tags || [], creator: it.user || '', title: it.content || '' }, interests),
          })).sort((a, b) => b.s - a.s);
          const page = scored.slice(offset, offset + limit).map((x) => x.it);
          if (Object.keys(interests).length) return json({ data: page, error: null, meta: { personalized: true } }, 200, cors);
          return json({ data: page, error: null }, 200, cors);
        } catch {}
      }
      return json({ data: filtered.slice(offset, offset + limit), error: null }, 200, cors);
    }

    if (path === '/api/posts' && method === 'POST') {
      return await createItem(context, 'posts', KEYS.POSTS, KEYS.POST, cors);
    }

    // THOUGHTS (visibility-enforced; see POSTS).
    if (path === '/api/thoughts' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 100);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const viewer = await getViewer(request, env);
      const ids = await cleanOrphans(env, KEYS.THOUGHTS, KEYS.THOUGHT);
      const page = ids.slice(0, Math.min(ids.length, (offset + limit) * 3 + 20));
      const thoughts = (await Promise.all(page.map(async (id) => {
        const t = await kv.get(KEYS.THOUGHT(id));
        return t ? transformItem(JSON.parse(t)) : null;
      }))).filter(Boolean);
      const visible = await filterVisibleItems(env, viewer, await filterSeed(env, thoughts));
      return json({ data: visible.slice(offset, offset + limit), error: null }, 200, cors);
    }

    if (path === '/api/thoughts' && method === 'POST') {
      return await createItem(context, 'thoughts', KEYS.THOUGHTS, KEYS.THOUGHT, cors);
    }

    // STORIES (visibility-enforced; see POSTS).
    if (path === '/api/stories' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 100);
      const viewer = await getViewer(request, env);
      const ids = await cleanOrphans(env, KEYS.STORIES, KEYS.STORY);
      const recent = ids.slice(0, Math.min(ids.length, limit * 3 + 20));
      const stories = (await Promise.all(recent.map(async (id) => {
        const s = await kv.get(KEYS.STORY(id));
        return s ? transformItem(JSON.parse(s)) : null;
      }))).filter(Boolean);
      const visible = await filterVisibleItems(env, viewer, await filterSeed(env, stories));
      return json({ data: visible.slice(0, limit), error: null }, 200, cors);
    }

    if (path === '/api/stories' && method === 'POST') {
      return await createItem(context, 'stories', KEYS.STORIES, KEYS.STORY, cors);
    }

    // MOMENTS (visibility-enforced; see POSTS).
    if (path === '/api/moments' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 100);
      const viewer = await getViewer(request, env);
      const ids = await cleanOrphans(env, KEYS.MOMENTS, KEYS.MOMENT);
      const recent = ids.slice(0, Math.min(ids.length, limit * 3 + 20));
      const moments = (await Promise.all(recent.map(async (id) => {
        const m = await kv.get(KEYS.MOMENT(id));
        return m ? transformItem(JSON.parse(m)) : null;
      }))).filter(Boolean);
      const visible = await filterVisibleItems(env, viewer, await filterSeed(env, moments));
      return json({ data: visible.slice(0, limit), error: null }, 200, cors);
    }

    if (path === '/api/moments' && method === 'POST') {
      return await createItem(context, 'moments', KEYS.MOMENTS, KEYS.MOMENT, cors);
    }

    // PROFILE
    // Private accounts: strangers (non-followers) receive only the
    // public-safe subset (avatar + basic details, no media/content), like
    // Facebook/Instagram. Owners and followers receive the full profile.
    if (path.match(/^\/api\/profile\//) && method === 'GET') {
      const userId = decodeURIComponent(path.split('/api/profile/')[1] || '');
      if (SEED_PROFILE_IDS.has(userId)) {
        return json({ data: null, error: 'Profile not found' }, 404, cors);
      }
      const profile = await kv.get(KEYS.PROFILE(userId));
      if (!profile) return json({ data: null, error: 'Profile not found' }, 404, cors);
      const parsed = JSON.parse(profile);
      if (parsed && parsed.isPrivate === true) {
        const viewer = await getViewer(request, env);
        const isOwner = !!(viewer && viewer.id === userId);
        const follower = isOwner ? true : viewer ? await isFollowingPair(env, viewer.id, userId) : false;
        if (!isOwner && !follower) {
          let pending = false;
          try {
            const reqs = await readIdList(env, KEYS.FOLLOW_REQ(userId));
            pending = viewer ? reqs.some((x) => String(x).toLowerCase() === String(viewer.id).toLowerCase()) : false;
          } catch { /* ignore */ }
          return json({ data: { ...publicSafeProfile(parsed), followStatus: viewer ? { isFollowing: false, pending } : undefined }, error: null }, 200, cors);
        }
        if (viewer && !isOwner) {
          return json({ data: { ...parsed, followStatus: { isFollowing: true, pending: false } }, error: null }, 200, cors);
        }
      }
      return json({ data: parsed, error: null }, 200, cors);
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
      // Account type: public/private toggle (signup page + settings).
      // Accepts isPrivate boolean and/or accountType string; stored as
      // canonical isPrivate + accountType. Never trusts the client for
      // anything else privileged.
      if (typeof clean.accountType === 'string') {
        const t = clean.accountType.toLowerCase().trim();
        if (t === 'private') clean.isPrivate = true;
        else if (t === 'public') clean.isPrivate = false;
        clean.accountType = clean.isPrivate === true ? 'private' : 'public';
      } else if (typeof clean.isPrivate === 'boolean') {
        clean.accountType = clean.isPrivate ? 'private' : 'public';
      }
      if (typeof clean.bio === 'string') clean.bio = clean.bio.slice(0, 500);
      await kv.put(KEYS.PROFILE(id), JSON.stringify(clean));
      return json({ data: clean, error: null }, 200, cors);
    }

    // SEARCH — interest-aware AI ranking (backend-only, no frontend changes).
    if (path === '/api/search' && method === 'GET') {
      const query = String(url.searchParams.get('q') || '').slice(0, 200);
      const limit = clamp(parseInt(url.searchParams.get('limit') || '20', 10), 1, 50);
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || '').slice(0, 200);
      let interests = {};
      try { interests = aiMerge(await aiGetInterests(env, userId), aiParseInterests(url.searchParams.get('interests'))); } catch {}
      const indexJson = await kv.get(KEYS.CONTENT_INDEX);
      const index = indexJson ? JSON.parse(indexJson) : [];
      const hasReal = await kv.get(KEYS.HAS_REAL_USERS);
      const unseeded = hasReal === 'true' ? index.filter(i => !isSeedItem(i)) : index;
      // Visibility-enforced search: drop removed items, private-account
      // items and followers-only items the viewer may not see.
      const searchViewer = await getViewer(request, env);
      const base = await filterVisibleItems(env, searchViewer, unseeded.map((e) => ({
        ...e,
        ownerId: e.authorId || e.ownerId || e.userId,
      })));
      if (!base.length) return json({ data: { results: [], totalCount: 0, isAiRecommended: false, personalized: false } }, 200, cors);
      const pops = {};
      await Promise.all(base.slice(0, 100).map(async (it) => {
        try { const r = await kv.get(KEYS.POP(it.id)); if (r) pops[it.id] = parseInt(r, 10) || 0; } catch {}
      }));
      const scoreItem = (item) => {
        const title = String(item.title || '').toLowerCase();
        const desc = String(item.description || '').toLowerCase();
        const content = String(item.content || '').toLowerCase();
        const cat = String(item.category || '').toLowerCase();
        const creator = String(item.creator || '').toLowerCase();
        const tags = (item.tags || []).map((t) => String(t).toLowerCase());
        const q = query.toLowerCase().trim();
        let s = 0;
        if (!q) {
          s = aiPopOf(item, pops) + aiRecency(item.publishedAt) * 2 + aiInterestBoost(item, interests);
          return s;
        }
        if ((title + ' ' + desc + ' ' + content + ' ' + cat + ' ' + creator + ' ' + tags.join(' ')).includes(q)) s += 100;
        if (title.includes(q)) s += 50;
        if (cat === q) s += 45; else if (cat.includes(q)) s += 30;
        if (creator.includes(q)) s += 25;
        if (desc.includes(q)) s += 20;
        if (content.includes(q)) s += 15;
        for (const t of tags) if (t.includes(q) || q.includes(t)) s += 20;
        const toks = aiTokenize(query);
        const exp = aiExpand(toks);
        const hayToks = aiTokenize(item.title + ' ' + item.description + ' ' + item.content + ' ' + item.category + ' ' + item.creator + ' ' + (item.tags || []).join(' '));
        let hits = 0;
        for (const tok of exp) {
          let h = false;
          if (title.includes(tok)) { s += 12; h = true; }
          else if (cat.includes(tok)) { s += 10; h = true; }
          else if (tags.some((tg) => tg.includes(tok))) { s += 10; h = true; }
          else if (desc.includes(tok) || content.includes(tok) || creator.includes(tok)) { s += 6; h = true; }
          else if (hayToks.some((x) => aiFuzzy(x, tok))) { s += 5; h = true; }
          if (h) hits++;
        }
        if (toks.length > 1 && hits >= Math.min(toks.length, 2)) s += 25;
        s += Math.min(20, aiPopOf(item, pops) / 5) + aiRecency(item.publishedAt) + aiInterestBoost(item, interests);
        return s;
      };
      const ranked = base.map((item) => ({ item, s: scoreItem(item) })).sort((a, b) => b.s - a.s);
      const personalized = Object.keys(interests).length > 0;
      if (!query.trim()) {
        return json({ data: { results: ranked.slice(0, limit).map((x) => transformItem(x.item)), totalCount: base.length, isAiRecommended: personalized, personalized } }, 200, cors);
      }
      const matching = ranked.filter((x) => x.s >= 15);
      if (!matching.length) {
        const fb = ranked.slice(0, Math.min(12, limit)).map((x) => transformItem(x.item));
        return json({ data: { results: fb, totalCount: 0, isAiRecommended: true, personalized } }, 200, cors);
      }
      return json({ data: { results: matching.slice(0, limit).map((x) => transformItem(x.item)), totalCount: matching.length, isAiRecommended: personalized || matching.length === 0, personalized } }, 200, cors);
    }

    // FEED — personalized across posts+thoughts+moments (new; old clients unaffected).
    if (path === '/api/feed' && method === 'GET') {
      const limit = clamp(parseInt(url.searchParams.get('limit') || '30', 10), 1, 100);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || '').slice(0, 200);
      let interests = {};
      try { interests = aiMerge(await aiGetInterests(env, userId), aiParseInterests(url.searchParams.get('interests'))); } catch {}
      const [pIds, tIds, mIds] = await Promise.all([
        (async () => { const j = await kv.get(KEYS.POSTS); return j ? JSON.parse(j).slice(0, 60) : []; })().catch(() => []),
        (async () => { const j = await kv.get(KEYS.THOUGHTS); return j ? JSON.parse(j).slice(0, 30) : []; })().catch(() => []),
        (async () => { const j = await kv.get(KEYS.MOMENTS); return j ? JSON.parse(j).slice(0, 30) : []; })().catch(() => []),
      ]);
      const [posts, thoughts, moments] = await Promise.all([
        Promise.all(pIds.map(async (id) => { const p = await kv.get(KEYS.POST(id)); return p ? transformItem(JSON.parse(p)) : null; })).then((a) => a.filter(Boolean)).catch(() => []),
        Promise.all(tIds.map(async (id) => { const t = await kv.get(KEYS.THOUGHT(id)); return t ? transformItem(JSON.parse(t)) : null; })).then((a) => a.filter(Boolean)).catch(() => []),
        Promise.all(mIds.map(async (id) => { const m = await kv.get(KEYS.MOMENT(id)); return m ? transformItem(JSON.parse(m)) : null; })).then((a) => a.filter(Boolean)).catch(() => []),
      ]);
      const viewerForFeed = await getViewer(request, env);
      const norm = await filterVisibleItems(env, viewerForFeed, [
        ...posts.map((p) => ({ kind: 'post', ...p })),
        ...thoughts.map((t) => ({ kind: 'thought', id: t.id, content: t.content, user: t.user_id, ownerId: t.ownerId || t.userId, visibility: t.visibility, createdAt: t.created_at, likes: t.likes_count, comments: t.comments_count, tags: t.tags || [], category: 'Thoughts' })),
        ...moments.map((m) => ({ kind: 'moment', ...m })),
      ]);
      const scored = norm.map((it) => ({
        it,
        s: (Number(it.likes ?? it.likes_count ?? 0) + Number(it.reacts ?? 0) * 2 + Number(it.comments ?? it.comments_count ?? 0) * 3) / 10
          + aiRecency(it.createdAt || it.created_at || it.publishedAt)
          + aiInterestBoost({ category: it.category || '', tags: it.tags || [], creator: it.user || it.creator || '', title: it.content || it.title || '' }, interests),
      })).sort((a, b) => b.s - a.s);
      const personalized = Object.keys(interests).length > 0;
      return json({ data: { items: scored.slice(offset, offset + limit).map((x) => x.it), totalCount: norm.length, personalized } }, 200, cors);
    }

    // ENGAGEMENT — persist interest signals + popularity (new; old clients unaffected).
    if (path === '/api/engagement' && method === 'POST') {
      let raw;
      try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
      const body = sanitizeBody(raw);
      const userId = String(body.userId || body.user_id || request.headers.get('X-User-Id') || '').slice(0, 200);
      if (!userId) return json({ error: 'userId required' }, 400, cors);
      const rl = await rateLimit(kv, 'engagement', userId, 60);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const interests = await aiRecordEngagement(env, userId, {
        category: String(body.category || ''), tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : [],
        creator: String(body.creator || ''), action: String(body.action || 'view'),
      });
      if (body.itemId) await aiBumpPop(env, String(body.itemId).slice(0, 64), String(body.action || 'view').toLowerCase() === 'view' ? 1 : 3);
      return json({ data: { ok: true, interests: Object.keys(interests).length } }, 200, cors);
    }

    // SUGGEST — AI search suggestions via brain proxy with local fallback.
    if (path === '/api/suggest/search' && method === 'GET') {
      const q = String(url.searchParams.get('q') || '').slice(0, 100);
      if (!q) return json({ data: { suggestions: [] } }, 200, cors);
      const brain = await aiFetchJson(aiBrainBase(env) + '/v1/suggest/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, source: 'equyvo-search' }),
      }, 2500);
      if (brain && Array.isArray(brain.suggestions) && brain.suggestions.length) {
        return json({ data: { suggestions: brain.suggestions.slice(0, 8).map((x) => ({ label: String(x?.label || x || ''), type: 'ai-generated' })), source: 'brain' } }, 200, cors);
      }
      try {
        const idxJson = await kv.get(KEYS.CONTENT_INDEX);
        const idx = idxJson ? JSON.parse(idxJson) : [];
        const ql = q.toLowerCase();
        const seen = new Set();
        const out = [];
        for (const it of idx) {
          for (const cand of [it.category, ...(it.tags || []), it.title]) {
            const c = String(cand || '').trim();
            if (c && c.toLowerCase().includes(ql) && !seen.has(c.toLowerCase()) && out.length < 8) { seen.add(c.toLowerCase()); out.push(c); }
          }
          if (out.length >= 8) break;
        }
        return json({ data: { suggestions: out.map((label) => ({ label, type: 'local' })), source: 'local' } }, 200, cors);
      } catch { return json({ data: { suggestions: [], source: 'none' } }, 200, cors); }
    }

    if ((path === '/api/suggest/feed' || path === '/api/trending') && method === 'GET') {
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || 'default').slice(0, 200);
      let interests = {};
      try { interests = await aiGetInterests(env, userId); } catch {}
      const top = Object.entries(interests).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
      const brain = await aiFetchJson(aiBrainBase(env) + '/v1/suggest/feed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, userId, interacted: top.slice(0, 20), source: 'equyvo-feed' }),
      }, 2500);
      if (brain && Array.isArray(brain.suggestions) && brain.suggestions.length) {
        return json({ data: { suggestions: brain.suggestions.slice(0, 8), source: 'brain', personalized: top.length > 0 } }, 200, cors);
      }
      const fb = top.length ? top : ['Trending topics', "What's new", 'Explore categories', 'Popular creators', 'Fresh uploads', 'Community picks'];
      return json({ data: { suggestions: fb.slice(0, 8), source: 'local', personalized: top.length > 0 } }, 200, cors);
    }

    // ---- FOLLOW GRAPH (server-side source of truth) ----
    // POST /api/follow { target } — follow a public account directly; for a
    // private account this creates a pending request instead.
    if (path === '/api/follow' && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const clean = sanitizeBody(body);
      const target = String(clean.target || clean.userId || '').slice(0, 200);
      if (!target || target === actor.id) return json({ error: 'Invalid target' }, 400, cors);
      const rl = await rateLimit(kv, 'engagement', actor.id, 60);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const targetProfile = await getStoredProfile(env, target);
      if (targetProfile && targetProfile.isPrivate === true) {
        const reqs = await readIdList(env, KEYS.FOLLOW_REQ(target));
        if (!reqs.some((x) => x === actor.id)) {
          reqs.unshift(actor.id);
          await kv.put(KEYS.FOLLOW_REQ(target), JSON.stringify(reqs.slice(0, 1000)));
        }
        return json({ data: { isFollowing: false, pending: true, isPrivate: true }, error: null }, 200, cors);
      }
      const [following, followers] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING(actor.id)),
        readIdList(env, KEYS.FOLLOWERS(target)),
      ]);
      if (!following.some((x) => x === target)) {
        following.unshift(target);
        await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(following.slice(0, 5000)));
      }
      if (!followers.some((x) => x === actor.id)) {
        followers.unshift(actor.id);
        await kv.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.slice(0, 50000)));
      }
      return json({ data: { isFollowing: true, pending: false }, error: null }, 200, cors);
    }

    // DELETE /api/follow/:target — unfollow (also withdraws pending requests).
    if (path.match(/^\/api\/follow\//) && method === 'DELETE' && !path.startsWith('/api/follow/requests')) {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const target = decodeURIComponent(path.split('/api/follow/')[1] || '').split('?')[0];
      if (!target) return json({ error: 'Invalid target' }, 400, cors);
      const [following, followers, reqs] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING(actor.id)),
        readIdList(env, KEYS.FOLLOWERS(target)),
        readIdList(env, KEYS.FOLLOW_REQ(target)),
      ]);
      await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(following.filter((x) => x !== target)));
      await kv.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.filter((x) => x !== actor.id)));
      if (reqs.some((x) => x === actor.id)) {
        await kv.put(KEYS.FOLLOW_REQ(target), JSON.stringify(reqs.filter((x) => x !== actor.id)));
      }
      return json({ data: { isFollowing: false, pending: false }, error: null }, 200, cors);
    }

    // GET /api/follow/status?target= — { isFollowing, pending } for the caller.
    if (path === '/api/follow/status' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const target = String(url.searchParams.get('target') || '').slice(0, 200);
      if (!target) return json({ error: 'target required' }, 400, cors);
      const following = await readIdList(env, KEYS.FOLLOWING(actor.id));
      const isFollowing = following.some((x) => x === target);
      let pending = false;
      if (!isFollowing) {
        const reqs = await readIdList(env, KEYS.FOLLOW_REQ(target));
        pending = reqs.some((x) => x === actor.id);
      }
      return json({ data: { isFollowing, pending }, error: null }, 200, cors);
    }

    // GET /api/followers/:userId and GET /api/following/:userId — counts and
    // id lists. Private accounts expose these only to owners/followers.
    if ((path.match(/^\/api\/followers\//) || path.match(/^\/api\/following\//)) && method === 'GET') {
      const isFollowers = path.startsWith('/api/followers/');
      const userId = decodeURIComponent((isFollowers ? path.split('/api/followers/')[1] : path.split('/api/following/')[1] || '').split('?')[0]);
      const viewer = await getViewer(request, env);
      const target = await getStoredProfile(env, userId);
      if (target && target.isPrivate === true) {
        const isOwner = !!(viewer && viewer.id === userId);
        const ok = isOwner || (viewer ? await isFollowingPair(env, viewer.id, userId) : false);
        if (!ok) {
          const c = await Promise.all([readIdList(env, KEYS.FOLLOWERS(userId)), readIdList(env, KEYS.FOLLOWING(userId))]);
          return json({ data: { count: isFollowers ? c[0].length : c[1].length, ids: [], restricted: true }, error: null }, 200, cors);
        }
      }
      const ids = await readIdList(env, isFollowers ? KEYS.FOLLOWERS(userId) : KEYS.FOLLOWING(userId));
      return json({ data: { count: ids.length, ids: ids.slice(0, 500) }, error: null }, 200, cors);
    }

    // GET /api/follow/requests — pending follow requests for the caller
    // (private-account owners). POST /api/follow/accept|decline { requester }.
    if (path === '/api/follow/requests' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const reqs = await readIdList(env, KEYS.FOLLOW_REQ(actor.id));
      return json({ data: { requests: reqs }, error: null }, 200, cors);
    }

    if ((path === '/api/follow/accept' || path === '/api/follow/decline') && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const clean = sanitizeBody(body);
      const requester = String(clean.requester || clean.userId || '').slice(0, 200);
      if (!requester) return json({ error: 'requester required' }, 400, cors);
      const reqs = await readIdList(env, KEYS.FOLLOW_REQ(actor.id));
      await kv.put(KEYS.FOLLOW_REQ(actor.id), JSON.stringify(reqs.filter((x) => x !== requester)));
      if (path === '/api/follow/accept') {
        const [following, followers] = await Promise.all([
          readIdList(env, KEYS.FOLLOWING(requester)),
          readIdList(env, KEYS.FOLLOWERS(actor.id)),
        ]);
        if (!following.some((x) => x === actor.id)) {
          following.unshift(actor.id);
          await kv.put(KEYS.FOLLOWING(requester), JSON.stringify(following.slice(0, 5000)));
        }
        if (!followers.some((x) => x === requester)) {
          followers.unshift(requester);
          await kv.put(KEYS.FOLLOWERS(actor.id), JSON.stringify(followers.slice(0, 50000)));
        }
        return json({ data: { accepted: true }, error: null }, 200, cors);
      }
      return json({ data: { declined: true }, error: null }, 200, cors);
    }

    // ---- CONTENT UPDATE (owner-only): edit text + visibility ----
    // PUT /api/posts/:id | /api/thoughts/:id | /api/stories/:id |
    //     /api/moments/:id  with { content?, title?, visibility?, thumbnail? }
    // Lets owners flip an item between public / followers / private
    // ("hide from public") without deleting it.
    const updateMatch = path.match(/^\/(api)\/(posts|thoughts|stories|moments)\/([^/]+)$/);
    if (updateMatch && method === 'PUT') {
      const kindPlural = updateMatch[2];
      const id = decodeURIComponent(updateMatch[3] || '').split('?')[0];
      const getKey = kindPlural === 'posts' ? KEYS.POST : kindPlural === 'thoughts' ? KEYS.THOUGHT : kindPlural === 'stories' ? KEYS.STORY : KEYS.MOMENT;
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const raw = await kv.get(getKey(id));
      if (!raw) return json({ error: 'Not found' }, 404, cors);
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { return json({ error: 'Not found' }, 404, cors); }
      if (!owns(parsed, actor)) return json({ error: 'Only the account that posted this can edit it.' }, 403, cors);
      const clean = sanitizeBody(body);
      // Safety re-check on edited text.
      if (typeof clean.content === 'string' || typeof clean.title === 'string' || typeof clean.description === 'string') {
        try {
          await moderateContent(env, {
            text: String(clean.content ?? parsed.content ?? '') + '\n' + String(clean.title ?? parsed.title ?? ''),
          });
        } catch (e) {
          return json({ error: (e && e.message) || 'Content violates community guidelines.' }, (e && e.status) || 400, cors);
        }
        if (typeof clean.content === 'string') parsed.content = clean.content.slice(0, 5000);
        if (typeof clean.title === 'string') parsed.title = clean.title.slice(0, 500);
        if (typeof clean.description === 'string') parsed.description = clean.description.slice(0, 5000);
      }
      if (clean.visibility !== undefined || clean.audience !== undefined || clean.isPrivate !== undefined) {
        const next = normalizeVisibility(
          clean.visibility || clean.audience || (clean.isPrivate === true ? 'private' : clean.isPrivate === false ? 'public' : parsed.visibility),
          'public'
        );
        parsed.visibility = next;
        delete parsed.audience;
        if (next === 'public') { delete parsed.isPrivate; delete parsed.hidden; delete parsed.hideFromPublic; }
      }
      if (Array.isArray(clean.tags)) parsed.tags = clean.tags.map((t) => String(t).slice(0, 40)).slice(0, 10);
      // Owner-supplied cover art: uploaded thumbnail URL only (never inline
      // data — those belong in /api/upload, not in KV item bodies).
      if (typeof clean.thumbnail === 'string' && clean.thumbnail) {
        const thumb = String(clean.thumbnail).slice(0, 2000);
        if (/^https?:\/\//i.test(thumb) && !thumb.startsWith('data:')) {
          parsed.thumbnail = thumb;
        }
      }
      parsed.updatedAt = new Date().toISOString();
      await kv.put(getKey(id), JSON.stringify(parsed));
      // Keep the search index visibility + thumbnail in sync (best-effort).
      try {
        const idxJson = await kv.get(KEYS.CONTENT_INDEX);
        if (idxJson) {
          const idx = JSON.parse(idxJson);
          const ix = idx.findIndex((i) => i && i.id === id);
          if (ix >= 0) {
            idx[ix] = { ...idx[ix], visibility: parsed.visibility || 'public', thumbnail: parsed.thumbnail || idx[ix].thumbnail || '' };
            await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(idx));
          }
        }
      } catch { /* ignore */ }
      return json({ data: transformItem(parsed), error: null }, 200, cors);
    }

    // ---- REPORTS (community safety) ----
    // POST /api/report { kind, id, reason?, details? } — any signed-in
    // account can report. Auto-hide at 3 reports, auto-remove at 5, with an
    // immediate brain re-check on every report. Generic responses only.
    if (path === '/api/report' && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const clean = sanitizeBody(body);
      const kind = String(clean.kind || clean.type || '').toLowerCase().replace(/s$/, '');
      const id = String(clean.id || clean.contentId || '').slice(0, 64);
      const reason = String(clean.reason || 'other').slice(0, 40);
      if (!['post', 'thought', 'story', 'moment'].includes(kind) || !id) {
        return json({ error: 'Invalid report' }, 400, cors);
      }
      const rl = await rateLimit(kv, 'engagement', actor.id, 30);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const getKey = kind === 'post' ? KEYS.POST : kind === 'thought' ? KEYS.THOUGHT : kind === 'story' ? KEYS.STORY : KEYS.MOMENT;
      const raw = await kv.get(getKey(id));
      if (!raw) return json({ data: { ok: true }, error: null }, 200, cors);
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { return json({ data: { ok: true }, error: null }, 200, cors); }
      // Owners cannot report their own content into removal; they can delete it.
      if (owns(parsed, actor)) return json({ data: { ok: true }, error: null }, 200, cors);
      const report = {
        id: generateId(), kind, contentId: id, reason,
        details: String(clean.details || clean.additionalInfo || '').slice(0, 1000),
        reporter: actor.id, createdAt: new Date().toISOString(),
      };
      await kv.put(KEYS.REPORT(report.id), JSON.stringify(report));
      try {
        const listJson = await kv.get(KEYS.REPORTS_LIST);
        const ids = listJson ? JSON.parse(listJson) : [];
        ids.unshift(report.id);
        await kv.put(KEYS.REPORTS_LIST, JSON.stringify(ids.slice(0, 2000)));
      } catch { /* ignore */ }
      // Count reports against this item.
      let count = 1;
      try {
        const flagRaw = await kv.get(KEYS.FLAGS(kind, id));
        count = (flagRaw ? parseInt(flagRaw, 10) || 0 : 0) + 1;
        await kv.put(KEYS.FLAGS(kind, id), String(count));
      } catch { /* ignore */ }
      // Immediate brain re-check of the reported content.
      let brainVerdict = null;
      try {
        brainVerdict = await brainSafetyCheck(env, String(parsed.content || parsed.title || parsed.description || ''));
      } catch { /* fail-open */ }
      const now = new Date().toISOString();
      if (brainVerdict === 'block' || count >= 5) {
        parsed.moderation = { status: 'removed', at: now, reason: 'community' };
        parsed.visibility = 'private';
        await kv.put(getKey(id), JSON.stringify(parsed));
        await enqueueModeration(env, { kind, id, owner: itemOwnerId(parsed), reason: 'removed' });
      } else if (brainVerdict === 'review' || count >= 3) {
        parsed.moderation = { status: 'quarantined', at: now, reason: 'community' };
        parsed.visibility = 'private';
        await kv.put(getKey(id), JSON.stringify(parsed));
        await enqueueModeration(env, { kind, id, owner: itemOwnerId(parsed), reason: 'auto-review' });
      }
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    // DELETE ENDPOINTS (strictly owner-only — see deleteItem).
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
      // Index rows carry the display name (not user id) as creator — track
      // deleted item ids so their index rows are purged explicitly too.
      const deletedIds = new Set();

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
              deletedIds.add(id);
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

      // Remove from content index (by deleted item id AND creator match).
      const idxJson = await kv.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(
          idx.filter(i => i && !deletedIds.has(i.id) && i.creator?.toLowerCase() !== userId.toLowerCase() && i.id !== `profile-${userId}`)
        ));
      }
      // Drop interest graph + popularity crumbs for deleted items.
      try {
        await kv.delete(KEYS.INTERESTS(userId));
        await Promise.all([...deletedIds].slice(0, 100).map((id) => kv.delete(KEYS.POP(id)).catch(() => {})));
      } catch { /* best-effort */ }

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

    // USER CONTENT — every collection for one account (posts + thoughts +
    // stories + moments), visibility-enforced. This is what makes an upload
    // on one device appear on every other device and for other accounts.
    if (path.match(/^\/api\/users\//) && path.endsWith('/content') && method === 'GET') {
      const userId = decodeURIComponent(path.split('/api/users/')[1].replace('/content', ''));
      const viewer = await getViewer(request, env);
      const isOwner = !!(viewer && String(viewer.id).toLowerCase() === String(userId).toLowerCase());
      if (!isOwner) {
        const target = await getStoredProfile(env, userId);
        if (target && target.isPrivate === true) {
          const ok = viewer ? await isFollowingPair(env, viewer.id, userId) : false;
          if (!ok) return json({ data: { posts: [], thoughts: [], stories: [], moments: [] }, error: null }, 200, cors);
        }
      }
      const matchOwner = (p) => {
        const cands = [p.ownerId, p.userId, p.user_id, p.creator, p.user, p.username, p.handle];
        const want = String(userId).toLowerCase();
        return cands.some((c) => typeof c === 'string' && c && (c === userId || c.toLowerCase() === want));
      };
      const [postIds, thoughtIds, storyIds, momentIds] = await Promise.all([
        cleanOrphans(env, KEYS.POSTS, KEYS.POST),
        cleanOrphans(env, KEYS.THOUGHTS, KEYS.THOUGHT),
        cleanOrphans(env, KEYS.STORIES, KEYS.STORY),
        cleanOrphans(env, KEYS.MOMENTS, KEYS.MOMENT),
      ]);
      const [posts, thoughts, stories, moments] = await Promise.all([
        Promise.all(postIds.map(async (id) => { const p = await kv.get(KEYS.POST(id)); return p ? transformItem(JSON.parse(p)) : null; })).then((a) => a.filter(Boolean)),
        Promise.all(thoughtIds.map(async (id) => { const t = await kv.get(KEYS.THOUGHT(id)); return t ? transformItem(JSON.parse(t)) : null; })).then((a) => a.filter(Boolean)),
        Promise.all(storyIds.map(async (id) => { const s = await kv.get(KEYS.STORY(id)); return s ? transformItem(JSON.parse(s)) : null; })).then((a) => a.filter(Boolean)),
        Promise.all(momentIds.map(async (id) => { const m = await kv.get(KEYS.MOMENT(id)); return m ? transformItem(JSON.parse(m)) : null; })).then((a) => a.filter(Boolean)),
      ]);
      const mine = (arr) => arr.filter(matchOwner);
      const seeded = await filterSeed(env, [...mine(posts), ...mine(thoughts), ...mine(stories), ...mine(moments)]);
      const visible = await filterVisibleItems(env, viewer, seeded);
      return json({ data: {
        posts: visible.filter((x) => !['thought', 'story', 'text-story', 'moment'].includes(String(x.type || '').toLowerCase())),
        thoughts: visible.filter((x) => String(x.type || '').toLowerCase() === 'thought'),
        stories: visible.filter((x) => ['story', 'text-story'].includes(String(x.type || '').toLowerCase())),
        moments: visible.filter((x) => String(x.type || '').toLowerCase() === 'moment'),
      }, error: null }, 200, cors);
    }

    // USER POSTS (visibility-enforced; private accounts reveal content only
    // to themselves and their followers — everyone else gets []).
    if (path.match(/^\/api\/users\//) && path.endsWith('/posts') && method === 'GET') {
      const userId = decodeURIComponent(path.split('/api/users/')[1].replace('/posts', ''));
      const viewer = await getViewer(request, env);
      const isOwner = !!(viewer && String(viewer.id).toLowerCase() === String(userId).toLowerCase());
      if (!isOwner) {
        const target = await getStoredProfile(env, userId);
        if (target && target.isPrivate === true) {
          const ok = viewer ? await isFollowingPair(env, viewer.id, userId) : false;
          if (!ok) return json({ data: [], error: null }, 200, cors);
        }
      }
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      const posts = (await Promise.all(ids.map(async (id) => {
        const p = await kv.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      const want = String(userId || '').toLowerCase();
      const userPosts = posts.filter((p) => {
        const candidates = [p.ownerId, p.userId, p.user_id, p.user, p.creator, p.username, p.handle];
        return candidates.some((c) => typeof c === 'string' && c && c.toLowerCase() === want);
      });
      const visible = await filterVisibleItems(env, viewer, await filterSeed(env, userPosts));
      const limit = clamp(parseInt(url.searchParams.get('limit') || '50', 10), 1, 100);
      return json({ data: visible.slice(0, limit), error: null }, 200, cors);
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
      // Authoritative ownership + visibility so search/discover filtering is
      // per-viewer correct across devices and accounts.
      clean.authorId = actor.id;
      clean.ownerId = actor.id;
      clean.visibility = normalizeVisibility(clean.visibility || 'public');
      // Same safety gate as direct creates (generic message only).
      try {
        await moderateContent(env, { text: String(clean.content || clean.title || clean.description || '') });
      } catch (e) {
        return json({ error: (e && e.message) || 'Content violates community guidelines and was not published.' }, (e && e.status) || 400, cors);
      }
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

    // ---- BILLING STATUS (same-origin proxy) ----
    // Keeps the browser on first-party /api only; the central billing host
    // is contacted server-to-server with the caller's Bearer token.
    if (path === '/api/billing/status' && method === 'GET') {
      const bearer = bearerFrom(request);
      if (!bearer) return json({ error: 'Please sign in first.' }, 401, cors);
      const base = (env.BILLING_BASE_URL || 'https://api.acronous.com').replace(/\/$/, '');
      try {
        const upstream = await fetch(base + '/v1/billing/status?product=equyvo', {
          headers: { Authorization: 'Bearer ' + bearer },
        });
        const data = await upstream.json().catch(() => ({ error: 'Bad billing response.' }));
        return json(data, upstream.status, cors);
      } catch {
        return json({ error: 'Billing service unreachable. Please try again.' }, 502, cors);
      }
    }

    // ---- RECOMMENDATIONS PROXY (same-origin) ----
    // The app's suggestion/learning signals go to first-party /api routes
    // below; this worker forwards them to the shared recommendations
    // service server-to-server (best-effort, capped). Clients never see
    // where the service lives or how it works.
    const brainProxy = async (brainPath, body) => {
      const data = await aiFetchJson(aiBrainBase(env) + brainPath, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      }, 2500);
      return data;
    };

    if ((path === '/api/learn' || path === '/api/feedback') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      let raw;
      try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
      const body = sanitizeBody(raw);
      const brainPath = path === '/api/learn' ? '/v1/learn' : '/v1/feedback';
      await brainProxy(brainPath, { ...body, source: 'equyvo' });
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    if ((path === '/api/generate' || path === '/api/chat') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const rl = await rateLimit(kv, 'suggest', actor.id, 30);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      let raw;
      try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
      const body = sanitizeBody(raw);
      const prompt = String(body.prompt || body.message || '').slice(0, 2000);
      if (!prompt) return json({ error: 'prompt required' }, 400, cors);
      const data = await brainProxy(path === '/api/generate' ? '/v1/generate' : '/v1/chat', {
        prompt, message: prompt,
        messages: Array.isArray(body.messages) ? body.messages.slice(0, 20) : [],
        system: String(body.system || '').slice(0, 1000),
        session_id: String(body.sessionId || body.session_id || actor.id).slice(0, 100),
        source: 'equyvo',
      });
      if (!data) return json({ data: { response: '' }, error: null }, 200, cors);
      return json({ data, error: null }, 200, cors);
    }

    if (path === '/api/trending/topics' && method === 'GET') {
      const data = await aiFetchJson(aiBrainBase(env) + '/v1/trending', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'equyvo-trending' }),
      }, 2500);
      const topics = data && Array.isArray(data.topics)
        ? data.topics.filter((t) => t && typeof t.name === 'string').slice(0, 10)
        : [];
      return json({ data: { topics }, error: null }, 200, cors);
    }

    return json({ error: 'Not found: ' + method + ' ' + path }, 404, cors);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return json({ error: (err && err.message) || 'Internal error', requestId }, status, cors);
  }
};
