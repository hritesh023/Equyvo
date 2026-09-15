import { Env } from './env';
import {
  corsHeaders, SECURITY_HEADERS, getPosts, getUserPosts, createPost, getThoughts, createThought,
  getStories, createStory, getMoments, createMoment,
  getProfile, upsertProfile, searchContent, likePost, unlikePost, voteThought,
  indexContent, deletePost, deleteThought, deleteStory, deleteMoment, deleteUserData,
  KEYS, purgeSeedData, SEED_PROFILE_IDS,
  getActor, bearerFrom, requiresVerifiedWrites, sanitizeBody, rateLimit, rateLimitFor,
  resolvePlan, planQuota, getUsage, addUsage, PLAN_CATALOG, PLATFORM_FEE_BPS, sha256Hex, cloudinaryVariants,
  r2KeyFor, extFromFile, r2DeliveryUrl, validMediaKey,
} from './kv';
export { Env };

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

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const origin = request.headers.get('Origin') || undefined;
  const cors = corsHeaders(origin);

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, ...SECURITY_HEADERS } });
  }

  await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
  await purgeSeedData(env);

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
      const posts = await getPosts(env, limit);
      return respond({ data: posts, error: null });
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
      return respond({ data: result, error: null });
    }

    if (path.startsWith('/api/posts/') && path.endsWith('/unlike') && method === 'POST') {
      const { actor, error } = await requireActor();
      if (error) return error;
      const id = path.split('/api/posts/')[1].replace('/unlike', '');
      const result = await unlikePost(env, id);
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
      const query = url.searchParams.get('q') || '';
      let { results, totalCount } = await searchContent(env, query);
      const hasReal = await env.EQUYVO_KV.get('has_real_users');
      if (hasReal === 'true') {
        results = results.filter(i => !(i.isSeed || (i.id && typeof i.id === 'string' && i.id.startsWith('seed-'))));
        totalCount = results.length;
      }
      return respond({ data: { results, totalCount, isAiRecommended: results.length === 0 } });
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
      return respond({ status: 'ok', version: env.APP_VERSION || '1.0.0', timestamp: new Date().toISOString() });
    }

    return respondError('Not found: ' + path, 404);
  } catch (err: any) {
    return respondError(err.message || 'Internal server error', 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
