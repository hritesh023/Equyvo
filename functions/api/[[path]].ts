// Pages Functions catch-all for /api/*
// Handles all API routes for the Equyvo app

export interface Env {
  EQUYVO_KV: KVNamespace;
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
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Prevent Cloudflare edge caching of API responses
const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...NO_CACHE_HEADERS },
  });
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



// Filter out seed/bot content when real users exist
// Checks both isSeed flag and seed-* ID prefix to handle legacy seeded data
function isSeedItem(item) {
  if (item.isSeed) return true;
  if (item.id && item.id.startsWith('seed-')) return true;
  return false;
}

async function filterSeed(env, items) {
  const hasReal = await env.EQUYVO_KV.get(KEYS.HAS_REAL_USERS);
  if (hasReal === 'true') {
    return items.filter(i => !isSeedItem(i));
  }
  return items;
}

export const onRequest = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    // Ensure seed data is always filtered out
    await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
    // POSTS
    if (path === '/api/posts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      const recent = ids.slice(0, limit);
      const posts = (await Promise.all(recent.map(async (id) => {
        const p = await env.EQUYVO_KV.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, posts), error: null });
    }

    if (path === '/api/posts' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const now = new Date().toISOString();
      const post = { id, createdAt: now, ...body };
      await env.EQUYVO_KV.put(KEYS.POST(id), JSON.stringify(post));
      const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.slice(0, 500)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: transformItem(post), error: null }, 201);
    }

    // THOUGHTS
    if (path === '/api/thoughts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const ids = await cleanOrphans(env, KEYS.THOUGHTS, KEYS.THOUGHT);
      const page = ids.slice(offset, offset + limit);
      const thoughts = (await Promise.all(page.map(async (id) => {
        const t = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
        return t ? transformItem(JSON.parse(t)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, thoughts), error: null });
    }

    if (path === '/api/thoughts' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const now = new Date().toISOString();
      const thought = { id, created_at: now, updated_at: now, ...body };
      await env.EQUYVO_KV.put(KEYS.THOUGHT(id), JSON.stringify(thought));
      const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(ids.slice(0, 500)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: transformItem(thought), error: null }, 201);
    }

    // STORIES
    if (path === '/api/stories' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const ids = await cleanOrphans(env, KEYS.STORIES, KEYS.STORY);
      const recent = ids.slice(0, limit);
      const stories = (await Promise.all(recent.map(async (id) => {
        const s = await env.EQUYVO_KV.get(KEYS.STORY(id));
        return s ? transformItem(JSON.parse(s)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, stories), error: null });
    }

    if (path === '/api/stories' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const story = { id, createdAt: new Date().toISOString(), ...body };
      await env.EQUYVO_KV.put(KEYS.STORY(id), JSON.stringify(story));
      const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.slice(0, 200)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: transformItem(story), error: null }, 201);
    }

    // MOMENTS
    if (path === '/api/moments' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const ids = await cleanOrphans(env, KEYS.MOMENTS, KEYS.MOMENT);
      const recent = ids.slice(0, limit);
      const moments = (await Promise.all(recent.map(async (id) => {
        const m = await env.EQUYVO_KV.get(KEYS.MOMENT(id));
        return m ? transformItem(JSON.parse(m)) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, moments), error: null });
    }

    if (path === '/api/moments' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const moment = { id, createdAt: new Date().toISOString(), ...body };
      await env.EQUYVO_KV.put(KEYS.MOMENT(id), JSON.stringify(moment));
      const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.slice(0, 500)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: transformItem(moment), error: null }, 201);
    }

    // PROFILE
    if (path.match(/^\/api\/profile\//) && method === 'GET') {
      const userId = path.split('/api/profile/')[1];
      const profile = await env.EQUYVO_KV.get(KEYS.PROFILE(userId));
      if (!profile) return json({ data: null, error: 'Profile not found' }, 404);
      return json({ data: JSON.parse(profile), error: null });
    }

    if (path === '/api/profile' && method === 'PUT') {
      const body = await request.json();
      await env.EQUYVO_KV.put(KEYS.PROFILE(body.id), JSON.stringify(body));
      return json({ data: body, error: null });
    }

    // SEARCH
    if (path === '/api/search' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      if (!indexJson) return json({ data: { results: [], totalCount: 0, isAiRecommended: false } });
      const index = JSON.parse(indexJson);
      // Filter out seed content from search when real users exist
      const hasReal = await env.EQUYVO_KV.get(KEYS.HAS_REAL_USERS);
      const filtered = hasReal === 'true' ? index.filter(i => !isSeedItem(i)) : index;
      if (!query.trim()) {
        return json({ data: { results: filtered.slice(0, 20).map(transformItem), totalCount: filtered.length, isAiRecommended: false } });
      }
      const q = query.toLowerCase();
      const matches = filtered.filter((item) => 
        [item.title, item.description, item.content, item.category, item.creator, ...(item.tags || [])]
          .filter(Boolean).some((text) => text.toLowerCase().includes(q))
      );
      return json({ data: { results: matches.slice(0, 20).map(transformItem), totalCount: matches.length, isAiRecommended: matches.length === 0 } });
    }

    // DELETE ENDPOINTS
    if (path.match(/^\/api\/posts\//) && method === 'DELETE') {
      const id = path.split('/api/posts/')[1];
      await env.EQUYVO_KV.delete(KEYS.POST(id));
      const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
      if (listJson) {
        const ids = JSON.parse(listJson);
        await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.filter(i => i !== id)));
      }
      const idxJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.filter(i => i.id !== id)));
      }
      return json({ data: { success: true }, error: null });
    }

    if (path.match(/^\/api\/thoughts\//) && method === 'DELETE') {
      const id = path.split('/api/thoughts/')[1];
      await env.EQUYVO_KV.delete(KEYS.THOUGHT(id));
      const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
      if (listJson) {
        const ids = JSON.parse(listJson);
        await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(ids.filter(i => i !== id)));
      }
      const idxJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.filter(i => i.id !== id)));
      }
      return json({ data: { success: true }, error: null });
    }

    if (path.match(/^\/api\/stories\//) && method === 'DELETE') {
      const id = path.split('/api/stories/')[1];
      await env.EQUYVO_KV.delete(KEYS.STORY(id));
      const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
      if (listJson) {
        const ids = JSON.parse(listJson);
        await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.filter(i => i !== id)));
      }
      const idxJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.filter(i => i.id !== id)));
      }
      return json({ data: { success: true }, error: null });
    }

    if (path.match(/^\/api\/moments\//) && method === 'DELETE') {
      const id = path.split('/api/moments/')[1];
      await env.EQUYVO_KV.delete(KEYS.MOMENT(id));
      const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
      if (listJson) {
        const ids = JSON.parse(listJson);
        await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.filter(i => i !== id)));
      }
      const idxJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(idx.filter(i => i.id !== id)));
      }
      return json({ data: { success: true }, error: null });
    }

    // DELETE ALL USER DATA
    if (path.match(/^\/api\/user\//) && path.endsWith('/data') && method === 'DELETE') {
      const userId = path.split('/api/user/')[1].replace('/data', '');
      let deletedPosts = 0, deletedThoughts = 0, deletedStories = 0, deletedMoments = 0;

      const filterList = async (listKey, getKey, delKey) => {
        const json = await env.EQUYVO_KV.get(listKey);
        if (!json) return 0;
        const ids = JSON.parse(json);
        const remaining = [];
        let deleted = 0;
        for (const id of ids) {
          const item = await env.EQUYVO_KV.get(getKey(id));
          if (item) {
            const parsed = JSON.parse(item);
            if (parsed.userId === userId || parsed.user_id === userId) {
              await env.EQUYVO_KV.delete(delKey(id));
              deleted++;
            } else {
              remaining.push(id);
            }
          }
        }
        await env.EQUYVO_KV.put(listKey, JSON.stringify(remaining));
        return deleted;
      };

      // Delete profile
      await env.EQUYVO_KV.delete(KEYS.PROFILE(userId));

      // Delete all user content
      deletedPosts = await filterList(KEYS.POSTS, KEYS.POST, KEYS.POST);
      deletedThoughts = await filterList(KEYS.THOUGHTS, KEYS.THOUGHT, KEYS.THOUGHT);
      deletedStories = await filterList(KEYS.STORIES, KEYS.STORY, KEYS.STORY);
      deletedMoments = await filterList(KEYS.MOMENTS, KEYS.MOMENT, KEYS.MOMENT);

      // Remove from content index
      const idxJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      if (idxJson) {
        const idx = JSON.parse(idxJson);
        await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(
          idx.filter(i => i.creator?.toLowerCase() !== userId.toLowerCase() && i.id !== `profile-${userId}`)
        ));
      }

      return json({ data: { success: true, deletedPosts, deletedThoughts, deletedStories, deletedMoments }, error: null });
    }

    // CLOUDINARY UPLOAD PROXY (keeps Cloudinary credentials on the server)
    if (path === '/api/upload' && method === 'POST') {
      const formData = await request.formData();
      const file = formData.get('file');
      const folder = formData.get('folder') || 'equyvo/uploads';

      if (!file) return json({ error: 'No file provided' }, 400);

      const cloudName = env.CLOUDINARY_CLOUD_NAME;
      const uploadPreset = env.CLOUDINARY_UPLOAD_PRESET;
      if (!cloudName || !uploadPreset) {
        return json({ error: 'Cloudinary not configured on server' }, 500);
      }

      const cloudForm = new FormData();
      cloudForm.append('file', file);
      cloudForm.append('upload_preset', uploadPreset);
      cloudForm.append('folder', folder);

      const resp = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, {
        method: 'POST',
        body: cloudForm,
      });

      const result = await resp.json();
      if (!resp.ok) {
        return json({ error: result.error?.message || 'Upload failed' }, 500);
      }

      return json({
        data: {
          publicId: result.public_id,
          secureUrl: result.secure_url,
          resourceType: result.resource_type,
          format: result.format,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          createdAt: result.created_at,
          duration: result.duration,
        },
        error: null,
      });
    }

    // USER POSTS
    if (path.match(/^\/api\/users\//) && path.endsWith('/posts') && method === 'GET') {
      const userId = path.split('/api/users/')[1].replace('/posts', '');
      const ids = await cleanOrphans(env, KEYS.POSTS, KEYS.POST);
      const posts = (await Promise.all(ids.map(async (id) => {
        const p = await env.EQUYVO_KV.get(KEYS.POST(id));
        return p ? transformItem(JSON.parse(p)) : null;
      }))).filter(Boolean);
      const userPosts = posts.filter(p =>
        p.userId === userId || p.id === userId
      );
      return json({ data: await filterSeed(env, userPosts), error: null });
    }

    // CONTENT INDEX
    if (path === '/api/content-index' && method === 'POST') {
      const body = await request.json();
      const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
      const index = indexJson ? JSON.parse(indexJson) : [];
      const existingIdx = index.findIndex((i) => i.id === body.id);
      if (existingIdx >= 0) index[existingIdx] = body;
      else index.unshift(body);
      await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.slice(0, 1000)));
      return json({ data: { success: true }, error: null });
    }

    // HEALTH
    if (path === '/api/health' && method === 'GET') {
      return json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    return json({ error: 'Not found: ' + method + ' ' + path }, 404);
  } catch (err) {
    return json({ error: err.message || 'Internal error' }, 500);
  }
};