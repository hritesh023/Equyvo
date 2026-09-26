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
  nameQuotaState, prepareProfileUpdate,
  readIdList, profileSummary, isFollowingPair, getViewer,
  readChatMessages, writeChatMessages, pushUserNotification, canChat,
  generateId, fileReport, listReports, fanOutUpload,
  findContentById, getCommentSettings, resolveCommentAuthor, toPublicComment,
  readCommentList, syncContentCommentCount, cleanCommentAvatar, cleanCommentName,
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

    // Display-name quota read (authenticated): powers the editor's
    // remaining-count + Premium upsell. Must precede the /api/profile/:id route.
    if (path === '/api/profile/name-quota' && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const prof = await getProfile(env, (actor as any).id);
      const st = nameQuotaState(prof || {});
      return respond({ data: { used: st.used, quota: st.quota, remaining: st.remaining }, error: null });
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
      // Quota counters are server-owned: forged client values are dropped.
      delete clean.nameChangesUsed;
      delete clean.nameChangeQuota;
      delete clean.nameGrantPayments;
      delete clean.nameBonusPlans;
      if (typeof clean.bio === 'string') clean.bio = String(clean.bio).slice(0, 500);
      if (typeof clean.name === 'string') clean.name = String(clean.name).slice(0, 80);
      if (typeof clean.username === 'string') clean.username = String(clean.username).slice(0, 80);
      // Display-name quota: only an actual `name` change consumes quota;
      // avatar/bio/username edits stay unlimited.
      const prev = await getProfile(env, id);
      const { profile, quotaError } = prepareProfileUpdate(prev || {}, clean, planId);
      if (quotaError) {
        return respond({
          error: `You have used all ${quotaError.quota} free profile name changes. Buy a Premium plan to get 2 more changes.`,
          code: 'NAME_CHANGE_QUOTA',
          used: quotaError.used,
          quota: quotaError.quota,
          remaining: 0,
        }, 402);
      }
      const saved = await upsertProfile(env, profile);
      return respond({ data: saved, error: null });
    }

    // ---- FOLLOW GRAPH (mirrors Pages Functions; server-side source of truth) ----
    // POST /api/follow { target } — public accounts follow directly;
    // private accounts get a pending request instead.
    if (path === '/api/follow' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const body = sanitizeBody(raw);
      const target = String(body.target || body.userId || '').slice(0, 200);
      if (!target || target === (actor as any).id) return respondError('Invalid target', 400);
      const rl = await rateLimit(env, 'engagement', (actor as any).id, 60);
      if (!rl.ok) return respondError('Too many requests', 429);
      const targetProfile: any = await getProfile(env, target);
      if (targetProfile && targetProfile.isPrivate === true) {
        const reqs = await readIdList(env, KEYS.FOLLOW_REQ(target));
        if (!reqs.some((x) => x === (actor as any).id)) {
          reqs.unshift((actor as any).id);
          await env.EQUYVO_KV.put(KEYS.FOLLOW_REQ(target), JSON.stringify(reqs.slice(0, 1000)));
        }
        return respond({ data: { isFollowing: false, pending: true, isPrivate: true }, error: null });
      }
      const [following, followers] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING((actor as any).id)),
        readIdList(env, KEYS.FOLLOWERS(target)),
      ]);
      if (!following.some((x) => x === target)) {
        following.unshift(target);
        await env.EQUYVO_KV.put(KEYS.FOLLOWING((actor as any).id), JSON.stringify(following.slice(0, 5000)));
      }
      if (!followers.some((x) => x === (actor as any).id)) {
        followers.unshift((actor as any).id);
        await env.EQUYVO_KV.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.slice(0, 50000)));
      }
      return respond({ data: { isFollowing: true, pending: false }, error: null });
    }

    if (path.startsWith('/api/follow/') && !path.startsWith('/api/follow/requests') && !path.startsWith('/api/follow/status') && !path.startsWith('/api/follow/accept') && !path.startsWith('/api/follow/decline') && method === 'DELETE') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const target = decodeURIComponent(path.split('/api/follow/')[1] || '').split('?')[0];
      if (!target) return respondError('Invalid target', 400);
      const [following, followers, reqs] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING((actor as any).id)),
        readIdList(env, KEYS.FOLLOWERS(target)),
        readIdList(env, KEYS.FOLLOW_REQ(target)),
      ]);
      await env.EQUYVO_KV.put(KEYS.FOLLOWING((actor as any).id), JSON.stringify(following.filter((x) => x !== target)));
      await env.EQUYVO_KV.put(KEYS.FOLLOWERS(target), JSON.stringify(followers.filter((x) => x !== (actor as any).id)));
      if (reqs.some((x) => x === (actor as any).id)) {
        await env.EQUYVO_KV.put(KEYS.FOLLOW_REQ(target), JSON.stringify(reqs.filter((x) => x !== (actor as any).id)));
      }
      return respond({ data: { isFollowing: false, pending: false }, error: null });
    }

    if (path === '/api/follow/status' && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const target = String(url.searchParams.get('target') || '').slice(0, 200);
      if (!target) return respondError('target required', 400);
      const following = await readIdList(env, KEYS.FOLLOWING((actor as any).id));
      const isFollowing = following.some((x) => x === target);
      let pending = false;
      if (!isFollowing) {
        const reqs = await readIdList(env, KEYS.FOLLOW_REQ(target));
        pending = reqs.some((x) => x === (actor as any).id);
      }
      return respond({ data: { isFollowing, pending }, error: null });
    }

    // GET /api/followers/:id + /api/following/:id with lightweight profiles.
    // Private accounts expose lists only to owners/followers (restricted:true otherwise).
    if ((path.startsWith('/api/followers/') || path.startsWith('/api/following/')) && method === 'GET') {
      const isFollowers = path.startsWith('/api/followers/');
      const userId = decodeURIComponent((isFollowers ? path.split('/api/followers/')[1] : path.split('/api/following/')[1] || '').split('?')[0]);
      const viewer = await getViewer(request, env);
      const target: any = await getProfile(env, userId);
      if (target && target.isPrivate === true) {
        const isOwner = !!(viewer && viewer.id === userId);
        const ok = isOwner || (viewer ? await isFollowingPair(env, viewer.id, userId) : false);
        if (!ok) {
          const c = await Promise.all([readIdList(env, KEYS.FOLLOWERS(userId)), readIdList(env, KEYS.FOLLOWING(userId))]);
          return respond({ data: { count: isFollowers ? c[0].length : c[1].length, ids: [], profiles: [], restricted: true }, error: null });
        }
      }
      const ids = await readIdList(env, isFollowers ? KEYS.FOLLOWERS(userId) : KEYS.FOLLOWING(userId));
      const profiles: any[] = [];
      try {
        const head = ids.slice(0, 100);
        for (let i = 0; i < head.length; i += 20) {
          const rows = await Promise.all(head.slice(i, i + 20).map(async (pid) => {
            try {
              const raw = await env.EQUYVO_KV.get(KEYS.PROFILE(pid));
              return profileSummary(raw ? JSON.parse(raw) : null, pid);
            } catch { return profileSummary(null, pid); }
          }));
          profiles.push(...rows);
        }
      } catch { /* ids stay authoritative */ }
      return respond({ data: { count: ids.length, ids: ids.slice(0, 500), profiles }, error: null });
    }

    if (path === '/api/follow/requests' && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const reqs = await readIdList(env, KEYS.FOLLOW_REQ((actor as any).id));
      return respond({ data: { requests: reqs }, error: null });
    }

    if ((path === '/api/follow/accept' || path === '/api/follow/decline') && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const clean = sanitizeBody(raw);
      const requester = String(clean.requester || clean.userId || '').slice(0, 200);
      if (!requester) return respondError('requester required', 400);
      const reqs = await readIdList(env, KEYS.FOLLOW_REQ((actor as any).id));
      await env.EQUYVO_KV.put(KEYS.FOLLOW_REQ((actor as any).id), JSON.stringify(reqs.filter((x) => x !== requester)));
      if (path === '/api/follow/accept') {
        const [following, followers] = await Promise.all([
          readIdList(env, KEYS.FOLLOWING(requester)),
          readIdList(env, KEYS.FOLLOWERS((actor as any).id)),
        ]);
        if (!following.some((x) => x === (actor as any).id)) {
          following.unshift((actor as any).id);
          await env.EQUYVO_KV.put(KEYS.FOLLOWING(requester), JSON.stringify(following.slice(0, 5000)));
        }
        if (!followers.some((x) => x === requester)) {
          followers.unshift(requester);
          await env.EQUYVO_KV.put(KEYS.FOLLOWERS((actor as any).id), JSON.stringify(followers.slice(0, 50000)));
        }
        try {
          const me: any = await getProfile(env, (actor as any).id);
          const name = (me && (me.username || me.name)) || (actor as any).id;
          await pushUserNotification(env, requester, {
            kind: 'follow_accepted', title: 'Follow request accepted',
            body: name + ' accepted your follow request. You can now see their posts and chat.',
            actorId: (actor as any).id, actorName: String(name),
          });
        } catch { /* best-effort */ }
        return respond({ data: { accepted: true }, error: null });
      }
      return respond({ data: { declined: true }, error: null });
    }

    // ---- REPORTS (mirrors Pages Functions; checkbox reasons[] supported) ----
    if (path === '/api/report' && method === 'POST') {
      const raw = await request.json() as any;
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const clean = sanitizeBody(raw);
      const kind = String(clean.kind || clean.type || '').toLowerCase().replace(/s$/, '');
      const id = String(clean.id || clean.contentId || '').slice(0, 64);
      const picked = Array.isArray(clean.reasons) ? clean.reasons.map((r: any) => String(r).slice(0, 40)).filter(Boolean).slice(0, 10) : [];
      const reason = String(clean.reason || picked[0] || 'other').slice(0, 40);
      if (!['post', 'thought', 'story', 'moment'].includes(kind) || !id) {
        return respondError('Invalid report', 400);
      }
      const rl = await rateLimit(env, 'engagement', (actor as any).id, 30);
      if (!rl.ok) return respondError('Too many requests', 429);
      await fileReport(env, {
        kind, id, reason, reasons: picked.length ? picked : [reason],
        details: String(clean.details || clean.additionalInfo || ''),
        reporter: (actor as any).id,
      });
      return respond({ data: { ok: true }, error: null });
    }

    // GET /api/reports?limit= — admin-gated dashboard ledger with snapshots.
    if (path === '/api/reports' && method === 'GET') {
      const token = String(request.headers.get('X-Admin-Token') || '');
      const expected = String((env as any).REPORTS_ADMIN_TOKEN || '');
      if (!expected || token !== expected) return respondError('Forbidden', 403);
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100') || 100));
      const reports = await listReports(env, limit);
      return respond({ data: { reports }, error: null });
    }

    // ---- CHAT TRANSPORT (WhatsApp-style ticks, follow-gated) ----
    if (path.startsWith('/api/chat/') && path.endsWith('/send') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/send', '')).split('?')[0];
      if (!peer || peer === (actor as any).id) return respondError('Invalid peer', 400);
      const rl = await rateLimit(env, 'engagement', (actor as any).id, 60);
      if (!rl.ok) return respondError('Too many requests', 429);
      if (!(await canChat(env, (actor as any).id, peer))) {
        return respondError('You can only message accounts you follow or that follow you.', 403);
      }
      const raw = await request.json() as any;
      const clean = sanitizeBody(raw);
      const text = String(clean.text || '').slice(0, 2000);
      const type = clean.type === 'image' || clean.type === 'file' ? clean.type : 'text';
      if (!text && !clean.fileUrl) return respondError('Empty message', 400);
      const msg = {
        id: generateId(), from: (actor as any).id, to: peer, text,
        type, fileUrl: String(clean.fileUrl || '').slice(0, 2000),
        fileName: String(clean.fileName || '').slice(0, 200),
        status: 'sent', createdAt: new Date().toISOString(),
      };
      const all = await readChatMessages(env, (actor as any).id, peer, 300);
      all.push(msg);
      await writeChatMessages(env, (actor as any).id, peer, all);
      try {
        const me: any = await getProfile(env, (actor as any).id);
        const name = (me && (me.username || me.name)) || (actor as any).id;
        await pushUserNotification(env, peer, {
          kind: 'chat', title: 'New message from ' + name,
          body: text.slice(0, 120) || 'Sent you an attachment.',
          actorId: (actor as any).id, actorName: String(name),
        });
      } catch { /* ignore */ }
      return respond({ data: { id: msg.id, delivered: false }, error: null });
    }

    if (path.startsWith('/api/chat/') && path.endsWith('/messages') && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/messages', '')).split('?')[0];
      if (!peer) return respondError('Invalid peer', 400);
      if (!(await canChat(env, (actor as any).id, peer))) return respondError('Forbidden', 403);
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100') || 100));
      const all = await readChatMessages(env, (actor as any).id, peer, 300);
      let touched = false;
      for (const m of all) {
        if (m && m.to === (actor as any).id && m.status === 'sent') { m.status = 'delivered'; touched = true; }
      }
      if (touched) await writeChatMessages(env, (actor as any).id, peer, all);
      const out = all.slice(-limit).map((m) => ({
        id: m.id, threadId: peer, text: m.text, fromMe: m.from === (actor as any).id,
        status: m.from === (actor as any).id ? m.status : undefined,
        timestamp: (() => { try { return new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } })(),
        createdAt: (() => { try { return new Date(m.createdAt).getTime(); } catch { return 0; } })(),
        type: m.type, fileUrl: m.fileUrl, fileName: m.fileName,
      }));
      return respond({ data: { messages: out }, error: null });
    }

    if (path.startsWith('/api/chat/') && path.endsWith('/seen') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/seen', '')).split('?')[0];
      if (!peer) return respondError('Invalid peer', 400);
      const all = await readChatMessages(env, (actor as any).id, peer, 300);
      for (const m of all) {
        if (m && m.to === (actor as any).id) m.status = 'seen';
      }
      await writeChatMessages(env, (actor as any).id, peer, all);
      return respond({ data: { ok: true }, error: null });
    }

    if (path.startsWith('/api/chat/') && path.endsWith('/delivered') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const peer = decodeURIComponent(path.split('/api/chat/')[1].replace('/delivered', '')).split('?')[0];
      if (!peer) return respondError('Invalid peer', 400);
      const raw = await request.json().catch(() => ({})) as any;
      const id = String((raw && raw.id) || '').slice(0, 64);
      const all = await readChatMessages(env, (actor as any).id, peer, 300);
      const m = all.find((x) => x && x.id === id);
      if (m && m.status === 'sent') { m.status = 'delivered'; await writeChatMessages(env, (actor as any).id, peer, all); }
      return respond({ data: { ok: true }, error: null });
    }

    if (path === '/api/chat/threads' && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const [following, followers] = await Promise.all([
        readIdList(env, KEYS.FOLLOWING((actor as any).id)),
        readIdList(env, KEYS.FOLLOWERS((actor as any).id)),
      ]);
      const seen = new Set<string>();
      const threads: any[] = [];
      const pushPeer = (pid: string, relation: string) => {
        const k = String(pid).toLowerCase();
        if (!pid || seen.has(k)) return;
        seen.add(k);
        threads.push({ id: pid, peerId: pid, relation });
      };
      followers.forEach((f) => pushPeer(f, following.some((x) => String(x).toLowerCase() === String(f).toLowerCase()) ? 'mutual' : 'follower'));
      following.forEach((f) => pushPeer(f, 'following'));
      return respond({ data: { threads: threads.slice(0, 300) }, error: null });
    }

    // ---- NOTIFICATIONS ----
    if (path === '/api/notifications' && method === 'GET') {
      const { actor, error } = await requireActor();
      if (error) return error;
      let stored: any[] = [];
      try {
        const r = await env.EQUYVO_KV.get(KEYS.NOTIF((actor as any).id));
        const a = r ? JSON.parse(r) : [];
        stored = Array.isArray(a) ? a : [];
      } catch { stored = []; }
      const reqs = await readIdList(env, KEYS.FOLLOW_REQ((actor as any).id));
      const items = [...stored];
      for (const req of reqs.slice(0, 20)) {
        if (!items.some((n) => n && n.id === 'followreq-' + req)) {
          items.unshift({
            id: 'followreq-' + req, kind: 'follow_request', title: 'New follow request',
            body: req + ' requested to follow you. Approve or decline from notifications.',
            at: new Date().toISOString(), read: false, actorId: req, actorName: req,
          });
        }
      }
      return respond({ data: { items: items.slice(0, 100) }, error: null });
    }

    if (path === '/api/notifications/read' && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const raw = await request.json().catch(() => ({})) as any;
      const ids = Array.isArray(raw.ids) ? raw.ids.map(String) : null;
      try {
        const r = await env.EQUYVO_KV.get(KEYS.NOTIF((actor as any).id));
        const arr = r ? JSON.parse(r) : [];
        const next = (Array.isArray(arr) ? arr : []).map((n: any) => (
          !ids || ids.includes(String(n.id)) ? { ...n, read: true } : n
        ));
        await env.EQUYVO_KV.put(KEYS.NOTIF((actor as any).id), JSON.stringify(next.slice(0, 100)));
      } catch { /* ignore */ }
      return respond({ data: { ok: true }, error: null });
    }

    // ---- LIVE PRESENCE ----
    if ((path === '/api/live/start' || path === '/api/live/stop') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const starting = path === '/api/live/start';
      try {
        const me: any = (await getProfile(env, (actor as any).id)) || { id: (actor as any).id };
        me.isLive = starting;
        me.liveAt = starting ? new Date().toISOString() : null;
        await upsertProfile(env, me);
      } catch { /* ignore */ }
      if (starting) {
        const fan = (async () => {
          try {
            const followers = await readIdList(env, KEYS.FOLLOWERS((actor as any).id));
            const me: any = await getProfile(env, (actor as any).id);
            const name = (me && (me.username || me.name)) || (actor as any).id;
            await Promise.all(followers.slice(0, 50).map((fid) =>
              pushUserNotification(env, fid, {
                kind: 'live', title: name + ' is live now',
                body: 'Tap to watch ' + name + ' live.',
                actorId: (actor as any).id, actorName: String(name),
              }).catch(() => {})));
          } catch { /* ignore */ }
        })();
        if (ctx && ctx.waitUntil) ctx.waitUntil(fan);
        else void fan;
      }
      return respond({ data: { live: starting }, error: null });
    }

    if (path === '/api/live/now' && method === 'GET') {
      const viewer = await getViewer(request, env);
      if (!viewer) return respond({ data: { live: [] }, error: null });
      const following = await readIdList(env, KEYS.FOLLOWING(viewer.id));
      const live: any[] = [];
      for (const pid of following.slice(0, 200)) {
        try {
          const p: any = await getProfile(env, pid);
          if (p && p.isLive === true) live.push(profileSummary(p, pid));
        } catch { /* ignore */ }
        if (live.length >= 20) break;
      }
      return respond({ data: { live }, error: null });
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
      // isAiRecommended is honest: true only when interest ranking applied.
      // Zero-match queries return empty (the app shows "No results found").
      const isAiRecommended = personalized;
      return respond({ data: { results: filtered, users: [], totalCount, userCount: 0, isAiRecommended, personalized } });
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

    // ---- COMMENTS (mirrors Pages Functions) ----
    // Persistent per-media discussions with real server-resolved identity,
    // replies, likes, shares, pins + owner enable/disable switch.
    if (path === '/api/comments' && method === 'GET') {
      const contentId = String(url.searchParams.get('contentId') || url.searchParams.get('content_id') || url.searchParams.get('postId') || '').slice(0, 64);
      if (!contentId) return respondError('contentId required', 400);
      const found = await findContentById(env, contentId);
      if (!found) return respondError('Content not found', 404);
      const viewer = await getViewer(request, env);
      const settings = await getCommentSettings(env, contentId, found.item);
      const ownerId = String(found.item.ownerId || found.item.userId || found.item.user_id || '');
      const ids = await readCommentList(env, contentId);
      const rows: any[] = [];
      for (const cid of ids.slice(0, 200)) {
        try {
          const raw = await env.EQUYVO_KV.get(KEYS.COMMENT(cid));
          if (raw) {
            const c = JSON.parse(raw);
            if (c && c.contentId === contentId) rows.push(c);
          }
        } catch { /* skip */ }
      }
      for (const c of rows) {
        try {
          const p: any = await getProfile(env, String(c.authorId));
          if (p) {
            const nm = cleanCommentName(p.username || p.name, { username: c.authorUsername, email: '' });
            if (nm) { c.authorName = nm; c.authorUsername = nm; }
            c.authorAvatar = cleanCommentAvatar(p.avatar);
          } else {
            c.authorAvatar = cleanCommentAvatar(c.authorAvatar);
          }
        } catch { /* keep stored identity */ }
      }
      const byId = new Map(rows.map((c) => [String(c.id), c]));
      const tops: any[] = [];
      for (const c of rows) {
        const pid = c.parentId ? String(c.parentId) : '';
        if (pid && byId.has(pid) && pid !== String(c.id)) {
          const parent = byId.get(pid);
          parent.replies = parent.replies || [];
          parent.replies.push(c);
        } else tops.push(c);
      }
      for (const t of tops) {
        if (Array.isArray(t.replies)) {
          t.replies.sort((a: any, b: any) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
          t.repliesCount = t.replies.length;
        }
      }
      tops.sort((a, b) => ((!!a.isPinned === !!b.isPinned) ? String(b.createdAt || '').localeCompare(String(a.createdAt || '')) : (a.isPinned ? -1 : 1)));
      const vid = viewer ? viewer.id : '';
      const pub = tops.map((t) => {
        const o = toPublicComment(t, vid);
        if (o && Array.isArray(t.replies)) o.replies = t.replies.map((r: any) => toPublicComment(r, vid));
        return o;
      }).filter(Boolean);
      return respond({ data: { comments: pub, totalCount: rows.length, commentsEnabled: settings.commentsEnabled, ownerId, isOwner: !!(viewer && ownerId && viewer.id === ownerId) }, error: null });
    }

    if (path === '/api/comments' && method === 'POST') {
      let raw: any = {};
      try { raw = await request.json(); } catch { return respondError('Invalid JSON body', 400); }
      const { actor, error } = await requireActor(raw);
      if (error) return error;
      const rl = await rateLimit(env, 'engagement', (actor as any).id, 30);
      if (!rl.ok) return respondError('Too many requests', 429);
      const body = sanitizeBody(raw);
      const contentId = String(body.contentId || body.content_id || body.postId || '').slice(0, 64);
      const text = String(body.text || body.content || '').trim().slice(0, 1000);
      if (!contentId) return respondError('contentId required', 400);
      if (!text) return respondError('Comment text required', 400);
      const found = await findContentById(env, contentId);
      if (!found) return respondError('Content not found', 404);
      const ownerId = String(found.item.ownerId || found.item.userId || found.item.user_id || '');
      const isOwner = !!(ownerId && ownerId === (actor as any).id);
      const settings = await getCommentSettings(env, contentId, found.item);
      if (!settings.commentsEnabled && !isOwner) return respondError('Comments are turned off for this post.', 403);
      let parentId: string | null = null;
      let parent: any = null;
      const wantParent = String(body.parentId || body.parent_id || '').slice(0, 64);
      if (wantParent) {
        try {
          const praw = await env.EQUYVO_KV.get(KEYS.COMMENT(wantParent));
          parent = praw ? JSON.parse(praw) : null;
        } catch { parent = null; }
        if (!parent || parent.contentId !== contentId) return respondError('Reply target not found', 404);
        parentId = parent.parentId ? String(parent.parentId) : String(parent.id);
      }
      const author = await resolveCommentAuthor(env, actor);
      const now = new Date().toISOString();
      const comment = {
        id: generateId(), contentId, contentKind: found.kind, parentId,
        authorId: author.id, authorName: author.name, authorUsername: author.username, authorAvatar: author.avatar,
        text, createdAt: now, updatedAt: now, likes: 0, likedBy: [], shares: 0,
        repliesCount: 0, isPinned: false, isEdited: false,
      };
      await env.EQUYVO_KV.put(KEYS.COMMENT(comment.id), JSON.stringify(comment));
      const ids = await readCommentList(env, contentId);
      ids.unshift(comment.id);
      await env.EQUYVO_KV.put(KEYS.COMMENTS(contentId), JSON.stringify(ids.slice(0, 1000)));
      if (parentId) {
        try {
          const rraw = await env.EQUYVO_KV.get(KEYS.COMMENT(parentId));
          if (rraw) {
            const root = JSON.parse(rraw);
            root.repliesCount = Number(root.repliesCount || 0) + 1;
            await env.EQUYVO_KV.put(KEYS.COMMENT(parentId), JSON.stringify(root));
          }
        } catch { /* ignore */ }
      }
      const total = await readCommentList(env, contentId);
      await syncContentCommentCount(env, found, total.length);
      try { await bumpPopularity(env, contentId, 3); } catch {}
      try { await recordEngagement(env, (actor as any).id, { action: 'comment' }); } catch {}
      try {
        if (ownerId && ownerId !== (actor as any).id) {
          await pushUserNotification(env, ownerId, { kind: 'comment', title: 'New comment', body: author.name + ' commented: ' + text.slice(0, 120), actorId: (actor as any).id, actorName: author.name, contentId });
        }
      } catch { /* ignore */ }
      return respond({ data: { comment: toPublicComment(comment, (actor as any).id) }, error: null }, 201);
    }

    const wCommentMatch = path.match(/^\/api\/comments\/([^/]+)(\/(like|share|pin))?$/);
    if (wCommentMatch && (method === 'PUT' || method === 'DELETE' || method === 'POST')) {
      const cid = decodeURIComponent(wCommentMatch[1] || '').split('?')[0].slice(0, 64);
      const wAction = wCommentMatch[3] || '';
      let craw: string | null = null;
      try { craw = await env.EQUYVO_KV.get(KEYS.COMMENT(cid)); } catch { craw = null; }
      if (!craw) return respondError('Comment not found', 404);
      let wComment: any = null;
      try { wComment = JSON.parse(craw); } catch { return respondError('Comment not found', 404); }
      const wFound = await findContentById(env, wComment.contentId);
      const wOwnerId = wFound ? String(wFound.item.ownerId || wFound.item.userId || wFound.item.user_id || '') : '';
      if (method === 'PUT' && !wAction) {
        let praw: any = {};
        try { praw = await request.json(); } catch { return respondError('Invalid JSON body', 400); }
        const { actor, error } = await requireActor(praw);
        if (error) return error;
        if (String(wComment.authorId) !== String((actor as any).id)) return respondError('Only the author can edit this comment.', 403);
        const clean = sanitizeBody(praw);
        const text = String(clean.text || clean.content || '').trim().slice(0, 1000);
        if (!text) return respondError('Comment text required', 400);
        wComment.text = text;
        wComment.isEdited = true;
        wComment.updatedAt = new Date().toISOString();
        await env.EQUYVO_KV.put(KEYS.COMMENT(cid), JSON.stringify(wComment));
        return respond({ data: { comment: toPublicComment(wComment, (actor as any).id) }, error: null });
      }
      if (method === 'DELETE' && !wAction) {
        const { actor, error } = await requireActor();
        if (error) return error;
        const isAuthor = String(wComment.authorId) === String((actor as any).id);
        const isContentOwner = !!(wOwnerId && wOwnerId === String((actor as any).id));
        if (!isAuthor && !isContentOwner) return respondError('Only the author or the post owner can delete this comment.', 403);
        const ids = await readCommentList(env, wComment.contentId);
        const toDelete = [cid];
        for (const oid of ids) {
          if (oid === cid) continue;
          try {
            const oraw = await env.EQUYVO_KV.get(KEYS.COMMENT(oid));
            const o = oraw ? JSON.parse(oraw) : null;
            if (o && String(o.parentId || '') === String(cid)) toDelete.push(oid);
          } catch { /* ignore */ }
        }
        for (const d of toDelete) {
          try { await env.EQUYVO_KV.delete(KEYS.COMMENT(d)); } catch { /* ignore */ }
        }
        const gone = new Set(toDelete);
        await env.EQUYVO_KV.put(KEYS.COMMENTS(wComment.contentId), JSON.stringify(ids.filter((x) => !gone.has(x)).slice(0, 1000)));
        const remaining = await readCommentList(env, wComment.contentId);
        await syncContentCommentCount(env, await findContentById(env, wComment.contentId), remaining.length);
        return respond({ data: { ok: true, deleted: toDelete.length }, error: null });
      }
      if (method === 'POST' && wAction === 'like') {
        const { actor, error } = await requireActor();
        if (error) return error;
        const likedBy: string[] = Array.isArray(wComment.likedBy) ? wComment.likedBy.map(String) : [];
        const has = likedBy.some((x) => x === String((actor as any).id));
        wComment.likedBy = has ? likedBy.filter((x) => x !== String((actor as any).id)) : [String((actor as any).id), ...likedBy].slice(0, 5000);
        wComment.likes = wComment.likedBy.length;
        await env.EQUYVO_KV.put(KEYS.COMMENT(cid), JSON.stringify(wComment));
        return respond({ data: { comment: toPublicComment(wComment, (actor as any).id) }, error: null });
      }
      if (method === 'POST' && wAction === 'share') {
        const { actor, error } = await requireActor();
        if (error) return error;
        wComment.shares = Number(wComment.shares || 0) + 1;
        await env.EQUYVO_KV.put(KEYS.COMMENT(cid), JSON.stringify(wComment));
        const shareUrl = new URL(request.url).origin + '/app/home?comment=' + encodeURIComponent(cid);
        return respond({ data: { comment: toPublicComment(wComment, (actor as any).id), shareUrl, shareText: String(wComment.text || '').slice(0, 200) }, error: null });
      }
      if (method === 'POST' && wAction === 'pin') {
        const { actor, error } = await requireActor();
        if (error) return error;
        if (!wOwnerId || wOwnerId !== String((actor as any).id)) return respondError('Only the post owner can pin comments.', 403);
        wComment.isPinned = !wComment.isPinned;
        await env.EQUYVO_KV.put(KEYS.COMMENT(cid), JSON.stringify(wComment));
        return respond({ data: { comment: toPublicComment(wComment, (actor as any).id) }, error: null });
      }
      return respondError('Not found: ' + path, 404);
    }

    const wCsetMatch = path.match(/^\/api\/content\/([^/]+)\/comment-settings$/);
    if (wCsetMatch && method === 'PUT') {
      let sraw: any = {};
      try { sraw = await request.json(); } catch { return respondError('Invalid JSON body', 400); }
      const { actor, error } = await requireActor(sraw);
      if (error) return error;
      const contentId = decodeURIComponent(wCsetMatch[1] || '').split('?')[0].slice(0, 64);
      const wFound = await findContentById(env, contentId);
      if (!wFound) return respondError('Content not found', 404);
      const wOwner = String(wFound.item.ownerId || wFound.item.userId || wFound.item.user_id || '');
      if (!wOwner || wOwner !== String((actor as any).id)) return respondError('Only the account that posted this can change comment settings.', 403);
      const clean = sanitizeBody(sraw);
      const enabled = clean.enabled !== false && clean.commentsEnabled !== false && clean.disabled !== true;
      await env.EQUYVO_KV.put(KEYS.CSETTINGS(contentId), JSON.stringify({ commentsEnabled: enabled, updatedAt: new Date().toISOString() }));
      try {
        const it = { ...wFound.item, commentsEnabled: enabled };
        await env.EQUYVO_KV.put(wFound.getKey(wFound.id), JSON.stringify(it));
      } catch { /* settings key stays authoritative */ }
      return respond({ data: { contentId, commentsEnabled: enabled }, error: null });
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
