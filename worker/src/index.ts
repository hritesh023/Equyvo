import { Env } from './env';
import { 
  corsHeaders, getPosts, createPost, getThoughts, createThought,
  getStories, createStory, getMoments, createMoment,
  getProfile, upsertProfile, searchContent, likePost, unlikePost, voteThought,
  indexContent, deletePost, deleteThought, deleteStory, deleteMoment, deleteUserData, KEYS
} from './kv';
import { seedKV } from './seed';

export { Env };

function jsonResponse(data: any, status = 200, env?: Env): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (env) {
    // We'll get origin from the request instead
  }
  return new Response(JSON.stringify(data), { status, headers });
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

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  // Auto-seed on first request if empty
  try {
    await seedKV(env);
  } catch (e) {
    // Ignore seed errors if already seeded
  }

  // Helper to wrap responses with CORS
  const respond = (data: any, status = 200): Response => {
    const res = jsonResponse(data, status);
    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  };

  const respondError = (msg: string, status = 400): Response => {
    const res = errorResponse(msg, status);
    Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
    return res;
  };

  try {
    // === POSTS ===
    if (path === '/api/posts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const posts = await getPosts(env, limit);
      return respond({ data: posts, error: null });
    }

    if (path === '/api/posts' && method === 'POST') {
      const body = await request.json() as any;
      const post = await createPost(env, body);
      return respond({ data: post, error: null }, 201);
    }

    if (path.startsWith('/api/posts/') && method === 'GET') {
      const id = path.split('/api/posts/')[1];
      const json = await env.EQUYVO_KV.get(KEYS.POST(id));
      if (!json) return respondError('Post not found', 404);
      return respond({ data: JSON.parse(json), error: null });
    }

    // === POST LIKES ===
    if (path.startsWith('/api/posts/') && path.endsWith('/like') && method === 'POST') {
      const id = path.split('/api/posts/')[1].replace('/like', '');
      const result = await likePost(env, id);
      return respond({ data: result, error: null });
    }

    if (path.startsWith('/api/posts/') && path.endsWith('/unlike') && method === 'POST') {
      const id = path.split('/api/posts/')[1].replace('/unlike', '');
      const result = await unlikePost(env, id);
      return respond({ data: result, error: null });
    }

    // === THOUGHTS ===
    if (path === '/api/thoughts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const { data: thoughts } = await getThoughts(env, limit, offset);
      return respond({ data: thoughts, error: null });
    }

    if (path === '/api/thoughts' && method === 'POST') {
      const body = await request.json() as any;
      const thought = await createThought(env, body);
      return respond({ data: thought, error: null }, 201);
    }

    if (path.startsWith('/api/thoughts/') && path.endsWith('/vote') && method === 'POST') {
      const id = path.split('/api/thoughts/')[1].replace('/vote', '');
      const body = await request.json() as any;
      const result = await voteThought(env, id, body.vote_type);
      return respond({ data: result, error: null });
    }

    // === STORIES ===
    if (path === '/api/stories' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const stories = await getStories(env, limit);
      return respond({ data: stories, error: null });
    }

    if (path === '/api/stories' && method === 'POST') {
      const body = await request.json() as any;
      const story = await createStory(env, body);
      return respond({ data: story, error: null }, 201);
    }

    // === MOMENTS ===
    if (path === '/api/moments' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const moments = await getMoments(env, limit);
      return respond({ data: moments, error: null });
    }

    if (path === '/api/moments' && method === 'POST') {
      const body = await request.json() as any;
      const moment = await createMoment(env, body);
      return respond({ data: moment, error: null }, 201);
    }

    // === PROFILES ===
    if (path.startsWith('/api/profile/') && method === 'GET') {
      const userId = path.split('/api/profile/')[1];
      const profile = await getProfile(env, userId);
      if (!profile) return respondError('Profile not found', 404);
      return respond({ data: profile, error: null });
    }

    if (path === '/api/profile' && method === 'PUT') {
      const body = await request.json() as any;
      const profile = await upsertProfile(env, body);
      return respond({ data: profile, error: null });
    }

    // === SEARCH ===
    if (path === '/api/search' && method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const { results, totalCount } = await searchContent(env, query);
      return respond({ data: { results, totalCount, isAiRecommended: results.length === 0 } });
    }

    // === CONTENT INDEX (for upload indexing) ===
    if (path === '/api/content-index' && method === 'POST') {
      const body = await request.json() as any;
      await indexContent(env, body);
      return respond({ data: { success: true }, error: null });
    }

    // === DELETE CONTENT ===
    if (path.startsWith('/api/posts/') && method === 'DELETE') {
      const id = path.split('/api/posts/')[1];
      await deletePost(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/thoughts/') && method === 'DELETE') {
      const id = path.split('/api/thoughts/')[1];
      await deleteThought(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/stories/') && method === 'DELETE') {
      const id = path.split('/api/stories/')[1];
      await deleteStory(env, id);
      return respond({ data: { success: true }, error: null });
    }

    if (path.startsWith('/api/moments/') && method === 'DELETE') {
      const id = path.split('/api/moments/')[1];
      await deleteMoment(env, id);
      return respond({ data: { success: true }, error: null });
    }

    // === DELETE ALL USER DATA ===
    if (path.startsWith('/api/user/') && path.endsWith('/data') && method === 'DELETE') {
      const userId = path.split('/api/user/')[1].replace('/data', '');
      const result = await deleteUserData(env, userId);
      return respond({ data: { success: true, ...result }, error: null });
    }

    // === HEALTH CHECK ===
    if (path === '/api/health') {
      return respond({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // === 404 ===
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
