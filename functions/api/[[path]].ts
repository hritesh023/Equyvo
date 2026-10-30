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
  // Per-author ledger of comment ids. Lets account deletion purge comments the
  // account left on OTHER people's posts (not reachable from its own lists)
  // and keep those posts' comment counters honest.
  USER_COMMENTS: (authorId) => 'usercomments:' + authorId,
  CSETTINGS: (contentId) => 'csettings:' + contentId,
};

// KV has no compare-and-swap operation. Serialize share mutations for the
// same account/item within a warm Pages isolate so two rapid taps cannot both
// read the old counter and write +1. The persisted sharedBy ledger remains the
// cross-isolate/source-of-truth guard.
const shareMutationLocks = new Map<string, Promise<void>>();
async function acquireShareMutationLock(key: string): Promise<() => void> {
  const previous = shareMutationLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  shareMutationLocks.set(key, current);
  if (previous) await previous;
  return () => {
    release();
    if (shareMutationLocks.get(key) === current) shareMutationLocks.delete(key);
  };
}

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
  // ownerId/userId/user_id are authoritative; authorId/creatorId cover legacy
  // index rows so old content still resolves to its real account.
  return String(item.ownerId || item.userId || item.user_id || item.authorId || item.creatorId || '');
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
    await invalidateProfileIndex(env);
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

// ── Profile identity resolution ──────────────────────────────────────────
// Profile rows are keyed by account id, but legacy data also contains rows
// keyed by email and duplicate rows for one email. Those must never become a
// canonical identity: routes/search resolve to the real account id instead.
const PROFILE_INDEX_KEY = 'maint:profile_index_v1';
const PROFILE_INDEX_TTL_MS = 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function isEmailLike(value: unknown): boolean {
  return EMAIL_RE.test(String(value || '').trim());
}

/**
 * Email addresses are never a public identity. If legacy data used an email as
 * a display name, render the local part instead so the address is never
 * exposed on profiles, feeds, comments, search or notifications.
 */
function maskEmailDisplay(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (!isEmailLike(s)) return s;
  const local = s.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local.slice(0, 80) || 'User';
}

const PLACEHOLDER_DISPLAY_NAMES = new Set([
  'anonymous', 'unknown', 'user', 'someone', 'guest', 'null', 'undefined',
]);

function isPlaceholderDisplayName(value: unknown): boolean {
  const s = String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
  return !s || PLACEHOLDER_DISPLAY_NAMES.has(s);
}

/** First non-email, non-placeholder display value (masked if email). */
function publicDisplayName(...values: unknown[]): string {
  for (const value of values) {
    const s = String(value ?? '').trim();
    if (s && !isEmailLike(s) && !isPlaceholderDisplayName(s)) return s.slice(0, 80);
  }
  for (const value of values) {
    const s = String(value ?? '').trim();
    if (s && !isPlaceholderDisplayName(s)) return maskEmailDisplay(s);
  }
  return 'User';
}

/** Replace email addresses embedded in generated notification text. */
function scrubEmailText(value: unknown): string {
  const s = String(value ?? '');
  if (!s) return '';
  return s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskEmailDisplay(m));
}

function normalizeProfileAlias(value: unknown): string {
  let s = String(value ?? '').trim();
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return s.replace(/^@+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function profileEmailOf(profile: any): string {
  if (!profile || typeof profile !== 'object') return '';
  return String(profile.email || profile._userEmail || '').trim().toLowerCase();
}

async function canonicalAuthIdForEmail(env: any, email: string): Promise<string> {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return '';
  try {
    const raw = await env.EQUYVO_KV.get('auth:user:' + clean);
    if (!raw) return '';
    const user = JSON.parse(raw);
    return user && user.id ? String(user.id) : '';
  } catch { return ''; }
}

async function invalidateProfileIndex(env: any): Promise<void> {
  try { await env.EQUYVO_KV.delete(PROFILE_INDEX_KEY); } catch { /* best effort */ }
}

/**
 * Bounded profile index: summaries only (never passwords/tokens), cached for a
 * minute. Duplicate rows sharing one email collapse to the canonical account
 * (the auth:user record), while their names/handles remain searchable aliases.
 */
async function buildProfileIndex(env: any): Promise<any[]> {
  try {
    const cached = await env.EQUYVO_KV.get(PROFILE_INDEX_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.profiles) && (Date.now() - Number(parsed.t || 0)) < PROFILE_INDEX_TTL_MS) {
        return parsed.profiles;
      }
    }
  } catch { /* rebuild below */ }

  const ids: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page: any = await env.EQUYVO_KV.list({ prefix: 'profile:', cursor, limit: 1000 });
      for (const key of (page.keys || [])) {
        const id = String(key.name || '').slice('profile:'.length);
        if (id) ids.push(id);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor && ids.length < 5000);
  } catch { return []; }

  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const slice = ids.slice(i, i + 20);
    const loaded = await Promise.all(slice.map(async (id) => {
      try {
        const raw = await env.EQUYVO_KV.get(KEYS.PROFILE(id));
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }));
    loaded.forEach((profile, offset) => {
      if (!profile || typeof profile !== 'object') return;
      const keyId = slice[offset];
      const id = String(profile.id || keyId);
      rows.push({
        id,
        keyId,
        name: String(profile.name || ''),
        username: String(profile.username || ''),
        avatar: String(profile.avatar || ''),
        bio: typeof profile.bio === 'string' ? String(profile.bio) : '',
        isPrivate: profile.isPrivate === true,
        followers: Number(profile.followers || 0) || 0,
        following: Number(profile.following || 0) || 0,
        verified: profile.verified === true,
        isSeed: profile.isSeed === true,
        // Live presence is part of the public summary so /api/live/now can
        // discover every live account (not just the viewer's following graph)
        // from the same bounded index — no full-KV scan per request.
        isLive: profile.isLive === true,
        liveAt: typeof profile.liveAt === 'string' ? profile.liveAt : '',
        liveTitle: typeof profile.liveTitle === 'string' ? profile.liveTitle.slice(0, 160) : '',
        liveContentId: typeof profile.liveContentId === 'string' ? profile.liveContentId.slice(0, 64) : '',
        email: profileEmailOf(profile),
        createdAt: String(profile.createdAt || ''),
      });
    });
  }

  // Canonical row per account email (auth record wins). Duplicate display
  // names/handles from the other rows are kept as aliases for search.
  const byEmail = new Map<string, any[]>();
  for (const row of rows) {
    if (!row.email) continue;
    if (!byEmail.has(row.email)) byEmail.set(row.email, []);
    byEmail.get(row.email)!.push(row);
  }
  const canonicalByEmail = new Map<string, string>();
  const emails = [...byEmail.keys()];
  for (let i = 0; i < emails.length; i += 20) {
    const batch = emails.slice(i, i + 20);
    const authIds = await Promise.all(batch.map((email) => canonicalAuthIdForEmail(env, email)));
    batch.forEach((email, offset) => {
      const group = byEmail.get(email) || [];
      const authId = authIds[offset];
      let canonical = authId && group.some((r) => String(r.id) === authId) ? authId : '';
      if (!canonical) {
        const real = group.filter((r) => !isEmailLike(r.id) && !isEmailLike(r.keyId));
        real.sort((a, b) =>
          (Number(b.followers || 0) - Number(a.followers || 0)) ||
          String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
          String(a.id).localeCompare(String(b.id)),
        );
        canonical = String((real[0] || group[0] || {}).id || '');
      }
      if (canonical) canonicalByEmail.set(email, canonical);
    });
  }

  const aliasesByCanonical = new Map<string, Set<string>>();
  for (const row of rows) {
    const canonicalId = row.email ? (canonicalByEmail.get(row.email) || row.id) : row.id;
    if (!aliasesByCanonical.has(canonicalId)) aliasesByCanonical.set(canonicalId, new Set());
    const aliases = aliasesByCanonical.get(canonicalId)!;
    for (const value of [row.name, row.username, row.id]) {
      // Emails are excluded from public search/identity. Duplicate rows still
      // fold onto the canonical account for legacy links, but their email is
      // never a searchable alias.
      if (isEmailLike(value)) continue;
      const alias = normalizeProfileAlias(value);
      if (alias) aliases.add(alias);
    }
  }

  const profiles = rows.map((row) => {
    const canonicalId = row.email ? (canonicalByEmail.get(row.email) || row.id) : row.id;
    return {
      ...row,
      canonicalId,
      emailKeyed: isEmailLike(row.id) || isEmailLike(row.keyId),
      aliases: [...(aliasesByCanonical.get(canonicalId) || [])],
    };
  });
  try {
    await env.EQUYVO_KV.put(PROFILE_INDEX_KEY, JSON.stringify({ t: Date.now(), profiles }));
  } catch { /* cache is best-effort */ }
  return profiles;
}

/** All stored ids/emails that belong to one account (duplicate rows included). */
async function refsForAccount(env: any, profile: any): Promise<{ ids: string[]; refs: Set<string> }> {
  const ids = new Set<string>();
  const refs = new Set<string>();
  const add = (value: unknown) => {
    const clean = String(value || '').trim();
    if (clean) {
      ids.add(clean);
      refs.add(clean.toLowerCase());
    }
  };
  add(profile?.id);
  add(profile?.email);
  add(profile?._userEmail);
  const addAlias = (value: unknown) => {
    const alias = normalizeProfileAlias(value);
    if (alias) {
      refs.add(alias);
      refs.add('@' + alias);
    }
  };
  addAlias(profile?.username);
  addAlias(profile?.name);
  const email = profileEmailOf(profile);
  if (email) {
    try {
      const index = await buildProfileIndex(env);
      for (const row of index) {
        if (profileEmailOf(row) !== email) continue;
        add(row.id);
        add(row.keyId);
        addAlias(row.name);
        addAlias(row.username);
      }
    } catch { /* ignore */ }
  }
  return { ids: [...ids], refs };
}

/**
 * Owner matching for content: explicit id fields win. Display-name fields are
 * only consulted for legacy rows with no id at all, so two accounts sharing a
 * name can never inherit each other's posts.
 */
function itemBelongsToAccount(item: any, refs: Set<string>): boolean {
  if (!item || typeof item !== 'object') return false;
  const lower = (value: unknown) => String(value || '').trim().toLowerCase();
  const strong = [item.ownerId, item.userId, item.user_id, item.authorId]
    .map(lower).filter(Boolean);
  if (strong.length) return strong.some((value) => refs.has(value));
  const legacy = [item.creatorId, item.username, item.handle]
    .map(lower).filter(Boolean);
  if (legacy.length) return legacy.some((value) => refs.has(value));
  const display = [item.creator, item.user].map(lower).filter(Boolean);
  return display.some((value) => refs.has(value));
}

/**
 * Resolve any route target (account id, legacy email id, @handle, username or
 * display name) to the canonical account. Exact alias matches only; ambiguity
 * is resolved deterministically, and email targets resolve through the auth
 * account rather than an email-keyed legacy profile row.
 */
async function resolveProfileRef(env: any, target: string): Promise<any | null> {
  const raw = String(target || '').trim();
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  const cleaned = decoded.replace(/^@+/, '').trim();
  if (!cleaned) return null;
  if (SEED_PROFILE_IDS.has(cleaned)) return null;

  // 1) Direct account id. Duplicate rows for the same email are folded onto
  //    the canonical account so stale links cannot open a second identity.
  if (!isEmailLike(cleaned)) {
    const direct = await getStoredProfile(env, cleaned);
    if (direct) {
      const email = profileEmailOf(direct);
      if (email) {
        const authId = await canonicalAuthIdForEmail(env, email);
        if (authId && authId !== cleaned) {
          const canonical = await getStoredProfile(env, authId);
          if (canonical) return { id: authId, profile: canonical, via: 'canonical-id' };
        }
        if (isEmailLike(direct.id) && cleaned !== direct.id) {
          // Row is a legacy email-keyed duplicate — never canonical.
        }
      }
      return { id: String(direct.id || cleaned), profile: direct, via: 'id' };
    }
  } else {
    // Legacy email link: map to the real auth account, never the legacy row.
    const authId = await canonicalAuthIdForEmail(env, cleaned);
    if (!authId) return null;
    const profile = await getStoredProfile(env, authId);
    if (profile) return { id: authId, profile, via: 'email' };
    return null;
  }

  // 2) Exact username / display-name alias from the bounded profile index.
  const needle = normalizeProfileAlias(cleaned);
  if (needle.length < 2) return null;
  const index = await buildProfileIndex(env);
  const matches = index.filter((row) =>
    !row.emailKeyed &&
    !row.isSeed &&
    !SEED_PROFILE_IDS.has(String(row.id)) &&
    (normalizeProfileAlias(row.username) === needle ||
      normalizeProfileAlias(row.name) === needle ||
      (Array.isArray(row.aliases) && row.aliases.includes(needle))),
  );
  const byCanonical = new Map<string, any>();
  for (const row of matches) {
    const canonicalId = String(row.canonicalId || row.id);
    const existing = byCanonical.get(canonicalId);
    // Prefer the canonical row itself over a duplicate row that merely
    // carries the searched alias.
    if (!existing || (String(row.id) === canonicalId && String(existing.id) !== canonicalId)) {
      byCanonical.set(canonicalId, row);
    }
  }
  const candidates = [...byCanonical.values()];
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    (Number(b.verified === true) - Number(a.verified === true)) ||
    (Number(b.followers || 0) - Number(a.followers || 0)) ||
    String(a.id).localeCompare(String(b.id)),
  );
  const chosen = candidates[0];
  const canonicalId = String(chosen.canonicalId || chosen.id);
  const profile = (await getStoredProfile(env, canonicalId)) || chosen;
  return {
    id: String(profile.id || canonicalId),
    profile,
    via: 'alias',
    ambiguous: candidates.length > 1,
  };
}

/**
 * Follow graph keys are canonical account ids. Route targets may arrive as
 * @handles, display names, legacy emails or duplicate profile ids, so resolve
 * them before touching FOLLOWING/FOLLOWERS/FOLLOW_REQ.
 */
async function canonicalTargetId(env: any, target: string): Promise<string> {
  const raw = String(target || '').trim();
  if (!raw) return '';
  try {
    const resolved = await resolveProfileRef(env, raw);
    if (resolved?.id) return String(resolved.id);
  } catch { /* fall through to the raw target */ }
  return raw;
}

/**
 * Canonicalize any stored account reference (account id, duplicate/legacy
 * profile id, email, @handle, username) to the one canonical account id.
 * Duplicate rows for an email collapse onto the auth:user account, so follow
 * lists, chat peers, ownership checks and viewer identity all agree.
 */
async function canonicalAccountId(env: any, value: unknown): Promise<string> {
  const raw = String(value || '').trim().slice(0, 200);
  if (!raw) return '';
  if (isEmailLike(raw)) {
    const authId = await canonicalAuthIdForEmail(env, raw);
    return authId || raw.toLowerCase();
  }
  try {
    const direct = await getStoredProfile(env, raw);
    if (direct) {
      const email = profileEmailOf(direct);
      if (email) {
        const authId = await canonicalAuthIdForEmail(env, email);
        if (authId) return authId;
      }
      const directId = String(direct.id || raw);
      if (isEmailLike(directId)) {
        const authId = await canonicalAuthIdForEmail(env, directId);
        if (authId) return authId;
      }
      return directId;
    }
  } catch { /* fall through to the index */ }
  try {
    const index = await buildProfileIndex(env);
    const needle = raw.toLowerCase();
    const row = index.find((r) =>
      String(r.id || '').toLowerCase() === needle ||
      String(r.keyId || '').toLowerCase() === needle,
    );
    if (row) return String(row.canonicalId || row.id || raw);
  } catch { /* fall through */ }
  // Last resort for legacy unverified clients that send a display name.
  try {
    const resolved = await resolveProfileRef(env, raw);
    if (resolved?.id) return String(resolved.id);
  } catch { /* keep raw */ }
  return raw;
}

/**
 * Canonical identity for an authenticated caller. The account email is the
 * strongest signal (it always maps to auth:user:<email>), then the supplied id.
 * Returns a usable fallback so a missing profile can never break a request.
 */
async function canonicalIdentity(env: any, id: unknown, email: unknown): Promise<{ id: string; email: string }> {
  const rawId = String(id || '').trim().slice(0, 200);
  const rawEmail = String(email || '').trim().toLowerCase().slice(0, 254);
  let canonical = '';
  if (rawEmail) canonical = await canonicalAuthIdForEmail(env, rawEmail);
  if (!canonical && rawId) canonical = await canonicalAccountId(env, rawId);
  if (!canonical && rawEmail) canonical = await canonicalAccountId(env, rawEmail);
  return {
    id: canonical || rawId || rawEmail,
    email: rawEmail || (isEmailLike(rawId) ? rawId.toLowerCase() : ''),
  };
}

/**
 * Every stored reference (ids, emails, aliases) that belongs to one account.
 * Used for follow/chat/ownership matching so a legacy duplicate ref can never
 * split one person into two identities.
 */
async function accountRefSet(env: any, account: any): Promise<Set<string>> {
  const base = account && typeof account === 'object' ? account : {};
  const { refs } = await refsForAccount(env, base);
  const add = (value: unknown) => {
    const clean = String(value || '').trim().toLowerCase();
    if (clean) refs.add(clean);
    const alias = normalizeProfileAlias(value);
    if (alias) { refs.add(alias); refs.add('@' + alias); }
  };
  add(base.id);
  add(base.email);
  add(base._userEmail);
  add(base.username);
  return refs;
}

