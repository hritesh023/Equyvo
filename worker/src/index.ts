import { Env } from './env';
import {
  corsHeaders, SECURITY_HEADERS, getPosts, getUserPosts, createPost, getThoughts, createThought,
  getStories, createStory, getMoments, createMoment,
  getProfile, upsertProfile, searchContent, likePost, unlikePost, voteThought,
  indexContent, deletePost, deleteThought, deleteStory, deleteMoment, deleteUserData,
  KEYS, purgeSeedData, SEED_PROFILE_IDS, SEED_PURGED_KEY,
  getInterests, recordEngagement, bumpPopularity, brainSearchSuggest, brainFeedSuggest,
  rankFeedItems, ensureContentIndex,
  getActor, bearerFrom, requiresVerifiedWrites, sanitizeBody, rateLimit, rateLimitFor,
  resolvePlan, planQuota, getUsage, addUsage, PLAN_CATALOG, PLATFORM_FEE_BPS, sha256Hex, cloudinaryVariants,
  r2KeyFor, extFromFile, r2DeliveryUrl, validMediaKey,
} from './kv';
export { Env };

function parseInterestsParam(v: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v) return out;
  for (const raw of v.split(',')) {
    const t = raw.trim().toLowerCase().replace(/^#+/, '').slice(0, 40);
    if (t) out[t] = 5;
  }
  return out;
}

function mergeInterests(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.min(100, (Number(out[k] || 0) + Number(v || 0)));
  return out;
}

