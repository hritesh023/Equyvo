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
  // Admin token for GET /api/reports (dashboard.acronous.com monitor).
  // Set via `wrangler pages secret put REPORTS_ADMIN_TOKEN`. Never public.
  REPORTS_ADMIN_TOKEN?: string;
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

  // Chat transport (WhatsApp-style ticks) + per-user notifications + live.
  CHAT: (a, b) => 'chat:' + a + ':' + b,
  NOTIF: (userId) => 'notif:' + userId,
  LIVE: 'live:now',  MOD_QUEUE: 'mod:queue',
  // Comments: per-content ledgers with replies, likes, pins + owner settings.
  // COMMENTS:<contentId> holds the ordered id list (newest first, capped).
  // COMMENT:<id> holds the comment object. CSETTINGS:<contentId> holds owner
  // controls ({ commentsEnabled }). All identity comes from the verified
  // caller + stored profile — never invented on the client.
  COMMENTS: (contentId) => 'comments:' + contentId,
  COMMENT: (id) => 'comment:' + id,
  CSETTINGS: (contentId) => 'csettings:' + contentId,
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

// Ensure every auth account has a stored profile so follower/following lists,
// chat threads and sheets always show a real name (never a bare UUID/userid).
async function ensureProfile(env, u) {
  try {
    const id = String(u?.id || '');
    if (!id) return null;
    const raw = await env.EQUYVO_KV.get(KEYS.PROFILE(id));
    if (raw) return JSON.parse(raw);
    const name = String(u?.name || u?.username || (u?.email ? String(u.email).split('@')[0] : id));
    const profile = {
      id,
      email: String(u?.email || ''),
      name,
      username: name,
      avatar: '',
      bio: '',
      followers: 0,
      following: 0,
      isPrivate: u?.isPrivate === true,
      verified: false,
      createdAt: new Date().toISOString(),
    };
    await env.EQUYVO_KV.put(KEYS.PROFILE(id), JSON.stringify(profile));
    return profile;
  } catch { return null; }
}

// Legacy accounts created before profiles existed: build an id -> name map by
// scanning auth:user:<email> records once (cached in KV) so follower/following
// lists and chat threads show real names instead of raw UUIDs. Missing profiles
// are self-healed by ensureProfile.
async function legacyNameMap(env) {
  try {
    const cached = await env.EQUYVO_KV.get('maint:idname_map_v1');
    if (cached) {
      try {
        const m = JSON.parse(cached);
        if (m && m.map && m.t && (Date.now() - m.t) < 10 * 60 * 1000) return m.map;
      } catch { /* fall through */ }
    }
    const map = {};
    let cursor;
    do {
      const page = await env.EQUYVO_KV.list({ prefix: 'auth:user:', cursor, limit: 500 });
      for (const k of (page.keys || [])) {
        try {
          const u = JSON.parse(await env.EQUYVO_KV.get(k.name));
          if (u && u.id) {
            const nm = String(u.name || (u.email ? String(u.email).split('@')[0] : '')).trim();
            if (nm && !map[u.id]) map[u.id] = nm;
          }
        } catch { /* ignore */ }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    await env.EQUYVO_KV.put('maint:idname_map_v1', JSON.stringify({ t: Date.now(), map }));
    return map;
  } catch { return {}; }
}

async function profileWithFallback(env, pid) {
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.PROFILE(pid));
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') return p;
    }
  } catch { /* ignore */ }
  const map = await legacyNameMap(env);
  const nm = String(map[pid] || '');
  const created = await ensureProfile(env, { id: pid, name: nm || (pid.slice(0, 8) || 'user') });
  return created || null;
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
      if (await canViewerSeeItem(env, viewer, it, cache)) {
        // Fresh author identity on every read: profile renames / avatar
        // changes reflect on all surfaces (Discover, Moments, feeds,
        // search) on next fetch, on every device and account.
        try {
          const owner = itemOwnerId(it);
          let profile = cache.get(owner);
          if (profile === undefined && owner) {
            profile = await getStoredProfile(env, owner);
            cache.set(owner, profile);
          }
          applyAuthorIdentity(it, profile);
        } catch { /* display overlay is best-effort */ }
        out.push(it);
      }
    } catch { /* skip undecidable items */ }
  }
  return out;
}

// Author identity overlay: the stored profile is the source of truth for
// display name + avatar. Stale per-item copies (written at upload time) are
// refreshed here so updates propagate immediately everywhere.
function applyAuthorIdentity(item, authorProfile) {
  if (!item || typeof item !== 'object' || !authorProfile || typeof authorProfile !== 'object') return;
  const name = String(authorProfile.username || authorProfile.name || '').slice(0, 80);
  if (name) {
    item.user = name;
    item.creator = name;
  }
  if (typeof authorProfile.avatar === 'string' && authorProfile.avatar) {
    item.avatar = authorProfile.avatar;
  }
  if (authorProfile.verified === true) item.verified = true;
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
    verifiedName: normVerifiedName(profile.verifiedName || profile.name || ''),
  };
}

// ---------------------------------------------------------------------------
// Profile display-name change quota — server-side source of truth.
//  - Every account gets NAME_CHANGE_BASE_QUOTA (2) free display-name changes.
//  - Profile icons/avatars, bios and usernames stay unlimited.
//  - Each verified paid-plan purchase grants +2 more (idempotent per
//    payment). A paid plan active without a recorded purchase grants +2 once
//    per plan on demand (covers legacy purchases).
// The client only displays counts; enforcement happens here, so no device,
// account swear-jar bypass, reinstall, or forged field can exceed the quota.
// ---------------------------------------------------------------------------

const NAME_CHANGE_BASE_QUOTA = 2;
const NAME_CHANGE_GRANT_PER_PURCHASE = 2;
const NAME_PAID_PLAN_IDS = new Set([
  'eq_plus', 'eq_premium', 'eq_creator', 'eq_creator_pro', 'eq_business',
]);

function nameQuotaState(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const usedRaw = Number(p.nameChangesUsed);
  const used = Number.isFinite(usedRaw) && usedRaw > 0 ? Math.floor(usedRaw) : 0;
  const quotaRaw = Number(p.nameChangeQuota);
  const quota = Number.isFinite(quotaRaw) && quotaRaw > 0 ? Math.floor(quotaRaw) : NAME_CHANGE_BASE_QUOTA;
  const grants = Array.isArray(p.nameGrantPayments)
    ? p.nameGrantPayments.filter((x) => typeof x === 'string').slice(-50)
    : [];
  const bonusPlans = Array.isArray(p.nameBonusPlans)
    ? p.nameBonusPlans.filter((x) => typeof x === 'string')
    : [];
  return { used, quota, remaining: Math.max(0, quota - used), grants, bonusPlans };
}

function quotaErrorBody(used, quota) {
  return {
    error: `You have used all ${quota} free profile name changes. Buy a Premium plan to get 2 more changes.`,
    code: 'NAME_CHANGE_QUOTA',
    used,
    quota,
    remaining: 0,
  };
}

// ---------------------------------------------------------------------------
// Creator Pro verified badge — global, server-owned registry of verified
// names. The client can never set these fields; every rule is enforced here.
//
// PURCHASE GRANT
//   A verified Creator Pro payment grants the verified tick to the exact
//   display name on the profile — granted ONCE per Creator Pro purchase and
//   held only by that account.
//
// EXCLUSIVITY
//   Active record: verifiedname:<lower> -> { userId, name, grantedAt }
//   KV keys are case-insensitive ("Riya" == "riya") and permanent-ish. A name
//   held by one account can NEVER be verified by another account (any plan,
//   ever) — released names become tombstones that keep blocking forever.
//   This satisfies "only one name per Creator Pro subscriber; a verified name
//   can't be repeated to another user paying for Creator Pro".
//
// MONTHLY RENAME WINDOW
//   Renaming a verified name is allowed at most once every 30 days
//   (nameLockUntil = last grant/rename + 30 days). The client cannot rename
//   through the lock; the server returns VERIFIED_NAME_LOCK with canChangeAt.
// ---------------------------------------------------------------------------

const VERIFIED_LOCK_MS = 30 * 24 * 60 * 60 * 1000; // wait another month
const VERIFIED_TOMBSTONE_TTL = 10 * 365 * 86400;   // permanent uniqueness memory

function verifiedNameKey(lower) { return 'verifiedname:' + lower; }
function verifiedOwnerKey(userId) { return 'verifiednameowner:' + userId; }
function normVerifiedName(name) { return String(name || '').trim().slice(0, 80); }
function lowerVerifiedName(name) { return normVerifiedName(name).toLowerCase(); }

// Read + normalize a registry record. Legacy/plain values tolerated.
async function verifiedNameRecord(env, lower) {
  if (!lower) return null;
  try {
    const raw = await env.EQUYVO_KV.get(verifiedNameKey(lower));
    if (!raw) return null;
    let o = null;
    try { o = JSON.parse(raw); } catch { o = { userId: raw }; }
    if (!o || typeof o !== 'object') return null;
    return { userId: String(o.userId || ''), name: normVerifiedName(o.name || ''), grantedAt: Number(o.grantedAt) || 0, tombstone: o.tombstone === true };
  } catch { return null; }
}

function verifiedProfileState(prof) {
  const p = prof && typeof prof === 'object' ? prof : {};
  const active = p.verified === true;
  const name = normVerifiedName(p.verifiedName || p.name || '');
  const grantedAt = Number(p.verifiedNameAt) || 0;
  const lockUntil = Number(p.nameLockUntil) || (grantedAt ? grantedAt + VERIFIED_LOCK_MS : 0);
  return { active, name, lower: name.toLowerCase(), grantedAt, lockUntil, pending: p.verifiedNamePending === true };
}

/**
 * Grant (or move / renew) the verified badge for a Creator Pro subscriber.
 * - Same-name renew is idempotent (no registry churn, keeps original grant date).
 * - Name changes first tombstone the previous name (permanent block for others).
 * - Exclusive by construction: the registry key must be free or already this
 *   user's own record.
 * Returns { ok, patch?, error?, code?, canChangeAt? } — never throws.
 */
async function grantVerifiedName(env, userId, prevProfile, candidateName) {
  const st = verifiedProfileState(prevProfile);
  const name = normVerifiedName(candidateName || prevProfile.name || prevProfile.username || '');
  const lower = name.toLowerCase();
  if (!lower) {
    return { ok: false, error: 'Add a profile name first — the verified badge attaches to your name.', code: 'VERIFIED_NAME_EMPTY' };
  }
  // Idempotent: same user re-verifying the very same name.
  if (st.active && st.lower === lower && st.grantedAt) {
    return { ok: true, patch: { verified: true, verifiedName: st.name, verifiedNameAt: st.grantedAt, nameLockUntil: st.lockUntil }, renewed: true };
  }
  // Exclusive claim: registry must be free OR this same user's record.
  const rec = await verifiedNameRecord(env, lower);
  if (rec && rec.userId && rec.userId !== String(userId)) {
    return { ok: false, code: 'VERIFIED_NAME_TAKEN', error: `"${name}" is already a verified name on another account. Verified names are unique and cannot be reused — pick your own.` };
  }
  const now = Date.now();
  // Tombstone the previous verified name so NO other account can ever claim it.
  if (st.active && st.lower && st.lower !== lower) {
    try {
      await env.EQUYVO_KV.put(verifiedNameKey(st.lower), JSON.stringify({ userId: String(userId), name: st.name, grantedAt: st.grantedAt, tombstone: true, releasedAt: now }), { expirationTtl: VERIFIED_TOMBSTONE_TTL });
    } catch { /* ignore */ }
  }
  try {
    await env.EQUYVO_KV.put(verifiedNameKey(lower), JSON.stringify({ userId: String(userId), name, grantedAt: now }), { expirationTtl: VERIFIED_TOMBSTONE_TTL });
    await env.EQUYVO_KV.put(verifiedOwnerKey(userId), JSON.stringify({ name: lower, at: now }), { expirationTtl: VERIFIED_TOMBSTONE_TTL });
  } catch {
    return { ok: false, code: 'VERIFIED_NAME_STORE_FAILED', error: 'Could not register the verified name right now. Please try again.' };
  }
  return { ok: true, patch: { verified: true, verifiedName: name, verifiedNameAt: now, nameLockUntil: now + VERIFIED_LOCK_MS } };
}

// Body used on profile-read endpoints so viewers see the verified state.
function withVerifiedPublicFields(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  return { ...profile, verified: profile.verified === true, verifiedName: normVerifiedName(profile.verifiedName || '') };
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


// ── Chat + notifications helpers (bounded, lag-free) ─────────────────────
// Chat pairs use a canonical key so A→B and B→A share one ledger (max 300
// messages, trimmed on write). Ticks: sent = reached server, delivered =
// reached peer device, seen = peer opened the thread. Notifications are
// per-user capped lists (max 100) written best-effort, never blocking reads.

function chatPairKey(a, b) {
  const x = String(a || ''), y = String(b || '');
  return (x < y ? KEYS.CHAT(x, y) : KEYS.CHAT(y, x));
}

async function readChatMessages(env, a, b, limit) {
  try {
    const raw = await env.EQUYVO_KV.get(chatPairKey(a, b));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    const n = Math.min(200, Math.max(1, Number(limit) || 100));
    return list.slice(-n);
  } catch { return []; }
}

async function writeChatMessages(env, a, b, list) {
  try {
    await env.EQUYVO_KV.put(chatPairKey(a, b), JSON.stringify(list.slice(-300)));
  } catch { /* best-effort */ }
}

// ---- Chat ledger v2: event-sourced per-message records --------------------
// KV is eventually consistent. The original design kept the whole thread as
// ONE array (read → push → write on a single key). Two devices sending within
// the same few seconds both read the same stale copy and the second write
// REPLACED the first message — messages could literally disappear across
// devices. Now every message lives under its own key (chatmsg:...) and each
// sender appends to a per-sender index (chatidx:...): concurrent senders
// never touch the same keys, so messages can no longer overwrite each other.
// The legacy blob stays readable for old history but is no longer written.

function chatPairToken(a, b) {
  return String(a) < String(b) ? (String(a) + ':' + String(b)) : (String(b) + ':' + String(a));
}

function normChatMsg(m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id || '').slice(0, 64);
  if (!id) return null;
  return {
    id,
    from: String(m.from || ''),
    to: String(m.to || ''),
    text: String(m.text || ''),
    type: m.type === 'image' || m.type === 'file' ? m.type : 'text',
    fileUrl: String(m.fileUrl || ''),
    fileName: String(m.fileName || ''),
    status: m.status === 'seen' || m.status === 'delivered' ? m.status : 'sent',
    createdAt: m.createdAt || new Date().toISOString(),
    deletedForEveryone: m.deletedForEveryone === true,
    deletedFor: Array.isArray(m.deletedFor)
      ? m.deletedFor.filter((x) => typeof x === 'string').slice(0, 10)
      : [],
  };
}

async function getChatMessagePer(env, pair, id) {
  try {
    const raw = await env.EQUYVO_KV.get('chatmsg:' + pair + ':' + id);
    if (!raw) return null;
    return normChatMsg(JSON.parse(raw));
  } catch { return null; }
}

async function putChatMessagePer(env, pair, msg) {
  try {
    await env.EQUYVO_KV.put('chatmsg:' + pair + ':' + String(msg.id || '').slice(0, 64), JSON.stringify(msg));
  } catch { /* best-effort */ }
}

async function readChatIndex(env, pair, from, max) {
  try {
    const raw = await env.EQUYVO_KV.get('chatidx:' + pair + ':' + String(from || '').slice(0, 200));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr.filter((x) => x && typeof x.id === 'string') : [];
    return list.slice(-Math.min(200, Math.max(1, Number(max) || 150)));
  } catch { return []; }
}