async function readIdList(env, key) {
  try {
    const raw = await env.EQUYVO_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * Fold every legacy ref in a stored id list onto its canonical account id and
 * drop duplicates. `had` reports whether the account was already present under
 * any ref (so counters are not incremented twice), `changed` whether the stored
 * list needs rewriting.
 */
async function normalizeRefList(env, rawList, account, canonicalId) {
  const refs = await accountRefSet(env, account || { id: canonicalId });
  refs.add(String(canonicalId).toLowerCase());
  const out = [];
  const seen = new Set();
  let had = false;
  for (const value of Array.isArray(rawList) ? rawList : []) {
    const clean = String(value || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    let next = clean;
    if (refs.has(key)) {
      had = true;
      next = canonicalId;
    }
    const nextKey = String(next).toLowerCase();
    if (seen.has(nextKey)) continue;
    seen.add(nextKey);
    out.push(next);
  }
  return {
    ids: out,
    had,
    changed: JSON.stringify(out) !== JSON.stringify(rawList || []),
  };
}

/**
 * Canonicalize + dedupe a follower/following id list. The bounded profile index
 * supplies duplicate-id -> canonical-id mappings in one read; anything not in
 * the index is kept as-is (it is already an account id or a legacy email).
 */
async function canonicalizeIdList(env, ids) {
  let index = [];
  try { index = await buildProfileIndex(env); } catch { index = []; }
  const map = new Map();
  const put = (key, canonical) => {
    const k = String(key || '').trim().toLowerCase();
    if (k && canonical) map.set(k, String(canonical));
  };
  for (const row of index) {
    const canonical = String(row.canonicalId || row.id || '');
    if (!canonical) continue;
    put(row.id, canonical);
    put(row.keyId, canonical);
    if (row.email) put(row.email, canonical);
  }
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(ids) ? ids : []) {
    const clean = String(raw || '').trim();
    if (!clean) continue;
    let canonical = map.get(clean.toLowerCase());
    if (!canonical && isEmailLike(clean)) {
      canonical = (await canonicalAuthIdForEmail(env, clean)) || clean;
    }
    canonical = String(canonical || clean);
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

async function isFollowingPair(env, viewerId, authorId) {
  if (!viewerId || !authorId || viewerId === authorId) return viewerId === authorId;
  try {
    const [following, followers] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(viewerId)),
      readIdList(env, KEYS.FOLLOWERS(authorId)),
    ]);
    const vl = String(viewerId).toLowerCase();
    const al = String(authorId).toLowerCase();
    if (following.some((x) => String(x).toLowerCase() === al)) return true;
    if (followers.some((x) => String(x).toLowerCase() === vl)) return true;
    // Legacy follow lists can still hold a duplicate/email ref for either
    // account. Match every ref that belongs to the pair before denying access.
    const [viewerProfile, authorProfile] = await Promise.all([
      getStoredProfile(env, viewerId),
      getStoredProfile(env, authorId),
    ]);
    const [viewerRefs, authorRefs] = await Promise.all([
      accountRefSet(env, viewerProfile || { id: viewerId }),
      accountRefSet(env, authorProfile || { id: authorId }),
    ]);
    if (following.some((x) => authorRefs.has(String(x).trim().toLowerCase()))) return true;
    if (followers.some((x) => viewerRefs.has(String(x).trim().toLowerCase()))) return true;
    return false;
  } catch { return false; }
}

// Light viewer resolution for PUBLIC reads: verified session/JWT when present,
// otherwise anonymous. Never rejects — anonymous viewers simply see public
// content only. An unverified X-User-Id header (or ?viewerId / ?userId query)
// must never grant viewer identity: anyone could claim a private account and
// read its followers-only posts. Header fallback stays available only when
// verified writes are explicitly relaxed for a deliberate rollback.
async function getViewer(request, env) {
  try {
    const auth = request.headers.get('Authorization') || '';
    if (auth.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (token) {
        // Equyvo's own sessions are opaque KV tokens.
        try {
          const raw = await env.EQUYVO_KV.get('auth:session:' + token);
          if (raw) {
            const u = JSON.parse(raw);
            if (!(await sessionRevoked(env, u))) {
              const who = await canonicalIdentity(env, u.id, u.email);
              if (who.id) return { id: who.id, email: who.email };
            }
          }
        } catch { /* fall through to JWT verification */ }
        const user = (await verifyCognitoToken(token, env)) || (await verifyCentralJWT(token, env));
        if (user) {
          const who = await canonicalIdentity(env, user.id, user.email);
          if (who.id) return { id: who.id, email: who.email };
        }
      }
    }
  } catch { /* fall through to header */ }
  if (requiresVerifiedWrites(env)) return null;
  try {
    const h = request.headers.get('X-User-Id') || request.headers.get('X-User-Email') || '';
    const q = new URL(request.url).searchParams;
    const id = String(h || q.get('viewerId') || q.get('viewer') || '').slice(0, 200);
    if (id) {
      // Legacy clients occasionally send the account email or a duplicate
      // profile id. Map it to the canonical account so privacy/ownership
      // checks never silently fail.
      const who = await canonicalIdentity(env, id, isEmailLike(id) ? id : '');
      if (who.id) return { id: who.id, email: who.email };
    }
  } catch { /* ignore */ }
  return null;
}

/** Canonical owner id for a content row, memoized per feed request. */
async function canonicalOwnerId(env, rawOwner, cache?) {
  const raw = String(rawOwner || '').trim();
  if (!raw) return '';
  const key = 'canon:' + raw.toLowerCase();
  if (cache && cache.has(key)) return cache.get(key);
  let id = '';
  try { id = await canonicalAccountId(env, raw); } catch { id = ''; }
  const out = id || raw;
  if (cache) cache.set(key, out);
  return out;
}

async function canViewerSeeItem(env, viewer, item, profileCache) {
  const owner = await canonicalOwnerId(env, itemOwnerId(item), profileCache);
  if (isRemovedItem(item)) {
    // Owners can still see their own quarantined item (so delete works);
    // everyone else cannot.
    if (viewer && owner && viewer.id === owner) return true;
    return false;
  }
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
          const owner = await canonicalOwnerId(env, itemOwnerId(it), cache);
          let profile = owner ? cache.get(owner) : undefined;
          if (profile === undefined && owner) {
            profile = await getStoredProfile(env, owner);
            cache.set(owner, profile);
          }
          applyAuthorIdentity(it, profile);
          // Expose the canonical owner id so every client click/ownership
          // path opens the real account, never a duplicate/legacy row.
          if (owner) {
            it.ownerId = owner;
            if (it.userId) it.userId = owner;
            if (it.user_id) it.user_id = owner;
            if (it.authorId) it.authorId = owner;
          }
          // Views badge policy: the Eye number stays only on content that is
          // effectively public. Private-account / followers-only rows keep
          // their real counter for the OWNER but get stripped for everyone
          // else (so the badge never shows on private content). `viewedBy`
          // is account-auth material and is never shipped to clients.
          try {
            delete it.viewedBy;
            const isOwnerRow = !!(viewer && owner && String(viewer.id).toLowerCase() === String(owner).toLowerCase());
            const effVis = itemVisibility(it, profile);
            if (!isOwnerRow && ((profile && profile.isPrivate === true) || effVis !== 'public')) {
              delete it.views;
              if ('views_count' in it) delete it.views_count;
            }
          } catch { /* badge policy is best-effort */ }
        } catch { /* display overlay is best-effort */ }
        // Never expose account email/auth material on public content rows.
        try {
          delete it.email;
          delete it.userEmail;
          delete it._userEmail;
          delete it.password;
          delete it.salt;
        } catch { /* frozen row */ }
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
  const name = publicDisplayName(authorProfile.username, authorProfile.name, '');
  if (name && name !== 'User') {
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
    name: publicDisplayName(profile.name, profile.username, profile.id),
    username: publicDisplayName(profile.username, profile.name, profile.id),
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

/**
 * Read one 1:1 ledger under canonical ids, folding in history that legacy
 * clients stored under a duplicate/email pair token. Returned messages are
 * re-keyed to the canonical accounts so ticks/fromMe stay correct.
 */
async function readThreadLedgerResolved(env, actorId, peerId, limit, rawPeer?) {
  const primary = await readThreadLedger(env, actorId, peerId, limit);
  if (primary.length) return primary;
  const [actorProfile, peerProfile] = await Promise.all([
    getStoredProfile(env, actorId),
    getStoredProfile(env, peerId),
  ]);
  const [actorRefs, peerRefs] = await Promise.all([
    refsForAccount(env, actorProfile || { id: actorId }),
    refsForAccount(env, peerProfile || { id: peerId }),
  ]);
  const canonicalActor = String(actorId).toLowerCase();
  const canonicalPeer = String(peerId).toLowerCase();
  const rawPeerClean = String(rawPeer || '').trim();
  const duplicateActorIds = actorRefs.ids.filter((id) => id && !isEmailLike(id) && String(id).toLowerCase() !== canonicalActor);
  const duplicatePeerIds = peerRefs.ids.filter((id) => id && !isEmailLike(id) && String(id).toLowerCase() !== canonicalPeer);
  const peerDiffers = !!rawPeerClean && rawPeerClean.toLowerCase() !== canonicalPeer;
  if (!peerDiffers && !duplicateActorIds.length && !duplicatePeerIds.length) return primary;
  const actorIds = [actorId, ...duplicateActorIds].slice(0, 4);
  const peerIds = [peerId, ...(peerDiffers ? [rawPeerClean] : []), ...duplicatePeerIds].slice(0, 4);
  const pairs = [];
  const seen = new Set();
  for (const a of actorIds) {
    for (const p of peerIds) {
      if (!a || !p) continue;
      if (String(a) === String(actorId) && String(p) === String(peerId)) continue;
      const key = chatPairToken(a, p);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, p]);
      if (pairs.length >= 6) break;
    }
    if (pairs.length >= 6) break;
  }
  if (!pairs.length) return primary;
  const ledgers = await Promise.all(pairs.map(([a, p]) => readThreadLedger(env, a, p, limit)));
  const actorSet = new Set(actorIds.map((x) => String(x).toLowerCase()));
  const peerSet = new Set(peerIds.map((x) => String(x).toLowerCase()));
  const mapAccount = (value) => {
    const key = String(value || '').toLowerCase();
    if (key === canonicalActor) return actorId;
    if (key === canonicalPeer) return peerId;
    if (actorSet.has(key)) return actorId;
    if (peerSet.has(key)) return peerId;
    return value;
  };
  const out = new Map();
  for (const list of ledgers) {
    for (const m of list) {
      if (!m || !m.id || out.has(m.id)) continue;
      const next = { ...m, from: mapAccount(m.from), to: mapAccount(m.to) };
      if (Array.isArray(next.deletedFor)) next.deletedFor = next.deletedFor.map(mapAccount);
      out.set(next.id, next);
    }
  }
  const merged = [...out.values()].sort(
    (x, y) => (new Date(x.createdAt).getTime() || 0) - (new Date(y.createdAt).getTime() || 0),
  );
  const n = Math.min(300, Math.max(1, Number(limit) || 100));
  return merged.slice(-n);
}

async function pushUserNotification(env, userId, item) {
  if (!userId || !item) return;
  try {
    // Always write to the canonical account, and canonicalize the actor ref in
    // the payload so tapping a notification opens the real profile.
    const target = (await canonicalAccountId(env, userId)) || String(userId);
    const payload = { id: generateId(), at: new Date().toISOString(), read: false, ...item };
    if (payload.actorId) {
      payload.actorId = (await canonicalAccountId(env, payload.actorId)) || String(payload.actorId);
      // Every notification about a person links to THAT person's profile.
      if (!payload.link) payload.link = '/profile/' + encodeURIComponent(payload.actorId);
    }
    if (payload.actorName && isEmailLike(payload.actorName)) payload.actorName = 'Someone';
    for (const key of ['title', 'body']) {
      if (typeof payload[key] === 'string') payload[key] = scrubEmailText(payload[key]);
    }
    const raw = await env.EQUYVO_KV.get(KEYS.NOTIF(target));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr : [];
    list.unshift(payload);
    await env.EQUYVO_KV.put(KEYS.NOTIF(target), JSON.stringify(list.slice(0, 100)));
  } catch { /* never block on notify */ }
}

