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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

async function ensureSeeded(env) {
  const existing = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (existing) return;

  const posts = [
    { id: 'seed-1', user: 'john_doe', avatar: '', time: '2 hours ago', content: 'Just launched my new app! Check it out! #development #react', image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&h=400&fit=crop', likes: 42, reacts: 8, comments: 12, shares: 3, type: 'post', tags: ['development', 'react'], categories: ['tech'], userId: 'user1', createdAt: new Date(Date.now() - 7200000).toISOString(), isSeed: true },
    { id: 'seed-2', user: 'jane_smith', avatar: '', time: '5 hours ago', content: 'Beautiful sunset today!', image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=600&fit=crop', likes: 128, reacts: 24, comments: 18, shares: 7, type: 'post', tags: ['nature', 'sunset'], categories: ['lifestyle'], userId: 'user2', createdAt: new Date(Date.now() - 18000000).toISOString(), isSeed: true },
  ];
  const stories = [
    { id: 'seed-s1', user: 'alex_jones', avatar: '', image: 'https://images.unsplash.com/photo-1559526324-59b1a3440d8b?w=400&h=600&fit=crop', time: '30 minutes ago', type: 'image', userId: 'user4', createdAt: new Date(Date.now() - 1800000).toISOString(), isSeed: true },
    { id: 'seed-s2', user: 'sarah_creative', avatar: '', image: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=400&h=600&fit=crop', video: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', time: '1 hour ago', type: 'video', userId: 'user5', createdAt: new Date(Date.now() - 3600000).toISOString(), isSeed: true },
    { id: 'seed-s3', user: 'mike_adventures', avatar: '', image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=600&fit=crop', time: '2 hours ago', type: 'image', userId: 'user6', createdAt: new Date(Date.now() - 7200000).toISOString(), isSeed: true },
  ];
  const moments = [
    { id: 'seed-m1', user: 'mike_wilson', content: 'Quick coding session update', media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=700&fit=crop', mediaType: 'video', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', likes: 89, comments: 15, views: 342, time: '1 hour ago', userId: 'user3', createdAt: new Date(Date.now() - 3600000).toISOString(), isSeed: true },
    { id: 'seed-m2', user: 'sarah_creative', content: 'Morning inspiration!', media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4', thumbnail: 'https://images.unsplash.com/photo-1490730141103-6cac27aaab94?w=400&h=700&fit=crop', mediaType: 'video', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4', likes: 234, comments: 42, views: 1024, time: '3 hours ago', userId: 'user4', createdAt: new Date(Date.now() - 10800000).toISOString(), isSeed: true },
    { id: 'seed-m3', user: 'alex_adventures', content: 'City vibes!', media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4', thumbnail: 'https://images.unsplash.com/photo-1516373363238-71c1eee6e0c5?w=400&h=700&fit=crop', mediaType: 'video', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4', likes: 567, comments: 89, views: 2341, time: '5 hours ago', userId: 'user5', createdAt: new Date(Date.now() - 18000000).toISOString(), isSeed: true },
  ];
  const profiles = [
    { id: 'user1', name: 'John Doe', username: '@john_doe', avatar: '', bio: 'Developer & creator.', followers: 1200, following: 340 },
    { id: 'user2', name: 'Jane Smith', username: '@jane_smith', avatar: '', bio: 'Photography enthusiast.', followers: 3400, following: 520 },
  ];
  const contentIndex = [
    { id: 'c1', title: 'Amazing Sunset Photography Tips', description: 'Learn how to capture stunning sunset photos.', type: 'video', creator: 'PhotoPro', creatorAvatar: '', views: '125K', thumbnail: 'https://picsum.photos/seed/sunset1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', category: 'Photography', tags: ['photography', 'sunset', 'tips', 'camera', 'golden hour', 'landscape', 'nature'], duration: '10:24', publishedAt: '2 days ago', content: 'Learn how to capture stunning sunset photos.', likes: 12500, comments: 890 },
    { id: 'c2', title: 'Quick & Easy Dinner Recipes', description: 'Delicious recipes in under 30 minutes.', type: 'photo', creator: 'FoodieLife', creatorAvatar: '', views: '89K', thumbnail: 'https://picsum.photos/seed/food1/300/200', imageUrl: 'https://picsum.photos/seed/food1/800/600', category: 'Food', tags: ['food', 'recipes', 'dinner', 'cooking', 'quick', 'easy'], publishedAt: '1 day ago', content: 'Delicious recipes you can make in under 30 minutes.', likes: 8900, comments: 670 },
    { id: 'c3', title: 'Latest AI Trends and Developments', description: 'Newest breakthroughs in AI.', type: 'thought', creator: 'Tech Enthusiast', creatorAvatar: '', views: '245K', thumbnail: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=300&h=200&fit=crop', imageUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&fit=crop', category: 'Technology', tags: ['AI', 'technology', 'machine learning', 'future', 'innovation', 'artificial intelligence', 'tech'], publishedAt: '1 hour ago', content: 'The future of AI is here! What are your thoughts?', likes: 245, comments: 67 },
    { id: 'c4', title: 'Morning Yoga Flow for Beginners', description: 'Gentle yoga sequence for beginners.', type: 'video', creator: 'YogaGuru', creatorAvatar: '', views: '234K', thumbnail: 'https://picsum.photos/seed/yoga1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', category: 'Fitness', tags: ['yoga', 'fitness', 'morning', 'wellness', 'meditation', 'stretching', 'beginner'], duration: '15:30', publishedAt: '3 days ago', content: 'Start your day with this gentle yoga sequence.', likes: 34000, comments: 2100 },
    { id: 'c5', title: 'Hidden Gems Around the World', description: 'Beautiful hidden travel spots.', type: 'video', creator: 'alex_adventures', creatorAvatar: '', views: '230K', thumbnail: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400&h=700&fit=crop', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', category: 'Travel', tags: ['travel', 'hidden gems', 'adventure', 'explore', 'nature', 'destination'], duration: '12:15', publishedAt: '2 hours ago', content: 'The view from the top is absolutely breathtaking!', likes: 15400, comments: 892 },
    { id: 'c6', title: 'Welcome to Equyvo Community', description: 'Join our growing community.', type: 'post', creator: 'Equyvo Official', creatorAvatar: '', views: '120K', thumbnail: 'https://picsum.photos/seed/welcome1/300/200', imageUrl: 'https://picsum.photos/seed/welcome1/800/600', category: 'Lifestyle', tags: ['community', 'welcome', 'social', 'equyvo', 'connect', 'share'], publishedAt: '2 hours ago', content: 'Welcome to Equyvo! Share your first thought and connect with others.', likes: 120, comments: 15 },
  ];

  const postIds = [];
  for (const p of posts) { await env.EQUYVO_KV.put(KEYS.POST(p.id), JSON.stringify(p)); postIds.push(p.id); }
  await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(postIds));

  const storyIds = [];
  for (const s of stories) { await env.EQUYVO_KV.put(KEYS.STORY(s.id), JSON.stringify(s)); storyIds.push(s.id); }
  await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(storyIds));

  const momentIds = [];
  for (const m of moments) { await env.EQUYVO_KV.put(KEYS.MOMENT(m.id), JSON.stringify(m)); momentIds.push(m.id); }
  await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(momentIds));

  for (const p of profiles) { await env.EQUYVO_KV.put(KEYS.PROFILE(p.id), JSON.stringify(p)); }
  await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(contentIndex));
  await env.EQUYVO_KV.put(KEYS.NEXT_ID, '100');
}

// Filter out seed content when real users exist
async function filterSeed(env, items) {
  const hasReal = await env.EQUYVO_KV.get(KEYS.HAS_REAL_USERS);
  if (hasReal === 'true') {
    return items.filter(i => !i.isSeed);
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
    await ensureSeeded(env);
    // POSTS
    if (path === '/api/posts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
      if (!listJson) return json({ data: [], error: null });
      const ids = JSON.parse(listJson).slice(0, limit);
      const posts = (await Promise.all(ids.map(async (id) => {
        const p = await env.EQUYVO_KV.get(KEYS.POST(id));
        return p ? JSON.parse(p) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, posts), error: null });
    }

    if (path === '/api/posts' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const now = new Date().toISOString();
      const post = { id, time: 'just now', createdAt: now, ...body };
      await env.EQUYVO_KV.put(KEYS.POST(id), JSON.stringify(post));
      const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.slice(0, 500)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: post, error: null }, 201);
    }

    // THOUGHTS
    if (path === '/api/thoughts' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
      if (!listJson) return json({ data: [], error: null });
      const ids = JSON.parse(listJson).slice(offset, offset + limit);
      const thoughts = (await Promise.all(ids.map(async (id) => {
        const t = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
        return t ? JSON.parse(t) : null;
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
      return json({ data: thought, error: null }, 201);
    }

    // STORIES
    if (path === '/api/stories' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
      if (!listJson) return json({ data: [], error: null });
      const ids = JSON.parse(listJson).slice(0, limit);
      const stories = (await Promise.all(ids.map(async (id) => {
        const s = await env.EQUYVO_KV.get(KEYS.STORY(id));
        return s ? JSON.parse(s) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, stories), error: null });
    }

    if (path === '/api/stories' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const story = { id, time: 'just now', createdAt: new Date().toISOString(), ...body };
      await env.EQUYVO_KV.put(KEYS.STORY(id), JSON.stringify(story));
      const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.slice(0, 200)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: story, error: null }, 201);
    }

    // MOMENTS
    if (path === '/api/moments' && method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
      if (!listJson) return json({ data: [], error: null });
      const ids = JSON.parse(listJson).slice(0, limit);
      const moments = (await Promise.all(ids.map(async (id) => {
        const m = await env.EQUYVO_KV.get(KEYS.MOMENT(id));
        return m ? JSON.parse(m) : null;
      }))).filter(Boolean);
      return json({ data: await filterSeed(env, moments), error: null });
    }

    if (path === '/api/moments' && method === 'POST') {
      const body = await request.json();
      const id = generateId();
      const moment = { id, time: 'just now', createdAt: new Date().toISOString(), ...body };
      await env.EQUYVO_KV.put(KEYS.MOMENT(id), JSON.stringify(moment));
      const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
      const ids = listJson ? JSON.parse(listJson) : [];
      ids.unshift(id);
      await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.slice(0, 500)));
      await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
      return json({ data: moment, error: null }, 201);
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
      if (!query.trim()) {
        return json({ data: { results: index.slice(0, 20), totalCount: index.length, isAiRecommended: false } });
      }
      const q = query.toLowerCase();
      const matches = index.filter((item) => 
        [item.title, item.description, item.content, item.category, item.creator, ...(item.tags || [])]
          .filter(Boolean).some((text) => text.toLowerCase().includes(q))
      );
      return json({ data: { results: matches.slice(0, 20), totalCount: matches.length, isAiRecommended: matches.length === 0 } });
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
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
      if (!listJson) return json({ data: [], error: null });
      const ids = JSON.parse(listJson).slice(0, limit);
      const posts = (await Promise.all(ids.map(async (id) => {
        const p = await env.EQUYVO_KV.get(KEYS.POST(id));
        return p ? JSON.parse(p) : null;
      }))).filter(Boolean);
      const userPosts = posts.filter(p =>
        p.userId === userId || p.id === userId
      );
      return json({ data: userPosts, error: null });
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