// Store a message: per-message record + append to the SENDER's own index.
// Only the sender ever writes their index key, so A and B sending at the
// same moment cannot clobber each other's history.
async function storeChatMessage(env, a, b, msg) {
  const n = normChatMsg(msg);
  if (!n) return;
  const pair = chatPairToken(a, b);
  await putChatMessagePer(env, pair, n);
  const entry = { id: n.id, ts: new Date(n.createdAt).getTime() || Date.now() };
  try {
    const key = 'chatidx:' + pair + ':' + n.from.slice(0, 200);
    const raw = await env.EQUYVO_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    if (!list.some((x) => x && x.id === n.id)) {
      list.push(entry);
      await env.EQUYVO_KV.put(key, JSON.stringify(list.slice(-300)));
    }
  } catch { /* best-effort */ }
}

// Merged ledger for reads: per-message records (authoritative) with the
// legacy single-blob history folded in for anything stored before v2.
async function readThreadLedger(env, a, b, limit) {
  const pair = chatPairToken(a, b);
  const [idxA, idxB, legacy] = await Promise.all([
    readChatIndex(env, pair, a, 150),
    readChatIndex(env, pair, b, 150),
    readChatMessages(env, a, b, 300),
  ]);
  const out = new Map();
  for (const m of (legacy || [])) {
    const n = normChatMsg(m);
    if (n && !out.has(n.id)) out.set(n.id, n);
  }
  const ids = [];
  for (const e of [...idxA, ...idxB]) {
    if (e && e.id && !out.has(e.id) && !ids.includes(e.id)) { ids.push(e.id); }
  }
  const tail = ids.slice(-200);
  const per = await Promise.all(tail.map((id) => getChatMessagePer(env, pair, id)));
  for (const m of per) if (m) out.set(m.id, m);
  const merged = [...out.values()].sort(
    (x, y) => (new Date(x.createdAt).getTime() || 0) - (new Date(y.createdAt).getTime() || 0),
  );
  const n = Math.min(300, Math.max(1, Number(limit) || 100));
  return merged.slice(-n);
}

async function pushUserNotification(env, userId, item) {
  if (!userId || !item) return;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.NOTIF(userId));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    list.unshift({ id: generateId(), at: new Date().toISOString(), read: false, ...item });
    await env.EQUYVO_KV.put(KEYS.NOTIF(userId), JSON.stringify(list.slice(0, 100)));
  } catch { /* never block on notify */ }
}

function profileSummary(p, fallbackId) {
  if (!p || typeof p !== 'object') {
    const f = String(fallbackId || '');
    return { id: f, name: f.replace(/^@/, ''), username: f.startsWith('@') ? f : '@' + f, avatar: '' };
  }
  const id = String(p.id || fallbackId || '');
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

// Gated 1:1 chat: allowed when EITHER side follows the other (followers tab +
// following tab coverage). Strangers (neither direction) get 403.
async function canChat(env, viewerId, peerId) {
  if (!viewerId || !peerId || viewerId === peerId) return viewerId === peerId;
  try {
    const [a, b] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(viewerId)),
      readIdList(env, KEYS.FOLLOWERS(viewerId)),
    ]);
    const t = String(peerId).toLowerCase();
    if (a.some((x) => String(x).toLowerCase() === t)) return true;
    if (b.some((x) => String(x).toLowerCase() === t)) return true;
    const [c, d] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(peerId)),
      readIdList(env, KEYS.FOLLOWERS(peerId)),
    ]);
    const v = String(viewerId).toLowerCase();
    if (c.some((x) => String(x).toLowerCase() === v)) return true;
    if (d.some((x) => String(x).toLowerCase() === v)) return true;
    return false;
  } catch { return false; }
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
// Comments — persistent per-content discussions with replies, likes, shares,
// pins and owner controls. Real identity only: author display fields are
// resolved server-side from the verified caller + stored profile, so a
// comment can never carry a bot/fake avatar or name.
// ---------------------------------------------------------------------------

// Locate a content item across all collections by id.
async function findContentById(env, contentId) {
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
        let item = null;
        try { item = JSON.parse(raw); } catch { continue; }
        if (item && typeof item === 'object') return { ...k, id, item };
      }
    } catch { /* try next collection */ }
  }
  return null;
}

// Owner controls for a content item. Defaults to enabled; the owner can turn
// comments off via PUT /api/content/:id/comment-settings.
async function getCommentSettings(env, contentId, item) {
  let enabled = true;
  if (item && item.commentsEnabled === false) enabled = false;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.CSETTINGS(contentId));
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.commentsEnabled === false) enabled = false;
      if (s && s.commentsEnabled === true) enabled = true;
    }
  } catch { /* default stands */ }
  return { commentsEnabled: enabled };
}

async function setCommentSettings(env, contentId, enabled) {
  const next = { commentsEnabled: enabled !== false, updatedAt: new Date().toISOString() };
  await env.EQUYVO_KV.put(KEYS.CSETTINGS(contentId), JSON.stringify(next));
  return next;
}

// Fresh author identity for a comment: stored profile wins (renames + avatar
// changes propagate), falling back to the verified caller. Never invents art.
//
// Real-data-only gate: legacy seed/demo/bot avatar hosts (picsum, pravatar,
// dicebear, robohash, placeholder services) are stripped to '' so the client
// renders the account's real initials instead of a fake/bot picture.
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

function cleanCommentAvatar(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (low.startsWith('data:image/')) return s;
  for (const h of FAKE_AVATAR_HOSTS) {
    if (low.includes(h)) return '';
  }
  return s;
}

function cleanCommentName(name, actor) {
  const n = String(name || '').trim().slice(0, 80);
  if (n && n.toLowerCase() !== 'user') return n;
  const a = String((actor && (actor.username || (actor.email ? String(actor.email).split('@')[0] : ''))) || '').trim().slice(0, 80);
  return a || 'User';
}

async function resolveCommentAuthor(env, actor, stored) {
  let profile = null;
  try { profile = await getStoredProfile(env, actor.id); } catch { profile = null; }
  const username = cleanCommentName(
    (profile && (profile.username || profile.name)) || actor.username,
    actor,
  );
  const avatar = cleanCommentAvatar((profile && profile.avatar) || (stored && stored.avatar) || '');
  return { id: actor.id, name: username, username, avatar };
}

// Public comment shape. likedBy stays server-side; viewers get hasLiked.
function toPublicComment(c, viewerId) {
  if (!c || typeof c !== 'object') return null;
  const likedBy = Array.isArray(c.likedBy) ? c.likedBy : [];
  const { likedBy: _drop, ...rest } = c;
  return {
    ...rest,
    likes: Number(c.likes || 0) || 0,
    hasLiked: viewerId ? likedBy.some((x) => String(x) === String(viewerId)) : false,
  };
}

async function readCommentList(env, contentId) {
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.COMMENTS(contentId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

async function writeCommentList(env, contentId, ids) {
  try {
    await env.EQUYVO_KV.put(KEYS.COMMENTS(contentId), JSON.stringify(ids.slice(0, 1000)));
  } catch { /* best-effort */ }
}

// Keep the parent content's comment counter in sync (all type variants).
async function syncContentCommentCount(env, found, count) {
  if (!found) return;
  const n = Math.max(0, Number(count) || 0);
  try {
    const it = { ...found.item };
    if ('comments_count' in it) it.comments_count = n;
    if ('comments' in it) it.comments = n;
    if (!('comments' in it) && !('comments_count' in it)) it.comments = n;
    await env.EQUYVO_KV.put(found.getKey(found.id), JSON.stringify(it));
  } catch { /* counter is best-effort */ }
  try {
    const idxJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
    if (idxJson) {
      const idx = JSON.parse(idxJson);
      const ix = idx.findIndex((i) => i && i.id === found.id);
      if (ix >= 0) {
        idx[ix] = { ...idx[ix], comments: n };
        await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(idx));
      }
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Plan catalog — SERVER-SIDE source of truth. Frontend plans.ts is display-only
// and must never be trusted for enforcement. Prices in INR/month.
// Storage quotas enforce the "free is affordable, power users pay" model:
//   Free 5GB / Plus 50GB / Premium 250GB / Creator 500GB / Creator Pro 1TB / Biz 2TB
// ---------------------------------------------------------------------------
const GB = 1024 * 1024 * 1024;
// Upload caps raised so the app can handle long videos / vlogs / live
// recordings on the free tier too (measured to real-world 1080p phone
// recordings): the FILE-SIZE/LENGTH gates scale with the plan, storage
// quota stays the primary limit. Upgrades buy storage + even bigger caps.
const PLAN_CATALOG = {
  eq_free:        { id: 'eq_free',        label: 'Free',        priceInr: 0,   storageBytes: 10 * GB,  maxUploadMB: 200,  maxVideoSec: 1800, monthlyUploads: 300,   quality: 'auto-low',  ads: true },
  eq_plus:        { id: 'eq_plus',        label: 'Plus',        priceInr: 49,  storageBytes: 100 * GB, maxUploadMB: 1000, maxVideoSec: 7200, monthlyUploads: 1000,  quality: 'auto-good', ads: 'light' },
  eq_premium:     { id: 'eq_premium',     label: 'Premium',     priceInr: 149, storageBytes: 250 * GB, maxUploadMB: 2000, maxVideoSec: 14400, monthlyUploads: 5000, quality: 'auto-best', ads: false },
  eq_creator:     { id: 'eq_creator',     label: 'Creator',     priceInr: 1999, storageBytes: 500 * GB, maxUploadMB: 4096, maxVideoSec: 28800, monthlyUploads: 10000, quality: 'auto-best', ads: false, creator: true },
  eq_creator_pro: { id: 'eq_creator_pro', label: 'Creator Pro', priceInr: 5999, storageBytes: 1024 * GB, maxUploadMB: 8192, maxVideoSec: 43200, monthlyUploads: 50000, quality: 'original', ads: false, creator: true },
  eq_business:    { id: 'eq_business',    label: 'Business',    priceInr: null, storageBytes: 2048 * GB, maxUploadMB: 8192, maxVideoSec: 43200, monthlyUploads: 100000, quality: 'original', ads: false, creator: true, business: true },
};
const DEFAULT_PLAN_ID = 'eq_free';
const PLAN_IDS = new Set(Object.keys(PLAN_CATALOG));

// Platform fee for creator earnings (tips / paid subs / digital products).
const PLATFORM_FEE_BPS = 1000; // 10%

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
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

async function hashPwLocal(password, salt) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(password) + String(salt)));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

// Central Acronous JWT (HS256 {id,email,name}, issued by acronous.com).
// Lets one Acronous account use Equyvo: dashboard SSO (?token=), checkout
// and billing all forward the same Bearer to api.acronous.com, which keys
// subscriptions by u:<id-or-email>. Requires JWT_SECRET (same value as the
// landing + api workers) or CENTRAL_JWT_SECRET to be set; when neither is
// set this step is skipped and Cognito-only behaviour is preserved.
async function verifyCentralJWT(token, env) {
  try {
    const secret = String(env.JWT_SECRET || env.CENTRAL_JWT_SECRET || '');
    if (!secret) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    const id = payload.id || payload.sub || payload.user_id || payload.email;
    if (!id) return null;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const valid = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sigB64), new TextEncoder().encode(headerB64 + '.' + payloadB64)
    );
    if (!valid) return null;
    const email = String(payload.email || (String(id).includes('@') ? id : ''));
    return {
      id: String(id),
      email,
      username: String(payload.name || payload.username || (email ? email.split('@')[0] : String(id))),
      verified: true,
      via: 'central',
    };
  } catch {
    return null;
  }
}

// Resolve the caller identity.
// 1) Valid Cognito JWT -> verified user (always accepted).
// 2) Valid central Acronous JWT -> verified user (always accepted).
// 3) X-User-Id / body userId -> UNVERIFIED fallback, only when
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
      try {
        const raw = await env.EQUYVO_KV.get('auth:session:' + token);
        if (raw) {
          const u = JSON.parse(raw);
          return { id: u.id, email: u.email, username: u.username || u.name || '', verified: true };
        }
      } catch { /* fall through */ }
    }
  }
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const user = await verifyCognitoToken(token, env);
      if (user) return user;
      const central = await verifyCentralJWT(token, env);
      if (central) return central;
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
  comments: 30,
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

// =============== Local billing grants (paid through this app) ===============
// Central billing verifies every Razorpay payment (HMAC + order binding),
// but its own subscription status only resolves CENTRAL Acronous JWTs.
// Equyvo's session tokens are opaque KV keys — central can never decode
// them, so a real payment used to stay invisible to plan resolution,
// storage quotas and ad gating. A successful verify therefore records the
// grant HERE (reusing the PLAN_CACHE shape resolvePlan already reads) so a
// paid tier activates instantly, on every device, with no app restart.
const GRANT_TTL_SEC = 45 * 86400; // mirror central's subscription TTL

function localGrantKey(actorId) {
  return 'billing:grant:' + String(actorId || '').slice(0, 200);
}
function localEmailGrantKey(email) {
  return 'billing:grant:email:' + String(email || '').toLowerCase().slice(0, 254);
}
function validEmailString(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
}

/** Persist a verified payment: account record (+ email record for claim). */
async function putLocalGrant(env, actorId, email, planId, untilMs, paymentId) {
  if (!PLAN_IDS.has(planId)) return;
  const record = {
    plan: planId,
    until: untilMs,
    grant: 'razorpay',
    paymentId: String(paymentId || '').slice(0, 100) || '',
    ts: Date.now(),
  };
  try {
    // Long-TTL account grant (not the 10-min billing cache — this one is
    // the purchase itself, valid until the month ends).
    await env.EQUYVO_KV.put(
      KEYS.PLAN_CACHE(actorId),
      JSON.stringify({ planId, until: untilMs }),
      { expirationTtl: GRANT_TTL_SEC },
    );
    await env.EQUYVO_KV.put(localGrantKey(actorId), JSON.stringify(record), { expirationTtl: GRANT_TTL_SEC });
    if (validEmailString(email)) {
      await env.EQUYVO_KV.put(
        localEmailGrantKey(email),
        JSON.stringify({ plan: planId, until: untilMs, paymentId: record.paymentId }),
        { expirationTtl: GRANT_TTL_SEC },
      );
    }
  } catch { /* best-effort: central remains authoritative for refunds */ }
}

/** Read the local paid-grant record for an account id. */
async function getLocalGrant(env, actorId) {
  try {
    const raw = await env.EQUYVO_KV.get(localGrantKey(actorId));
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (g && PLAN_IDS.has(g.plan) && Number(g.until) > Date.now()) {
      return { plan: g.plan, until: Number(g.until) };
    }
  } catch { /* ignore */ }
  return null;
}