function profileSummary(p, fallbackId) {
  if (!p || typeof p !== 'object') {
    const f = publicDisplayName(fallbackId, '');
    return { id: String(fallbackId || ''), name: f, username: f.startsWith('@') ? f : '@' + f, avatar: '' };
  }
  const id = String(p.id || fallbackId || '');
  const username = publicDisplayName(p.username, p.name, id);
  return {
    id,
    name: publicDisplayName(p.name, username, id),
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
    // Legacy lists may carry duplicate/email refs for either account.
    const [viewerProfile, peerProfile] = await Promise.all([
      getStoredProfile(env, viewerId),
      getStoredProfile(env, peerId),
    ]);
    const [viewerRefs, peerRefs] = await Promise.all([
      accountRefSet(env, viewerProfile || { id: viewerId }),
      accountRefSet(env, peerProfile || { id: peerId }),
    ]);
    if (a.some((x) => peerRefs.has(String(x).trim().toLowerCase()))) return true;
    if (b.some((x) => peerRefs.has(String(x).trim().toLowerCase()))) return true;
    const [c, d] = await Promise.all([
      readIdList(env, KEYS.FOLLOWING(peerId)),
      readIdList(env, KEYS.FOLLOWERS(peerId)),
    ]);
    const v = String(viewerId).toLowerCase();
    if (c.some((x) => String(x).toLowerCase() === v)) return true;
    if (d.some((x) => String(x).toLowerCase() === v)) return true;
    if (c.some((x) => viewerRefs.has(String(x).trim().toLowerCase()))) return true;
    if (d.some((x) => viewerRefs.has(String(x).trim().toLowerCase()))) return true;
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
  const raw = String(name || '').trim();
  const n = raw && !isEmailLike(raw) ? raw.slice(0, 80) : '';
  if (n && n.toLowerCase() !== 'user') return n;
  const a = String((actor && (actor.username || (actor.email ? String(actor.email).split('@')[0] : ''))) || '').trim().slice(0, 80);
  return maskEmailDisplay(a) || 'User';
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
function toPublicComment(c, viewerId, viewerRefs?: Set<string>) {
  if (!c || typeof c !== 'object') return null;
  const likedBy = Array.isArray(c.likedBy) ? c.likedBy : [];
  // Engagement ledgers are server-only. Never expose account references in a
  // comment response, even when the comment has been shared.
  const { likedBy: _drop, sharedBy: _dropShares, ...rest } = c;
  const hasLiked = viewerRefs
    ? likedBy.some((x) => viewerRefs.has(String(x).trim().toLowerCase()))
    : viewerId
      ? likedBy.some((x) => String(x) === String(viewerId))
      : false;
  const masked = { ...rest };
  for (const key of ['user', 'name', 'author', 'creator', 'username', 'authorName', 'authorUsername']) {
    if (typeof masked[key] === 'string') masked[key] = maskEmailDisplay(masked[key]);
  }
  return {
    ...masked,
    likes: Number(c.likes || 0) || 0,
    hasLiked,
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

// Per-author comment ledger (newest first, capped). Best-effort: a failed
// ledger write never blocks posting a comment; read-time tombstone filtering
// still hides comments from deleted accounts.
async function addCommentToAuthorLedger(env, authorId, commentId) {
  const key = String(authorId || '').trim().toLowerCase();
  if (!key || !commentId) return;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.USER_COMMENTS(key));
    const arr = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(arr) ? arr.map(String).filter((x) => x !== commentId) : [];
    list.unshift(String(commentId));
    await env.EQUYVO_KV.put(KEYS.USER_COMMENTS(key), JSON.stringify(list.slice(0, 1000)));
  } catch { /* best-effort */ }
}

async function removeCommentsFromAuthorLedger(env, authorId, removedIds) {
  const key = String(authorId || '').trim().toLowerCase();
  const gone = new Set((removedIds || []).map(String));
  if (!key || !gone.size) return;
  try {
    const raw = await env.EQUYVO_KV.get(KEYS.USER_COMMENTS(key));
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    await env.EQUYVO_KV.put(KEYS.USER_COMMENTS(key), JSON.stringify(arr.filter((x) => !gone.has(String(x)))));
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
// Storage quotas per EQUYVO SUBSCRIPTION MODEL:
//   Free 1GB / Plus 10GB / Premium 30GB / Creator 150GB / Creator Pro 500GB / Biz custom
// ---------------------------------------------------------------------------
const GB = 1024 * 1024 * 1024;
// Upload caps raised so the app can handle long videos / vlogs / live
// recordings on the free tier too (measured to real-world 1080p phone
// recordings): the FILE-SIZE/LENGTH gates scale with the plan, storage
// quota stays the primary limit. Upgrades buy storage + even bigger caps.
const PLAN_CATALOG = {
  eq_free:        { id: 'eq_free',        label: 'Free',        priceInr: 0,    storageBytes: 1 * GB,    maxUploadMB: 50,   maxVideoSec: 300,   monthlyUploads: 100,  quality: 'auto-low',  ads: true },
  eq_plus:        { id: 'eq_plus',        label: 'Plus',        priceInr: 79,   storageBytes: 10 * GB,   maxUploadMB: 100,  maxVideoSec: 1800,  monthlyUploads: 500,  quality: 'auto-good', ads: 'light' },
  eq_premium:     { id: 'eq_premium',     label: 'Premium',     priceInr: 149,  storageBytes: 30 * GB,   maxUploadMB: 250,  maxVideoSec: 3600,  monthlyUploads: 2000, quality: 'auto-best', ads: false },
  eq_creator:     { id: 'eq_creator',     label: 'Creator',     priceInr: 499,  storageBytes: 150 * GB,  maxUploadMB: 500,  maxVideoSec: 7200,  monthlyUploads: 5000, quality: 'auto-best', ads: false, creator: true },
  eq_creator_pro: { id: 'eq_creator_pro', label: 'Creator Pro', priceInr: 1499, storageBytes: 500 * GB,  maxUploadMB: 1024, maxVideoSec: 14400, monthlyUploads: 20000, quality: 'original', ads: false, creator: true, verified: true },
  eq_business:    { id: 'eq_business',    label: 'Business',    priceInr: null, storageBytes: 1024 * GB, maxUploadMB: 2048, maxVideoSec: 14400, monthlyUploads: 50000, quality: 'original', ads: false, creator: true, business: true },
};
const DEFAULT_PLAN_ID = 'eq_free';
const PLAN_IDS = new Set(Object.keys(PLAN_CATALOG));

// Platform fee for creator earnings (tips / paid subs / digital products).
const PLATFORM_FEE_BPS = 1500; // 15% (Creator tier platform fee per spec)

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

// ── Media truth (server-enforced) ─────────────────────────────────────────
// Writers have used every representation over time: `media` as a string, an
// array of {type,url}, or an object; sometimes only `image`/`videoUrl`. Feed
// clients must never receive a raw array in a field they render as `<img src>`.
const SERVER_VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)(\?|#|$)/i;
const SERVER_IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif)(\?|#|$)/i;
const SERVER_AUDIO_EXT = /\.(mp3|wav|m4a|aac|oga|ogg|flac|opus)(\?|#|$)/i;

function serverRenderableUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url || url === '[object Object]' || url === 'undefined' || url === 'null') return '';
  if (!/^(https?:)?\/\//i.test(url) && !/^(blob:|data:|file:)/i.test(url) && !url.startsWith('/')) return '';
  return url;
}

function serverFirstMediaUrl(value) {
  if (value == null) return '';
  if (typeof value === 'string') return serverRenderableUrl(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = serverFirstMediaUrl(entry);
      if (url) return url;
    }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'secureUrl', 'secure_url', 'src', 'mediaUrl', 'media_url', 'videoUrl', 'video_url', 'audioUrl', 'audio_url', 'playbackUrl', 'imageUrl', 'image_url', 'path', 'link', 'image', 'video', 'audio', 'media', 'thumbnail', 'poster']) {
      const url = serverFirstMediaUrl(value[key]);
      if (url) return url;
    }
  }
  return '';
}

function serverMediaKind(url, hint) {
  const u = String(url || '');
  const h = String(hint || '').toLowerCase();
  if (h === 'gif') return 'gif';
  if (h === 'audio') return 'audio';
  if (/res\.cloudinary\.com\//i.test(u)) {
    if (/\/video\/upload\//i.test(u) && !SERVER_IMAGE_EXT.test(u)) return 'video';
    if (/\.gif(\?|#|$)/i.test(u)) return 'gif';
    return 'image';
  }
  if (SERVER_VIDEO_EXT.test(u)) return 'video';
  if (SERVER_IMAGE_EXT.test(u)) return /\.gif(\?|#|$)/i.test(u) ? 'gif' : 'image';
  if (SERVER_AUDIO_EXT.test(u)) return 'audio';
  if (h === 'image' || h === 'photo') return 'image';
  if (h === 'gif') return 'gif';
  return h === 'video' || h === 'moment' ? 'video' : 'image';
}

function normalizeMediaFields(item) {
  if (!item || typeof item !== 'object') return item;
  const items = [];
  const seen = new Set();
  const push = (url, hint, extra) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    const kind = serverMediaKind(url, hint);
    const entry = { url, type: kind };
    if (extra && typeof extra === 'object') {
      const thumb = serverFirstMediaUrl(extra.thumbnail) || serverFirstMediaUrl(extra.poster);
      if (thumb && thumb !== url) entry.thumbnail = thumb;
      const duration = Number(extra.duration ?? extra.durationSec);
      if (Number.isFinite(duration) && duration > 0) entry.duration = duration;
      if (typeof extra.publicId === 'string') entry.publicId = extra.publicId;
    }
    items.push(entry);
  };
  const visit = (value, hint) => {
    if (value == null) return;
    // Cover-slot rule: if the item already has playable media, singular image
    // fields (`image` / `image_url` / `imageUrl`) could only have carried the
    // cover/poster — real second gallery slides always live in the media
    // array. Visiting them as slides is what made a video thought with a
    // custom thumbnail render the thumbnail as a separate second media block.
    if (hasPlayableHint && String(hint).toLowerCase().startsWith('image')) return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry, hint); return; }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length < 20000) {
        try { visit(JSON.parse(trimmed), hint); return; } catch { /* URL below */ }
      }
      push(trimmed, hint);
      return;
    }
    if (typeof value === 'object') {
      const url = serverFirstMediaUrl(value);
      if (!url) return;
      push(url, value.type || value.mediaType || value.kind || value.resourceType || hint, value);
    }
  };
  // Preserve the original list for gallery renderers.
  // Playable media can come from `media`/`videoUrl`/`audioUrl` — detect it
  // BEFORE the visits so image-family fields are treated as cover slots.
  const hasPlayableHint = !!(serverFirstMediaUrl(item.videoUrl) || serverFirstMediaUrl(item.video_url) || serverFirstMediaUrl(item.video) ||
    serverFirstMediaUrl(item.audioUrl) || serverFirstMediaUrl(item.audio_url) || serverFirstMediaUrl(item.audio));
  visit(item.mediaItems, item.mediaType);
  visit(item.media, item.mediaType);
  visit(item.videoUrl, 'video');
  visit(item.video_url, 'video');
  visit(item.video, 'video');
  visit(item.imageUrl, 'image');
  visit(item.image_url, 'image');
  visit(item.image, 'image');
  visit(item.audioUrl, 'audio');
  visit(item.audio_url, 'audio');
  visit(item.audio, 'audio');
  // Posters/thumbnails are previews, not gallery slides.
  if (!items.length) visit(item.thumbnail || item.poster, 'image');

  const videoItem = items.find((m) => m.type === 'video');
  const audioItem = items.find((m) => m.type === 'audio');
  const imageItem = items.find((m) => m.type === 'image' || m.type === 'gif');
  const explicitVideo = serverFirstMediaUrl(item.videoUrl) || serverFirstMediaUrl(item.video_url) || serverFirstMediaUrl(item.video);
  const videoUrl = videoItem?.url || (explicitVideo && serverMediaKind(explicitVideo, 'video') === 'video' ? explicitVideo : '');
  const explicitAudio = serverFirstMediaUrl(item.audioUrl) || serverFirstMediaUrl(item.audio_url) || serverFirstMediaUrl(item.audio);
  const audioUrl = audioItem?.url || (explicitAudio && serverMediaKind(explicitAudio, 'audio') === 'audio' ? explicitAudio : '');
  const explicitImage = serverFirstMediaUrl(item.image) || serverFirstMediaUrl(item.imageUrl) || serverFirstMediaUrl(item.image_url);
  // Photos are their own preview: a separate thumbnail/poster file must never
  // replace the original image on write. Letting a cover win `image` is how
  // photo originals went missing while the cover survived. Posters remain a
  // video-only concept.
  const isImageMedia = !videoUrl && !audioUrl && !!(explicitImage || imageItem?.url);
  // `image` is a still-image field, never the video's cover. Filling it with
  // the poster made every video thought with a custom thumbnail expose the
  // cover as a SECOND gallery slide on read (content + thumbnail rendered as
  // two separate media in one post). Posters stay in `thumbnail` only.
  const stillImage = explicitImage || imageItem?.url || '';
  const image = stillImage;
  const safeImage = image && image !== videoUrl && image !== audioUrl && serverMediaKind(image, 'image') !== 'video' ? image : '';
  // For image media the thumbnail IS the image (same file, self-referential);
  // video items keep the cover/poster precedence.
  const rawCover = serverFirstMediaUrl(item.thumbnail) || serverFirstMediaUrl(item.poster) || '';
  const thumbnail = isImageMedia ? safeImage :
    (rawCover || safeImage || imageItem?.thumbnail || '');
  // Self-heal legacy video rows that stored their cover in `image`: the cover
  // already renders as the video poster, and leaving it in `image` re-created
  // the duplicate (poster rendered as both the video preview and a slide).
  const videoImageIsCover = !isImageMedia && !!videoUrl && !!safeImage && (safeImage === thumbnail || safeImage === rawCover);
  const dedupedVideoImage = videoImageIsCover ? '' : safeImage;
  // Self-heal legacy rows that appended the cover as its own gallery entry:
  // later slides whose url is the item's cover are thumbnail copies, not
  // separate media. The cover itself stays in `thumbnail` either way.
  const coverCopyCount = items.reduce((n, m, index) => n + (index > 0 && rawCover && m.url === rawCover ? 1 : 0), 0);
  if (coverCopyCount > 0 && items.length - coverCopyCount > 0) {
    const kept = items.filter((m, index) => index === 0 || m.url !== rawCover);
    items.length = 0;
    for (const keptItem of kept) items.push(keptItem);
  }

  item.mediaItems = items;
  item.media = videoUrl || safeImage || audioUrl || items[0]?.url || '';
  item.image = dedupedVideoImage;
  // Sync the legacy alias fields with the derived truth so later
  // normalisations (any client or mirror worker) can never resurrect the old
  // cover or re-duplicate slides from stale aliases.
  item.imageUrl = dedupedVideoImage;
  item.image_url = dedupedVideoImage;
  item.videoUrl = videoUrl;
  item.video = videoUrl;
  item.mediaUrl = item.media;
  item.media_url = item.media;
  item.audioUrl = audioUrl;
  item.audio = audioUrl;
  item.thumbnail = thumbnail && thumbnail !== videoUrl ? thumbnail : '';
  if (!videoUrl && !safeImage && !audioUrl && !item.mediaType) item.mediaType = 'text';
  else item.mediaType = videoUrl ? 'video' : audioUrl ? 'audio' : 'image';
  return item;
}

// Apply computed time and other transformations to items before returning
function transformItem(item) {
  if (!item) return item;
  if (item.createdAt) {
    item.time = computeRelativeTime(item.createdAt);
  }
  // Make every media representation render-safe BEFORE type routing reads it.
  normalizeMediaFields(item);
  // ── Content-type truth (server-enforced) ────────────────────────────────
  // Every surface relies on `type` to choose its renderer. Legacy clients wrote
  // photos into the moments collection and videos into photo posts; without
  // normalization those items appear in the wrong place (a photo in the
  // short-video feed, a video in the photo grid). Enforce the truth here once:
  //   • moment WITHOUT playable video → photo
  //   • legacy type "image"          → photo
  //   • video/image types follow the actual media (videoUrl/mediaType wins)
  const rawType = String(item.type || item.contentType || '').toLowerCase();
  const hasVideo = itemHasPlayableVideo(item);
  if (rawType === 'moment' && !hasVideo) {
    item.type = 'photo';
    item.contentType = 'photo';
    item.mediaType = 'image';
    if (!item.image) item.image = item.thumbnail || item.media || '';
  } else if (rawType === 'image') {
    item.type = 'photo';
    item.contentType = item.contentType && String(item.contentType).toLowerCase() !== 'image'
      ? item.contentType
      : 'photo';
  } else if (hasVideo && ['photo', 'image'].includes(rawType) && !item.image && !item.thumbnail) {
    // A video-only item mislabeled as a photo is a video post, not a still.
    item.type = 'video';
    item.contentType = 'video';
  }
  return item;
}

// Per-viewer engagement truth for items returned by list endpoints. The
// stored counter is shared, but `user_vote` / `user_has_liked` are personal.
function viewerRefSet(viewer) {
  const refs = new Set();
  if (viewer && viewer.id) refs.add(String(viewer.id).toLowerCase());
  if (viewer && viewer.email) refs.add(String(viewer.email).toLowerCase());
  if (viewer && viewer.username) refs.add(String(viewer.username).replace(/^@/, '').toLowerCase());
  return refs;
}

function applyViewerVoteState(item, viewer) {
  if (!item || typeof item !== 'object') return item;
  const refs = viewerRefSet(viewer);
  const upLedger = Array.isArray(item.upvotedBy) ? item.upvotedBy.map((x) => String(x).toLowerCase()) : [];
  const downLedger = Array.isArray(item.downvotedBy) ? item.downvotedBy.map((x) => String(x).toLowerCase()) : [];
  const likedLedger = Array.isArray(item.likedBy) ? item.likedBy.map((x) => String(x).toLowerCase()) : [];
  const sharedLedger = Array.isArray(item.sharedBy) ? item.sharedBy.map((x) => String(x).toLowerCase()) : [];
  const hasRef = (ledger) => [...refs].some((r) => ledger.includes(r));
  item.upvotes_count = Math.max(Number(item.upvotes_count ?? item.upvotes ?? 0) || 0, upLedger.length);
  item.downvotes_count = Math.max(Number(item.downvotes_count ?? item.downvotes ?? 0) || 0, downLedger.length);
  item.user_vote = hasRef(upLedger) ? 'upvote' : hasRef(downLedger) ? 'downvote' : null;
  item.user_has_liked = refs.size > 0 && hasRef(likedLedger);
  item.user_has_shared = refs.size > 0 && hasRef(sharedLedger);
  // Account references are engagement ledgers, not public content fields.
  delete item.sharedBy;
  delete item.viewedBy;
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

// Content-type truth: a "moment" is the short-video surface. Any item stored
// as a moment without playable video (legacy/photo uploads) is NOT a moment —
// callers bucket it back into the photo feed instead of the video rail.
function itemHasPlayableVideo(item) {
  if (!item || typeof item !== 'object') return false;
  if (String(item.mediaType || '').toLowerCase() === 'video') {
    return Boolean(item.videoUrl || item.video || item.media);
  }
  const video = String(item.videoUrl || item.video || item.playbackUrl || '').trim();
  if (video && !/\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|$)/i.test(video)) return true;
  const media = item.media;
  if (Array.isArray(media)) {
    return media.some((m) => m && String(m.type || '').toLowerCase() === 'video' && m.url);
  }
  if (media && typeof media === 'object' && String(media.type || '').toLowerCase() === 'video' && media.url) return true;
  return false;
}

// Reset the bucket of an item stored as a moment but carrying only a photo.
function asPhotoItem(item) {
  return {
    ...item,
    type: 'photo',
    contentType: 'photo',
    videoUrl: '',
    mediaType: 'image',
    image: item.image || item.thumbnail || item.media || '',
  };
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
// Bot/test author signals: automated-account email domains, the Playwright id
// prefix, and smoke-test display names (e.g. "SmokeAlice"). These are author
// identity fields only — post CONTENT text is never matched, so a real post
// that happens to contain the word "test" or "smoke" is never dropped.
const TEST_TEXT_PATTERNS = [/@test\.com$/i, /^pwsrc_/i, /^smoke/i];
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
  // and the bundled placeholder.svg art used by smoke-test posts.
  if (refs.some((r) =>
    String(r).includes('gtv-videos-bucket/sample/') ||
    String(r).includes('picsum.photos/seed/') ||
    String(r).includes('/placeholder.svg')
  )) return true;
  // Automated test/bot content: only author identity fields are reliable
  // signals (email, ids, display names). Deliberately NOT matching free-text
  // content/id so a real post is never dropped because of its wording.
  const authorSignals = [
    item.email,
    item.userId,
    item.user_id,
    item.creator,
    item.username,
    item.handle,
    item.user,
    item.name,
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
// Bump SEED_PURGE_VERSION whenever the purge logic or bot patterns change so
// production KV re-runs the purge exactly once after the deploy.
const SEED_PURGED_KEY = 'seed_purged';
const SEED_PURGE_VERSION = '2';

// Legacy demo profiles (user1/user2) plus the 2026-10 smoke-test accounts:
// the "SmokeAlice" author and its companion "liker" account. Both are removed
// from storage and blocked from every read path.
const SEED_PROFILE_IDS = new Set([
  'user1',
  'user2',
  'e5c51ad9-93d4-43a9-a79d-aeedd91f5768',
  '2b950fe3-0732-4c61-88d8-907ed16f70d2',
]);

async function purgeSeedData(env) {
  const kv = env.EQUYVO_KV;
  if ((await kv.get(SEED_PURGED_KEY)) === SEED_PURGE_VERSION) return;

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

  await kv.put(SEED_PURGED_KEY, SEED_PURGE_VERSION);
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
async function requiresVerifiedWrites(env) {
  // Secure by default: account identity must come from a real session token,
  // never from a client-supplied X-User-Id (which anyone can forge). Set
  // REQUIRE_VERIFIED_WRITES="false" only for a deliberate temporary rollback.
  const flag = String(env.REQUIRE_VERIFIED_WRITES ?? '').trim().toLowerCase();
  return flag !== 'false' && flag !== '0';
}

/** A deleted account's leftover sessions must stop working immediately. */
async function sessionRevoked(env, sessionUser) {
  const email = String(sessionUser?.email || '').trim().toLowerCase();
  if (!email) return false;
  try {
    return !!(await env.EQUYVO_KV.get('auth:blocked:' + email));
  } catch {
    return false;
  }
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
          if (!(await sessionRevoked(env, u))) {
            const who = await canonicalIdentity(env, u.id, u.email);
            return { id: who.id, email: who.email, username: u.username || u.name || '', verified: true };
          }
          try { await env.EQUYVO_KV.delete('auth:session:' + token); } catch { /* ignore */ }
        }
      } catch { /* fall through */ }
    }
  }
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      const user = await verifyCognitoToken(token, env);
      if (user) {
        const who = await canonicalIdentity(env, user.id, user.email);
        return { ...user, id: who.id, email: who.email };
      }
      const central = await verifyCentralJWT(token, env);
      if (central) {
        const who = await canonicalIdentity(env, central.id, central.email);
        return { ...central, id: who.id, email: who.email };
      }
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
  const who = await canonicalIdentity(env, id, isEmailLike(id) ? id : '');
  if (!who.id) return null;
  return { id: who.id, email: who.email, username: '', verified: false };
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
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const SINGLE_UPLOAD_MAX_BYTES = UPLOAD_PART_SIZE;
const MAX_MULTIPART_PARTS = 10000;
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
    'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag',
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