const GB = 1024 * 1024 * 1024;

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleRequest(request: Request, env: Env, ctx?: { waitUntil(p: Promise<any>): void }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = request.headers.get('Origin') || undefined;
  const cors = corsHeaders(origin);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });
  }

  // Lag fix: never block a response on maintenance writes. The old code did
  // a KV write + full seed-purge scan (hundreds of reads) on EVERY request.
  // Now: one cheap flag read; the one-time purge runs in the background.
  try {
    const purged = await env.EQUYVO_KV.get(SEED_PURGED_KEY);
    if (!purged) {
      const p = (async () => {
        try { await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true'); } catch {}
        try { await purgeSeedData(env); } catch {}
      })();
      if (ctx && ctx.waitUntil) ctx.waitUntil(p);
      else await p;
    }
  } catch { /* ignore maintenance failures */ }

  const respond = (data: any, status = 200): Response => {
    const res = jsonResponse(data, status);
    Object.entries({ ...cors, ...SECURITY_HEADERS }).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  };

  const respondError = (msg: string, status = 400): Response => {
    const res = errorResponse(msg, status);
    Object.entries({ ...cors, ...SECURITY_HEADERS }).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  };

  const requireActor = async (body?: any) => {
    const actor: any = await getActor(request, env, body);
    if (!actor) return { error: respondError(requiresVerifiedWrites(env) ? 'Authentication required (valid Bearer token)' : 'Authentication required', 401) };
    return { actor };
  };

  const serveR2 = async (key: string, method: string): Promise<Response> => {
    if (!env.EQUYVO_R2) {
      return respond({ error: 'Media warehouse not bound. Enable R2 (see wrangler.toml) — Cloudinary URLs remain authoritative until then.' }, 503);
    }
    if (!validMediaKey(key)) return respondError('Invalid media key', 400);
    let head: R2Object | null = null;
    try {
      head = await env.EQUYVO_R2.head(key);
    } catch {
      return respondError('Media fetch failed', 500);
    }
    if (!head) return respondError('Not found', 404);
    const contentType = (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream';
    const base: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (head.etag) base['ETag'] = head.etag;
    const withCors = (extra: Record<string, string> = {}, status = 200, body: ReadableStream | null = null): Response => {
      const res = new Response(body, { status, headers: { ...base, ...extra } });
      Object.entries({ ...cors, ...SECURITY_HEADERS }).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    };
    if (method === 'HEAD') return withCors({ 'Content-Length': String(head.size) });
    const rangeHeader = request.headers.get('Range');
    if (!rangeHeader) {
      const obj = await env.EQUYVO_R2.get(key);
      if (!obj) return respondError('Not found', 404);
      return withCors({ 'Content-Length': String(obj.size) }, 200, obj.body);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      return withCors({ 'Content-Range': `bytes */${head.size}` }, 416);
    }
    let offset: number, length: number;
    if (m[1] === '') {
      const suffix = Math.min(parseInt(m[2], 10), head.size);
      if (!Number.isFinite(suffix) || suffix <= 0) return withCors({ 'Content-Range': `bytes */${head.size}` }, 416);
      offset = head.size - suffix;
      length = suffix;
    } else {
      offset = parseInt(m[1], 10);
      const end = m[2] === '' ? head.size - 1 : Math.min(parseInt(m[2], 10), head.size - 1);
      if (!Number.isFinite(offset) || offset < 0 || offset >= head.size || end < offset) {
        return withCors({ 'Content-Range': `bytes */${head.size}` }, 416);
      }
      length = end - offset + 1;
    }
    const obj = await env.EQUYVO_R2.get(key, { range: { offset, length } });
    if (!obj) return respondError('Not found', 404);
    return withCors({ 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${head.size}` }, 206, obj.body);
  };

  try {
    if (path === '/api/posts' && method === 'GET') {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50')));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0') || 0);
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || '').slice(0, 200);
      const sort = String(url.searchParams.get('sort') || '').toLowerCase();
      // Fetch one extra page when ranking so offset works on ranked order.
      const posts = await getPosts(env, Math.min(100, limit + offset));
      // Transparent AI ranking: existing frontend calls GET /api/posts?limit=50
      // with no changes, but when we know the user's interests we return
      // interest-ranked order instead of pure reverse-chronological.
      let out = posts;
      let personalized = false;
      const wantRank = sort === 'relevant' || sort === 'foryou' || !!userId || !!url.searchParams.get('interests');
      if (wantRank) {
        try {
          const stored = userId ? await getInterests(env, userId) : {};
          const qi = parseInterestsParam(url.searchParams.get('interests'));
          const interests = mergeInterests(stored, qi);
          const ranked = rankFeedItems(posts, interests, limit + offset);
          out = ranked.items.slice(offset, offset + limit);
          personalized = ranked.personalized;
        } catch { out = posts.slice(offset, offset + limit); }
      } else {
        out = posts.slice(offset, offset + limit);
      }
      if (personalized) {
        return respond({ data: out, error: null, meta: { personalized: true } });
      }
      return respond({ data: out, error: null });
    }

    if (path === '/api/posts' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const { planId } = await resolvePlan(env, actor.id, bearerFrom(request));
      const rl = await rateLimit(env, 'posts', actor.id, rateLimitFor(planId, 'posts'));
      if (!rl.ok) return respondError('Too many requests', 429);
      const body = sanitizeBody(raw);
      const post = await createPost(env, body);
      return respond({ data: post, error: null }, 201);
    }

    if (path.startsWith('/api/posts/') && !path.endsWith('/like') && !path.endsWith('/unlike') && method === 'GET') {
      const id = path.split('/api/posts/')[1];
      const json = await env.EQUYVO_KV.get(KEYS.POST(id));
      if (!json) return respondError('Post not found', 404);
      return respond({ data: JSON.parse(json), error: null });
    }

    if (path.startsWith('/api/users/') && path.endsWith('/posts') && method === 'GET') {
      const userId = path.split('/api/users/')[1].replace('/posts', '');
      const posts = await getUserPosts(env, userId);
      return respond({ data: posts, error: null });
    }

    if (path.startsWith('/api/posts/') && path.endsWith('/like') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/posts/')[1].replace('/like', '');
      const result = await likePost(env, id);
      // Server-side interest learning: no frontend change needed.
      try {
        const raw = await env.EQUYVO_KV.get(KEYS.POST(id));
        if (raw) {
          const p: any = JSON.parse(raw);
          void recordEngagement(env, (actor as any).id, {
            category: String((p.categories && p.categories[0]) || ''),
            tags: Array.isArray(p.tags) ? p.tags : [],
            creator: String(p.user || ''),
            action: 'like',
          });
        }
      } catch {}
      return respond({ data: result, error: null });
    }

    if (path.startsWith('/api/posts/') && path.endsWith('/unlike') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/posts/')[1].replace('/unlike', '');
      const result = await unlikePost(env, id);
      try {
        void recordEngagement(env, (actor as any).id, { action: 'unlike' });
      } catch {}
      return respond({ data: result, error: null });
    }

    if (path === '/api/thoughts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const thoughts = await getThoughts(env, limit, offset);
      return respond({ data: thoughts, error: null });
    }

    if (path === '/api/thoughts' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const { planId } = await resolvePlan(env, actor.id, bearerFrom(request));
      const rl = await rateLimit(env, 'thoughts', actor.id, rateLimitFor(planId, 'thoughts'));
      if (!rl.ok) return respondError('Too many requests', 429);
      const thought = await createThought(env, sanitizeBody(raw));
      return respond({ data: thought, error: null }, 201);
    }

    if (path.startsWith('/api/thoughts/') && path.endsWith('/vote') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/thoughts/')[1].replace('/vote', '');
      const body = await request.json() as any;
      const result = await voteThought(env, id, body.vote_type);
      try {
        const raw = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
        if (raw) {
          const t: any = JSON.parse(raw);
          void recordEngagement(env, (actor as any).id, {
            tags: Array.isArray(t.tags) ? t.tags : [],
            action: 'vote',
          });
        }
      } catch {}
      return respond({ data: result, error: null });
    }

    if (path === '/api/stories' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const stories = await getStories(env, limit);
      return respond({ data: stories, error: null });
    }

    if (path === '/api/stories' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const { planId } = await resolvePlan(env, actor.id, bearerFrom(request));
      const rl = await rateLimit(env, 'stories', actor.id, rateLimitFor(planId, 'stories'));
      if (!rl.ok) return respondError('Too many requests', 429);
      const story = await createStory(env, sanitizeBody(raw));
      return respond({ data: story, error: null }, 201);
    }

    if (path === '/api/moments' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const moments = await getMoments(env, limit);
      return respond({ data: moments, error: null });
    }

    if (path === '/api/moments' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const { planId } = await resolvePlan(env, actor.id, bearerFrom(request));
      const rl = await rateLimit(env, 'moments', actor.id, rateLimitFor(planId, 'moments'));
      if (!rl.ok) return respondError('Too many requests', 429);
      const moment = await createMoment(env, sanitizeBody(raw));
      return respond({ data: moment, error: null }, 201);
    }

    if (path.startsWith('/api/profile/') && method === 'GET') {
      const userId = path.split('/api/profile/')[1];
      if (SEED_PROFILE_IDS.has(userId)) return respondError('Profile not found', 404);
      const profile = await getProfile(env, userId);
      if (!profile) return respondError('Profile not found', 404);
      return respond({ data: profile, error: null });
    }

    if (path === '/api/profile' && method === 'PUT') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const id = (typeof raw.id === 'string' && raw.id) || actor.id;
      if (id !== actor.id) return respondError('Forbidden', 403);
      const { planId } = await resolvePlan(env, actor.id, bearerFrom(request));
      const rl = await rateLimit(env, 'profile', actor.id, rateLimitFor(planId, 'profile'));
      if (!rl.ok) return respondError('Too many requests', 429);
      const clean = sanitizeBody(raw);
      clean.id = id;
      const profile = await upsertProfile(env, clean);
      return respond({ data: profile, error: null });
    }

    if (path === '/api/search' && method === 'GET') {
      const query = String(url.searchParams.get('q') || '').slice(0, 200);
      const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20') || 20));
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || '').slice(0, 200);
      // Interest-aware AI search (backend-only): merges persisted interests
      // with explicit ?interests= so the search bar ranks what this user
      // cares about first. No frontend changes required.
      let interests: Record<string, number> = {};
      try {
        const stored = userId ? await getInterests(env, userId) : {};
        interests = mergeInterests(stored, parseInterestsParam(url.searchParams.get('interests')));
        // Also fold profile categories/bio keywords when available.
        if (userId && Object.keys(stored).length === 0) {
          try {
            const prof = await getProfile(env, userId);
            const extra: Record<string, number> = {};
            const bio = String((prof as any)?.bio || '');
            for (const t of bio.toLowerCase().split(/[^a-z0-9]+/).slice(0, 10)) {
              if (t.length >= 3) extra[t] = 2;
            }
            interests = mergeInterests(interests, extra);
          } catch {}
        }
      } catch { interests = {}; }
      const { results, totalCount, personalized } = await searchContent(env, query, { interests, limit });
      const hasReal = await env.EQUYVO_KV.get('has_real_users');
      let filtered = results;
      if (hasReal === 'true') {
        filtered = results.filter(i => !(i.isSeed || (i.id && typeof i.id === 'string' && i.id.startsWith('seed-'))));
      }
      // isAiRecommended is now honest: true when interest/AI ranking applied
      // or when we served the popular fallback for a zero-match query.
      const isAiRecommended = personalized || totalCount === 0;
      return respond({ data: { results: filtered, totalCount, isAiRecommended, personalized } });
    }

    // Personalized feed across posts+thoughts+moments, ranked by interests +
    // popularity + recency. New endpoint; existing clients are unaffected.
    if (path === '/api/feed' && method === 'GET') {
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '30') || 30));
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0') || 0);
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || '').slice(0, 200);
      let interests: Record<string, number> = {};
      try {
        const stored = userId ? await getInterests(env, userId) : {};
        interests = mergeInterests(stored, parseInterestsParam(url.searchParams.get('interests')));
      } catch { interests = {}; }
      // Bounded fan-out: newest 60 posts + 30 thoughts + 30 moments.
      const [posts, thoughts, moments] = await Promise.all([
        getPosts(env, 60).catch(() => []),
        getThoughts(env, 30, 0).catch(() => []),
        getMoments(env, 30).catch(() => []),
      ]);
      const norm = [
        ...posts.map((p: any) => ({ kind: 'post', ...p, createdAt: p.createdAt || p.time })),
        ...thoughts.map((t: any) => ({ kind: 'thought', id: t.id, content: t.content, user: t.user_id, createdAt: t.created_at || t.updated_at, likes: t.likes_count, comments: t.comments_count, tags: t.tags || [], category: 'Thoughts' })),
        ...moments.map((m: any) => ({ kind: 'moment', ...m })),
      ];
      const { items, personalized } = rankFeedItems(norm, interests, limit + offset);
      return respond({ data: { items: items.slice(offset, offset + limit), totalCount: norm.length, personalized } });
    }

    // Engagement ingestion: persists interest signals + popularity. The
    // current frontend doesn't call this yet, but like/unlike/vote hooks
    // below also record signals server-side, so interests build up with
    // zero frontend changes.
    if (path === '/api/engagement' && method === 'POST') {
      let raw: any = {};
      try { raw = await request.json(); } catch { return respondError('Invalid JSON body', 400); }
      const body = sanitizeBody(raw);
      const userId = String(body.userId || body.user_id || request.headers.get('X-User-Id') || '').slice(0, 200);
      if (!userId) return respondError('userId required', 400);
      const action = String(body.action || 'view').slice(0, 20);
      const rl = await rateLimit(env, 'engagement', userId, 60);
      if (!rl.ok) return respondError('Too many requests', 429);
      const interests = await recordEngagement(env, userId, {
        category: String(body.category || ''),
        tags: Array.isArray(body.tags) ? body.tags.slice(0, 10) : [],
        creator: String(body.creator || ''),
        action,
      });
      if (body.itemId) void bumpPopularity(env, String(body.itemId).slice(0, 64), action === 'view' ? 1 : 3);
      // Best-effort brain learning (never blocks).
      try {
        const bb = (await import('./kv')).brainBase(env);
        void fetch(`${bb}/v1/learn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: String(body.itemId || body.category || action), response: `user ${action}`, route_type: 'general_chat', session_id: userId, source: 'equyvo-feed' }),
        }).catch(() => {});
      } catch {}
      return respond({ data: { ok: true, interests: Object.keys(interests).length } });
    }

    // AI search suggestions (backend proxy to the Contabo brain with instant
    // local fallback). Frontend keeps working even when the brain is down.
    if (path === '/api/suggest/search' && method === 'GET') {
      const q = String(url.searchParams.get('q') || '').slice(0, 100);
      if (!q) return respond({ data: { suggestions: [] } });
      const ai = await brainSearchSuggest(env, q).catch(() => [] as string[]);
      if (ai.length) return respond({ data: { suggestions: ai.map((label) => ({ label, type: 'ai-generated' })), source: 'brain' } });
      // Instant local fallback: tags/categories from the index.
      try {
        const idx = await ensureContentIndex(env);
        const ql = q.toLowerCase();
        const seen = new Set<string>();
        const out: string[] = [];
        for (const it of idx) {
          for (const cand of [it.category, ...(it.tags || []), it.title]) {
            const c = String(cand || '').trim();
            if (c && c.toLowerCase().includes(ql) && !seen.has(c.toLowerCase()) && out.length < 8) {
              seen.add(c.toLowerCase());
              out.push(c);
            }
          }
          if (out.length >= 8) break;
        }
        return respond({ data: { suggestions: out.map((label) => ({ label, type: 'local' })), source: 'local' } });
      } catch {
        return respond({ data: { suggestions: [], source: 'none' } });
      }
    }

    // AI trending/feed suggestions for Discover (backend proxy + fallback).
    if ((path === '/api/suggest/feed' || path === '/api/trending') && method === 'GET') {
      const userId = String(url.searchParams.get('userId') || url.searchParams.get('user_id') || 'default').slice(0, 200);
      let interests: Record<string, number> = {};
      try { interests = userId ? await getInterests(env, userId) : {}; } catch {}
      const top = Object.entries(interests).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
      const ai = await brainFeedSuggest(env, userId, top).catch(() => [] as string[]);
      if (ai.length) return respond({ data: { suggestions: ai, source: 'brain', personalized: top.length > 0 } });
      const fb = top.length ? top : ['Trending topics', "What's new", 'Explore categories', 'Popular creators', 'Fresh uploads', 'Community picks'];
      return respond({ data: { suggestions: fb.slice(0, 8), source: 'local', personalized: top.length > 0 } });
    }

    if (path === '/api/content-index' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const { planId } = await resolvePlan(env, actor.id, bearerFrom(request));
      const rl = await rateLimit(env, 'index', actor.id, rateLimitFor(planId, 'index'));
      if (!rl.ok) return respondError('Too many requests', 429);
      await indexContent(env, sanitizeBody(raw));
      return respond({ data: { success: true }, error: null });
    }

    // Plans + usage: public catalog, authenticated usage.
    if (path === '/api/plans' && method === 'GET') {
      const plans = Object.values(PLAN_CATALOG).map((p) => ({
        id: p.id, label: p.label, priceInr: p.priceInr,
        storageGB: Math.round(p.storageBytes / GB),
        maxUploadMB: p.maxUploadMB, maxVideoSec: p.maxVideoSec,
        monthlyUploads: p.monthlyUploads, ads: p.ads,
        creator: !!p.creator, business: !!p.business,
      }));
      return respond({ data: { plans, platformFeeBps: PLATFORM_FEE_BPS }, error: null });
    }

    if (path === '/api/me/usage' && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const { planId, source } = await resolvePlan(env, actor.id, bearerFrom(request));
      const quota = planQuota(planId);
      const usage = await getUsage(env, actor.id);
      return respond({ data: {
        planId, planLabel: quota.label, source,
        usedBytes: usage.bytes, quotaBytes: quota.storageBytes,
        usedPct: quota.storageBytes ? Math.round((usage.bytes / quota.storageBytes) * 1000) / 10 : 0,
        files: usage.files, monthlyUploads: usage.monthUploads, monthlyCap: quota.monthlyUploads,
        maxUploadMB: quota.maxUploadMB,
      }, error: null });
    }

    // R2 upload: primary warehouse, Cloudinary selective for variants.
    // secureUrl is always the best delivery URL (R2 when available).
    if (path === '/api/upload' && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const bearer = bearerFrom(request);
      const { planId } = await resolvePlan(env, actor.id, bearer);
      const quota = planQuota(planId);
      const rl = await rateLimit(env, 'upload', actor.id, rateLimitFor(planId, 'upload'));
      if (!rl.ok) return respondError('Too many requests', 429);

      const formData = await request.formData();
      const file = formData.get('file') as unknown as File | null;
      const folder = String(formData.get('folder') || 'equyvo/uploads').replace(/[^a-zA-Z0-9/_-]/g, '').slice(0, 120);
      if (!file || typeof file === 'string') return respondError('No file provided', 400);
      if (!(file.type || '').startsWith('image/') && !(file.type || '').startsWith('video/')) {
        return respondError('Only images and videos are allowed', 415);
      }
      const envCapMB = parseInt(env.MAX_UPLOAD_MB || '', 10) || quota.maxUploadMB;
      const maxBytes = Math.min(quota.maxUploadMB, envCapMB) * 1024 * 1024;
      if ((file as any).size > maxBytes) return respondError(`File too large for ${quota.label} (max ${Math.min(quota.maxUploadMB, envCapMB)}MB)`, 413);

      const usage = await getUsage(env, actor.id);
      if (usage.bytes + (file as any).size > quota.storageBytes) {
        return respond({ error: `Storage quota exceeded for ${quota.label}`, code: 'QUOTA_STORAGE', planId }, 402);
      }
      if (usage.monthUploads >= quota.monthlyUploads) {
        return respond({ error: `Monthly upload limit reached for ${quota.label}`, code: 'QUOTA_MONTHLY', planId }, 402);
      }

      let bytes: Uint8Array | null = null;
      let hash = '';
      try {
        bytes = new Uint8Array(await (file as any).arrayBuffer());
        hash = await sha256Hex(bytes.buffer as ArrayBuffer);
        const hit = await env.EQUYVO_KV.get(KEYS.HASH(hash));
        if (hit) return respond({ data: { ...JSON.parse(hit), deduped: true, planId }, error: null });
      } catch { /* best-effort */ }

      const cloudName = env.CLOUDINARY_CLOUD_NAME;
      const uploadPreset = env.CLOUDINARY_UPLOAD_PRESET;
      const hasR2 = !!env.EQUYVO_R2;
      const cloudConfigured = !!(cloudName && uploadPreset);
      if (!hasR2 && !cloudConfigured) return respondError('Media storage not configured on server', 500);

      let r2Key: string | null = null;
      if (hasR2 && bytes) {
        r2Key = r2KeyFor(actor.id, hash, extFromFile(file));
        try {
          await env.EQUYVO_R2.put(r2Key, bytes, {
            httpMetadata: {
              contentType: (file as any).type || 'application/octet-stream',
              cacheControl: 'public, max-age=31536000, immutable',
            },
            customMetadata: { uploader: String(actor.id).slice(0, 128), sha256: hash },
          });
        } catch {
          r2Key = null;
        }
      }

      let result: any = null;
      if (cloudConfigured) {
        const cloudForm = new FormData();
        const upFile = bytes ? new File([bytes as any], (file as any).name || 'upload', { type: (file as any).type }) : (file as any);
        cloudForm.append('file', upFile);
        cloudForm.append('upload_preset', uploadPreset);
        cloudForm.append('folder', folder);

        const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, { method: 'POST', body: cloudForm });
        result = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          if (!r2Key) return respondError(result.error?.message || 'Upload failed', 500);
          result = null;
        }
      }

      const resourceType = result?.resource_type || (String((file as any).type).startsWith('video/') ? 'video' : 'image');
      const variants = result ? cloudinaryVariants(result.secure_url, result.resource_type, quota.quality) : null;
      const r2Url = r2Key ? r2DeliveryUrl(request, env, r2Key) : null;
      const payload = {
        publicId: result?.public_id || null,
        secureUrl: r2Url || result?.secure_url,
        originalUrl: r2Url || result?.secure_url,
        delivery: r2Url ? 'r2' : 'cloudinary',
        resourceType,
        format: result?.format || extFromFile(file),
        bytes: result?.bytes || (file as any).size || 0,
        width: result?.width, height: result?.height,
        createdAt: result?.created_at || new Date().toISOString(), duration: result?.duration,
        variants, r2Key, store: r2Key && result ? 'r2+cloudinary' : r2Key ? 'r2' : 'cloudinary', planId,
      };
      try {
        if (hash) await env.EQUYVO_KV.put(KEYS.HASH(hash), JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 90 });
        if (payload.publicId) {
          await env.EQUYVO_KV.put(KEYS.MEDIA(payload.publicId), JSON.stringify({ bytes: payload.bytes, r2Key }), { expirationTtl: 60 * 60 * 24 * 365 });
        }
      } catch { /* ignore */ }
      const next = await addUsage(env, actor.id, Number(payload.bytes || 0));
      return respond({ data: payload, usage: { usedBytes: next.bytes, quotaBytes: quota.storageBytes }, error: null });
    }

    // R2 media delivery: public GET/HEAD with Range + immutable cache.
    if ((path === '/api/media' || path.startsWith('/api/media/')) && (method === 'GET' || method === 'HEAD')) {
      const key = decodeURIComponent(path.slice('/api/media/'.length));
      return await serveR2(key, method);
    }

    if (path.startsWith('/api/posts/') && method === 'DELETE') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/posts/')[1];
      await deletePost(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/thoughts/') && method === 'DELETE') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/thoughts/')[1];
      await deleteThought(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/stories/') && method === 'DELETE') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/stories/')[1];
      await deleteStory(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/moments/') && method === 'DELETE') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/moments/')[1];
      await deleteMoment(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/user/') && path.endsWith('/data') && method === 'DELETE') {
      const userId = path.split('/api/user/')[1].replace('/data', '');
      const { actor, error } = await requireActor();
      if (error) return error;
      if ((actor as any).id !== userId) return respondError('Forbidden', 403);
      const result = await deleteUserData(env, userId);
      return respond({ data: { success: true, ...result }, error: null });
    }

    if (path === '/api/health') {
      // Honest health: KV must answer. Brain is best-effort (feed/search work
      // offline from KV), so a down brain = degraded, not a 503 outage.
      let kv: string = 'down';
      try {
        await env.EQUYVO_KV.get(KEYS.NEXT_ID);
        kv = 'up';
      } catch { kv = 'down'; }
      if (kv === 'down') {
        return respond({ status: 'down', kv, version: env.APP_VERSION || '1.0.0', timestamp: new Date().toISOString() }, 503);
      }
      return respond({ status: 'ok', kv, version: env.APP_VERSION || '1.0.0', timestamp: new Date().toISOString() });
    }

    // Keep-alive: warms KV + touches the brain so the tunnel/model never idles.
    if (path === '/api/warmup' && method === 'GET') {
      try { await env.EQUYVO_KV.get(KEYS.NEXT_ID); } catch {}
      return respond({ status: 'ok', timestamp: new Date().toISOString() });
    }

    return respondError('Not found: ' + path, 404);
  } catch (err: any) {
    return respondError(err.message || 'Internal server error', 500);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<any>): void }): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<any>): void }) {
    // Cron every 5 min keeps KV warm; Workers themselves never sleep, but
    // this also keeps the Contabo brain tunnel warm via a best-effort ping.
    ctx.waitUntil((async () => {
      try { await env.EQUYVO_KV.get(KEYS.NEXT_ID); } catch {}
      try {
        const base = String((env as any).BRAIN_URL || 'https://brain.acronous.com').replace(/\/$/, '');
        const ctrl = new AbortController();
        const t = setTimeout(() => { try { ctrl.abort(); } catch {} }, 5000);
        try { await fetch(`${base}/v1/brain/info`, { signal: ctrl.signal }); } catch {}
        finally { clearTimeout(t); }
      } catch {}
    })());
  },
};