/** Guest paid with email X, then signed in with X: link to this account. */
async function claimLocalEmailGrant(env, actor) {
  if (!actor || !validEmailString(actor.email)) return null;
  try {
    const raw = await env.EQUYVO_KV.get(localEmailGrantKey(actor.email));
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (!g || !PLAN_IDS.has(g.plan) || !(Number(g.until) > Date.now())) return null;
    await putLocalGrant(env, actor.id, actor.email, g.plan, Number(g.until), g.paymentId);
    return { ok: true, granted: [g.plan], plan: g.plan, claimed: true };
  } catch {
    return null;
  }
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

const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
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
  // Voice notes / audio uploads.
  if (mime === 'audio/webm') return 'webm';
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a' || mime === 'audio/m4a') return 'm4a';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'ogg';
  if (mime === 'audio/aac') return 'aac';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
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
  const contentEncoding = (head.httpMetadata && head.httpMetadata.contentEncoding) || '';

  // Legacy gzip objects: decompress BEFORE serving. Browsers do not reliably
  // decompress manually-announced Content-Encoding for image/video requests,
  // which made stored photos undecodable (`naturalWidth === 0`) and silently
  // broke chat backgrounds. Serving plain bytes (with no Content-Encoding
  // header) makes old and new uploads render everywhere.
  const isLegacyGzip = contentEncoding === 'gzip';
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': isLegacyGzip ? 'none' : 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...cors,
    ...SECURITY_HEADERS,
  };
  if (head.etag) baseHeaders['ETag'] = head.etag;
  // NOTE: intentionally never advertise Content-Encoding on our responses.

  if (method === 'HEAD' && !isLegacyGzip) {
    return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(head.size) } });
  }

  if (isLegacyGzip) {
    // Decompressed path: HEAD reports the DECOMPRESSED size, GET streams the
    // plain bytes. Range requests are refused (Accept-Ranges: none) — gzip
    // objects are small stills, not video.
    let plain = null;
    try {
      const obj = await env.EQUYVO_R2.get(key);
      if (!obj) return json({ error: 'Not found' }, 404, cors);
      const gz = await obj.arrayBuffer();
      const ds = new DecompressionStream('gzip');
      const out = new Blob([gz]).stream().pipeThrough(ds);
      const buf = await new Response(out).arrayBuffer();
      plain = new Uint8Array(buf);
    } catch {
      plain = null;
    }
    if (!plain) {
      // Un-decompressible legacy object: serve raw rather than fail.
      const obj2 = await env.EQUYVO_R2.get(key);
      if (!obj2) return json({ error: 'Not found' }, 404, cors);
      return new Response(obj2.body, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(obj2.size) } });
    }
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(plain.byteLength) } });
    }
    return new Response(plain, { status: 200, headers: { ...baseHeaders, 'Content-Length': String(plain.byteLength) } });
  }

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

  // ── Idempotent-create guard: identical rapid re-posts return the original ──
  // Double-tapped "Post" buttons, retried taps during a slow network, or
  // replayed requests previously created real duplicate stories/moments in
  // the feed. Now an identical item from the SAME account within a short
  // window returns the ALREADY-created item instead of duplicating it.
  // Distinct uploads (different text/media or after the window) create as
  // normal — nothing legitimate is ever swallowed.
  let idempotencyId = '';
  let idempotencyKey = '';
  try {
    const fpText = JSON.stringify([
      kind,
      actor.id,
      String(body.content || body.text || ''),
      String(body.title || ''),
      String(body.videoUrl || body.video || body.media || ''),
      String(body.image || body.image_url || ''),
      Array.isArray(body.tags) ? body.tags.join('|') : String(body.tags || ''),
    ]);
    const fp = await sha256Hex(new TextEncoder().encode(fpText).buffer);
    idempotencyId = fp.slice(0, 24);
    idempotencyKey = 'dup:' + kind + ':' + actor.id + ':' + idempotencyId;
    const recent = await kv.get('seenup:' + idempotencyKey);
    if (recent) {
      const prev = JSON.parse(recent);
      if (prev && prev.id) {
        const prevRaw = await kv.get(itemKey(prev.id));
        if (prevRaw) return json({ data: transformItem(JSON.parse(prevRaw)), duplicate: true, error: null }, 200, cors);
      }
    }
  } catch { /* dedupe is best-effort */ }

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
  // Record the idempotency window for this content fingerprint.
  try {
    if (idempotencyKey) {
      await kv.put('seenup:' + idempotencyKey, JSON.stringify({ id, at: Date.now() }), { expirationTtl: 15 });
    }
  } catch { /* best-effort */ }
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
  // New-upload fan-out: followers get an in-app (+push) notification.
  // Bounded to 50 followers, background via waitUntil when available so
  // uploads stay fast (lag-free) even for large audiences.
  try {
    const fan = (async () => {
      try {
        const followers = await readIdList(env, KEYS.FOLLOWERS(actor.id));
        const head = followers.slice(0, 50);
        const title = String(item.content || item.title || item.description || '').slice(0, 120) || 'New post';
        const author = String(item.user || item.creator || actor.id).slice(0, 80);
        await Promise.all(head.map((fid) => pushUserNotification(env, fid, {
          kind: 'upload', title: 'New from ' + author, body: title,
          actorId: actor.id, actorName: author,
        }).catch(() => {})));
      } catch { /* ignore */ }
    })();
    if (context && typeof context.waitUntil === 'function') { try { context.waitUntil(fan); } catch {} }
    else { void fan; }
  } catch { /* ignore */ }
  // New content boosts the author's interest graph (zero frontend changes).
  try {
    if (actor && actor.id) await aiRecordEngagement(env, actor.id, { category: String(item.category || ''), tags: Array.isArray(item.tags) ? item.tags : [], creator: String(item.user || ''), action: 'create' });
  } catch {}
  // Human-eval fan-out: every upload becomes a labelled preference for the
  // shared Acronous brain (Contabo). Backend-only, never surfaced to client.
  try {
    const evalText = String(item.content || item.title || item.description || '').slice(0, 500);
    if (evalText.trim()) {
      void aiFetchJson(aiBrainBase(env) + '/v1/learn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: evalText,
          response: 'user uploaded ' + kind + ': ' + String(item.id),
          session_id: String(actor.id).slice(0, 100),
          source: 'equyvo',
          route_type: 'equyvo-upload',
          feedback: 0.5,
        }),
      }, 2500).catch(() => null);
    }
  } catch { /* ignore */ }
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

    // AUTH (self-contained, no email verification required) ─────────────
    // Equyvo keeps its own user store in KV so sign-up/sign-in never depend
    // on an external Cognito pool or email confirmation. A valid email +
    // password is enough to use the app.
    if (path === '/api/auth/signup' && method === 'POST') {
      let body = {};
      try { body = (await request.json()) || {}; } catch { return json({ error: 'Invalid JSON body.' }, 400, cors); }
      const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      const password = String(body.password || '');
      const name = String(body.name || '').trim().slice(0, 80) || (email ? email.split('@')[0] : '');
      const isPrivate = body.isPrivate === true || body.accountType === 'private';
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'A valid email is required.' }, 400, cors);
      if (!password || password.length < 6) return json({ error: 'Password must be at least 6 characters.' }, 400, cors);
      // Deleted/banned emails stay unavailable (tombstone wins over signup).
      if (await kv.get('auth:blocked:' + email)) {
        return json({ error: 'This email is no longer available.' }, 403, cors);
      }
      const existing = await kv.get('auth:user:' + email);
      if (existing) return json({ error: 'An account with this email already exists. Try signing in.' }, 409, cors);
      const salt = crypto.randomUUID();
      const hashed = await hashPwLocal(password, salt);
      const user = { id: crypto.randomUUID(), email, name, salt, password: hashed, createdAt: new Date().toISOString(), isPrivate };
      await kv.put('auth:user:' + email, JSON.stringify(user));
      await ensureProfile(env, user);
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      await kv.put('auth:session:' + token, JSON.stringify({ id: user.id, email, name, username: name, isPrivate }), { expirationTtl: 60 * 60 * 24 * 7 });
      return json({ success: true, token, user: { id: user.id, email, name, username: name, isPrivate } }, 200, cors);
    }

    if (path === '/api/auth/login' && method === 'POST') {
      let body = {};
      try { body = (await request.json()) || {}; } catch { return json({ error: 'Invalid JSON body.' }, 400, cors); }
      const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      const password = String(body.password || '');
      if (!email || !password) return json({ error: 'Email and password are required.' }, 400, cors);
      // Deleted/banned accounts stay dead: without this tombstone, the
      // auto-provision fallback below would resurrect them on login.
      if (await kv.get('auth:blocked:' + email)) {
        return json({ error: 'This account is no longer available.' }, 403, cors);
      }
      const raw = await kv.get('auth:user:' + email);
      let user;
      if (!raw) {
        // Auto-provision on login so returning/legacy users are never
        // blocked by a missing record (treats login as sign-up fallback).
        const salt = crypto.randomUUID();
        const hashed = await hashPwLocal(password, salt);
        user = { id: crypto.randomUUID(), email, name: email.split('@')[0], salt, password: hashed, createdAt: new Date().toISOString(), isPrivate: false };
        await kv.put('auth:user:' + email, JSON.stringify(user));
      } else {
        try { user = JSON.parse(raw); } catch { return json({ error: 'Invalid email or password.' }, 401, cors); }
        // Migrate legacy/incomplete records that lack salt/password.
        if (!user.salt || !user.password) {
          const salt = crypto.randomUUID();
          const hashed = await hashPwLocal(password, salt);
          user.salt = salt;
          user.password = hashed;
          user.name = user.name || email.split('@')[0];
          user.email = user.email || email;
          if (!user.id) user.id = crypto.randomUUID();
          await kv.put('auth:user:' + email, JSON.stringify(user));
        } else {
          const hashed = await hashPwLocal(password, user.salt);
          if (hashed !== user.password) return json({ error: 'Invalid email or password.' }, 401, cors);
        }
      }
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
      await kv.put('auth:session:' + token, JSON.stringify({ id: user.id, email: user.email, name: user.name, username: user.name, isPrivate: user.isPrivate === true }), { expirationTtl: 60 * 60 * 24 * 7 });
      await ensureProfile(env, user);
      return json({ success: true, token, user: { id: user.id, email: user.email, name: user.name, username: user.name, isPrivate: user.isPrivate === true } }, 200, cors);
    }

    if (path === '/api/auth/me' && method === 'GET') {
      const token = bearerFrom(request);
      if (!token) return json({ error: 'Not authenticated.' }, 401, cors);
      const raw = await kv.get('auth:session:' + token);
      if (!raw) return json({ error: 'Not authenticated.' }, 401, cors);
      let u;
      try { u = JSON.parse(raw); } catch { return json({ error: 'Not authenticated.' }, 401, cors); }
      return json({ success: true, user: u }, 200, cors);
    }

    if (path === '/api/auth/logout' && method === 'POST') {
      const token = bearerFrom(request);
      if (token) { try { await kv.delete('auth:session:' + token); } catch {} }
      return json({ success: true }, 200, cors);
    }

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

    // GEO (public): the visitor's country (Cloudflare edge data) so the
    // pricing page can show country-appropriate currency approximations.
    // Returns only the two-letter country code — no other data. Falls back
    // to an empty code, which the client resolves from browser locale.
    if (path === '/api/geo' && method === 'GET') {
      let country = '';
      try {
        const cf = (request as unknown as { cf?: { country?: string } }).cf;
        if (cf && typeof cf.country === 'string' && /^[A-Za-z]{2}$/.test(cf.country)) country = cf.country.toUpperCase();
      } catch { /* cf missing in local dev */ }
      return json({ data: { country }, error: null }, 200, { ...cors, 'Cache-Control': 'private, max-age=3600' });
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
    // browser only ever sees key_id + order_id, and returns payment_id +
    // signature for verify.
    //
    // Bearer policy (the "Sign in failed" fix): the bearer is forwarded
    // ONLY when central can verify it (dashboard SSO JWT). Equyvo's own
    // session tokens are opaque KV keys — forwarded verbatim they made
    // central answer 401 "Please sign in to continue." on every tap of a
    // plan card, which surfaced to users as an endless sign-in loop.
    // Signed-in Equyvo callers instead check out through the verified
    // account email (central's guest-with-email path): the order binds
    // guest_email, verify grants it, and the grant is recorded locally so
    // this account immediately holds the paid tier.
    if ((path === '/api/create-order' || path === '/api/verify-payment') && method === 'POST') {
      const bearer = bearerFrom(request);
      let body: any = {};
      try { body = (await request.json()) || {}; } catch { return json({ error: 'Invalid JSON body.' }, 400, cors); }
      const centralAuthed = Boolean(bearer && await verifyCentralJWT(bearer, env));
      // Which email pays for this order:
      //   1. explicit guest email in the body (signed-out checkout), or
      //   2. the caller's VERIFIED account email (signed-in Equyvo user).
      const guestEmail = !centralAuthed && typeof body.email === 'string' && validEmailString(body.email)
        ? body.email.trim().toLowerCase().slice(0, 254) : null;
      let payerActor: any = null;
      if (!centralAuthed) payerActor = await getActor(request, env);
      const payerEmail = !centralAuthed && payerActor && validEmailString(payerActor.email)
        ? String(payerActor.email).trim().toLowerCase() : null;
      const orderEmail = guestEmail || payerEmail;
      if (!centralAuthed && !orderEmail) return json({ error: 'Please sign in first.' }, 401, cors);
      // Abuse guard: order/verify spam costs real upstream writes (Razorpay
      // orders, central bookkeeping). Per-minute caps keyed to whoever is
      // paying — central caller, account id, guest email, or IP fallback.
      const rlId = centralAuthed
        ? 'u:' + bearer.slice(-24)
        : payerActor && payerActor.id ? 'a:' + payerActor.id
        : orderEmail ? 'e:' + orderEmail
        : 'ip:' + (request.headers.get('cf-connecting-ip') || 'unknown');
      const rlKind = path === '/api/create-order' ? 'billing_order' : 'billing_verify';
      if (!(await rateLimit(env.EQUYVO_KV, rlKind, rlId, path === '/api/create-order' ? 8 : 20)).ok) {
        return json({ error: 'Too many payment attempts. Please wait a minute and try again.' }, 429, cors);
      }
      if (path === '/api/create-order') {
        // STRICT: a catalog plan id is required. Raw client-supplied amounts
        // are never forwarded — the central worker prices from its catalog
        // (and also rejects bare amounts since hardening).
        const plan = typeof body.plan === 'string' ? body.plan.slice(0, 64) : '';
        if (!plan) return json({ error: 'A plan id is required.' }, 400, cors);
        body = orderEmail ? { plan, email: orderEmail } : { plan };
      }
      if (path === '/api/verify-payment' && (!body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature)) {
        return json({ ok: false, error: 'Missing payment fields.' }, 400, cors);
      }
      // Verify rides with the payer email too (central binds by the server-set
      // order notes; the email only helps its claim bookkeeping).
      if (path === '/api/verify-payment' && orderEmail && !body.email) body.email = orderEmail;
      const base = (env.BILLING_BASE_URL || 'https://api.acronous.com').replace(/\/$/, '');
      const target = base + (path === '/api/create-order' ? '/v1/billing/order' : '/v1/billing/verify');
      try {
        const upstream = await fetch(target, {
          method: 'POST',
          headers: centralAuthed
            ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer }
            : { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await upstream.json().catch(() => ({ error: 'Bad billing response.' }));
        // Verified purchase → record the grant LOCALLY so the paid tier is
        // visible to plan resolution / quotas / ad-gating right away and on
        // every device — never gated on central's own JWT recognition.
        if (upstream.ok && path === '/api/verify-payment' && data && data.ok) {
          try {
            const paidPlan = String(data.plan || body.plan || '').slice(0, 64);
            if (PLAN_IDS.has(paidPlan)) {
              const untilMs = Date.now() + 31 * 86400000;
              const grantActor = await getActor(request, env);
              if (grantActor) {
                await putLocalGrant(env, grantActor.id, grantActor.email, paidPlan, untilMs, body.razorpay_payment_id);
                // The paid grant belongs to THIS account: keep the client's
                // success toast honest even when the upstream order was a
                // guest-email order created from the session email.
                data.plan = paidPlan;
                data.guest = false;
                data.claimed = true;
              } else if (orderEmail) {
                // True guest (no session): park the grant under the payment
                // email — claim-on-signin promotes it to the account.
                await kv.put(
                  localEmailGrantKey(orderEmail),
                  JSON.stringify({ plan: paidPlan, until: untilMs, paymentId: String(body.razorpay_payment_id || '').slice(0, 100) }),
                  { expirationTtl: GRANT_TTL_SEC },
                );
              }
            }
          } catch { /* grant persistence is best-effort */ }
          // Verified purchase → +2 display-name changes (idempotent per
          // payment). Best-effort: never fails the payment response itself.
          try {
            const actor = await getActor(request, env);
            if (actor) {
              const paymentKey = String(
                (body && (body.razorpay_payment_id || body.payment_id)) || '',
              ).slice(0, 100) || ('verify:' + String(Date.now()));
              const prof = (await getStoredProfile(env, actor.id)) || { id: actor.id };
              const st = nameQuotaState(prof);
              let profChanged = false;
              if (!st.grants.includes(paymentKey)) {
                prof.nameChangeQuota = st.quota + NAME_CHANGE_GRANT_PER_PURCHASE;
                prof.nameChangesUsed = st.used;
                prof.nameGrantPayments = [...st.grants, paymentKey].slice(-50);
                if (!Array.isArray(prof.nameBonusPlans)) prof.nameBonusPlans = st.bonusPlans;
                profChanged = true;
                data.nameGrant = {
                  granted: NAME_CHANGE_GRANT_PER_PURCHASE,
                  quota: prof.nameChangeQuota,
                  used: st.used,
                  remaining: Math.max(0, prof.nameChangeQuota - st.used),
                };
              }
              // Creator Pro verified badge: granted with this payment. The
              // tick attaches to the profile's registered display name (or
              // username) and is globally exclusive in the verified-name
              // registry — see grantVerifiedName. Idempotent: renewing the
              // same plan keeps the exact same verified name and date.
              const paidPlan = String((data && data.plan) || (body && body.plan) || '').slice(0, 64);
              if (paidPlan === 'eq_creator_pro') {
                const vs = verifiedProfileState(prof);
                const g = await grantVerifiedName(env, actor.id, prof, vs.name || prof.name || prof.username || '');
                if (g.ok && g.patch) {
                  Object.assign(prof, g.patch);
                  prof.verifiedNamePending = false;
                  profChanged = true;
                  data.verifiedBadge = { granted: true, name: g.patch.verifiedName, grantedAt: g.patch.verifiedNameAt, canChangeNameFrom: g.patch.nameLockUntil };
                } else if (g && g.error) {
                  // Name is exclusive-held or empty: keep the purchase valid,
                  // mark the badge as pending so the next unique name claim
                  // attaches it (server enforces on the profile save).
                  prof.verifiedNamePending = true;
                  profChanged = true;
                  data.verifiedBadge = { granted: false, pending: true, reason: g.code || 'VERIFIED_NAME_BLOCKED' };
                }
              }
              if (profChanged) {
                await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(prof));
              }
            }
          } catch { /* grant is best-effort */ }
        }
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

    // THOUGHTS TRENDING (real engagement algorithm, server-computed):
    // GET /api/thoughts/trending — topics come ONLY from explicit tags and
    // #hashtags in real thoughts (never invented). Score = Σ(engagement ×
    // recency decay) with a volume floor, where engagement is the same
    // composite the feed uses (pop score + reacts + likes + comments).
    // Direction compares the last 24h against the previous window so the
    // list visibly reorders as the app's activity changes. Cached 45s in
    // KV so every client polls the same fresh-but-cheap ranking.
    if (path === '/api/thoughts/trending' && method === 'GET') {
      const CACHE_KEY = 'trending:thoughts:v1';
      try {
        const cached = await kv.get(CACHE_KEY);
        if (cached) {
          const c = JSON.parse(cached);
          if (c && Array.isArray(c.topics) && c.computedAt && (Date.now() - c.computedAt) < 45000) {
            return json({ data: { topics: c.topics, source: 'algorithm', computedAt: c.computedAt, cached: true }, error: null }, 200, cors);
          }
        }
      } catch { /* cache miss — compute below */ }

      const viewer = await getViewer(request, env);
      const ids = (await cleanOrphans(env, KEYS.THOUGHTS, KEYS.THOUGHT)).slice(0, 300);
      const raw = (await Promise.all(ids.map(async (id) => {
        try { const t = await kv.get(KEYS.THOUGHT(id)); return t ? JSON.parse(t) : null; } catch { return null; }
      }))).filter(Boolean);

      // Same visibility rules as the feed: removed/private/followers-only
      // thoughts must never leak into what "trends".
      const visible = await filterVisibleItems(
        env,
        viewer,
        await filterSeed(env, raw.map((t) => ({ ...t, ownerId: t.userId || t.ownerId || t.user || t.authorId }))),
      );

      const pops = {};
      await Promise.all(visible.slice(0, 250).map(async (t) => {
        try { const r = await kv.get(KEYS.POP(t.id)); if (r) pops[t.id] = parseInt(r, 10) || 0; } catch {}
      }));

      const topicsOf = (t) => {
        const names = new Set();
        for (const tag of (Array.isArray(t.tags) ? t.tags : [])) {
          const key = String(tag || '').trim().replace(/^#+/, '').toLowerCase();
          if (key && key.length <= 40) names.add(key);
        }
        const matches = String(t.content || '').match(/#([A-Za-z0-9_]{2,40})/g) || [];
        for (const m of matches) names.add(m.slice(1).toLowerCase());
        return [...names];
      };
      const engagementOf = (t) => {
        const up = Number(t.upvotes_count ?? t.upvotes ?? t.votes ?? 0) || 0;
        const down = Number(t.downvotes_count ?? t.downvotes ?? 0) || 0;
        const votes = up - down * 0.5;
        const likes = Number(t.likes ?? t.likes_count ?? t.likesCount ?? 0) || 0;
        const reacts = Number(t.reacts ?? t.reacts_count ?? 0) || 0;
        const comments = Number(t.comments ?? t.comments_count ?? 0) || 0;
        const pop = Number(pops[t.id] || 0);
        return votes * 2 + likes * 1.5 + reacts * 2 + comments * 3 + pop;
      };
      const now = Date.now();

      const recencyDecay = (t) => {
        const ts = new Date(t.createdAt || t.publishedAt || 0).getTime();
        if (!Number.isFinite(ts) || ts <= 0) return 0.01;
        const ageH = Math.max(0, (now - ts) / 3600000);
        // 12.6h half-life: yesterday's buzz cools to near-zero by the weekend.
        return Math.pow(2, -ageH / 18);
      };

      const aggregates = new Map();
      for (const t of visible.slice(0, 250)) {
        const tags = topicsOf(t);
        if (!tags.length) continue;
        const decay = recencyDecay(t);
        const eng = engagementOf(t);
        // Volume floor: a topic only counts while it is recent enough to be
        // a trend; the engagement multiplier amplifies hot thoughts.
        const contribution = (1 + Math.max(0, eng)) * decay;
        const ageH = (() => {
          const ts = new Date(t.createdAt || t.publishedAt || 0).getTime();
          if (!Number.isFinite(ts) || ts <= 0) return 8760;
          return Math.max(0, (now - ts) / 3600000);
        })();
        for (const key of tags) {
          const rec = aggregates.get(key) || { count: 0, score: 0, recent: 0, past: 0 };
          rec.count += 1;
          rec.score += contribution;
          if (ageH <= 24) rec.recent += 1;
          else if (ageH <= 48) rec.past += 1;
          aggregates.set(key, rec);
        }
      }

      const topics = [...aggregates.entries()]
        .map(([name, v]) => {
          // Velocity: more tagging activity in the last 24h than the
          // previous window = rising; visibly lower = cooling; else stable.
          let trend = 'stable';
          if (v.recent > v.past) trend = 'up';
          else if (v.past > 0 && v.recent < v.past) trend = 'down';
          return { name: '#' + name, count: v.count, score: Math.round(v.score * 10) / 10, trend };
        })
        .sort((a, b) => b.score - a.score || b.count - a.count)
        .slice(0, 8);

      const computedAt = Date.now();
      try { await kv.put(CACHE_KEY, JSON.stringify({ computedAt, topics }), { expirationTtl: 300 }); } catch {}
      return json({ data: { topics, source: 'algorithm', computedAt, cached: false }, error: null }, 200, cors);
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

    // NAME-CHANGE QUOTA (authenticated): { used, quota, remaining } so the
    // profile editor can show remaining renames + the Premium upsell.
    if (path === '/api/profile/name-quota' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const prof = (await getStoredProfile(env, actor.id)) || {};
      const st = nameQuotaState(prof);
      const vs = verifiedProfileState(prof);
      return json({ data: {
        used: st.used, quota: st.quota, remaining: st.remaining,
        verified: vs.active,
        verifiedName: vs.active ? vs.name : '',
        canChangeNameAt: vs.active ? vs.lockUntil : 0,
      }, error: null }, 200, cors);
    }

    // VERIFIED-NAME availability (authenticated): can THIS account claim the
    // candidate name as its Creator Pro verified identity? Never leaks the
    // owner's identity — only availability + the reason.
    if (path === '/api/profile/verify-name-check' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const candidate = lowerVerifiedName(url.searchParams.get('name') || '');
      const prof = (await getStoredProfile(env, actor.id)) || {};
      const vs = verifiedProfileState(prof);
      const { planId: livePlan } = await resolvePlan(env, actor, bearerFrom(request));
      const creatorProActive = livePlan === 'eq_creator_pro';
      const base = { verified: vs.active, verifiedName: vs.active ? vs.name : '', canChangeAt: vs.active ? vs.lockUntil : 0, creatorProActive };
      if (!candidate) return json({ data: { ...base, available: false, reason: 'NAME_REQUIRED' }, error: null }, 200, cors);
      const rec = await verifiedNameRecord(env, candidate);
      const mine = vs.active && vs.lower === candidate;
      if (rec && rec.userId && rec.userId !== String(actor.id)) {
        return json({ data: { ...base, available: false, reason: rec.tombstone ? 'NAME_VERIFIED_ELSEWHERE' : 'NAME_TAKEN' }, error: null }, 200, cors);
      }
      if (mine) return json({ data: { ...base, available: true, reason: 'CURRENT' }, error: null }, 200, cors);
      return json({ data: { ...base, available: true, reason: '' }, error: null }, 200, cors);
    }

    // CONTENT-SCREEN (authenticated, pre-upload): the Create page calls this
    // the moment a file is picked, BEFORE any upload traffic. Runs the same
    // safety stack used at publish time (local blocklists + Acronous safety
    // brain + vision survey of small frame samples) so obvious adult /
    // violent / exploitative / illegal media is refused on the spot. This is
    // a UX gate, not the final gate — publish-time moderation still runs and
    // can quarantine. The verdict travels to the client, internals (patterns,
    // brain URLs) never leave the server.
    if (path === '/api/content-screen' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      let payload = {};
      try { payload = await readJson(request); } catch { payload = {}; }
      if (!payload || typeof payload !== 'object') payload = {};
      const filename = String((payload as any).filename || '').slice(0, 200);
      const caption = String((payload as any).caption || '').slice(0, 600);
      let samples = Array.isArray((payload as any).samples) ? (payload as any).samples : [];
      // Hard caps: at most 4 samples, each clipped, never logged.
      samples = samples
        .filter((s) => typeof s === 'string' && /^data:image\/(jpe?g|png);base64,/.test(s.slice(0, 40)))
        .slice(0, 4)
        .map((s) => s.slice(0, 260000));
      const text = [filename, caption].filter(Boolean).join('\n');
      const local = moderateTextLocal(text);
      let verdict = local.verdict;
      let category = '';
      if (verdict === 'allow') {
        try {
          const brain = await brainSafetyCheck(env, text);
          if (brain === 'block') verdict = 'block';
          else if (brain === 'review') verdict = 'review';
        } catch { /* fail-open */ }
      }
      if (verdict === 'allow' && samples.length > 0) {
        try {
          const data = await aiFetchJson(aiBrainBase(env) + '/v1/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: samples, task: 'moderate', source: 'equyvo-upload-gate' }),
          }, 4000);
          if (data && typeof data === 'object') {
            if (data.safe === false || data.block === true) verdict = 'block';
            else if (data.review === true || data.quarantine === true) verdict = 'review';
            else {
              const cats = (data.categories || data.labels || []);
              if (Array.isArray(cats) && cats.some((c) => /child|csam|minor|terror|non-?consensual|assault/i.test(String(c)))) verdict = 'block';
              else if (Array.isArray(cats) && cats.some((c) => /adult|nudity|porn|graphic|gore|violence/i.test(String(c)))) { verdict = 'review'; category = /child|minor/i.test(cats.join(' ')) ? 'exploitative' : 'adult'; }
            }
            if (!category && verdict !== 'allow') category = /child|csam|minor/i.test(JSON.stringify(data)) ? 'exploitative' : 'adult';
          }
        } catch { /* vision is best-effort; publish-time gate still applies */ }
      }
      if (verdict !== 'allow' && !category) category = 'unspecified';
      const message = verdict === 'block'
        ? 'This content isn’t allowed on Equyvo (adult, violent, exploitative or otherwise prohibited media). It was not added.'
        : verdict === 'review'
          ? 'This content looks potentially unsafe and cannot be added until it passes review.'
          : '';
      return json({ data: { verdict, category: category || 'unspecified', checked: true, message }, error: null }, 200, cors);
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
      // Quota + verified-badge counters are server-owned: forged client values
      // are dropped and the stored counters are merged back on save.
      delete clean.nameChangesUsed;
      delete clean.nameChangeQuota;
      delete clean.nameGrantPayments;
      delete clean.nameBonusPlans;
      delete clean.verified;            // badge is granted only by payment
      delete clean.verifiedName;        // registry-managed
      delete clean.verifiedNameAt;
      delete clean.nameLockUntil;
      delete clean.verifiedNamePending;
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
      if (typeof clean.name === 'string') clean.name = clean.name.slice(0, 80);
      if (typeof clean.username === 'string') clean.username = clean.username.slice(0, 80);
      // Display-name quota: avatar/bio/username edits are unlimited; only an
      // actual change of the display `name` consumes quota. The first-ever
      // name on a fresh profile is free (establishing, not changing).
      const prevProfile = (await getStoredProfile(env, id)) || {};
      const qs = nameQuotaState(prevProfile);
      let used = qs.used;
      let quota = qs.quota;
      const bonusPlans = [...qs.bonusPlans];
      const prevName = typeof prevProfile.name === 'string' ? prevProfile.name : '';
      const nextName = typeof clean.name === 'string' ? clean.name : prevName;
      const nameChanged = prevName ? nextName.trim() !== prevName.trim() : false;
      const vs = verifiedProfileState(prevProfile);
      let verifiedPatch = null;
      if (nameChanged && vs.active) {
        // Creator Pro verified name: renames are allowed at most once a
        // month (see VERIFIED_LOCK_MS). The registry move + tombstone runs
        // only after every other gate passes, on the merged save below.
        const now = Date.now();
        if (now < vs.lockUntil) {
          return json({
            error: `Your verified name "${vs.name}" was registered recently. Verified names can be changed at most once a month.`,
            code: 'VERIFIED_NAME_LOCK',
            canChangeAt: vs.lockUntil,
          }, 403, cors);
        }
        // The new name must be claimable (never owned/tombstoned by another
        // account). Verification follows the name — the registry moves.
        const g = await grantVerifiedName(env, id, prevProfile, clean.name);
        if (!g.ok) {
          return json({ error: g.error, code: g.code }, 409, cors);
        }
        verifiedPatch = g.patch;
      } else if (nameChanged && vs.pending) {
        // A Creator Pro payment is waiting for a claimable unique name
        // (their name at purchase time was verified by someone else).
        // Establishing the verified identity consumes no quota — it is a
        // first-time grant, like a fresh profile's first name.
        const g = await grantVerifiedName(env, id, prevProfile, clean.name);
        if (g.ok && g.patch) {
          verifiedPatch = g.patch;
          verifiedPatch = { ...g.patch, verifiedNamePending: false };
        }
        // Not claimable? Fall through: the rename works as an ordinary
        // (quota-gated) name change and the badge stays pending.
      }
      if (nameChanged && !verifiedPatch) {
        // On-demand grant for a paid plan that never recorded a purchase
        // (legacy purchases predate the grant ledger): +2 once per plan.
        try {
          const live = await resolvePlan(env, actor, bearerFrom(request));
          if (NAME_PAID_PLAN_IDS.has(live.planId) && !bonusPlans.includes(live.planId)) {
            quota += NAME_CHANGE_GRANT_PER_PURCHASE;
            bonusPlans.push(live.planId);
          }
        } catch { /* quota check below still applies */ }
        if (used >= quota) {
          return json(quotaErrorBody(used, quota), 402, cors);
        }
        used += 1;
      }
      const merged = {
        ...prevProfile,
        ...clean,
        id,
        nameChangesUsed: used,
        nameChangeQuota: quota,
        nameGrantPayments: qs.grants,
        nameBonusPlans: bonusPlans,
      };
      if (verifiedPatch) Object.assign(merged, verifiedPatch);
      await kv.put(KEYS.PROFILE(id), JSON.stringify(merged));
      return json({ data: merged, error: null }, 200, cors);
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
      // NOTE: do not early-return on empty content here — people results are
      // resolved below and must still be returned when there is no content.
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
      // ── People search: match real user profiles (username / name / bio) ──
      // Bounded KV scan (max 200 profiles) so search stays lag-free. Seed and
      // test profiles are never returned. Private accounts are included as
      // people results (public-safe subset) — their media stays gated by
      // filterVisibleItems on content, mirroring Instagram-style search.
      let matchedUsers = [];
      try {
        const ql = query.toLowerCase().trim();
        if (ql) {
          let listed = null;
          try {
            listed = await kv.list({ prefix: 'profile:', limit: 200 });
          } catch { listed = null; }
          const keys = listed && Array.isArray(listed.keys) ? listed.keys.map((k) => k.name) : [];
          const head = keys.slice(0, 200);
          const profiles = [];
          for (let i = 0; i < head.length; i += 20) {
            const slice = head.slice(i, i + 20);
            const rows = await Promise.all(slice.map(async (k) => {
              try {
                const raw = await kv.get(k);
                return raw ? JSON.parse(raw) : null;
              } catch { return null; }
            }));
            for (const r of rows) if (r) profiles.push(r);
          }
          const scoredUsers = [];
          for (const p of profiles) {
            if (!p || typeof p !== 'object') continue;
            const pid = String(p.id || '');
            if (!pid || SEED_PROFILE_IDS.has(pid)) continue;
            if (p.isSeed === true) continue;
            const email = String(p.email || '');
            if (/@test\.com$/i.test(email) || /^pwsrc_/i.test(pid)) continue;
            const username = String(p.username || p.name || '').toLowerCase();
            const name = String(p.name || '').toLowerCase();
            const bio = String(p.bio || '').toLowerCase();
            const idl = pid.toLowerCase();
            const handle = username.startsWith('@') ? username : '@' + username;
            let s = 0;
            if (username === ql || handle === ql || idl === ql) s += 200;
            else if (username === ql.replace(/^@/, '')) s += 180;
            if (username.includes(ql) || ql.includes(username) && username) s += 120;
            if (handle.includes(ql)) s += 110;
            if (name && (name.includes(ql) || ql.includes(name))) s += 100;
            if (idl.includes(ql) && ql.length >= 3) s += 60;
            if (bio && bio.includes(ql)) s += 40;
            const qtoks = ql.split(/\s+/).filter((w) => w.length > 1);
            for (const tok of qtoks) {
              if (username.includes(tok)) s += 25;
              else if (name.includes(tok)) s += 20;
              else if (bio.includes(tok)) s += 10;
            }
            if (s > 0) {
              const isPrivate = p.isPrivate === true;
              scoredUsers.push({
                s,
                user: isPrivate
                  ? { id: pid, name: p.name, username: p.username, avatar: p.avatar || '', bio: typeof p.bio === 'string' ? String(p.bio).slice(0, 160) : '', isPrivate: true, restricted: true, followers: Number(p.followers || 0) || 0, following: Number(p.following || 0) || 0, verified: !!p.verified }
                  : { id: pid, name: p.name || p.username || pid, username: p.username || p.name || pid, avatar: cleanCommentAvatar(p.avatar || ''), bio: typeof p.bio === 'string' ? String(p.bio).slice(0, 160) : '', isPrivate: false, followers: Number(p.followers || 0) || 0, following: Number(p.following || 0) || 0, verified: !!p.verified },
              });
            }
          }
          scoredUsers.sort((a, b) => b.s - a.s);
          matchedUsers = scoredUsers.slice(0, limit).map((x) => x.user);
        }
      } catch { matchedUsers = []; }
      if (!query.trim()) {
        return json({ data: { results: ranked.slice(0, limit).map((x) => transformItem(x.item)), users: [], totalCount: base.length, userCount: 0, isAiRecommended: personalized, personalized } }, 200, cors);
      }
      const matching = ranked.filter((x) => x.s >= 15);
      // Honest empty: when nothing matches, return empty (no fallback filler)
      // so the app can show "No results found". Never invent results.
      if (!matching.length && !matchedUsers.length) {
        return json({ data: { results: [], users: [], totalCount: 0, userCount: 0, isAiRecommended: false, personalized } }, 200, cors);
      }
      return json({ data: { results: matching.slice(0, limit).map((x) => transformItem(x.item)), users: matchedUsers, totalCount: matching.length, userCount: matchedUsers.length, isAiRecommended: personalized, personalized } }, 200, cors);
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
      // Human-eval fan-out to the shared brain (best-effort, never blocks):
      // the engagement that just ranked this feed also becomes a labelled
      // preference for continual learning. Equyvo hosts no model itself.
      try {
        const act = String(body.action || 'view').slice(0, 20);
        void aiFetchJson(aiBrainBase(env) + '/v1/learn', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: String(body.itemId || body.category || act).slice(0, 300),
            response: `user ${act}`,
            route_type: 'equyvo-feed',
            session_id: String(userId).slice(0, 100),
            source: 'equyvo',
          }),
        }, 2500).catch(() => null);
      } catch { /* ignore */ }
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
      let added = false;
      if (!following.some((x) => x === target)) {
        following.unshift(target);
        await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(following.slice(0, 5000)));
        added = true;
      }
      if (!followers.some((x) => x === actor.id)) {
        followers.unshift(actor.id);
        await kv.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.slice(0, 50000)));
        added = true;
      }
      if (added) {
        try {
          const tp = await getStoredProfile(env, target);
          if (tp) { tp.followers = (Number(tp.followers || 0) + 1); await kv.put(KEYS.PROFILE(target), JSON.stringify(tp)); }
          const ap = await getStoredProfile(env, actor.id);
          if (ap) { ap.following = (Number(ap.following || 0) + 1); await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(ap)); }
        } catch { /* best-effort */ }
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
      const wasFollowing = following.some((x) => x === target);
      const wasFollower = followers.some((x) => x === actor.id);
      await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(following.filter((x) => x !== target)));
      await kv.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.filter((x) => x !== actor.id)));
      if (reqs.some((x) => x === actor.id)) {
        await kv.put(KEYS.FOLLOW_REQ(target), JSON.stringify(reqs.filter((x) => x !== actor.id)));
      }
      if (wasFollowing || wasFollower) {
        try {
          if (wasFollower) {
            const tp = await getStoredProfile(env, target);
            if (tp) { tp.followers = Math.max(0, Number(tp.followers || 0) - 1); await kv.put(KEYS.PROFILE(target), JSON.stringify(tp)); }
          }
          if (wasFollowing) {
            const ap = await getStoredProfile(env, actor.id);
            if (ap) { ap.following = Math.max(0, Number(ap.following || 0) - 1); await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(ap)); }
          }
        } catch { /* best-effort */ }
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
      // Lightweight profiles (bounded to 100) so sheets render names/avatars
      // without N+1 client fetches. Best-effort; ids are always authoritative.
      let profiles = [];
      try {
        const head = ids.slice(0, 100);
        const batch = 20;
        for (let i = 0; i < head.length; i += batch) {
          const slice = head.slice(i, i + batch);
          const rows = await Promise.all(slice.map(async (pid) => {
            try {
              const stored = await profileWithFallback(env, pid);
              return profileSummary(stored, pid);
            } catch { return profileSummary(null, pid); }
          }));
          profiles.push(...rows);
        }
      } catch { profiles = []; }
      return json({ data: { count: ids.length, ids: ids.slice(0, 500), profiles }, error: null }, 200, cors);
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
        let addedFollowing = false;
        if (!following.some((x) => x === actor.id)) {
          following.unshift(actor.id);
          await kv.put(KEYS.FOLLOWING(requester), JSON.stringify(following.slice(0, 5000)));
          addedFollowing = true;
        }
        let addedFollower = false;
        if (!followers.some((x) => x === requester)) {
          followers.unshift(requester);
          await kv.put(KEYS.FOLLOWERS(actor.id), JSON.stringify(followers.slice(0, 50000)));
          addedFollower = true;
        }
        if (addedFollowing || addedFollower) {
          try {
            if (addedFollowing) {
              const rp = await getStoredProfile(env, requester);
              if (rp) { rp.following = (Number(rp.following || 0) + 1); await kv.put(KEYS.PROFILE(requester), JSON.stringify(rp)); }
            }
            if (addedFollower) {
              const ap = await getStoredProfile(env, actor.id);
              if (ap) { ap.followers = (Number(ap.followers || 0) + 1); await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(ap)); }
            }
          } catch { /* best-effort */ }
        }
        // Notify the requester (in-app + system push on their device).
        try {
          const me = await getStoredProfile(env, actor.id);
          const name = (me && (me.username || me.name)) || actor.id;
          await pushUserNotification(env, requester, {
            kind: 'follow_accepted', title: 'Follow request accepted',
            body: name + ' accepted your follow request. You can now see their posts and chat.',
            actorId: actor.id, actorName: String(name),
          });
        } catch { /* best-effort */ }
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
      // An explicit empty string clears the cover (profile "Remove cover").
      let thumbnailCleared = false;
      if (typeof clean.thumbnail === 'string' && clean.thumbnail) {
        const thumb = String(clean.thumbnail).slice(0, 2000);
        if (/^https?:\/\//i.test(thumb) && !thumb.startsWith('data:')) {
          parsed.thumbnail = thumb;
        }
      } else if (clean.thumbnail === '') {
        delete parsed.thumbnail;
        thumbnailCleared = true;
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
            idx[ix] = {
              ...idx[ix],
              visibility: parsed.visibility || 'public',
              thumbnail: thumbnailCleared ? '' : (parsed.thumbnail || idx[ix].thumbnail || ''),
            };
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
      const picked = Array.isArray(clean.reasons) ? clean.reasons.map((r) => String(r).slice(0, 40)).filter(Boolean).slice(0, 10) : [];
      const reason = String(clean.reason || picked[0] || 'other').slice(0, 40);
      const reasons = picked.length ? picked : [reason];
      if (!['post', 'thought', 'story', 'moment', 'profile'].includes(kind) || !id) {
        return json({ error: 'Invalid report' }, 400, cors);
      }
      const rl = await rateLimit(kv, 'engagement', actor.id, 30);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      // Owners cannot report their own profile.
      if (kind === 'profile' && id === actor.id) return json({ data: { ok: true }, error: null }, 200, cors);
      const getKey = kind === 'post' ? KEYS.POST : kind === 'thought' ? KEYS.THOUGHT : kind === 'story' ? KEYS.STORY : kind === 'moment' ? KEYS.MOMENT : null;
      let parsed = {};
      if (getKey) {
        const raw = await kv.get(getKey(id));
        if (!raw) return json({ data: { ok: true }, error: null }, 200, cors);
        try { parsed = JSON.parse(raw); } catch { return json({ data: { ok: true }, error: null }, 200, cors); }
        if (owns(parsed, actor)) return json({ data: { ok: true }, error: null }, 200, cors);
      }
      // Owners cannot report their own content into removal; they can delete it.
      if (owns(parsed, actor)) return json({ data: { ok: true }, error: null }, 200, cors);
      const report = {
        id: generateId(), kind, contentId: id, reason, reasons,
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
      // Human eval: a report is a strong negative label for the shared brain
      // (best-effort — safety flow never blocks on it).
      try {
        void brainProxy('/v1/feedback', {
          session_id: String(actor.id).slice(0, 100),
          query: String(id).slice(0, 300),
          rating: -1,
          response: `report:${reason}`,
          source: 'equyvo',
        }).catch(() => null);
      } catch { /* ignore */ }
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
    // ── CHUNKED UPLOAD (resumable multipart → R2) ────────────────────────────
    // Long videos / vlogs / live recordings exceed what a single fetch body
    // and a single worker memory window can safely carry. The client slices
    // the file into 8MB parts and streams them one request at a time:
    //   POST /api/upload/init            → { uploadId, partSize }
    //   PUT  /api/upload/part?uploadId&partIndex  (chunk as 'file') → { etag }
    //   POST /api/upload/complete        → same payload shape as /api/upload
    //   POST /api/upload/abort           → cancels (removes R2 multipart)
    // Plan caps are checked at INIT against the declared total size and at
    // COMPLETE against the real assembled size, so partial progress can
    // never bypass billing.
    if (path === '/api/upload/init' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      if (!env.EQUYVO_R2) return json({ error: 'Media warehouse not configured' }, 503, cors);
      const bearer = bearerFrom(request);
      const { planId } = await resolvePlan(env, actor, bearer);
      const quota = planQuota(planId);
      const rl = await rateLimit(kv, 'upload', actor.id, rateLimitFor(planId, 'upload'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      let payload = {};
      try { payload = await readJson(request); } catch { payload = {}; }
      const declaredBytes = Math.max(0, Math.round(Number(payload.size) || 0));
      const contentType = String(payload.type || '').slice(0, 120);
      const folder = String(payload.folder || 'equyvo/uploads').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 120);
      if (!mimeAllowed(contentType)) return json({ error: 'Only images, videos and audio are allowed' }, 415, cors);
      if (declaredBytes <= 0) return json({ error: 'Empty file' }, 400, cors);
      if (declaredBytes <= 8 * 1024 * 1024) {
        // Small enough for the single-shot path — tell the client to use it.
        return json({ data: { chunked: false }, error: null }, 200, cors);
      }
      const envCapMB = parseInt(env.MAX_UPLOAD_MB, 10) || quota.maxUploadMB;
      const maxBytes = Math.min(quota.maxUploadMB, envCapMB) * 1024 * 1024;
      if (declaredBytes > maxBytes) {
        return json({ error: `File too large for ${quota.label} (max ${Math.min(quota.maxUploadMB, envCapMB)}MB). Upgrade for higher limits.`, code: 'QUOTA_FILE_SIZE', planId }, 413, cors);
      }
      const usage = await getUsage(env, actor.id);
      if (usage.bytes + declaredBytes > quota.storageBytes) {
        return json({ error: `Storage quota exceeded for ${quota.label} (${Math.round(quota.storageBytes / GB)}GB). Delete media or upgrade.`, code: 'QUOTA_STORAGE', planId, usage }, 402, cors);
      }
      if (usage.monthUploads >= quota.monthlyUploads) {
        return json({ error: `Monthly upload limit reached for ${quota.label}. Upgrades reset limits.`, code: 'QUOTA_MONTHLY', planId }, 402, cors);
      }
      const ext = String(payload.ext || extFromFile({ name: payload.name || '', type: contentType })).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
      const r2Key = r2KeyFor(actor.id, generateId(), ext);
      let mpu;
      try {
        mpu = await env.EQUYVO_R2.createMultipartUpload(r2Key, {
          httpMetadata: { contentType: contentType || 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' },
          customMetadata: { uploader: String(actor.id).slice(0, 128), encoding: 'none' },
        });
      } catch {
        return json({ error: 'Could not start chunked upload. Please try again.' }, 500, cors);
      }
      const uploadId = generateId() + generateId();
      const session = {
        actorId: actor.id, r2Key, r2UploadId: mpu.uploadId, folder,
        size: declaredBytes, type: contentType, partSize: 8 * 1024 * 1024,
        parts: {}, createdAt: Date.now(), planId,
      };
      try {
        await kv.put('upl:' + uploadId, JSON.stringify(session), { expirationTtl: 6 * 60 * 60 });
      } catch {
        try { await env.EQUYVO_R2.resumeMultipartUpload(r2Key, mpu.uploadId).abortMultipartUpload(); } catch {}
        return json({ error: 'Could not start chunked upload. Please try again.' }, 500, cors);
      }
      return json({ data: { chunked: true, uploadId, partSize: session.partSize, r2Key }, error: null }, 200, cors);
    }

    if (path === '/api/upload/part' && method === 'PUT') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const url = new URL(request.url);
      const uploadId = String(url.searchParams.get('uploadId') || '').slice(0, 64);
      const partIndex = clamp(parseInt(url.searchParams.get('partIndex') || '', 10) || 0, 1, 10000);
      let session = null;
      try {
        const raw = await kv.get('upl:' + uploadId);
        if (raw) session = JSON.parse(raw);
      } catch { session = null; }
      if (!session || session.actorId !== actor.id) {
        return json({ error: 'Upload session not found. Restart the upload.' , code: 'UPLOAD_SESSION_GONE' }, 404, cors);
      }
      let formData;
      try { formData = await request.formData(); } catch { return json({ error: 'Invalid chunk' }, 400, cors); }
      const file = formData.get('file');
      if (!file || typeof file === 'string' || file.size <= 0) return json({ error: 'Empty chunk' }, 400, cors);
      // Running hash: digest every part so the final object can be identified
      // even without a whole-file buffer (CPU-safe: per-part native crypto).
      let partHash = '';
      try {
        partHash = await sha256Hex(await file.arrayBuffer());
      } catch { /* hashing is metadata only — continue */ }
      let etag = '';
      try {
        const mpu = env.EQUYVO_R2.resumeMultipartUpload(session.r2Key, session.r2UploadId);
        const part = await mpu.uploadPart(partIndex, await file.arrayBuffer());
        etag = part.etag || '';
      } catch (e) {
        return json({ error: 'Chunk upload failed. Retry this part.', code: 'UPLOAD_PART_FAILED' }, 502, cors);
      }
      try {
        session.parts[String(partIndex)] = { etag, hash: partHash, size: Number(file.size || 0) };
        await kv.put('upl:' + uploadId, JSON.stringify(session), { expirationTtl: 6 * 60 * 60 });
      } catch { /* best-effort progress tracking */ }
      return json({ data: { partIndex, etag, bytes: Number(file.size || 0) }, error: null }, 200, cors);
    }

    if (path === '/api/upload/complete' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      if (!env.EQUYVO_R2) return json({ error: 'Media warehouse not configured' }, 503, cors);
      let payload = {};
      try { payload = await readJson(request); } catch { payload = {}; }
      const uploadId = String(payload.uploadId || '').slice(0, 64);
      let session = null;
      try {
        const raw = await kv.get('upl:' + uploadId);
        if (raw) session = JSON.parse(raw);
      } catch { session = null; }
      if (!session || session.actorId !== actor.id) {
        return json({ error: 'Upload session not found. Restart the upload.', code: 'UPLOAD_SESSION_GONE' }, 404, cors);
      }
      const partEntries = Object.entries(session.parts || {})
        .map(([k, v]) => ({ i: parseInt(k, 10), etag: (v && v.etag) || '', hash: (v && v.hash) || '', size: (v && v.size) || 0 }))
        .filter((p) => p.i > 0 && p.etag)
        .sort((a, b) => a.i - b.i);
      if (!partEntries.length) {
        return json({ error: 'No chunks received. Please restart the upload.', code: 'UPLOAD_NO_PARTS' }, 400, cors);
      }
      const totalBytes = partEntries.reduce((n, p) => n + (Number(p.size) || 0), 0);
      if (totalBytes <= 0) return json({ error: 'Empty upload' }, 400, cors);
      const { planId: livePlan } = await resolvePlan(env, actor, bearerFrom(request));
      const quota = planQuota(livePlan);
      const envCapMB = parseInt(env.MAX_UPLOAD_MB, 10) || quota.maxUploadMB;
      const maxBytes = Math.min(quota.maxUploadMB, envCapMB) * 1024 * 1024;
      if (totalBytes > maxBytes + session.partSize) {
        try { await env.EQUYVO_R2.resumeMultipartUpload(session.r2Key, session.r2UploadId).abortMultipartUpload(); } catch {}
        try { await kv.delete('upl:' + uploadId); } catch {}
        return json({ error: `File too large for ${quota.label}. Upgrade for higher limits.`, code: 'QUOTA_FILE_SIZE', planId: livePlan }, 413, cors);
      }
      let obj = null;
      try {
        const mpu = env.EQUYVO_R2.resumeMultipartUpload(session.r2Key, session.r2UploadId);
        obj = await mpu.completeMultipartUpload(partEntries.map((p) => ({ partNumber: p.i, etag: p.etag })));
      } catch (e) {
        return json({ error: 'Could not finalize upload. Please retry.', code: 'UPLOAD_COMPLETE_FAILED' }, 502, cors);
      }
      try { await kv.delete('upl:' + uploadId); } catch {}
      // Whole-file identity without a whole-file hash: the object is keyed by
      // the hash chain of its bytes.
      let fullHash = '';
      try {
        fullHash = await sha256Hex(new TextEncoder().encode('mp1:' + partEntries.map((p) => p.hash).join('')).buffer);
      } catch { fullHash = session.r2UploadId || generateId(); }
      const contentType = session.type || 'application/octet-stream';
      const isVideo = String(contentType).startsWith('video/');
      const audioLike = String(contentType).startsWith('audio/');
      const r2Url = r2DeliveryUrl(request, env, session.r2Key);
      const resourceType = audioLike || isVideo ? 'video' : 'image';
      const payloadOut = {
        publicId: null,
        secureUrl: r2Url,
        originalUrl: r2Url,
        delivery: 'r2',
        resourceType,
        format: String(session.r2Key || '').split('.').pop().replace(/[^a-z0-9]/gi, '') || 'bin',
        bytes: totalBytes,
        // Multipart-completed objects: expose stored size/etag via head data.
        width: undefined,
        height: undefined,
        createdAt: new Date().toISOString(),
        duration: Number(payload.duration) || undefined,
        variants: null,
        r2Key: session.r2Key,
        store: 'r2',
        deduped: false,
        planId: livePlan,
        chunked: true,
      };
      try {
        await env.EQUYVO_KV.put(KEYS.HASH('mp:' + fullHash), JSON.stringify(payloadOut), { expirationTtl: 60 * 60 * 24 * 90 });
        await env.EQUYVO_KV.put(KEYS.MEDIA('mp:' + fullHash), JSON.stringify({ bytes: totalBytes, r2Key: session.r2Key }), { expirationTtl: 60 * 60 * 24 * 365 });
      } catch { /* best-effort */ }
      try {
        const nextUsage = await addUsage(env, actor.id, Number(totalBytes || 0));
        return json({
          data: payloadOut,
          usage: { usedBytes: nextUsage.bytes, quotaBytes: quota.storageBytes },
          error: null,
        }, 200, cors);
      } catch {
        return json({ data: payloadOut, error: null }, 200, cors);
      }
    }

    if (path === '/api/upload/abort' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      let payload = {};
      try { payload = await readJson(request); } catch { payload = {}; }
      const uploadId = String(payload.uploadId || '').slice(0, 64);
      let session = null;
      try {
        const raw = await kv.get('upl:' + uploadId);
        if (raw) session = JSON.parse(raw);
      } catch { session = null; }
      try { await kv.delete('upl:' + uploadId); } catch {}
      if (session && session.actorId === actor.id && env.EQUYVO_R2) {
        try { await env.EQUYVO_R2.resumeMultipartUpload(session.r2Key, session.r2UploadId).abortMultipartUpload(); } catch {}
      }
      return json({ data: { aborted: true }, error: null }, 200, cors);
    }

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
      if (!mimeAllowed(file.type)) return json({ error: 'Only images, videos and audio are allowed' }, 415, cors);

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
      // NOTE: never gzip-compress here. Browsers do not reliably
      // auto-decompress manually-announced Content-Encoding for image
      // requests, which made served photos undecodable ("Could not display
      // that image.") and broke chat backgrounds. Images/videos are
      // compressed formats anyway; gzip bought nothing real. Legacy gzip
      // objects remain readable because serveR2 decompresses on read.
      let r2Key = null;
      if (hasR2 && bytes) {
        r2Key = r2KeyFor(actor.id, hash, extFromFile(file));
        try {
          await env.EQUYVO_R2.put(r2Key, bytes, {
            httpMetadata: {
              contentType: file.type || 'application/octet-stream',
              cacheControl: 'public, max-age=31536000, immutable',
            },
            customMetadata: { uploader: String(actor.id).slice(0, 128), sha256: hash, encoding: 'none' },
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
        // Audio is filed under the video resource type on Cloudinary.
        || (String(file.type).startsWith('video/') || String(file.type).startsWith('audio/') ? 'video' : 'image');
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
      // Human-eval fan-out: every media upload becomes a labelled preference
      // for the shared Acronous brain (Contabo). Backend-only.
      try {
        const hint = String(folder || '') + ' ' + String(file.type || '') + ' ' + String(file.name || '');
        void aiFetchJson(aiBrainBase(env) + '/v1/learn', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: hint.slice(0, 300),
            response: 'user uploaded media: ' + String(payload.resourceType || 'media'),
            session_id: String(actor.id).slice(0, 100),
            source: 'equyvo',
            route_type: 'equyvo-upload',
            feedback: 0.4,
          }),
        }, 2500).catch(() => null);
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

    // ---- BILLING STATUS (same-origin) ----
    // 1) Local grant first: a plan paid through Equyvo (Razorpay-verified by
    //    central) must show up even though central only resolves its own
    //    JWTs — Equyvo session tokens used to fall back to free here, which
    //    made paid tiers vanish after an app restart.
    // 2) Central proxy for callers holding a central JWT (cross-product
    //    subscriptions live there).
    if (path === '/api/billing/status' && method === 'GET') {
      const bearer = bearerFrom(request);
      if (bearer) {
        const actor = await getActor(request, env);
        if (actor) {
          const local = await getLocalGrant(env, actor.id);
          if (local) {
            return json({
              subscriptions: { equyvo: { plan: local.plan, until: local.until } },
              access: { plan: local.plan, until: local.until },
              api_credits: 0,
            }, 200, cors);
          }
        }
      }
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

    // ---- BILLING CLAIM (guest purchase linking) ----
    // POST /api/claim-billing — links a guest-paid plan (same email) to the
    // caller's account. Local email grants (paid through THIS app while
    // signed out) are claimed first; central claim handles browsers that
    // present a verifiable central JWT.
    if (path === '/api/claim-billing' && method === 'POST') {
      const bearer = bearerFrom(request);
      if (!bearer) return json({ error: 'Please sign in first.' }, 401, cors);
      const actor = await getActor(request, env);
      if (actor) {
        const localClaim = await claimLocalEmailGrant(env, actor);
        if (localClaim) return json(localClaim, 200, cors);
      }
      const base = (env.BILLING_BASE_URL || 'https://api.acronous.com').replace(/\/$/, '');
      try {
        const upstream = await fetch(base + '/v1/billing/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
          body: JSON.stringify({}),
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

    // ── CHAT TRANSPORT (WhatsApp-style ticks, follow-gated) ────────────────
    // POST /api/chat/:peer/send { text?, type?, fileUrl?, fileName? }
    //   → { id, delivered:false } + status `sent` (single tick = on server).
    //   Delivery (`delivered`, double tick) + read (`seen`, Seen label) are
    //   confirmed via GET messages / POST seen polling below.
    //   Gate: either side must follow the other, else 403 (strangers blocked).
    if (path.match(/^\/api\/chat\//) && path.endsWith('/send') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/send', '')).split('?')[0];
      if (!peer || peer === actor.id) return json({ error: 'Invalid peer' }, 400, cors);
      const rl = await rateLimit(kv, 'engagement', actor.id, 60);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      if (!(await canChat(env, actor.id, peer))) {
        return json({ error: 'You can only message accounts you follow or that follow you.' }, 403, cors);
      }
      let raw; try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
      const clean = sanitizeBody(raw);
      const text = String(clean.text || '').slice(0, 2000);
      const type = clean.type === 'image' || clean.type === 'file' || clean.type === 'audio' ? clean.type : 'text';
      if (!text && !clean.fileUrl) return json({ error: 'Empty message' }, 400, cors);
      const clientId = String(clean.id || '').slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '');
      const msg = {
        id: clientId || generateId(), from: actor.id, to: peer, text,
        type, fileUrl: String(clean.fileUrl || '').slice(0, 2000),
        fileName: String(clean.fileName || '').slice(0, 200),
        // Voice notes: recording length in seconds (display-only metadata).
        durationSec: Math.min(600, Math.max(0, Math.round(Number(clean.durationSec) || 0))),
        status: 'sent', createdAt: new Date().toISOString(),
      };
      // Event-sourced store: per-message key + per-sender index append. Two
      // devices sending at once can no longer overwrite each other's history.
      await storeChatMessage(env, actor.id, peer, msg);
      // Human-eval fan-out: every message becomes a labelled preference for
      // the shared Acronous brain (Contabo). Backend-only.
      try {
        if (text && text.trim()) {
          void aiFetchJson(aiBrainBase(env) + '/v1/learn', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: text.slice(0, 500),
              response: 'user message to ' + peer,
              session_id: String(actor.id).slice(0, 100),
              source: 'equyvo',
              route_type: 'equyvo-chat',
              feedback: 0.3,
            }),
          }, 2500).catch(() => null);
        }
      } catch { /* ignore */ }
      // Nudge the peer (unread badge + push) — best-effort, never blocks send.
      try {
        const me = await getStoredProfile(env, actor.id);
        const name = (me && (me.username || me.name)) || actor.id;
        await pushUserNotification(env, peer, {
          kind: 'chat', title: 'New message from ' + name,
          body: text.slice(0, 120) || 'Sent you an attachment.',
          actorId: actor.id, actorName: String(name),
        });
      } catch { /* ignore */ }
      return json({ data: { id: msg.id, delivered: false }, error: null }, 200, cors);
    }

    // GET /api/chat/:peer/messages?limit= — merged ledger; marks messages
    // addressed TO the caller as `delivered` (double tick for the sender).
    if (path.match(/^\/api\/chat\//) && path.endsWith('/messages') && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/messages', '')).split('?')[0];
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      if (!(await canChat(env, actor.id, peer))) {
        return json({ error: 'Forbidden' }, 403, cors);
      }
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100') || 100));
      const all = await readThreadLedger(env, actor.id, peer, 300);
      let touched = false;
      for (const m of all) {
        if (m && m.to === actor.id && m.status === 'sent') {
          m.status = 'delivered';
          touched = true;
        }
      }
      if (touched) {
        const pair = chatPairToken(actor.id, peer);
        await Promise.all([
          ...new Set(all.filter((m) => m && m.to === actor.id && m.status === 'delivered').map((m) => m.id)),
        ].map((id) => (async () => {
          const m = all.find((x) => x && x.id === id);
          if (m) await putChatMessagePer(env, pair, m);
        })()));
      }
      const out = all.slice(-limit)
        .filter((m) => !(Array.isArray(m?.deletedFor) && m.deletedFor.includes(actor.id)))
        .map((m) => ({
        id: m.id, threadId: peer, text: m.text, fromMe: m.from === actor.id,
        status: m.from === actor.id ? m.status : undefined,
        timestamp: (() => { try { return new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })(),
        createdAt: (() => { try { return new Date(m.createdAt).getTime(); } catch { return 0; } })(),
        type: m.type, fileUrl: m.fileUrl, fileName: m.fileName,
        durationSec: Number(m.durationSec) || 0,
        deletedForEveryone: !!m.deletedForEveryone,
        deletedFor: Array.isArray(m.deletedFor) ? m.deletedFor : [],
      }));
      return json({ data: { messages: out }, error: null }, 200, cors);
    }

    // POST /api/chat/:peer/seen — caller opened the thread: all messages TO
    // them become `delivered`, and their own pending messages TO the peer
    // stay until the peer polls; peer's messages to caller become `seen`.
    if (path.match(/^\/api\/chat\//) && path.endsWith('/seen') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/seen', '')).split('?')[0];
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      const all = await readThreadLedger(env, actor.id, peer, 300);
      const pair = chatPairToken(actor.id, peer);
      const flips = [];
      for (const m of all) {
        if (m && m.to === actor.id && m.status !== 'seen') {
          m.status = 'seen';
          flips.push(m);
        }
      }
      if (flips.length) await Promise.all(flips.map((m) => putChatMessagePer(env, pair, m)));
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    // POST /api/chat/:peer/delivered { id } — peer-device ack (double tick).
    if (path.match(/^\/api\/chat\//) && path.endsWith('/delivered') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/delivered', '')).split('?')[0];
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      let raw; try { raw = await readJson(request); } catch { raw = {}; }
      const id = String((raw && raw.id) || '').slice(0, 64);
      const all = await readThreadLedger(env, actor.id, peer, 300);
      const m = all.find((x) => x && x.id === id);
      if (m && m.status === 'sent') {
        m.status = 'delivered';
        await putChatMessagePer(env, chatPairToken(actor.id, peer), m);
      }
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    // GET /api/chat/threads — follow-based thread list with unread counts.
    // POST /api/chat/:peer/delete { id, forEveryone? } - delete message.
    if (path.match(/^\/api\/chat\//) && path.endsWith('/delete') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/delete', '')).split('?')[0];
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      let raw; try { raw = await readJson(request); } catch { raw = {}; }
      const id = String((raw && raw.id) || '').slice(0, 64);
      const forEveryone = !!(raw && raw.forEveryone);
      if (!id) return json({ error: 'Invalid id' }, 400, cors);
      const all = await readThreadLedger(env, actor.id, peer, 300);
      const m = all.find((x) => x && x.id === id);
      if (!m) return json({ error: 'Not found' }, 404, cors);
      if (forEveryone && m.from !== actor.id) return json({ error: 'Forbidden' }, 403, cors);
      if (forEveryone) {
        m.deletedForEveryone = true;
        m.text = '';
        m.fileUrl = '';
        m.fileName = '';
      } else {
        m.deletedFor = Array.isArray(m.deletedFor) ? m.deletedFor : [];
        if (!m.deletedFor.includes(actor.id)) m.deletedFor.push(actor.id);
      }
      await putChatMessagePer(env, chatPairToken(actor.id, peer), m);
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    if (path === '/api/chat/threads' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const [following, followers] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING(actor.id)),
        readIdList(env, KEYS.FOLLOWERS(actor.id)),
      ]);
      const seen = new Set();
      const threads = [];
      const pushPeer = (pid, relation) => {
        const k = String(pid).toLowerCase();
        if (!pid || seen.has(k)) return;
        seen.add(k);
        threads.push({ id: pid, peerId: pid, relation });
      };
      followers.forEach((f) => pushPeer(f, following.some((x) => String(x).toLowerCase() === String(f).toLowerCase()) ? 'mutual' : 'follower'));
      following.forEach((f) => pushPeer(f, 'following'));
      return json({ data: { threads: threads.slice(0, 300) }, error: null }, 200, cors);
    }

    // ── NOTIFICATIONS ──────────────────────────────────────────────────────
    // GET /api/notifications — pending follow requests (as items) + stored
    // per-user items (accepts, chat nudges, uploads, live). Bounded ≤100.
    if (path === '/api/notifications' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const [stored, reqs] = await Promise.all([
        (async () => { try { const r = await kv.get(KEYS.NOTIF(actor.id)); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a : []; } catch { return []; } })(),
        readIdList(env, KEYS.FOLLOW_REQ(actor.id)),
      ]);
      const items = [...stored];
      for (const r of reqs.slice(0, 20)) {
        if (!items.some((n) => n && n.id === 'followreq-' + r)) {
          items.unshift({
            id: 'followreq-' + r, kind: 'follow_request', title: 'New follow request',
            body: r + ' requested to follow you. Approve or decline from notifications.',
            at: new Date().toISOString(), read: false, actorId: r, actorName: r,
          });
        }
      }
      return json({ data: { items: items.slice(0, 100) }, error: null }, 200, cors);
    }

    // POST /api/notifications/read { ids? } — mark read (all when omitted).
    if (path === '/api/notifications/read' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      let raw; try { raw = await readJson(request); } catch { raw = {}; }
      const ids = Array.isArray(raw.ids) ? raw.ids.map(String) : null;
      try {
        const r = await kv.get(KEYS.NOTIF(actor.id));
        const arr = r ? JSON.parse(r) : [];
        const next = (Array.isArray(arr) ? arr : []).map((n) => (
          !ids || ids.includes(String(n.id)) ? { ...n, read: true } : n
        ));
        await kv.put(KEYS.NOTIF(actor.id), JSON.stringify(next.slice(0, 100)));
      } catch { /* ignore */ }
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    // ── REPORTS LEDGER (dashboard.acronous.com monitor) ────────────────────
    // GET /api/reports?limit= — admin-gated via X-Admin-Token matching
    // REPORTS_ADMIN_TOKEN. Returns newest reports with content snapshots so
    // developers can identify the account + basis. Never public.
    // POST /api/notifications/clear - wipe the caller's stored notifications
    // (or a specific id list), so locally dismissed notifications stop
    // re-appearing after the next sync.
    if (path === '/api/notifications/clear' && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      let raw; try { raw = await readJson(request); } catch { raw = {}; }
      const ids = Array.isArray(raw?.ids) ? raw.ids.map(String).filter(Boolean) : null;
      try {
        if (!ids) {
          await kv.put(KEYS.NOTIF(actor.id), JSON.stringify([]));
        } else {
          const r = await kv.get(KEYS.NOTIF(actor.id));
          const arr = r ? JSON.parse(r) : [];
          const next = (Array.isArray(arr) ? arr : []).filter((n) => !ids.includes(String(n?.id)));
          await kv.put(KEYS.NOTIF(actor.id), JSON.stringify(next.slice(0, 100)));
        }
      } catch { /* ignore */ }
      return json({ data: { ok: true }, error: null }, 200, cors);
    }

    if (path === '/api/reports' && method === 'GET') {
      const token = String(request.headers.get('X-Admin-Token') || '');
      const expected = String(env.REPORTS_ADMIN_TOKEN || '');
      if (!expected || token !== expected) return json({ error: 'Forbidden' }, 403, cors);
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100') || 100));
      let ids = [];
      try {
        const raw = await kv.get(KEYS.REPORTS_LIST);
        ids = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(ids)) ids = [];
      } catch { ids = []; }
      const out = [];
      for (const rid of ids.slice(0, limit)) {
        try {
          const rraw = await kv.get(KEYS.REPORT(rid));
          if (!rraw) continue;
          const r = JSON.parse(rraw);
          // Attach a content snapshot (bounded fields only).
          let snapshot = null;
          try {
            const k = r.kind === 'post' ? KEYS.POST : r.kind === 'thought' ? KEYS.THOUGHT : r.kind === 'story' ? KEYS.STORY : KEYS.MOMENT;
            const craw = await kv.get(k(r.contentId));
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
          } catch { /* snapshot best-effort */ }
          out.push({ ...r, snapshot });
        } catch { /* skip bad rows */ }
        if (out.length >= limit) break;
      }
      return json({ data: { reports: out }, error: null }, 200, cors);
    }

    // ── REPORT MODERATION (dashboard.acronous.com actions) ───────────────
    // POST /api/reports/action { reportId?, kind?, contentId?, owner?,
    //   action: 'quarantine'|'remove'|'restore'|'delete'|'restrict-account'|'unrestrict-account'|'delete-account-content' }
    // Admin-gated via X-Admin-Token. Lets developers remove, restrict
    // (private account), or restore reported media/accounts instantly.
    if (path === '/api/reports/action' && method === 'POST') {
      const token = String(request.headers.get('X-Admin-Token') || '');
      const expected = String(env.REPORTS_ADMIN_TOKEN || '');
      if (!expected || token !== expected) return json({ error: 'Forbidden' }, 403, cors);
      let body = {};
      try { body = (await request.json()) || {}; } catch { return json({ error: 'Invalid JSON body.' }, 400, cors); }
      const action = String(body.action || '').toLowerCase().replace(/[^a-z-]/g, '');
      const valid = ['quarantine', 'remove', 'restore', 'delete', 'restrict-account', 'unrestrict-account', 'delete-account-content'];
      if (!valid.includes(action)) return json({ error: 'Unknown action. Use: ' + valid.join(', ') }, 400, cors);
      // Resolve target content: explicit kind+contentId wins, else via reportId.
      let kind = String(body.kind || body.type || '').toLowerCase().replace(/s$/, '');
      let contentId = String(body.contentId || body.id || '').slice(0, 64);
      const owner = String(body.owner || '').slice(0, 200);
      if ((!kind || !contentId) && body.reportId) {
        try {
          const rraw = await kv.get(KEYS.REPORT(String(body.reportId).slice(0, 64)));
          if (rraw) {
            const rr = JSON.parse(rraw);
            kind = String(rr.kind || '').toLowerCase();
            contentId = String(rr.contentId || '');
          }
        } catch { /* fall through */ }
      }
      const now = new Date().toISOString();
      const getKey = kind === 'post' ? KEYS.POST : kind === 'thought' ? KEYS.THOUGHT : kind === 'story' ? KEYS.STORY : kind === 'moment' ? KEYS.MOMENT : null;
      // Account-level actions need only an owner id (from snapshot or body).
      if ((action === 'restrict-account' || action === 'unrestrict-account' || action === 'delete-account-content')) {
        if (!owner) return json({ error: 'owner is required for account actions.' }, 400, cors);
        try {
          const praw = await kv.get(KEYS.PROFILE(owner));
          const prof = praw ? JSON.parse(praw) : { id: owner };
          if (action === 'restrict-account') {
            prof.isPrivate = true; prof.accountType = 'private';
            prof.moderation = { status: 'restricted', at: now, reason: 'admin' };
            await kv.put(KEYS.PROFILE(owner), JSON.stringify(prof));
          } else if (action === 'unrestrict-account') {
            prof.isPrivate = false; prof.accountType = 'public';
            prof.moderation = { status: 'cleared', at: now, reason: 'admin' };
            await kv.put(KEYS.PROFILE(owner), JSON.stringify(prof));
          } else {
            // delete-account-content: purge all content items owned by account.
            let deleted = 0;
            for (const [listKey, getK, delK] of [[KEYS.POSTS, KEYS.POST, KEYS.POST], [KEYS.THOUGHTS, KEYS.THOUGHT, KEYS.THOUGHT], [KEYS.STORIES, KEYS.STORY, KEYS.STORY], [KEYS.MOMENTS, KEYS.MOMENT, KEYS.MOMENT]]) {
              try {
                const listJson = await kv.get(listKey);
                if (!listJson) continue;
                const ids = JSON.parse(listJson);
                const remaining = [];
                for (const cid of ids) {
                  try {
                    const craw = await kv.get(getK(cid));
                    if (!craw) continue;
                    const c = JSON.parse(craw);
                    const oid = String(c.ownerId || c.userId || c.user_id || '');
                    if (oid === owner) { await kv.delete(delK(cid)); deleted++; }
                    else remaining.push(cid);
                  } catch { remaining.push(cid); }
                }
                await kv.put(listKey, JSON.stringify(remaining));
              } catch { /* best-effort per list */ }
            }
            prof.moderation = { status: 'content-purged', at: now, reason: 'admin', deleted };
            await kv.put(KEYS.PROFILE(owner), JSON.stringify(prof));
            return json({ data: { ok: true, action, owner, deleted }, error: null }, 200, cors);
          }
          return json({ data: { ok: true, action, owner }, error: null }, 200, cors);
        } catch (e) { return json({ error: 'Account action failed.' }, 500, cors); }
      }
      // Content-level actions.
      if (!getKey || !contentId) return json({ error: 'kind (post|thought|story|moment) + contentId (or reportId) required.' }, 400, cors);
      try {
        const craw = await kv.get(getKey(contentId));
        if (!craw) return json({ error: 'Content not found (already deleted).' }, 404, cors);
        const c = JSON.parse(craw);
        if (action === 'delete') {
          await kv.delete(getKey(contentId));
          try {
            const idxJson = await kv.get(KEYS.CONTENT_INDEX);
            if (idxJson) {
              const idx = JSON.parse(idxJson);
              await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.filter((x) => x && x.id !== contentId)));
            }
          } catch { /* index best-effort */ }
          return json({ data: { ok: true, action, kind, contentId }, error: null }, 200, cors);
        }
        if (action === 'quarantine') { c.moderation = { status: 'quarantined', at: now, reason: 'admin' }; c.visibility = 'private'; }
        else if (action === 'remove') { c.moderation = { status: 'removed', at: now, reason: 'admin' }; c.visibility = 'private'; }
        else if (action === 'restore') { c.moderation = { status: 'cleared', at: now, reason: 'admin' }; c.visibility = 'public'; }
        await kv.put(getKey(contentId), JSON.stringify(c));
        return json({ data: { ok: true, action, kind, contentId, visibility: c.visibility }, error: null }, 200, cors);
      } catch { return json({ error: 'Moderation action failed.' }, 500, cors); }
    }

    // ── LIVE PRESENCE ──────────────────────────────────────────────────────
    // POST /api/live/start|stop — owner toggles their live flag; followers
    // get a "X is live now" notification (bounded 50, background).
    if ((path === '/api/live/start' || path === '/api/live/stop') && method === 'POST') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const starting = path === '/api/live/start';
      try {
        const me = (await getStoredProfile(env, actor.id)) || { id: actor.id };
        me.isLive = starting;
        me.liveAt = starting ? new Date().toISOString() : null;
        await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(me));
      } catch { /* ignore */ }
      if (starting) {
        const fan = (async () => {
          try {
            const followers = await readIdList(env, KEYS.FOLLOWERS(actor.id));
            const me = await getStoredProfile(env, actor.id);
            const name = (me && (me.username || me.name)) || actor.id;
            await Promise.all(followers.slice(0, 50).map((fid) => pushUserNotification(env, fid, {
              kind: 'live', title: name + ' is live now',
              body: 'Tap to watch ' + name + ' live.',
              actorId: actor.id, actorName: String(name),
            }).catch(() => {})));
          } catch { /* ignore */ }
        })();
        if (context && typeof context.waitUntil === 'function') { try { context.waitUntil(fan); } catch {} }
        else { void fan; }
      }
      return json({ data: { live: starting }, error: null }, 200, cors);
    }

    // GET /api/live/now — who among the caller's following is live (bounded).
    if (path === '/api/live/now' && method === 'GET') {
      const viewer = await getViewer(request, env);
      if (!viewer) return json({ data: { live: [] }, error: null }, 200, cors);
      const following = await readIdList(env, KEYS.FOLLOWING(viewer.id));
      const live = [];
      for (const pid of following.slice(0, 200)) {
        try {
          const p = await getStoredProfile(env, pid);
          if (p && p.isLive === true) live.push(profileSummary(p, pid));
        } catch { /* ignore */ }
        if (live.length >= 20) break;
      }
      return json({ data: { live }, error: null }, 200, cors);
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

    // ── COMMENTS ─────────────────────────────────────────────────────────
    // Persistent per-media discussions. Every comment carries real identity
    // (verified caller + stored profile); the client never supplies names or
    // avatars. Tapping a media's comment button calls GET /api/comments to
    // list that media's comments; posting/replying/liking/sharing/pinning and
    // the owner's enable/disable switch are the routes below.
    if (path === '/api/comments' && method === 'GET') {
      const contentId = String(url.searchParams.get('contentId') || url.searchParams.get('content_id') || url.searchParams.get('postId') || '').slice(0, 64);
      if (!contentId) return json({ error: 'contentId required' }, 400, cors);
      const found = await findContentById(env, contentId);
      if (!found) return json({ error: 'Content not found' }, 404, cors);
      const viewer = await getViewer(request, env);
      const settings = await getCommentSettings(env, contentId, found.item);
      const ownerId = itemOwnerId(found.item);
      const ids = await readCommentList(env, contentId);
      const rows = await Promise.all(ids.slice(0, 200).map(async (cid) => {
        try {
          const raw = await kv.get(KEYS.COMMENT(cid));
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      }));
      // Refresh author identity from stored profiles (real data only) and
      // nest single-level replies under their parents. Pinned first.
      // Placeholder/demo avatar hosts are stripped so no comment can ever
      // carry a bot/fake picture; the client renders real initials instead.
      const fresh = [];
      for (const c of rows) {
        if (!c || typeof c !== 'object' || c.contentId !== contentId) continue;
        try {
          const p = await getStoredProfile(env, c.authorId);
          if (p) {
            const nm = cleanCommentName(p.username || p.name, { username: c.authorUsername, email: '' });
            if (nm) { c.authorName = nm; c.authorUsername = nm; }
            c.authorAvatar = cleanCommentAvatar(p.avatar);
          } else {
            c.authorAvatar = cleanCommentAvatar(c.authorAvatar);
          }
        } catch { /* keep stored identity */ }
        fresh.push(c);
      }
      const byId = new Map(fresh.map((c) => [String(c.id), c]));
      const tops = [];
      for (const c of fresh) {
        const pid = c.parentId ? String(c.parentId) : '';
        if (pid && byId.has(pid) && pid !== String(c.id)) {
          const parent = byId.get(pid);
          parent.replies = parent.replies || [];
          parent.replies.push(c);
        } else {
          tops.push(c);
        }
      }
      for (const t of tops) {
        if (Array.isArray(t.replies)) {
          t.replies.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
          t.repliesCount = t.replies.length;
        }
      }
      tops.sort((a, b) => {
        if (!!a.isPinned !== !!b.isPinned) return a.isPinned ? -1 : 1;
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      });
      const pub = tops.map((t) => {
        const o = toPublicComment(t, viewer ? viewer.id : '');
        if (o && Array.isArray(t.replies)) o.replies = t.replies.map((r) => toPublicComment(r, viewer ? viewer.id : ''));
        return o;
      }).filter(Boolean);
      return json({ data: {
        comments: pub,
        totalCount: fresh.length,
        commentsEnabled: settings.commentsEnabled,
        ownerId,
        isOwner: !!(viewer && ownerId && viewer.id === ownerId),
      }, error: null }, 200, cors);
    }

    if (path === '/api/comments' && method === 'POST') {
      let raw;
      try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
      const actor = await getActor(request, env, raw);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'comments', actor.id, rateLimitFor(planId, 'comments'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const clean = sanitizeBody(raw);
      const contentId = String(clean.contentId || clean.content_id || clean.postId || '').slice(0, 64);
      const text = String(clean.text || clean.content || '').trim().slice(0, 1000);
      if (!contentId) return json({ error: 'contentId required' }, 400, cors);
      if (!text) return json({ error: 'Comment text required' }, 400, cors);
      const found = await findContentById(env, contentId);
      if (!found) return json({ error: 'Content not found' }, 404, cors);
      const ownerId = itemOwnerId(found.item);
      const isOwner = !!(ownerId && actor.id === ownerId);
      const settings = await getCommentSettings(env, contentId, found.item);
      if (!settings.commentsEnabled && !isOwner) {
        return json({ error: 'Comments are turned off for this post.' }, 403, cors);
      }
      // Optional reply target: must belong to the same content; collapse to root.
      let parentId = null;
      let parent = null;
      const wantParent = String(clean.parentId || clean.parent_id || '').slice(0, 64);
      if (wantParent) {
        try {
          const praw = await kv.get(KEYS.COMMENT(wantParent));
          parent = praw ? JSON.parse(praw) : null;
        } catch { parent = null; }
        if (!parent || parent.contentId !== contentId) return json({ error: 'Reply target not found' }, 404, cors);
        parentId = parent.parentId ? String(parent.parentId) : String(parent.id);
        try {
          const rraw = await kv.get(KEYS.COMMENT(parentId));
          const root = rraw ? JSON.parse(rraw) : null;
          if (!root || root.contentId !== contentId) parentId = String(parent.id);
        } catch { parentId = String(parent.id); }
      }
      try {
        await moderateContent(env, { text });
      } catch (e) {
        return json({ error: (e && e.message) || 'Comment violates community guidelines.' }, (e && e.status) || 400, cors);
      }
      const author = await resolveCommentAuthor(env, actor, null);
      const now = new Date().toISOString();
      const comment = {
        id: generateId(),
        contentId,
        contentKind: found.kind,
        parentId,
        authorId: author.id,
        authorName: author.name,
        authorUsername: author.username,
        authorAvatar: author.avatar,
        text,
        createdAt: now,
        updatedAt: now,
        likes: 0,
        likedBy: [],
        shares: 0,
        repliesCount: 0,
        isPinned: false,
        isEdited: false,
      };
      await kv.put(KEYS.COMMENT(comment.id), JSON.stringify(comment));
      const ids = await readCommentList(env, contentId);
      ids.unshift(comment.id);
      await writeCommentList(env, contentId, ids);
      if (parentId) {
        try {
          const rraw = await kv.get(KEYS.COMMENT(parentId));
          if (rraw) {
            const root = JSON.parse(rraw);
            root.repliesCount = Number(root.repliesCount || 0) + 1;
            await kv.put(KEYS.COMMENT(parentId), JSON.stringify(root));
          }
        } catch { /* ignore */ }
      }
      const totalIds = await readCommentList(env, contentId);
      await syncContentCommentCount(env, found, totalIds.length);
      try { await aiBumpPop(env, contentId, 3); } catch {}
      try { await aiRecordEngagement(env, actor.id, { action: 'comment' }); } catch {}
      // Notify the content owner + the replied-to author (best-effort).
      try {
        if (ownerId && ownerId !== actor.id) {
          await pushUserNotification(env, ownerId, {
            kind: 'comment', title: 'New comment',
            body: author.name + ' commented: ' + text.slice(0, 120),
            actorId: actor.id, actorName: author.name, contentId,
          });
        }
        if (parent && parent.authorId && parent.authorId !== actor.id && parent.authorId !== ownerId) {
          await pushUserNotification(env, parent.authorId, {
            kind: 'reply', title: 'New reply',
            body: author.name + ' replied: ' + text.slice(0, 120),
            actorId: actor.id, actorName: author.name, contentId,
          });
        }
      } catch { /* ignore */ }
      return json({ data: { comment: toPublicComment(comment, actor.id) }, error: null }, 201, cors);
    }

    // PUT /api/comments/:id — edit own comment. POST .../like|share|pin and
    // DELETE ... live alongside (exact-id match guarded to those suffixes).
    const commentIdMatch = path.match(/^\/api\/comments\/([^/]+)(\/(like|share|pin))?$/);
    if (commentIdMatch && (method === 'PUT' || method === 'DELETE' || method === 'POST')) {
      const cid = decodeURIComponent(commentIdMatch[1] || '').split('?')[0].slice(0, 64);
      const action = commentIdMatch[3] || '';
      let craw = null;
      try { craw = await kv.get(KEYS.COMMENT(cid)); } catch { craw = null; }
      if (!craw) return json({ error: 'Comment not found' }, 404, cors);
      let comment = null;
      try { comment = JSON.parse(craw); } catch { return json({ error: 'Comment not found' }, 404, cors); }
      const found = await findContentById(env, comment.contentId);
      const ownerId = found ? itemOwnerId(found.item) : '';

      if (method === 'PUT' && !action) {
        let raw;
        try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
        const actor = await getActor(request, env, raw);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        if (String(comment.authorId) !== String(actor.id)) return json({ error: 'Only the author can edit this comment.' }, 403, cors);
        const clean = sanitizeBody(raw);
        const text = String(clean.text || clean.content || '').trim().slice(0, 1000);
        if (!text) return json({ error: 'Comment text required' }, 400, cors);
        try {
          await moderateContent(env, { text });
        } catch (e) {
          return json({ error: (e && e.message) || 'Comment violates community guidelines.' }, (e && e.status) || 400, cors);
        }
        comment.text = text;
        comment.isEdited = true;
        comment.updatedAt = new Date().toISOString();
        await kv.put(KEYS.COMMENT(cid), JSON.stringify(comment));
        return json({ data: { comment: toPublicComment(comment, actor.id) }, error: null }, 200, cors);
      }

      if (method === 'DELETE' && !action) {
        const actor = await getActor(request, env);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        const isAuthor = String(comment.authorId) === String(actor.id);
        const isContentOwner = !!(ownerId && String(ownerId) === String(actor.id));
        if (!isAuthor && !isContentOwner) return json({ error: 'Only the author or the post owner can delete this comment.' }, 403, cors);
        // Delete the comment + its direct replies (single-level threads).
        const ids = await readCommentList(env, comment.contentId);
        const toDelete = [cid];
        for (const otherId of ids) {
          if (otherId === cid) continue;
          try {
            const oraw = await kv.get(KEYS.COMMENT(otherId));
            const o = oraw ? JSON.parse(oraw) : null;
            if (o && String(o.parentId || '') === String(cid)) toDelete.push(otherId);
          } catch { /* ignore */ }
        }
        for (const d of toDelete) {
          try { await kv.delete(KEYS.COMMENT(d)); } catch { /* ignore */ }
        }
        const gone = new Set(toDelete);
        await writeCommentList(env, comment.contentId, ids.filter((x) => !gone.has(x)));
        if (comment.parentId) {
          try {
            const rraw = await kv.get(KEYS.COMMENT(String(comment.parentId)));
            if (rraw) {
              const root = JSON.parse(rraw);
              root.repliesCount = Math.max(0, Number(root.repliesCount || 1) - 1);
              await kv.put(KEYS.COMMENT(String(comment.parentId)), JSON.stringify(root));
            }
          } catch { /* ignore */ }
        }
        const remaining = await readCommentList(env, comment.contentId);
        const refound = await findContentById(env, comment.contentId);
        await syncContentCommentCount(env, refound, remaining.length);
        return json({ data: { ok: true, deleted: toDelete.length }, error: null }, 200, cors);
      }

      if (method === 'POST' && action === 'like') {
        const actor = await getActor(request, env);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        const likedBy = Array.isArray(comment.likedBy) ? comment.likedBy.map(String) : [];
        const has = likedBy.some((x) => x === String(actor.id));
        const next = has ? likedBy.filter((x) => x !== String(actor.id)) : [String(actor.id), ...likedBy].slice(0, 5000);
        comment.likedBy = next;
        comment.likes = next.length;
        await kv.put(KEYS.COMMENT(cid), JSON.stringify(comment));
        try { await aiBumpPop(env, comment.contentId, has ? -1 : 1); } catch {}
        return json({ data: { comment: toPublicComment(comment, actor.id) }, error: null }, 200, cors);
      }

      if (method === 'POST' && action === 'share') {
        const actor = await getActor(request, env);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        comment.shares = Number(comment.shares || 0) + 1;
        await kv.put(KEYS.COMMENT(cid), JSON.stringify(comment));
        const shareUrl = new URL(request.url).origin + '/app/home?comment=' + encodeURIComponent(cid);
        return json({ data: { comment: toPublicComment(comment, actor.id), shareUrl, shareText: String(comment.text || '').slice(0, 200) }, error: null }, 200, cors);
      }

      if (method === 'POST' && action === 'pin') {
        const actor = await getActor(request, env);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        // Flexible: the account the media belongs to can pin ANY comment
        // (their own or anyone else's) and unpin it again.
        if (!ownerId || String(ownerId) !== String(actor.id)) {
          return json({ error: 'Only the post owner can pin comments.' }, 403, cors);
        }
        comment.isPinned = !comment.isPinned;
        await kv.put(KEYS.COMMENT(cid), JSON.stringify(comment));
        return json({ data: { comment: toPublicComment(comment, actor.id) }, error: null }, 200, cors);
      }

      return json({ error: 'Not found: ' + method + ' ' + path }, 404, cors);
    }

    // PUT /api/content/:id/comment-settings { enabled } — owner-only toggle.
    const csetMatch = path.match(/^\/api\/content\/([^/]+)\/comment-settings$/);
    if (csetMatch && method === 'PUT') {
      const contentId = decodeURIComponent(csetMatch[1] || '').split('?')[0].slice(0, 64);
      let raw;
      try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
      const actor = await getActor(request, env, raw);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const found = await findContentById(env, contentId);
      if (!found) return json({ error: 'Content not found' }, 404, cors);
      if (!owns(found.item, actor)) return json({ error: 'Only the account that posted this can change comment settings.' }, 403, cors);
      const clean = sanitizeBody(raw);
      const enabled = clean.enabled !== false && clean.commentsEnabled !== false && clean.disabled !== true;
      const saved = await setCommentSettings(env, contentId, enabled);
      try {
        const it = { ...found.item, commentsEnabled: enabled };
        await kv.put(found.getKey(found.id), JSON.stringify(it));
      } catch { /* settings key stays authoritative */ }
      return json({ data: { contentId, commentsEnabled: saved.commentsEnabled }, error: null }, 200, cors);
    }

    return json({ error: 'Not found: ' + method + ' ' + path }, 404, cors);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return json({ error: (err && err.message) || 'Internal error', requestId }, status, cors);
  }
};