/**
 * Ownership check that understands duplicate/legacy account refs. `owns()` is
 * kept as the cheap synchronous fast path; this expands the caller to every
 * id/email/alias that belongs to their account before matching, so an owner is
 * never locked out of content written under a duplicate profile id.
 */
async function ownsAccount(env, item, actor) {
  if (!item || !actor) return false;
  if (owns(item, actor)) return true;
  try {
    const rawOwner = itemOwnerId(item) || String(item.creatorId || '');
    if (rawOwner) {
      const canonicalOwner = await canonicalAccountId(env, rawOwner);
      if (canonicalOwner && canonicalOwner === actor.id) return true;
    }
    let profile = await getStoredProfile(env, actor.id);
    if (!profile && actor.email) {
      const authId = await canonicalAuthIdForEmail(env, actor.email);
      if (authId) profile = await getStoredProfile(env, authId);
    }
    const refs = await accountRefSet(env, profile || {
      id: actor.id, email: actor.email, username: actor.username,
    });
    return itemBelongsToAccount(item, refs);
  } catch { return false; }
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
  // Duration is checked again at publish time so callers cannot bypass the
  // plan's video-length allowance by skipping the composer UI.
  const declaredDuration = Number(clean.duration ?? clean.durationSec);
  const hasVideo = String(clean.mediaType || '').toLowerCase() === 'video' ||
    String(clean.type || '').toLowerCase() === 'video' ||
    itemHasPlayableVideo(clean);
  if (hasVideo && Number.isFinite(declaredDuration) && declaredDuration > quota.maxVideoSec) {
    return json({ error: `Video is longer than the ${quota.label} plan allows. Upgrade for longer uploads.`, code: 'QUOTA_VIDEO_LENGTH', planId }, 413, cors);
  }
  // Ownership is authoritative server-side: the verified caller owns the
  // item, regardless of what display-name fields the client sent. Only the
  // owning account can ever delete this item; other accounts may only hide
  // it from their own view (enforced in deleteItem + hide is per-viewer).
  // Author identity: the authenticated account is authoritative. Client-sent
  // display fields are only a hint, and placeholders like "anonymous" are
  // ignored so genuine uploads never get a fake author.
  let authorProfile = null;
  try {
    authorProfile = await ensureProfile(env, {
      id: actor.id,
      email: actor.email,
      name: actor.username,
      username: actor.username,
    });
  } catch { /* fall back to the session identity */ }
  const displayName = publicDisplayName(
    clean.user,
    clean.creator,
    authorProfile && authorProfile.username,
    authorProfile && authorProfile.name,
    actor.username,
    actor.email?.split('@')[0],
    'User',
  ).slice(0, 80);
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
    creator: displayName,
    visibility,
  };
  // Prefer the profile avatar over a stale/missing client copy.
  if ((!item.avatar || typeof item.avatar !== 'string') && authorProfile && authorProfile.avatar) {
    item.avatar = String(authorProfile.avatar);
  }
  // Never persist credentials or the account email on public content.
  delete item.email;
  delete item.userEmail;
  delete item._userEmail;
  delete item.password;
  delete item.salt;
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
  // Moments are short-video only. If a client sends an image-only "moment"
  // (legacy composer or a spoofed request), store it as a photo post instead
  // of letting it pollute the video feed.
  if (kind === 'moments' && !itemHasPlayableVideo(item)) {
    kind = 'posts';
    listKey = KEYS.POSTS;
    itemKey = KEYS.POST;
    item.type = 'photo';
    item.contentType = 'photo';
    item.mediaType = 'image';
    if (!item.image) item.image = item.thumbnail || item.media || '';
    item.videoUrl = '';
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
  const owned = await ownsAccount(env, parsed, actor);
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
    // the versioned one-time seed purge runs in the background via waitUntil.
    try {
      const purged = await env.EQUYVO_KV.get(SEED_PURGED_KEY);
      if (purged !== SEED_PURGE_VERSION) {
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
      // Bot guard: automated test/smoke accounts can never register. Matches
      // the same author signals the read-path seed filter uses, so no bot
      // identity can create content that later has to be purged.
      if (/@test\.com$/i.test(email) || /^pwsrc_/i.test(name) || /^smoke/i.test(name)) {
        return json({ error: 'Automated test accounts are not allowed to register.' }, 403, cors);
      }
      // Abuse guard: signup spam creates real KV rows and profiles.
      const signupIp = request.headers.get('cf-connecting-ip') || 'unknown';
      if (!(await rateLimit(kv, 'auth_signup', 'ip:' + signupIp, 5)).ok) {
        return json({ error: 'Too many sign-up attempts. Please wait a minute and try again.' }, 429, cors);
      }
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
      // Brute-force guard: per-IP and per-email windows. A failed password no
      // longer allows unlimited guesses against an account.
      const loginIp = request.headers.get('cf-connecting-ip') || 'unknown';
      const [ipRl, emailRl] = await Promise.all([
        rateLimit(kv, 'auth_login_ip', 'ip:' + loginIp, 30),
        rateLimit(kv, 'auth_login_email', 'e:' + email, 10),
      ]);
      if (!ipRl.ok || !emailRl.ok) {
        return json({ error: 'Too many sign-in attempts. Please wait a minute and try again.' }, 429, cors);
      }
      // Deleted/banned accounts stay dead: without this tombstone, the
      // auto-provision fallback below would resurrect them on login.
      if (await kv.get('auth:blocked:' + email)) {
        return json({ error: 'This account is no longer available.' }, 403, cors);
      }
      const raw = await kv.get('auth:user:' + email);
      let user;
      if (!raw) {
        // Bot guard: auto-provisioning must never create a test/smoke account.
        const loginName = email.split('@')[0];
        if (/@test\.com$/i.test(email) || /^pwsrc_/i.test(loginName) || /^smoke/i.test(loginName)) {
          return json({ error: 'Invalid email or password.' }, 401, cors);
        }
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
      if (await sessionRevoked(env, u)) {
        try { await kv.delete('auth:session:' + token); } catch { /* ignore */ }
        return json({ error: 'Not authenticated.' }, 401, cors);
      }
      // Sliding session: a user who launches the app at least once a week never
      // gets logged out mid-use. Renew at most once a day to avoid KV writes on
      // every screen that asks who the viewer is.
      try {
        const now = Date.now();
        const last = Number(u.renewedAt || 0) || 0;
        if (now - last > 24 * 60 * 60 * 1000) {
          const next = { ...u, renewedAt: now };
          await kv.put('auth:session:' + token, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 7 });
          u = next;
        }
      } catch { /* best-effort */ }
      return json({ success: true, user: u, token }, 200, cors);
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
      const withViewer = filtered.map((it) => applyViewerVoteState(it, viewer));
      const wantRank = sort === 'relevant' || sort === 'foryou' || !!userId || !!url.searchParams.get('interests');
      if (wantRank) {
        try {
          const interests = aiMerge(await aiGetInterests(env, userId), aiParseInterests(url.searchParams.get('interests')));
          const pops = {};
          await Promise.all(withViewer.slice(0, 100).map(async (it) => {
            try { const r = await kv.get(KEYS.POP(it.id)); if (r) pops[it.id] = parseInt(r, 10) || 0; } catch {}
          }));
          const scored = withViewer.map((it) => ({
            it,
            s: aiPopOf(it, pops) / 5 + aiRecency(it.createdAt || it.time) + aiInterestBoost({ category: (it.categories && it.categories[0]) || '', tags: it.tags || [], creator: it.user || '', title: it.content || '' }, interests),
          })).sort((a, b) => b.s - a.s);
          const page = scored.slice(offset, offset + limit).map((x) => x.it);
          if (Object.keys(interests).length) return json({ data: page, error: null, meta: { personalized: true } }, 200, cors);
          return json({ data: page, error: null }, 200, cors);
        } catch {}
      }
      return json({ data: withViewer.slice(offset, offset + limit), error: null }, 200, cors);
    }

    if (path === '/api/posts' && method === 'POST') {
      return await createItem(context, 'posts', KEYS.POSTS, KEYS.POST, cors);
    }

    // ONE CONTENT ITEM BY ID ───────────────────────────────────────────────
    // Shared links (/posts/:id, /profile/posts/:id) redirect to
    // /app/home?post=<id>; the feed fetches any post that is not on the
    // current page here. Same visibility rules as the feeds: private,
    // followers-only, removed and seed content are never exposed.
    if (path.startsWith('/api/content/') && method === 'GET') {
      const contentId = decodeURIComponent(path.slice('/api/content/'.length)).split('?')[0].slice(0, 64);
      if (!contentId) return json({ error: 'Content id is required.' }, 400, cors);
      const found = await findContentById(env, contentId);
      if (!found) return json({ error: 'This content is unavailable or was deleted.' }, 404, cors);
      const viewer = await getViewer(request, env);
      const item = transformItem({ ...found.item, id: found.item.id || found.id });
      const [visible] = await filterVisibleItems(env, viewer, await filterSeed(env, [item]));
      if (!visible) return json({ error: 'This content is unavailable or was deleted.' }, 404, cors);
      return json({ data: applyViewerVoteState(visible, viewer), error: null }, 200, cors);
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
      return json({ data: visible.slice(offset, offset + limit).map((it) => applyViewerVoteState(it, viewer)), error: null }, 200, cors);
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
        await filterSeed(env, raw.map((t) => ({ ...t, ownerId: itemOwnerId(t) || t.creatorId }))),
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
      // Moments is the short-VIDEO surface. Photo-only items that were stored
      // here by legacy clients are never shown as moments (they remain visible
      // in the photo feed / profile via asPhotoItem bucketing).
      const videoOnly = visible.filter((m) => itemHasPlayableVideo(m));
      return json({ data: videoOnly.slice(0, limit), error: null }, 200, cors);
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
      const rawUserId = decodeURIComponent(path.split('/api/profile/')[1] || '');
      if (SEED_PROFILE_IDS.has(rawUserId)) {
        return json({ data: null, error: 'Profile not found' }, 404, cors);
      }
      // Resolve ids, legacy email ids, @handles, usernames and display names
      // to the canonical account id — never a duplicate/email-keyed row.
      const resolved = await resolveProfileRef(env, rawUserId);
      if (!resolved || !resolved.profile) return json({ data: null, error: 'Profile not found' }, 404, cors);
      const userId = String(resolved.id || resolved.profile.id || '');
      const parsed = { ...resolved.profile, id: userId };
      // Follower/following counters are DERIVED from the authoritative graph
      // lists, not trusted from the stored profile row. KV is eventually
      // consistent across colos and a follow can land its list write before
      // the counter write is visible, which previously showed "following 0"
      // right after following someone. Reading the lists here makes the number
      // correct on every device immediately (and repairs legacy drift).
      try {
        const [followersRaw, followingRaw] = await Promise.all([
          readIdList(env, KEYS.FOLLOWERS(userId)),
          readIdList(env, KEYS.FOLLOWING(userId)),
        ]);
        const countUnique = (list: string[]) => {
          const seen = new Set<string>();
          for (const value of list) {
            const key = String(value || '').trim().toLowerCase();
            if (key) seen.add(key);
          }
          return seen.size;
        };
        parsed.followers = countUnique(followersRaw);
        parsed.following = countUnique(followingRaw);
      } catch { /* keep stored counters as a fallback */ }
      // Email/password material is owner-only and never part of a public row.
      delete parsed.password;
      delete parsed.salt;
      const viewer = await getViewer(request, env);
      const isOwner = !!(viewer && String(viewer.id) === userId);
      parsed.isOwner = isOwner;
      if (!isOwner) {
        delete parsed.email;
        delete parsed._userEmail;
        // Private viewer-only collections (watch history, saved items, local
        // post/reaction caches) are NEVER exposed on another person's profile.
        delete parsed.posts;
        delete parsed.watchHistory;
        delete parsed.history;
        delete parsed.saved;
        delete parsed.savedPosts;
        delete parsed.savedStories;
        delete parsed.savedContent;
        delete parsed.allSavedContent;
        delete parsed.userReactedPosts;
        // Internal account bookkeeping and payment references stay private.
        delete parsed.nameChangesUsed;
        delete parsed.nameChangeQuota;
        delete parsed.nameGrantPayments;
        delete parsed.nameBonusPlans;
        delete parsed.nameLockUntil;
        delete parsed.verifiedNamePending;
        delete parsed.verifiedNameAt;
        // Legacy rows sometimes stored the account email as the display
        // name/handle. Never expose it publicly.
        parsed.name = publicDisplayName(parsed.name, parsed.username, parsed.id);
        parsed.username = publicDisplayName(parsed.username, parsed.name, parsed.id);
        if (parsed.verifiedName) parsed.verifiedName = maskEmailDisplay(parsed.verifiedName);
      }
      if (parsed && parsed.isPrivate === true) {
        const follower = isOwner ? true : viewer ? await isFollowingPair(env, viewer.id, userId) : false;
        if (!isOwner && !follower) {
          let pending = false;
          try {
            if (viewer) {
              const [reqs, viewerProfile] = await Promise.all([
                readIdList(env, KEYS.FOLLOW_REQ(userId)),
                getStoredProfile(env, viewer.id),
              ]);
              const viewerRefs = await accountRefSet(env, viewerProfile || viewer);
              pending = reqs.some((x) => viewerRefs.has(String(x).trim().toLowerCase()));
            }
          } catch { /* ignore */ }
          const safe = publicSafeProfile(parsed);
          delete safe.email;
          delete safe._userEmail;
          return json({ data: { ...safe, id: userId, followStatus: viewer ? { isFollowing: false, pending } : undefined }, error: null }, 200, cors);
        }
        if (viewer && !isOwner) {
          return json({ data: { ...parsed, id: userId, followStatus: { isFollowing: true, pending: false } }, error: null }, 200, cors);
        }
      }
      return json({ data: parsed, error: null }, 200, cors);
    }

    if (path === '/api/profile' && method === 'PUT') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      // The stored profile id is always the authenticated account id. A client
      // may send a legacy duplicate/email id for the same person (allowed,
      // folded onto the canonical row), but never another account's id.
      const requestedId = typeof body.id === 'string' ? body.id.trim() : '';
      if (requestedId && requestedId !== actor.id) {
        const requestedCanonical = await canonicalAccountId(env, requestedId);
        if (requestedCanonical !== actor.id) return json({ error: 'Forbidden' }, 403, cors);
      }
      const id = actor.id;
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'profile', actor.id, rateLimitFor(planId, 'profile'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const clean = sanitizeBody(body);
      clean.id = id;
      // The profile email is account-owned. A client can never point its row at
      // another account's email (that would alias two identities together).
      const actorEmail = String(actor.email || '').trim().toLowerCase();
      if (actorEmail) clean.email = actorEmail;
      else { delete clean.email; delete clean._userEmail; }
      delete clean._userEmail;
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
      // Follower/following counters, live status and account age are derived
      // from the real follow graph / live sessions / first save. A client can
      // never inflate them by writing them into its profile row.
      delete clean.followers;
      delete clean.following;
      delete clean.isLive;
      delete clean.createdAt;
      delete clean.isSeed;
      delete clean.isAdmin;
      delete clean.role;
      delete clean.plan;
      delete clean.planId;
      delete clean.isOwner;
      // Never persist client-side feed/history/saved arrays inside the profile
      // KV record (content has its own buckets; history & saved are owner-only).
      delete clean.posts;
      delete clean.watchHistory;
      delete clean.history;
      delete clean.saved;
      delete clean.savedPosts;
      delete clean.savedStories;
      delete clean.savedContent;
      delete clean.allSavedContent;
      delete clean.userReactedPosts;
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
      if (typeof clean.name === 'string') {
        clean.name = clean.name.slice(0, 80);
        // An email is never a public display name, even if the client sends it.
        if (isEmailLike(clean.name)) clean.name = maskEmailDisplay(clean.name);
      }
      if (typeof clean.username === 'string') {
        clean.username = clean.username.slice(0, 80);
        if (isEmailLike(clean.username)) clean.username = maskEmailDisplay(clean.username);
      }
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
      await invalidateProfileIndex(env);
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
        ownerId: e.ownerId || e.userId || e.user_id || e.authorId,
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
      // ── People search: match real user profiles (name / username / bio) ──
      // Uses the shared profile index, so duplicate rows for one account are
      // collapsed to a single canonical result (never an email-keyed row) and
      // searching any part of a name/username still finds the person.
      let matchedUsers = [];
      try {
        const ql = normalizeProfileAlias(query);
        if (ql) {
          const profiles = await buildProfileIndex(env);
          const scoredUsers = [];
          for (const p of profiles) {
            if (!p || typeof p !== 'object') continue;
            const canonicalId = String(p.canonicalId || p.id || '');
            const pid = String(p.id || '');
            if (!canonicalId || pid !== canonicalId) continue; // one row per account
            if (SEED_PROFILE_IDS.has(canonicalId) || p.isSeed === true) continue;
            if (isEmailLike(canonicalId) || p.emailKeyed) continue;
            if (/@test\.com$/i.test(String(p.email || '')) || /^pwsrc_/i.test(pid)) continue;
            // Bot display names (smoke/test accounts) never surface in people
            // search — same author signals as the content seed filter.
            if (isSeedItem(p)) continue;
            const username = String(p.username || '').toLowerCase();
            const name = String(p.name || '').toLowerCase();
            const bio = String(p.bio || '').toLowerCase();
            const aliases = Array.from(new Set([
              normalizeProfileAlias(username),
              normalizeProfileAlias(name),
              ...(Array.isArray(p.aliases) ? p.aliases : []),
            ].filter(Boolean))).filter((a) => !isEmailLike(a));
            const handles = Array.from(new Set(aliases.flatMap((a) => [a, '@' + a])));
            // An email query is never a people search.
            if (isEmailLike(ql)) continue;
            let s = 0;
            for (const alias of handles) {
              const flatAlias = alias.replace(/\s+/g, '');
              const flatQuery = ql.replace(/\s+/g, '');
              if (alias === ql || flatAlias === flatQuery) s = Math.max(s, 220);
              else if (alias.startsWith(ql)) s = Math.max(s, 170);
              else if (alias.includes(ql) || (ql.includes(alias) && alias.length >= 3)) s = Math.max(s, 130);
            }
            if (bio && bio.includes(ql)) s += 40;
            const qtoks = ql.split(/\s+/).filter((w) => w.length > 1);
            for (const tok of qtoks) {
              if (aliases.some((a) => a.includes(tok))) s += 25;
              else if (bio.includes(tok)) s += 10;
            }
            if (s > 0) {
              const isPrivate = p.isPrivate === true;
              const displayName = publicDisplayName(p.name, p.username, canonicalId);
              const displayHandle = publicDisplayName(p.username, p.name, canonicalId);
              scoredUsers.push({
                s,
                user: isPrivate
                  ? { id: canonicalId, name: displayName, username: displayHandle, avatar: p.avatar || '', bio: typeof p.bio === 'string' ? String(p.bio).slice(0, 160) : '', isPrivate: true, restricted: true, followers: Number(p.followers || 0) || 0, following: Number(p.following || 0) || 0, verified: !!p.verified }
                  : { id: canonicalId, name: displayName, username: displayHandle, avatar: cleanCommentAvatar(p.avatar || ''), bio: typeof p.bio === 'string' ? String(p.bio).slice(0, 160) : '', isPrivate: false, followers: Number(p.followers || 0) || 0, following: Number(p.following || 0) || 0, verified: !!p.verified },
              });
            }
          }
          scoredUsers.sort((a, b) => b.s - a.s || String(a.user.id).localeCompare(String(b.user.id)));
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
      const momentPhotoFallback = moments
        .filter((m) => !itemHasPlayableVideo(m))
        .map((m) => ({ ...asPhotoItem(m), kind: 'post' }));
      const norm = await filterVisibleItems(env, viewerForFeed, [
        ...posts.map((p) => ({ kind: 'post', ...p })),
        ...momentPhotoFallback,
        ...thoughts.map((t) => ({ ...t, kind: 'thought', id: t.id, content: t.content, user: t.user || t.user_id, ownerId: itemOwnerId(t) || t.creatorId, visibility: t.visibility, createdAt: t.createdAt || t.created_at, likes: t.likes ?? t.likes_count, comments: t.comments ?? t.comments_count, tags: t.tags || [], category: 'Thoughts' })),
        ...moments.filter((m) => itemHasPlayableVideo(m)).map((m) => ({ kind: 'moment', ...m })),
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

    // LIKES / REACTIONS — the real engagement write path.
    // Every like is persisted on the item (counter + likedBy ledger) and the
    // content OWNER gets a notification. Previously likes only changed local
    // React state, so the owner never heard about them and every device showed
    // a different count.
    if ((path === '/api/likes' || path === '/api/react') && method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const clean = sanitizeBody(body || {});
      const itemId = String(clean.itemId || clean.item_id || clean.contentId || clean.postId || clean.id || '').slice(0, 64);
      if (!itemId) return json({ error: 'itemId required' }, 400, cors);
      const rl = await rateLimit(kv, 'likes', actor.id, 120);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const found = await findContentById(env, itemId);
      if (!found) return json({ error: 'Content not found' }, 404, cors);
      const viewer = { id: actor.id, email: actor.email };
      if (!(await canViewerSeeItem(env, viewer, transformItem(found.item)))) {
        return json({ error: 'Content not found' }, 404, cors);
      }
      const isReact = path === '/api/react' || String(clean.kind || '').toLowerCase() === 'react';
      const counterKey = isReact ? 'reacts' : 'likes';
      const ledgerKey = isReact ? 'reactedBy' : 'likedBy';
      const action = String(clean.action || 'toggle').toLowerCase();
      const item = { ...found.item };
      const existing = Array.isArray(item[ledgerKey]) ? item[ledgerKey].map((x: unknown) => String(x).toLowerCase()) : [];
      const actorRefs = new Set([String(actor.id).toLowerCase()]);
      if (actor.email) actorRefs.add(String(actor.email).toLowerCase());
      if (actor.username) actorRefs.add(String(actor.username).replace(/^@/, '').toLowerCase());
      const had = existing.some((x: string) => actorRefs.has(x));
      const wantLiked = action === 'unlike' || action === 'unreact' ? false : action === 'like' || action === 'react' ? true : !had;
      let nextLedger = existing.filter((x: string) => !actorRefs.has(x));
      if (wantLiked) nextLedger = [String(actor.id).toLowerCase(), ...nextLedger];
      nextLedger = [...new Set(nextLedger)].slice(0, 5000);
      const storedCount = Number(item[counterKey] ?? item[counterKey + '_count'] ?? 0) || 0;
      const nextCount = Math.max(0, wantLiked
        ? (had ? storedCount : storedCount + 1)
        : (had ? storedCount - 1 : storedCount));
      item[ledgerKey] = nextLedger;
      item[counterKey] = nextCount;
      if (counterKey === 'likes' && 'likes_count' in item) item.likes_count = nextCount;
      if (counterKey === 'reacts' && 'reacts_count' in item) item.reacts_count = nextCount;
      try {
        await kv.put(found.getKey(itemId), JSON.stringify(item));
      } catch {
        return json({ error: 'Could not save your like. Please try again.' }, 500, cors);
      }
      // Popularity / interest signals stay best-effort.
      try {
        void aiBumpPop(env, itemId, wantLiked ? 3 : -1);
        void aiRecordEngagement(env, actor.id, {
          category: String(item.category || ''),
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 10) : [],
          creator: String(item.user || item.creator || ''),
          action: wantLiked ? 'like' : 'unlike',
        });
      } catch { /* never block */ }
      // Notify the owner exactly once per actor+item even if they toggle.
      if (wantLiked && !had) {
        try {
          const ownerId = await canonicalOwnerId(env, itemOwnerId(item));
          if (ownerId && ownerId.toLowerCase() !== String(actor.id).toLowerCase()) {
            let already = false;
            const noteKey = 'like:notified:' + actor.id.toLowerCase() + ':' + itemId;
            try { already = !!(await kv.get(noteKey)); } catch { already = false; }
            if (!already) {
              const me = (await getStoredProfile(env, actor.id)) || actor;
              const name = publicDisplayName(me.username, me.name, actor.username, actor.email?.split('@')[0], 'Someone');
              const snippet = String(item.content || item.title || item.description || '').trim().slice(0, 80);
              const what = isReact ? 'reacted to' : 'liked';
              await pushUserNotification(env, ownerId, {
                kind: isReact ? 'reaction' : 'like',
                title: name + ' ' + what + ' your post',
                body: snippet || 'Tap to see who liked your content.',
                actorId: actor.id,
                actorName: name,
                contentId: itemId,
                link: '/app/home?post=' + encodeURIComponent(itemId),
              });
              try { await kv.put(noteKey, '1', { expirationTtl: 60 * 60 * 24 }); } catch { /* best-effort */ }
            }
          }
        } catch { /* notifications never block the like */ }
      }
      return json({ data: { id: itemId, likes: nextCount, reacts: Number(item.reacts || 0) || 0, hasLiked: wantLiked }, error: null }, 200, cors);
    }

    // VIEWS — persistence for the Eye badge shown on every public content row.
    // Exactly like likes/shares/follow: one view PER ACCOUNT, kept on a
    // `viewedBy` ledger on the item. Re-opening never double-counts (the
    // ledger gate itself makes this idempotent — no rate counter needed, the
    // only possible write is the first open by an account, ever).
    // Privacy: invisible content 404s, and filterVisibleItems strips `views`
    // from rows that are not effectively public (private accounts /
    // followers-only) for non-owner viewers, so the badge never leaks.
    if (path === '/api/views' && method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      const actor = await getActor(request, env, body);
      const clean = sanitizeBody(body || {});
      const itemId = String(clean.itemId || clean.item_id || clean.contentId || clean.content_id || clean.postId || clean.id || '').slice(0, 64);
      if (!itemId) return json({ error: 'itemId required' }, 400, cors);
      const found = await findContentById(env, itemId);
      if (!found) return json({ error: 'Content not found' }, 404, cors);
      const viewer = actor ? { id: actor.id, email: actor.email, username: actor.username } : null;
      if (!(await canViewerSeeItem(env, viewer, transformItem(found.item)))) {
        return json({ error: 'Content not found' }, 404, cors);
      }
      const item = { ...found.item };
      // Anonymous opens are not counted (views count accounts, like likes do).
      if (!actor) {
        return json({ data: { id: itemId, views: Number(item.views ?? item.views_count ?? 0) || 0, counted: false }, error: null }, 200, cors);
      }
      const refs = new Set([String(actor.id).toLowerCase()]);
      if (actor.email) refs.add(String(actor.email).toLowerCase());
      if (actor.username) refs.add(String(actor.username).replace(/^@/, '').toLowerCase());
      const ledger = Array.isArray(item.viewedBy) ? item.viewedBy.map((x: unknown) => String(x).toLowerCase()) : [];
      const had = ledger.some((x: string) => refs.has(x));
      if (had) {
        // Already counted for this account — fetch path stays read-only.
        return json({ data: { id: itemId, views: Number(item.views ?? item.views_count ?? 0) || 0, counted: false }, error: null }, 200, cors);
      }
      const stored = Number(item.views ?? item.views_count ?? 0) || 0;
      const nextViews = Math.min(99_999_999, Math.max(0, stored) + 1);
      item.viewedBy = [...new Set([String(actor.id).toLowerCase(), ...ledger])].slice(0, 5000);
      item.views = String(nextViews);
      if ('views_count' in item) item.views_count = nextViews;
      try {
        await kv.put(found.getKey(itemId), JSON.stringify(item));
      } catch {
        return json({ error: 'Could not record the view. Please try again.' }, 500, cors);
      }
      // Keep the search index row in sync with the real counter (best-effort,
      // same pattern the comment counter uses).
      try {
        const idxJson = await kv.get(KEYS.CONTENT_INDEX);
        if (idxJson) {
          const idx = JSON.parse(idxJson);
          const ix = idx.findIndex((i: any) => i && i.id === itemId);
          if (ix >= 0) {
            idx[ix] = { ...idx[ix], views: String(nextViews) };
            await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.slice(0, 1000)));
          }
        }
      } catch { /* ignore */ }
      // A real open is the strongest popularity signal there is (best-effort).
      try { void aiBumpPop(env, itemId, 1); } catch { /* never block */ }
      return json({ data: { id: itemId, views: nextViews, counted: true }, error: null }, 200, cors);
    }

    // VOTES — real upvote/downvote persistence for thoughts. Previously the
    // client faked this with random numbers, so counts reset on every reload
    // and the owner never saw votes. One ledger per direction per item; a
    // vote switch adjusts both counters without double-counting.
    if (path === '/api/votes' && method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const clean = sanitizeBody(body || {});
      const itemId = String(clean.itemId || clean.item_id || clean.thoughtId || clean.thought_id || clean.contentId || clean.id || '').slice(0, 64);
      if (!itemId) return json({ error: 'itemId required' }, 400, cors);
      const rl = await rateLimit(kv, 'votes', actor.id, 120);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const found = await findContentById(env, itemId);
      if (!found) return json({ error: 'Content not found' }, 404, cors);
      const viewer = { id: actor.id, email: actor.email };
      if (!(await canViewerSeeItem(env, viewer, transformItem(found.item)))) {
        return json({ error: 'Content not found' }, 404, cors);
      }
      const rawVote = String(clean.voteType || clean.vote_type || clean.vote || clean.action || 'toggle').toLowerCase();
      const actorRefs = new Set([String(actor.id).toLowerCase()]);
      if (actor.email) actorRefs.add(String(actor.email).toLowerCase());
      if (actor.username) actorRefs.add(String(actor.username).replace(/^@/, '').toLowerCase());
      const item = { ...found.item };
      const up = Array.isArray(item.upvotedBy) ? item.upvotedBy.map((x) => String(x).toLowerCase()) : [];
      const down = Array.isArray(item.downvotedBy) ? item.downvotedBy.map((x) => String(x).toLowerCase()) : [];
      const hadUp = up.some((x) => actorRefs.has(x));
      const hadDown = down.some((x) => actorRefs.has(x));
      // "toggle" removes an existing vote; a new vote replaces the opposite.
      const desired = rawVote === 'toggle'
        ? (hadUp ? 'none' : 'upvote')
        : ['upvote', 'up', 'downvote', 'down', 'none', 'remove'].includes(rawVote)
          ? (rawVote.startsWith('up') ? 'upvote' : rawVote.startsWith('down') ? 'downvote' : 'none')
          : 'none';
      let nextUp = up.filter((x) => !actorRefs.has(x));
      let nextDown = down.filter((x) => !actorRefs.has(x));
      if (desired === 'upvote') nextUp = [String(actor.id).toLowerCase(), ...nextUp];
      if (desired === 'downvote') nextDown = [String(actor.id).toLowerCase(), ...nextDown];
      nextUp = [...new Set(nextUp)].slice(0, 5000);
      nextDown = [...new Set(nextDown)].slice(0, 5000);
      const storedUp = Number(item.upvotes_count ?? item.upvotes ?? 0) || 0;
      const storedDown = Number(item.downvotes_count ?? item.downvotes ?? 0) || 0;
      const upCount = Math.max(0, storedUp + (desired === 'upvote' && !hadUp ? 1 : desired !== 'upvote' && hadUp ? -1 : 0));
      const downCount = Math.max(0, storedDown + (desired === 'downvote' && !hadDown ? 1 : desired !== 'downvote' && hadDown ? -1 : 0));
      item.upvotedBy = nextUp;
      item.downvotedBy = nextDown;
      item.upvotes_count = upCount;
      item.downvotes_count = downCount;
      if ('upvotes' in item) item.upvotes = upCount;
      if ('downvotes' in item) item.downvotes = downCount;
      try {
        await kv.put(found.getKey(itemId), JSON.stringify(item));
      } catch {
        return json({ error: 'Could not save your vote. Please try again.' }, 500, cors);
      }
      try {
        void aiRecordEngagement(env, actor.id, {
          category: String(item.category || ''),
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 10) : [],
          creator: String(item.user || item.creator || ''),
          action: 'vote',
        });
      } catch { /* never block */ }
      return json({ data: {
        id: itemId,
        upvotes: upCount,
        downvotes: downCount,
        upvotes_count: upCount,
        downvotes_count: downCount,
        user_vote: desired === 'upvote' ? 'upvote' : desired === 'downvote' ? 'downvote' : null,
      }, error: null }, 200, cors);
    }

    // SHARES — increment the post's share counter. Sharing used to update only
    // local state, so the count reset on reload and never moved for anyone
    // else. The share sheet itself is still device-native (client-side).
    if (path === '/api/shares' && method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      const actor = await getActor(request, env, body);
      if (!actor || !actor.id) return json({ error: 'Sign in to share content' }, 401, cors);
      const clean = sanitizeBody(body || {});
      const itemId = String(clean.itemId || clean.item_id || clean.contentId || clean.postId || clean.id || '').slice(0, 64);
      if (!itemId) return json({ error: 'itemId required' }, 400, cors);
      const rl = await rateLimit(kv, 'shares', actor.id, 120);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const releaseShareLock = await acquireShareMutationLock(`${String(actor.id).toLowerCase()}:${itemId}`);
      try {
      const found = await findContentById(env, itemId);
      if (!found) return json({ data: { id: itemId, shares: 0, offline: true }, error: null }, 200, cors);
      const viewer = { id: actor.id, email: actor.email };
      if (!(await canViewerSeeItem(env, viewer, transformItem(found.item)))) {
        return json({ error: 'Content not found' }, 404, cors);
      }
      const item = { ...found.item };
      // One share per account per item: repeat shares by the same account must
      // never inflate the counter (one person could otherwise push a post's
      // share number to infinity by tapping the button). A ledger mirrors the
      // like/vote ledgers; the FIRST share increments, repeats are no-ops.
      const sharedBy = Array.isArray(item.sharedBy) ? item.sharedBy.map((x: unknown) => String(x).toLowerCase()) : [];
      const actorRefs = new Set([String(actor.id).toLowerCase()]);
      if (actor.email) actorRefs.add(String(actor.email).toLowerCase());
      if (actor.username) actorRefs.add(String(actor.username).replace(/^@/, '').toLowerCase());
      const alreadyShared = sharedBy.some((x: string) => actorRefs.has(x));
      const current = Number(item.shares ?? item.shares_count ?? 0) || 0;
      const next = alreadyShared ? current : Math.min(5000, current + 1);
      if (!alreadyShared) {
        item.sharedBy = [...new Set([String(actor.id).toLowerCase(), ...sharedBy])].slice(0, 5000);
        item.shares = next;
        if ('shares_count' in item) item.shares_count = next;
      }
      try {
        await kv.put(found.getKey(itemId), JSON.stringify(item));
      } catch {
        return json({ error: 'Could not save your share. Please try again.' }, 500, cors);
      }
      try {
        void aiBumpPop(env, itemId, alreadyShared ? 0 : 2);
        void aiRecordEngagement(env, actor.id, {
          category: String(item.category || ''),
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 10) : [],
          creator: String(item.user || item.creator || ''),
          action: 'share',
        });
      } catch { /* never block */ }
      return json({ data: { id: itemId, shares: next, shares_count: next, alreadyShared }, error: null }, 200, cors);
      } finally {
        releaseShareLock();
      }
    }

    // GET /api/likes?itemId= — authoritative like state for the viewer.
    if ((path === '/api/likes' || path === '/api/react') && method === 'GET') {
      const itemId = String(url.searchParams.get('itemId') || url.searchParams.get('contentId') || '').slice(0, 64);
      if (!itemId) return json({ error: 'itemId required' }, 400, cors);
      const isReact = path === '/api/react';
      const found = await findContentById(env, itemId);
      if (!found) return json({ data: null, error: 'Content not found' }, 404, cors);
      const viewer = await getViewer(request, env);
      const item = found.item;
      const ledger = Array.isArray(item[isReact ? 'reactedBy' : 'likedBy'])
        ? item[isReact ? 'reactedBy' : 'likedBy'].map((x: unknown) => String(x).toLowerCase())
        : [];
      const refs = viewer ? new Set([String(viewer.id).toLowerCase()]) : new Set<string>();
      if (viewer?.email) refs.add(String(viewer.email).toLowerCase());
      return json({
        data: {
          id: itemId,
          likes: Number(item.likes ?? item.likes_count ?? 0) || 0,
          reacts: Number(item.reacts ?? item.reacts_count ?? 0) || 0,
          hasLiked: [...refs].some((x) => ledger.includes(x)),
        },
        error: null,
      }, 200, cors);
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
      const rawTarget = String(clean.target || clean.userId || '').slice(0, 200);
      const target = await canonicalTargetId(env, rawTarget);
      if (!target || target === actor.id) return json({ error: 'Invalid target' }, 400, cors);
      const rl = await rateLimit(kv, 'engagement', actor.id, 60);
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);
      const actorProfile = (await getStoredProfile(env, actor.id)) || {
        id: actor.id, email: actor.email, username: actor.username,
      };
      const [targetProfile, rawFollowing] = await Promise.all([
        getStoredProfile(env, target),
        readIdList(env, KEYS.FOLLOWING(actor.id)),
      ]);
      // Fold any legacy duplicate/email refs onto canonical ids before
      // deciding whether this relationship already exists.
      const normFollowing = await normalizeRefList(
        env, rawFollowing, targetProfile || { id: target }, target,
      );
      if (normFollowing.changed) {
        await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(normFollowing.ids.slice(0, 5000)));
      }
      const alreadyFollowing = normFollowing.had;
      if (targetProfile && targetProfile.isPrivate === true && !alreadyFollowing) {
        const rawReqs = await readIdList(env, KEYS.FOLLOW_REQ(target));
        const normReqs = await normalizeRefList(env, rawReqs, actorProfile, actor.id);
        const reqs = normReqs.ids;
        if (!normReqs.had) reqs.unshift(actor.id);
        if (!normReqs.had || normReqs.changed) {
          await kv.put(KEYS.FOLLOW_REQ(target), JSON.stringify(reqs.slice(0, 1000)));
        }
        return json({ data: { isFollowing: false, pending: true, isPrivate: true }, error: null }, 200, cors);
      }
      const rawFollowers = await readIdList(env, KEYS.FOLLOWERS(target));
      const normFollowers = await normalizeRefList(
        env, rawFollowers, actorProfile, actor.id,
      );
      const following = normFollowing.ids;
      const followers = normFollowers.ids;
      let addedFollowing = false;
      let addedFollower = false;
      if (!alreadyFollowing) {
        following.unshift(target);
        addedFollowing = true;
      }
      if (!normFollowers.had) {
        followers.unshift(actor.id);
        addedFollower = true;
      }
      if (addedFollowing || normFollowing.changed) {
        await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(following.slice(0, 5000)));
      }
      if (addedFollower || normFollowers.changed) {
        await kv.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.slice(0, 50000)));
      }
      // Counters are derived from the authoritative list lengths (not blind
      // increments) so duplicate/legacy refs and retried requests can never
      // drift them. Each side reflects its own list.
      if (addedFollowing || normFollowing.changed) {
        try {
          const ap = (await getStoredProfile(env, actor.id)) || actorProfile;
          ap.following = Math.min(following.length, 5000);
          await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(ap));
        } catch { /* best-effort */ }
      }
      if (addedFollower || normFollowers.changed) {
        try {
          const tp = (await getStoredProfile(env, target)) || targetProfile;
          if (tp) {
            tp.followers = Math.min(followers.length, 50000);
            await kv.put(KEYS.PROFILE(target), JSON.stringify(tp));
          }
        } catch { /* best-effort */ }
      }
      return json({ data: { isFollowing: true, pending: false }, error: null }, 200, cors);
    }

    // DELETE /api/follow/:target — unfollow (also withdraws pending requests).
    if (path.match(/^\/api\/follow\//) && method === 'DELETE' && !path.startsWith('/api/follow/requests')) {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const rawTarget = decodeURIComponent(path.split('/api/follow/')[1] || '').split('?')[0];
      const target = await canonicalTargetId(env, rawTarget);
      if (!target) return json({ error: 'Invalid target' }, 400, cors);
      const actorProfile = (await getStoredProfile(env, actor.id)) || {
        id: actor.id, email: actor.email, username: actor.username,
      };
      const targetProfile = await getStoredProfile(env, target);
      const [following, followers, reqs] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING(actor.id)),
        readIdList(env, KEYS.FOLLOWERS(target)),
        readIdList(env, KEYS.FOLLOW_REQ(target)),
      ]);
      const actorRefs = await accountRefSet(env, actorProfile);
      const targetRefs = await accountRefSet(env, targetProfile || { id: target });
      const has = (list, refs) => list.some((x) => refs.has(String(x).trim().toLowerCase()));
      const wasFollowing = has(following, targetRefs);
      const wasFollower = has(followers, actorRefs);
      const hadRequest = has(reqs, actorRefs);
      const nextFollowing = following.filter((x) => !targetRefs.has(String(x).trim().toLowerCase()));
      const nextFollowers = followers.filter((x) => !actorRefs.has(String(x).trim().toLowerCase()));
      await kv.put(KEYS.FOLLOWING(actor.id), JSON.stringify(nextFollowing));
      await kv.put(KEYS.FOLLOWERS(target), JSON.stringify(nextFollowers));
      if (hadRequest) {
        await kv.put(KEYS.FOLLOW_REQ(target), JSON.stringify(
          reqs.filter((x) => !actorRefs.has(String(x).trim().toLowerCase())),
        ));
      }
      // Derive counters from the authoritative list lengths so retries and
      // legacy refs can never leave them drifting.
      if (wasFollowing) {
        try {
          const ap = (await getStoredProfile(env, actor.id)) || actorProfile;
          ap.following = nextFollowing.length;
          await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(ap));
        } catch { /* best-effort */ }
      }
      if (wasFollower) {
        try {
          const tp = (await getStoredProfile(env, target)) || targetProfile;
          if (tp) { tp.followers = nextFollowers.length; await kv.put(KEYS.PROFILE(target), JSON.stringify(tp)); }
        } catch { /* best-effort */ }
      }
      return json({ data: { isFollowing: false, pending: false }, error: null }, 200, cors);
    }

    // GET /api/follow/status?target= — { isFollowing, pending } for the caller.
    if (path === '/api/follow/status' && method === 'GET') {
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const rawTarget = String(url.searchParams.get('target') || '').slice(0, 200);
      if (!rawTarget) return json({ error: 'target required' }, 400, cors);
      const resolved = await resolveProfileRef(env, rawTarget);
      const target = resolved?.id ? String(resolved.id) : await canonicalTargetId(env, rawTarget);
      const targetProfile = resolved?.profile || (await getStoredProfile(env, target));
      const actorProfile = (await getStoredProfile(env, actor.id)) || {
        id: actor.id, email: actor.email, username: actor.username,
      };
      // A follow list may still contain an old alias/duplicate id for the same
      // account, so match any ref that belongs to the resolved profile.
      const [targetRefs, actorRefs] = await Promise.all([
        accountRefSet(env, targetProfile || { id: target }),
        accountRefSet(env, actorProfile),
      ]);
      const following = await readIdList(env, KEYS.FOLLOWING(actor.id));
      const isFollowing = following.some((x) => targetRefs.has(String(x).trim().toLowerCase()));
      let pending = false;
      if (!isFollowing) {
        const reqs = await readIdList(env, KEYS.FOLLOW_REQ(target));
        pending = reqs.some((x) => actorRefs.has(String(x).trim().toLowerCase()));
      }
      return json({ data: { isFollowing, pending }, error: null }, 200, cors);
    }

    // GET /api/followers/:userId and GET /api/following/:userId — counts and
    // id lists. Private accounts expose these only to owners/followers.
    if ((path.match(/^\/api\/followers\//) || path.match(/^\/api\/following\//)) && method === 'GET') {
      const isFollowers = path.startsWith('/api/followers/');
      const rawUserId = decodeURIComponent((isFollowers ? path.split('/api/followers/')[1] : path.split('/api/following/')[1] || '').split('?')[0]);
      // Accept @handle / display-name / legacy-email links and always read the
      // canonical account's graph.
      const userId = await canonicalTargetId(env, rawUserId);
      const viewer = await getViewer(request, env);
      const target = await getStoredProfile(env, userId);
      const ids = await canonicalizeIdList(
        env, await readIdList(env, isFollowers ? KEYS.FOLLOWERS(userId) : KEYS.FOLLOWING(userId)),
      );
      if (target && target.isPrivate === true) {
        const isOwner = !!(viewer && viewer.id === userId);
        const ok = isOwner || (viewer ? await isFollowingPair(env, viewer.id, userId) : false);
        if (!ok) {
          return json({ data: { count: ids.length, ids: [], restricted: true }, error: null }, 200, cors);
        }
      }
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
      const reqs = await canonicalizeIdList(env, await readIdList(env, KEYS.FOLLOW_REQ(actor.id)));
      return json({ data: { requests: reqs }, error: null }, 200, cors);
    }

    if ((path === '/api/follow/accept' || path === '/api/follow/decline') && method === 'POST') {
      const body = await readJson(request);
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const clean = sanitizeBody(body);
      const rawRequester = String(clean.requester || clean.userId || '').slice(0, 200);
      const requester = await canonicalTargetId(env, rawRequester);
      if (!requester) return json({ error: 'requester required' }, 400, cors);
      const actorProfile = (await getStoredProfile(env, actor.id)) || {
        id: actor.id, email: actor.email, username: actor.username,
      };
      const requesterProfile = await getStoredProfile(env, requester);
      const reqs = await readIdList(env, KEYS.FOLLOW_REQ(actor.id));
      const requesterRefs = await accountRefSet(env, requesterProfile || { id: requester });
      const pending = reqs.some((x) => requesterRefs.has(String(x).trim().toLowerCase()));
      if (!pending) return json({ error: 'No pending request from this account.' }, 404, cors);
      // Remove every legacy ref of the requester, not just the canonical id.
      await kv.put(KEYS.FOLLOW_REQ(actor.id), JSON.stringify(
        reqs.filter((x) => !requesterRefs.has(String(x).trim().toLowerCase())),
      ));
      if (path === '/api/follow/accept') {
        const [rawFollowing, rawFollowers] = await Promise.all([
          readIdList(env, KEYS.FOLLOWING(requester)),
          readIdList(env, KEYS.FOLLOWERS(actor.id)),
        ]);
        const normFollowing = await normalizeRefList(
          env, rawFollowing, actorProfile, actor.id,
        );
        const normFollowers = await normalizeRefList(
          env, rawFollowers, requesterProfile || { id: requester }, requester,
        );
        const following = normFollowing.ids;
        const followers = normFollowers.ids;
        let addedFollowing = false;
        let addedFollower = false;
        if (!normFollowing.had) {
          following.unshift(actor.id);
          addedFollowing = true;
        }
        if (!normFollowers.had) {
          followers.unshift(requester);
          addedFollower = true;
        }
        if (addedFollowing || normFollowing.changed) {
          await kv.put(KEYS.FOLLOWING(requester), JSON.stringify(following.slice(0, 5000)));
        }
        if (addedFollower || normFollowers.changed) {
          await kv.put(KEYS.FOLLOWERS(actor.id), JSON.stringify(followers.slice(0, 50000)));
        }
        // Counters reflect the authoritative list lengths on each side.
        if (addedFollowing || normFollowing.changed) {
          try {
            const rp = (await getStoredProfile(env, requester)) || requesterProfile;
            if (rp) { rp.following = Math.min(following.length, 5000); await kv.put(KEYS.PROFILE(requester), JSON.stringify(rp)); }
          } catch { /* best-effort */ }
        }
        if (addedFollower || normFollowers.changed) {
          try {
            const ap = (await getStoredProfile(env, actor.id)) || actorProfile;
            ap.followers = Math.min(followers.length, 50000);
            await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(ap));
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
      if (!(await ownsAccount(env, parsed, actor))) return json({ error: 'Only the account that posted this can edit it.' }, 403, cors);
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
      if (kind === 'profile') {
        const profileTarget = await canonicalAccountId(env, id);
        if (profileTarget && profileTarget === actor.id) return json({ data: { ok: true }, error: null }, 200, cors);
      }
      const getKey = kind === 'post' ? KEYS.POST : kind === 'thought' ? KEYS.THOUGHT : kind === 'story' ? KEYS.STORY : kind === 'moment' ? KEYS.MOMENT : null;
      let parsed = {};
      if (getKey) {
        const raw = await kv.get(getKey(id));
        if (!raw) return json({ data: { ok: true }, error: null }, 200, cors);
        try { parsed = JSON.parse(raw); } catch { return json({ data: { ok: true }, error: null }, 200, cors); }
        if (await ownsAccount(env, parsed, actor)) return json({ data: { ok: true }, error: null }, 200, cors);
      }
      // Owners cannot report their own content into removal; they can delete it.
      if (await ownsAccount(env, parsed, actor)) return json({ data: { ok: true }, error: null }, 200, cors);
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
      const rawUserId = decodeURIComponent(path.split('/api/user/')[1].replace('/data', '')).split('?')[0];
      const actor = await getActor(request, env);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      // Legacy clients may call this with a duplicate/email id. Always delete
      // the canonical account's data, and never another account's.
      const userId = await canonicalAccountId(env, rawUserId);
      if (!userId || userId !== actor.id) return json({ error: 'Forbidden' }, 403, cors);
      const { planId } = await resolvePlan(env, actor, bearerFrom(request));
      const rl = await rateLimit(kv, 'delete', actor.id, rateLimitFor(planId, 'delete'));
      if (!rl.ok) return json({ error: 'Too many requests', retryAfter: 60 }, 429, cors);

      const accountProfile = (await getStoredProfile(env, userId)) || {
        id: userId, email: actor.email, username: actor.username,
      };
      const { ids: accountIds, refs } = await refsForAccount(env, accountProfile);
      refs.add(String(userId).toLowerCase());
      refs.add(String(rawUserId || '').toLowerCase());
      if (actor.email) refs.add(String(actor.email).toLowerCase());
      if (actor.username) refs.add(normalizeProfileAlias(actor.username));

      let deletedPosts = 0, deletedThoughts = 0, deletedStories = 0, deletedMoments = 0;
      // Index rows carry the display name (not user id) as creator — track
      // deleted item ids so their index rows are purged explicitly too.
      const deletedIds = new Set();

      // Content-index snapshot: it records authorId for every item, so account
      // deletion also catches content whose collection list is momentarily
      // stale (KV eventual consistency let an immediately-created post survive
      // deletion and stay publicly readable). Never trust one list alone.
      let contentIndex: any[] = [];
      try {
        const idxJson = await kv.get(KEYS.CONTENT_INDEX);
        const parsed = idxJson ? JSON.parse(idxJson) : [];
        contentIndex = Array.isArray(parsed) ? parsed : [];
      } catch { contentIndex = []; }

      const filterList = async (listKey, getKey, delKey, indexType) => {
        let ids: string[] = [];
        try {
          const listJson = await kv.get(listKey);
          const parsed = listJson ? JSON.parse(listJson) : [];
          ids = Array.isArray(parsed) ? parsed.map(String) : [];
        } catch { ids = []; }
        const listed = new Set(ids);
        const extraIds = contentIndex
          .filter((i) => i && String(i.type || '') === indexType &&
            (refs.has(String(i.authorId || '').toLowerCase()) ||
             refs.has(String(i.creator || '').toLowerCase())))
          .map((i) => String(i.id || ''))
          .filter((id) => id && !listed.has(id));
        const remaining = [];
        let deleted = 0;
        for (const id of [...listed, ...extraIds]) {
          let item = null;
          try { item = await kv.get(getKey(id)); } catch { item = null; }
          if (!item) continue;
          let parsed = null;
          try { parsed = JSON.parse(item); } catch { parsed = null; }
          if (parsed && itemBelongsToAccount(parsed, refs)) {
            await purgeStoredMedia(env, parsed);
            try {
              const { bytes } = await resolveStoredMedia(env, parsed);
              if (bytes > 0) await subtractUsage(env, userId, bytes);
            } catch { /* ignore */ }
            await kv.delete(delKey(id));
            deletedIds.add(id);
            deleted++;
          } else if (listed.has(id)) {
            remaining.push(id);
          }
        }
        await kv.put(listKey, JSON.stringify(remaining));
        return deleted;
      };

      // Delete every profile row that belongs to the account (canonical +
      // duplicate/email-keyed legacy rows).
      await Promise.all([...new Set([...accountIds, userId, rawUserId])].filter(Boolean).map(
        (pid) => kv.delete(KEYS.PROFILE(String(pid))).catch(() => {}),
      ));

      // Delete all user content
      deletedPosts = await filterList(KEYS.POSTS, KEYS.POST, KEYS.POST, 'post');
      deletedThoughts = await filterList(KEYS.THOUGHTS, KEYS.THOUGHT, KEYS.THOUGHT, 'thought');
      deletedStories = await filterList(KEYS.STORIES, KEYS.STORY, KEYS.STORY, 'story');
      deletedMoments = await filterList(KEYS.MOMENTS, KEYS.MOMENT, KEYS.MOMENT, 'moment');

      // Remove from content index (by deleted item id AND creator match).
      await kv.put(KEYS.CONTENT_INDEX, JSON.stringify(
        contentIndex.filter((i) => i && !deletedIds.has(String(i.id)) && !refs.has(String(i.creator || '').toLowerCase())
          && !accountIds.some((pid) => i.id === `profile-${pid}`)
          && i.id !== `profile-${userId}`)
      ));
      // Drop interest graph + popularity crumbs for deleted items.
      try {
        await kv.delete(KEYS.INTERESTS(userId));
        await Promise.all([...deletedIds].slice(0, 100).map((id) => kv.delete(KEYS.POP(id)).catch(() => {})));
      } catch { /* best-effort */ }

      // Comments this account left on OTHER accounts' posts are not reachable
      // from its own content lists. The per-author ledger makes them findable,
      // so they are physically purged (not merely tombstoned at read time) and
      // the host posts' counters are recomputed.
      let deletedComments = 0;
      try {
        const authorRefs = [...new Set([...accountIds, userId].map((x) => String(x || '').toLowerCase()).filter(Boolean))];
        const touchedContent = new Map<string, Set<string>>();
        for (const ref of authorRefs) {
          const ledgerKey = KEYS.USER_COMMENTS(ref);
          let cids: string[] = [];
          try {
            const rawLedger = await kv.get(ledgerKey);
            const parsed = rawLedger ? JSON.parse(rawLedger) : [];
            cids = Array.isArray(parsed) ? parsed.map(String) : [];
          } catch { cids = []; }
          for (const cid of cids.slice(0, 500)) {
            let c: any = null;
            try {
              const craw = await kv.get(KEYS.COMMENT(cid));
              c = craw ? JSON.parse(craw) : null;
            } catch { c = null; }
            if (!c) continue;
            const parentId = c.parentId ? String(c.parentId) : '';
            try { await kv.delete(KEYS.COMMENT(cid)); } catch { /* ignore */ }
            deletedComments++;
            const contentKey = String(c.contentId || '');
            if (contentKey) {
              if (!touchedContent.has(contentKey)) touchedContent.set(contentKey, new Set());
              touchedContent.get(contentKey)!.add(String(cid));
            }
            if (parentId) {
              try {
                const rraw = await kv.get(KEYS.COMMENT(parentId));
                if (rraw) {
                  const root = JSON.parse(rraw);
                  root.repliesCount = Math.max(0, Number(root.repliesCount || 1) - 1);
                  await kv.put(KEYS.COMMENT(parentId), JSON.stringify(root));
                }
              } catch { /* ignore */ }
            }
          }
          try { await kv.delete(ledgerKey); } catch { /* ignore */ }
        }
        for (const [contentKey, removed] of touchedContent) {
          const remaining = (await readCommentList(env, contentKey)).filter((x) => !removed.has(String(x)));
          await writeCommentList(env, contentKey, remaining);
          const refound = await findContentById(env, contentKey);
          if (refound) await syncContentCommentCount(env, refound, remaining.length);
        }
      } catch { /* best-effort */ }

      // Account-level cleanup: credentials, live sessions, privacy graph,
      // notifications, quota/creator records. Without this the "deleted"
      // account could still log in, its old session token stayed valid, and
      // notifications/usage lingered forever.
      const emails = new Set<string>();
      const addEmail = (value: unknown) => {
        const email = String(value || '').trim().toLowerCase();
        if (email) emails.add(email);
      };
      addEmail(actor.email);
      addEmail(accountProfile.email);
      addEmail(profileEmailOf(accountProfile));
      try {
        for (const email of emails) {
          await kv.put('auth:blocked:' + email, JSON.stringify({ at: Date.now(), reason: 'deleted' }));
          await kv.delete('auth:user:' + email);
        }
        // Identity-level marker: comments on OTHER people's posts are not
        // reachable from this account's content lists, so reads check this
        // marker and never render a deleted account's comments.
        for (const accountId of new Set([...accountIds, userId].filter(Boolean))) {
          await kv.put('auth:blockedid:' + String(accountId).toLowerCase(), JSON.stringify({ at: Date.now(), reason: 'deleted' }));
        }
      } catch { /* best-effort */ }
      try {
        await Promise.all([
          kv.delete(KEYS.NOTIF(userId)),
          kv.delete(KEYS.FOLLOWING(userId)),
          kv.delete(KEYS.FOLLOWERS(userId)),
          kv.delete(KEYS.FOLLOW_REQ(userId)),
          kv.delete(KEYS.USAGE(userId)),
          kv.delete(KEYS.PLAN_CACHE(userId)),
          kv.delete(KEYS.CREATOR(userId)),
          kv.delete(KEYS.BIZ(userId)),
          kv.delete(KEYS.INTERESTS(userId)),
        ]);
      } catch { /* best-effort */ }
      await invalidateProfileIndex(env);

      return json({ data: { success: true, deletedPosts, deletedThoughts, deletedStories, deletedMoments, deletedComments }, error: null }, 200, cors);
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
      if (declaredBytes <= SINGLE_UPLOAD_MAX_BYTES) {
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
        size: declaredBytes, type: contentType, partSize: UPLOAD_PART_SIZE,
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
      const rawPartIndex = parseInt(url.searchParams.get('partIndex') || '', 10) || 0;
      const partIndex = clamp(rawPartIndex, 1, MAX_MULTIPART_PARTS);
      let session = null;
      try {
        const raw = await kv.get('upl:' + uploadId);
        if (raw) session = JSON.parse(raw);
      } catch { session = null; }
      if (!session || session.actorId !== actor.id) {
        return json({ error: 'Upload session not found. Restart the upload.' , code: 'UPLOAD_SESSION_GONE' }, 404, cors);
      }
      const expectedParts = Math.ceil(Number(session.size || 0) / Number(session.partSize || UPLOAD_PART_SIZE));
      if (!Number.isFinite(expectedParts) || expectedParts < 1 || rawPartIndex !== partIndex || partIndex > expectedParts) {
        return json({ error: 'Invalid upload part. Restart the upload.', code: 'UPLOAD_PART_INVALID' }, 400, cors);
      }
      let formData;
      try { formData = await request.formData(); } catch { return json({ error: 'Invalid chunk' }, 400, cors); }
      const file = formData.get('file');
      if (!file || typeof file === 'string' || file.size <= 0) return json({ error: 'Empty chunk' }, 400, cors);
      const expectedSize = partIndex === expectedParts
        ? Number(session.size || 0) - (expectedParts - 1) * Number(session.partSize || UPLOAD_PART_SIZE)
        : Number(session.partSize || UPLOAD_PART_SIZE);
      if (file.size > Number(session.partSize || UPLOAD_PART_SIZE) || (partIndex === expectedParts && file.size !== expectedSize)) {
        return json({ error: 'Invalid chunk size. Retry this part.', code: 'UPLOAD_PART_SIZE_INVALID' }, 400, cors);
      }
      // Running hash: digest every part so the final object can be identified
      // even without a whole-file buffer (CPU-safe: per-part native crypto).
      let partHash = '';
      let partBytes;
      try {
        partBytes = await file.arrayBuffer();
        partHash = await sha256Hex(partBytes);
      } catch { /* hashing is metadata only — continue */ }
      let etag = '';
      try {
        const mpu = env.EQUYVO_R2.resumeMultipartUpload(session.r2Key, session.r2UploadId);
        const part = await mpu.uploadPart(partIndex, partBytes || await file.arrayBuffer());
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
      const expectedParts = Math.ceil(Number(session.size || 0) / Number(session.partSize || UPLOAD_PART_SIZE));
      const partEntries = Object.entries(session.parts || {})
        .map(([k, v]) => ({ i: parseInt(k, 10), etag: (v && v.etag) || '', hash: (v && v.hash) || '', size: (v && v.size) || 0 }))
        .filter((p) => p.i > 0 && p.etag)
        .sort((a, b) => a.i - b.i);
      if (!Number.isFinite(expectedParts) || expectedParts < 1 || partEntries.length !== expectedParts || partEntries.some((p, index) => p.i !== index + 1)) {
        return json({ error: 'Some upload chunks are missing. Retry the missing parts.', code: 'UPLOAD_PARTS_INCOMPLETE' }, 400, cors);
      }
      if (!partEntries.length) {
        return json({ error: 'No chunks received. Please restart the upload.', code: 'UPLOAD_NO_PARTS' }, 400, cors);
      }
      const totalBytes = partEntries.reduce((n, p) => n + (Number(p.size) || 0), 0);
      if (totalBytes <= 0 || totalBytes !== Number(session.size || 0)) {
        return json({ error: 'Upload size verification failed. Retry the upload.', code: 'UPLOAD_SIZE_MISMATCH' }, 400, cors);
      }
      const { planId: livePlan } = await resolvePlan(env, actor, bearerFrom(request));
      const quota = planQuota(livePlan);
      const envCapMB = parseInt(env.MAX_UPLOAD_MB, 10) || quota.maxUploadMB;
      const maxBytes = Math.min(quota.maxUploadMB, envCapMB) * 1024 * 1024;
      if (totalBytes > maxBytes) {
        try { await env.EQUYVO_R2.resumeMultipartUpload(session.r2Key, session.r2UploadId).abortMultipartUpload(); } catch {}
        try { await kv.delete('upl:' + uploadId); } catch {}
        return json({ error: `File too large for ${quota.label}. Upgrade for higher limits.`, code: 'QUOTA_FILE_SIZE', planId: livePlan }, 413, cors);
      }
      const completeUsage = await getUsage(env, actor.id);
      if (completeUsage.bytes + totalBytes > quota.storageBytes) {
        return json({ error: `Storage quota exceeded for ${quota.label}. Delete media or upgrade.`, code: 'QUOTA_STORAGE', planId: livePlan, usage: completeUsage }, 402, cors);
      }
      if (completeUsage.monthUploads >= quota.monthlyUploads) {
        return json({ error: `Monthly upload limit reached for ${quota.label}. Upgrades reset limits.`, code: 'QUOTA_MONTHLY', planId: livePlan }, 402, cors);
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

      // The direct endpoint is intentionally small and memory-bounded. The
      // client automatically uses the resumable R2 multipart flow above for
      // anything larger, while hand-written clients get a useful instruction
      // instead of making Pages parse a multi-gigabyte multipart body.
      const requestBytes = Number(request.headers.get('content-length') || 0);
      if (requestBytes > SINGLE_UPLOAD_MAX_BYTES + 512 * 1024) {
        return json({ error: 'Large files must use the resumable upload flow.', code: 'UPLOAD_CHUNK_REQUIRED' }, 413, cors);
      }

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
      const rawUserId = decodeURIComponent(path.split('/api/users/')[1].replace('/content', ''));
      const resolved = await resolveProfileRef(env, rawUserId);
      const effectiveId = String(resolved?.id || rawUserId);
      const account = resolved?.profile || { id: effectiveId };
      const { refs } = await refsForAccount(env, account);
      refs.add(String(rawUserId || '').toLowerCase());
      const viewer = await getViewer(request, env);
      const isOwner = !!(viewer && refs.has(String(viewer.id).toLowerCase()));
      if (!isOwner) {
        const target = account;
        if (target && target.isPrivate === true) {
          const ok = viewer ? await isFollowingPair(env, viewer.id, effectiveId) : false;
          if (!ok) return json({ data: { posts: [], thoughts: [], stories: [], moments: [] }, error: null }, 200, cors);
        }
      }
      const matchOwner = (p) => itemBelongsToAccount(p, refs);
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
      const isMoment = (x) => String(x.type || '').toLowerCase() === 'moment';
      // Photos mis-filed as moments by legacy clients are returned in the
      // photo feed bucket (never the short-video surface).
      const photoMoments = visible.filter((x) => isMoment(x) && !itemHasPlayableVideo(x)).map(asPhotoItem);
      const withViewer = visible.map((x) => applyViewerVoteState(x, viewer));
      return json({ data: {
        posts: [...withViewer.filter((x) => !['thought', 'story', 'text-story', 'moment'].includes(String(x.type || '').toLowerCase())), ...photoMoments],
        thoughts: withViewer.filter((x) => String(x.type || '').toLowerCase() === 'thought'),
        stories: withViewer.filter((x) => ['story', 'text-story'].includes(String(x.type || '').toLowerCase())),
        moments: withViewer.filter((x) => isMoment(x) && itemHasPlayableVideo(x)),
      }, error: null }, 200, cors);
    }

    // USER POSTS (visibility-enforced; private accounts reveal content only
    // to themselves and their followers — everyone else gets []).
    if (path.match(/^\/api\/users\//) && path.endsWith('/posts') && method === 'GET') {
      const rawUserId = decodeURIComponent(path.split('/api/users/')[1].replace('/posts', ''));
      const resolved = await resolveProfileRef(env, rawUserId);
      const effectiveId = String(resolved?.id || rawUserId);
      const account = resolved?.profile || { id: effectiveId };
      const { refs } = await refsForAccount(env, account);
      refs.add(String(rawUserId || '').toLowerCase());
      const viewer = await getViewer(request, env);
      const isOwner = !!(viewer && refs.has(String(viewer.id).toLowerCase()));
      if (!isOwner) {
        const target = account;
        if (target && target.isPrivate === true) {
          const ok = viewer ? await isFollowingPair(env, viewer.id, effectiveId) : false;
          if (!ok) return json({ data: [], error: null }, 200, cors);
        }
      }
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      const posts = (await Promise.all(ids.map(async (id) => {
        const p = await kv.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      const userPosts = posts.filter((p) => itemBelongsToAccount(p, refs));
      const visible = await filterVisibleItems(env, viewer, await filterSeed(env, userPosts));
      const limit = clamp(parseInt(url.searchParams.get('limit') || '50', 10), 1, 100);
      return json({ data: visible.slice(0, limit).map((it) => applyViewerVoteState(it, viewer)), error: null }, 200, cors);
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
      const rawUserId = decodeURIComponent(path.split('/api/creator/')[1] || '').split('?')[0];
      // Accept @handle / display-name / legacy-email links and always read the
      // canonical account's creator settings.
      const userId = await canonicalTargetId(env, rawUserId);
      let raw = await kv.get(KEYS.CREATOR(userId));
      // Legacy payouts were keyed by a duplicate/email id. Only fall back to a
      // row that actually belongs to the resolved account.
      if (!raw && rawUserId && rawUserId !== userId) {
        const legacy = await kv.get(KEYS.CREATOR(rawUserId));
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy);
            if (String(parsed?.userId || '') === userId) raw = legacy;
          } catch { /* ignore malformed legacy row */ }
        }
      }
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
      const to = await canonicalAccountId(env, String(clean.to || clean.creator || '').slice(0, 200));
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
      const creator = await canonicalAccountId(env, String(clean.creator || '').slice(0, 200));
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
      const rawPeer = decodeURIComponent(path.split('/api/chat/')[1].replace('/send', '')).split('?')[0];
      const peer = await canonicalAccountId(env, rawPeer);
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
      const rawPeer = decodeURIComponent(path.split('/api/chat/')[1].replace('/messages', '')).split('?')[0];
      const peer = await canonicalAccountId(env, rawPeer);
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      if (!(await canChat(env, actor.id, peer))) {
        return json({ error: 'Forbidden' }, 403, cors);
      }
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100') || 100));
      const all = await readThreadLedgerResolved(env, actor.id, peer, 300, rawPeer);
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
      const rawPeer = decodeURIComponent(path.split('/api/chat/')[1].replace('/seen', '')).split('?')[0];
      const peer = await canonicalAccountId(env, rawPeer);
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      const all = await readThreadLedgerResolved(env, actor.id, peer, 300, rawPeer);
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
      const rawPeer = decodeURIComponent(path.split('/api/chat/')[1].replace('/delivered', '')).split('?')[0];
      const peer = await canonicalAccountId(env, rawPeer);
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      let raw; try { raw = await readJson(request); } catch { raw = {}; }
      const id = String((raw && raw.id) || '').slice(0, 64);
      const all = await readThreadLedgerResolved(env, actor.id, peer, 300, rawPeer);
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
      const rawPeer = decodeURIComponent(path.split('/api/chat/')[1].replace('/delete', '')).split('?')[0];
      const peer = await canonicalAccountId(env, rawPeer);
      if (!peer) return json({ error: 'Invalid peer' }, 400, cors);
      let raw; try { raw = await readJson(request); } catch { raw = {}; }
      const id = String((raw && raw.id) || '').slice(0, 64);
      const forEveryone = !!(raw && raw.forEveryone);
      if (!id) return json({ error: 'Invalid id' }, 400, cors);
      const all = await readThreadLedgerResolved(env, actor.id, peer, 300, rawPeer);
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
      const [rawFollowing, rawFollowers] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING(actor.id)),
        readIdList(env, KEYS.FOLLOWERS(actor.id)),
      ]);
      // Duplicate/legacy refs collapse to canonical ids so one person cannot
      // appear twice (or open the wrong profile) in the chat list.
      const [following, followers] = await Promise.all([
        canonicalizeIdList(env, rawFollowing),
        canonicalizeIdList(env, rawFollowers),
      ]);
      const followingSet = new Set(following.map((x) => String(x).toLowerCase()));
      const seen = new Set();
      const threads = [];
      const pushPeer = (pid, relation) => {
        const k = String(pid).toLowerCase();
        if (!pid || seen.has(k)) return;
        seen.add(k);
        threads.push({ id: pid, peerId: pid, relation });
      };
      followers.forEach((f) => pushPeer(f, followingSet.has(String(f).toLowerCase()) ? 'mutual' : 'follower'));
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
      const actorProfile = (await getStoredProfile(env, actor.id)) || actor;
      const { ids: accountIds } = await refsForAccount(env, actorProfile);
      // Legacy notifications were written under a duplicate/email account id.
      // Merge every row that belongs to this account so they never disappear.
      const notifKeys = [...new Set([actor.id, ...accountIds])].filter(Boolean).slice(0, 10);
      const [storedRows, reqs] = await Promise.all([
        Promise.all(notifKeys.map(async (nid) => {
          try {
            const r = await kv.get(KEYS.NOTIF(nid));
            const a = r ? JSON.parse(r) : [];
            return Array.isArray(a) ? a : [];
          } catch { return []; }
        })),
        readIdList(env, KEYS.FOLLOW_REQ(actor.id)),
      ]);
      const byId = new Map();
      for (const row of storedRows.flat()) {
        if (!row || typeof row !== 'object' || !row.id) continue;
        if (row.actorName) row.actorName = maskEmailDisplay(row.actorName);
        if (row.title) row.title = scrubEmailText(row.title);
        if (row.body) row.body = scrubEmailText(row.body);
        if (!byId.has(String(row.id))) byId.set(String(row.id), row);
      }
      const items = [...byId.values()];
      const requestIds = (await canonicalizeIdList(env, reqs)).slice(0, 20);
      for (const r of requestIds) {
        if (items.some((n) => n && n.id === 'followreq-' + r)) continue;
        let display = String(r);
        try {
          const p = await profileWithFallback(env, r);
          const nm = p && (p.name || p.username);
          if (nm && !isEmailLike(nm)) display = String(nm);
        } catch { /* keep canonical id */ }
        if (isEmailLike(display)) display = 'Someone';
        items.unshift({
          id: 'followreq-' + r, kind: 'follow_request', title: 'New follow request',
          body: display + ' requested to follow you. Approve or decline from notifications.',
          at: new Date().toISOString(), read: false, actorId: r, actorName: display,
          link: '/profile/' + encodeURIComponent(r),
        });
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
    // ── ADMIN CONTENT BROWSER (dashboard.acronous.com) ───────────────────
    // GET /api/admin/content?limit= — admin-gated via X-Admin-Token. Returns
    // EVERY content item uploaded by users (posts/thoughts/stories/moments)
    // unless the uploading user deleted it themselves (deleted items are gone
    // from KV). Includes full media fields so developers can view content.
    if (path === '/api/admin/content' && method === 'GET') {
      const token = String(request.headers.get('X-Admin-Token') || '');
      const expected = String(env.REPORTS_ADMIN_TOKEN || '');
      if (!expected || token !== expected) return json({ error: 'Forbidden' }, 403, cors);
      const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '500') || 500));
      const ownerFilter = String(url.searchParams.get('owner') || '').trim().toLowerCase();
      const kindFilter = String(url.searchParams.get('kind') || url.searchParams.get('type') || '').trim().toLowerCase();
      const lists = [
        { kind: 'post', listKey: KEYS.POSTS, getKey: KEYS.POST },
        { kind: 'thought', listKey: KEYS.THOUGHTS, getKey: KEYS.THOUGHT },
        { kind: 'story', listKey: KEYS.STORIES, getKey: KEYS.STORY },
        { kind: 'moment', listKey: KEYS.MOMENTS, getKey: KEYS.MOMENT },
      ];
      const items = [];
      const stats = { total: 0, byType: {}, byUser: {} };
      for (const L of lists) {
        if (kindFilter && kindFilter !== 'all' && L.kind !== kindFilter && (L.kind + 's') !== kindFilter) continue;
        let ids = [];
        try {
          const raw = await kv.get(L.listKey);
          ids = raw ? JSON.parse(raw) : [];
          if (!Array.isArray(ids)) ids = [];
        } catch { ids = []; }
        for (const cid of ids) {
          if (items.length >= limit) break;
          try {
            const craw = await kv.get(L.getKey(cid));
            if (!craw) continue;
            const c = JSON.parse(craw);
            const owner = String(c.ownerId || c.userId || c.user_id || c.creator || c.user || '');
            if (ownerFilter && !owner.toLowerCase().includes(ownerFilter)) continue;
            const transformed = transformItem({ ...c });
            transformed.kind = L.kind;
            transformed.id = transformed.id || cid;
            items.push(transformed);
            stats.total++;
            const t = String(transformed.type || transformed.contentType || L.kind);
            stats.byType[t] = (stats.byType[t] || 0) + 1;
            if (owner) {
              const key = owner;
              if (!stats.byUser[key]) stats.byUser[key] = { count: 0, name: String(transformed.user || transformed.creator || owner) };
              stats.byUser[key].count++;
            }
          } catch { /* skip bad */ }
        }
        if (items.length >= limit) break;
      }
      items.sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
      return json({ data: { items: items.slice(0, limit), stats }, error: null }, 200, cors);
    }

    // POST /api/live/start|stop — owner toggles their live flag; followers
    // get a "X is live now" notification (bounded 50, background).
    // The flag lives on the profile row AND is mirrored into the bounded
    // profile index, so /api/live/now can show the stream to every account —
    // not just people who already follow the broadcaster.
    const LIVE_MAX_MS = 4 * 60 * 60 * 1000;
    if ((path === '/api/live/start' || path === '/api/live/stop') && method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      const actor = await getActor(request, env, body);
      const denied = actorResponse(actor, env, cors);
      if (denied) return denied;
      const starting = path === '/api/live/start';
      const clean = sanitizeBody(body || {});
      const liveTitle = String(clean.title || clean.liveTitle || '').trim().slice(0, 160);
      const liveContentId = String(clean.contentId || clean.liveContentId || clean.id || '').slice(0, 64);
      const liveThumbnail = String(clean.thumbnail || clean.liveThumbnail || '').slice(0, 1000);
      try {
        const me = (await getStoredProfile(env, actor.id)) || { id: actor.id };
        me.isLive = starting;
        me.liveAt = starting ? new Date().toISOString() : null;
        me.liveTitle = starting ? liveTitle : '';
        me.liveContentId = starting ? liveContentId : '';
        me.liveThumbnail = starting ? liveThumbnail : '';
        await kv.put(KEYS.PROFILE(actor.id), JSON.stringify(me));
        // The profile index is cached for a minute; drop it so the new live
        // state is discoverable on the next request instead of the next TTL.
        await invalidateProfileIndex(env);
      } catch { /* best-effort */ }
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
              contentId: liveContentId || undefined,
            }).catch(() => {})));
          } catch { /* ignore */ }
        })();
        if (context && typeof context.waitUntil === 'function') { try { context.waitUntil(fan); } catch {} }
        else { void fan; }
      }
      return json({ data: { live: starting, liveAt: starting ? new Date().toISOString() : null }, error: null }, 200, cors);
    }

    // GET /api/live/now — EVERY account that is live right now (public
    // discoverability), plus a `following` flag so the UI can surface followed
    // creators first. Private accounts are only visible to their followers.
    if (path === '/api/live/now' && method === 'GET') {
      const viewer = await getViewer(request, env);
      if (!viewer) return json({ data: { live: [] }, error: null }, 200, cors);
      let followingIds: string[] = [];
      try {
        followingIds = await canonicalizeIdList(env, await readIdList(env, KEYS.FOLLOWING(viewer.id)));
      } catch { followingIds = []; }
      const followingSet = new Set(followingIds.map((x) => String(x).toLowerCase()));
      const live: any[] = [];
      try {
        const index = await buildProfileIndex(env);
        const now = Date.now();
        for (const row of index) {
          if (!row || row.isLive !== true) continue;
          const id = String(row.canonicalId || row.id || '');
          if (!id || id === viewer.id) continue;
          if (row.isSeed === true) continue;
          const liveAt = Date.parse(String(row.liveAt || ''));
          // Auto-expire abandoned streams (app crash / lost network) instead
          // of showing a dead "live" badge forever.
          if (!liveAt || now - liveAt > LIVE_MAX_MS) continue;
          const isFollowing = followingSet.has(id.toLowerCase());
          // Private broadcasters are discoverable only by their followers.
          if (row.isPrivate === true && !isFollowing) continue;
          live.push({
            ...profileSummary(row, id),
            isLive: true,
            liveAt: row.liveAt,
            title: String(row.liveTitle || 'Live now'),
            liveTitle: String(row.liveTitle || 'Live now'),
            thumbnail: String(row.avatar || ''),
            contentId: String(row.liveContentId || ''),
            liveContentId: String(row.liveContentId || ''),
            isFollowing,
          });
        }
      } catch { /* index unavailable: return empty rather than fail */ }
      live.sort((a, b) =>
        Number(b.isFollowing) - Number(a.isFollowing) ||
        String(b.liveAt || '').localeCompare(String(a.liveAt || '')),
      );
      return json({ data: { live: live.slice(0, 30) }, error: null }, 200, cors);
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
      // Comments inherit the content's visibility: a private/followers-only
      // post's discussion must not be readable by id alone.
      if (!(await canViewerSeeItem(env, viewer, transformItem(found.item)))) {
        return json({ error: 'Content not found' }, 404, cors);
      }
      const settings = await getCommentSettings(env, contentId, found.item);
      const ownerId = await canonicalOwnerId(env, itemOwnerId(found.item));
      const viewerProfile = viewer ? await getStoredProfile(env, viewer.id) : null;
      const viewerRefs = viewer ? await accountRefSet(env, viewerProfile || viewer) : undefined;
      const authorIds = new Map();
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
      // Deleted accounts are tombstoned under auth:blockedid:<id>. Their
      // comments on other people's posts are not reachable from the deleted
      // account's own content lists, so they would otherwise linger forever
      // with a stale name/avatar. One cached check per author per request.
      const blockedAuthors = new Map<string, boolean>();
      const authorIsBlocked = async (id: unknown): Promise<boolean> => {
        const key = String(id || '').trim().toLowerCase();
        if (!key) return false;
        if (!blockedAuthors.has(key)) {
          try { blockedAuthors.set(key, !!(await kv.get('auth:blockedid:' + key))); }
          catch { blockedAuthors.set(key, false); }
        }
        return blockedAuthors.get(key) === true;
      };
      for (const c of rows) {
        if (!c || typeof c !== 'object' || c.contentId !== contentId) continue;
        try {
          if (await authorIsBlocked(c.authorId)) continue;
          const rawAuthor = String(c.authorId || '').toLowerCase();
          if (!authorIds.has(rawAuthor)) {
            authorIds.set(rawAuthor, c.authorId ? await canonicalAccountId(env, c.authorId) : '');
          }
          const authorId = authorIds.get(rawAuthor);
          if (authorId) c.authorId = authorId;
          if (await authorIsBlocked(authorId)) continue;
          const p = await getStoredProfile(env, authorId);
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
        const o = toPublicComment(t, viewer ? viewer.id : '', viewerRefs);
        if (o && Array.isArray(t.replies)) o.replies = t.replies.map((r) => toPublicComment(r, viewer ? viewer.id : '', viewerRefs));
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
      // Never let a signed-in caller comment on content they cannot see
      // (private account / followers-only / removed).
      if (!(await canViewerSeeItem(env, { id: actor.id, email: actor.email }, transformItem(found.item)))) {
        return json({ error: 'Content not found' }, 404, cors);
      }
      const ownerId = await canonicalOwnerId(env, itemOwnerId(found.item));
      const isOwner = await ownsAccount(env, found.item, actor);
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
      await addCommentToAuthorLedger(env, author.id, comment.id);
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
        const parentAuthorId = parent && parent.authorId
          ? await canonicalAccountId(env, parent.authorId)
          : '';
        if (parentAuthorId && parentAuthorId !== actor.id && parentAuthorId !== ownerId) {
          await pushUserNotification(env, parentAuthorId, {
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

      if (method === 'PUT' && !action) {
        let raw;
        try { raw = await readJson(request); } catch (e) { return json({ error: e.message || 'Invalid body' }, 400, cors); }
        const actor = await getActor(request, env, raw);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        const authorCanonical = comment.authorId ? await canonicalAccountId(env, comment.authorId) : '';
        if (authorCanonical !== actor.id) return json({ error: 'Only the author can edit this comment.' }, 403, cors);
        const clean = sanitizeBody(raw);
        const text = String(clean.text || clean.content || '').trim().slice(0, 1000);
        if (!text) return json({ error: 'Comment text required' }, 400, cors);
        try {
          await moderateContent(env, { text });
        } catch (e) {
          return json({ error: (e && e.message) || 'Comment violates community guidelines.' }, (e && e.status) || 400, cors);
        }
        comment.authorId = actor.id;
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
        const authorCanonical = comment.authorId ? await canonicalAccountId(env, comment.authorId) : '';
        const isAuthor = authorCanonical === actor.id;
        const isContentOwner = found ? await ownsAccount(env, found.item, actor) : false;
        if (!isAuthor && !isContentOwner) return json({ error: 'Only the author or the post owner can delete this comment.' }, 403, cors);
        // Delete the comment + its direct replies (single-level threads).
        const ids = await readCommentList(env, comment.contentId);
        const toDelete = [cid];
        const replyAuthors = new Map<string, string[]>();
        for (const otherId of ids) {
          if (otherId === cid) continue;
          try {
            const oraw = await kv.get(KEYS.COMMENT(otherId));
            const o = oraw ? JSON.parse(oraw) : null;
            if (o && String(o.parentId || '') === String(cid)) {
              toDelete.push(otherId);
              const a = String(o.authorId || '').trim();
              if (a) {
                if (!replyAuthors.has(a)) replyAuthors.set(a, []);
                replyAuthors.get(a)!.push(String(otherId));
              }
            }
          } catch { /* ignore */ }
        }
        for (const d of toDelete) {
          try { await kv.delete(KEYS.COMMENT(d)); } catch { /* ignore */ }
        }
        // Keep per-author ledgers in sync so account deletion later does not
        // chase comments that are already gone.
        try {
          await removeCommentsFromAuthorLedger(env, comment.authorId, [cid]);
          for (const [authorId, list] of replyAuthors) {
            await removeCommentsFromAuthorLedger(env, authorId, list);
          }
        } catch { /* ignore */ }
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
        const actorProfile = (await getStoredProfile(env, actor.id)) || actor;
        const actorRefs = await accountRefSet(env, actorProfile);
        const likedBy = Array.isArray(comment.likedBy) ? comment.likedBy.map(String) : [];
        const has = likedBy.some((x) => actorRefs.has(String(x).trim().toLowerCase()));
        // Normalize legacy/duplicate refs to the canonical id while toggling.
        const others = likedBy.filter((x) => !actorRefs.has(String(x).trim().toLowerCase()));
        const next = has ? others : [String(actor.id), ...others].slice(0, 5000);
        comment.likedBy = next;
        comment.likes = next.length;
        await kv.put(KEYS.COMMENT(cid), JSON.stringify(comment));
        try { await aiBumpPop(env, comment.contentId, has ? -1 : 1); } catch {}
        return json({ data: { comment: toPublicComment(comment, actor.id, actorRefs) }, error: null }, 200, cors);
      }

      if (method === 'POST' && action === 'share') {
        const actor = await getActor(request, env);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        const sharedBy = Array.isArray(comment.sharedBy)
          ? comment.sharedBy.map((x) => String(x).toLowerCase())
          : [];
        const actorRefs = new Set([String(actor.id).toLowerCase()]);
        if (actor.email) actorRefs.add(String(actor.email).toLowerCase());
        if (actor.username) actorRefs.add(String(actor.username).replace(/^@/, '').toLowerCase());
        const alreadyShared = sharedBy.some((x) => actorRefs.has(x));
        const current = Number(comment.shares || 0) || 0;
        const next = alreadyShared ? current : Math.min(5000, current + 1);
        if (!alreadyShared) {
          comment.sharedBy = [...new Set([String(actor.id).toLowerCase(), ...sharedBy])].slice(0, 5000);
          comment.shares = next;
        }
        await kv.put(KEYS.COMMENT(cid), JSON.stringify(comment));
        const shareUrl = new URL(request.url).origin + '/app/home?comment=' + encodeURIComponent(cid);
        return json({ data: { comment: toPublicComment(comment, actor.id), shareUrl, shareText: String(comment.text || '').slice(0, 200), alreadyShared }, error: null }, 200, cors);
      }

      if (method === 'POST' && action === 'pin') {
        const actor = await getActor(request, env);
        const denied = actorResponse(actor, env, cors);
        if (denied) return denied;
        // Flexible: the account the media belongs to can pin ANY comment
        // (their own or anyone else's) and unpin it again.
        if (!(found && await ownsAccount(env, found.item, actor))) {
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
      if (!(await ownsAccount(env, found.item, actor))) return json({ error: 'Only the account that posted this can change comment settings.' }, 403, cors);
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
