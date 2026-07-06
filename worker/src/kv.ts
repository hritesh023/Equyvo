import { Env } from './env';

// KV Keys
const KEYS = {
  POSTS: 'posts:list',
  POST: (id: string) => `post:${id}`,
  THOUGHTS: 'thoughts:list',
  THOUGHT: (id: string) => `thought:${id}`,
  STORIES: 'stories:list',
  STORY: (id: string) => `story:${id}`,
  MOMENTS: 'moments:list',
  MOMENT: (id: string) => `moment:${id}`,
  PROFILE: (userId: string) => `profile:${userId}`,
  CONTENT_INDEX: 'content:index',
  NEXT_ID: 'next:id',
  HAS_REAL_USERS: 'has_real_users',
};

export { KEYS };

// --- ID Generation ---
export async function getNextId(env: Env): Promise<string> {
  const val = await env.EQUYVO_KV.get(KEYS.NEXT_ID);
  const next = val ? parseInt(val, 10) + 1 : 1;
  await env.EQUYVO_KV.put(KEYS.NEXT_ID, next.toString());
  return next.toString();
}

// --- Posts ---
export interface Post {
  id: string;
  userId: string;
  user: string;
  avatar?: string;
  time: string;
  content: string;
  image?: string;
  media?: string;
  videoUrl?: string;
  thumbnail?: string;
  likes: number;
  reacts: number;
  comments: number;
  shares: number;
  type: 'post' | 'thought' | 'moment' | 'video' | 'story';
  tags?: string[];
  categories?: string[];
  createdAt: string;
  isSeed?: boolean;
  upvotes_count?: number;
  downvotes_count?: number;
  user_vote?: 'upvote' | 'downvote' | null;
}

async function hasRealUsers(env: Env): Promise<boolean> {
  const val = await env.EQUYVO_KV.get(KEYS.HAS_REAL_USERS);
  return val === 'true';
}

export async function markHasRealUsers(env: Env): Promise<void> {
  await env.EQUYVO_KV.put(KEYS.HAS_REAL_USERS, 'true');
}

function filterSeed<T extends { isSeed?: boolean }>(items: T[], hasReal: boolean): T[] {
  if (hasReal) return items.filter(i => !i.isSeed);
  return items;
}

export async function getPosts(env: Env, limit = 50): Promise<Post[]> {
  const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (!listJson) return [];
  const ids: string[] = JSON.parse(listJson);
  const recent = ids.slice(0, limit);
  const posts = await Promise.all(
    recent.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.POST(id));
      return json ? (JSON.parse(json) as Post) : null;
    })
  );
  const hasReal = await hasRealUsers(env);
  return filterSeed(posts.filter(Boolean) as Post[], hasReal);
}

export async function createPost(env: Env, post: Omit<Post, 'id' | 'time' | 'createdAt'>): Promise<Post> {
  const id = await getNextId(env);
  const now = new Date().toISOString();
  const newPost: Post = {
    ...post,
    id,
    time: 'just now',
    createdAt: now,
  };
  await env.EQUYVO_KV.put(KEYS.POST(id), JSON.stringify(newPost));
  
  // Prepend to list
  const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);
  
  // Also index in search
  await indexContent(env, {
    id,
    title: post.content.slice(0, 100),
    description: post.content,
    type: post.type || 'post',
    creator: post.user,
    creatorAvatar: post.avatar || '',
    views: '0',
    thumbnail: post.image || post.media || '',
    imageUrl: post.image || post.media,
    videoUrl: post.videoUrl,
    category: (post.categories && post.categories[0]) || 'General',
    tags: post.tags || [],
    publishedAt: now,
    content: post.content,
    likes: 0,
    comments: 0,
  });
  
  return newPost;
}

// --- Thoughts ---
export interface Thought {
  id: string;
  user_id: string;
  content: string;
  platform: string;
  tags: string[];
  comments_count: number;
  shares_count: number;
  retweets_count: number;
  media?: { type: string; url: string; thumbnail?: string; duration?: number }[];
  likes_count: number;
  created_at: string;
  updated_at: string;
  user_vote?: 'upvote' | 'downvote' | null;
  user_has_liked?: boolean;
  isSeed?: boolean;
}

export async function getThoughts(env: Env, limit = 20, offset = 0): Promise<Thought[]> {
  const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  if (!listJson) return [];
  const ids: string[] = JSON.parse(listJson);
  const page = ids.slice(offset, offset + limit);
  const thoughts = await Promise.all(
    page.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
      return json ? (JSON.parse(json) as Thought) : null;
    })
  );
  const hasReal = await hasRealUsers(env);
  return filterSeed(thoughts.filter(Boolean) as Thought[], hasReal);
}

export async function createThought(env: Env, thought: Omit<Thought, 'id' | 'created_at' | 'updated_at'>): Promise<Thought> {
  const id = await getNextId(env);
  const now = new Date().toISOString();
  const newThought: Thought = {
    ...thought,
    id,
    created_at: now,
    updated_at: now,
  };
  await env.EQUYVO_KV.put(KEYS.THOUGHT(id), JSON.stringify(newThought));
  
  const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);
  
  return newThought;
}

// --- Stories ---
export interface Story {
  id: string;
  user: string;
  avatar?: string;
  image: string;
  video?: string;
  type: 'image' | 'video';
  time?: string;
  userId?: string;
  createdAt?: string;
  isSeed?: boolean;
}

export async function getStories(env: Env, limit = 20): Promise<Story[]> {
  const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  if (!listJson) return [];
  const ids: string[] = JSON.parse(listJson);
  const recent = ids.slice(0, limit);
  const stories = await Promise.all(
    recent.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.STORY(id));
      return json ? (JSON.parse(json) as Story) : null;
    })
  );
  const hasReal = await hasRealUsers(env);
  return filterSeed(stories.filter(Boolean) as Story[], hasReal);
}

export async function createStory(env: Env, story: Omit<Story, 'id'>): Promise<Story> {
  const id = await getNextId(env);
  const newStory: Story = {
    ...story,
    id,
    time: 'just now',
    createdAt: new Date().toISOString(),
  };
  await env.EQUYVO_KV.put(KEYS.STORY(id), JSON.stringify(newStory));
  
  const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.slice(0, 200)));
  await markHasRealUsers(env);
  
  return newStory;
}

// --- Moments ---
export interface Moment {
  id: string;
  user: string;
  content: string;
  media: string;
  thumbnail?: string;
  mediaType: 'video' | 'image';
  videoUrl?: string;
  likes: number;
  comments: number;
  views: number;
  time?: string;
  userId?: string;
  createdAt?: string;
  isSeed?: boolean;
}

export async function getMoments(env: Env, limit = 20): Promise<Moment[]> {
  const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  if (!listJson) return [];
  const ids: string[] = JSON.parse(listJson);
  const recent = ids.slice(0, limit);
  const moments = await Promise.all(
    recent.map(async (id) => {
      const json = await env.EQUYVO_KV.get(KEYS.MOMENT(id));
      return json ? (JSON.parse(json) as Moment) : null;
    })
  );
  const hasReal = await hasRealUsers(env);
  return filterSeed(moments.filter(Boolean) as Moment[], hasReal);
}

export async function createMoment(env: Env, moment: Omit<Moment, 'id'>): Promise<Moment> {
  const id = await getNextId(env);
  const newMoment: Moment = {
    ...moment,
    id,
    time: 'just now',
    createdAt: new Date().toISOString(),
  };
  await env.EQUYVO_KV.put(KEYS.MOMENT(id), JSON.stringify(newMoment));
  
  const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  const ids: string[] = listJson ? JSON.parse(listJson) : [];
  ids.unshift(id);
  await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.slice(0, 500)));
  await markHasRealUsers(env);
  
  return newMoment;
}

// --- Profiles ---
export interface UserProfile {
  id: string;
  name: string;
  username: string;
  avatar: string;
  bio: string;
  followers: number;
  following: number;
  email?: string;
  _userEmail?: string;
}

export async function getProfile(env: Env, userId: string): Promise<UserProfile | null> {
  const json = await env.EQUYVO_KV.get(KEYS.PROFILE(userId));
  return json ? JSON.parse(json) : null;
}

export async function upsertProfile(env: Env, profile: UserProfile): Promise<UserProfile> {
  await env.EQUYVO_KV.put(KEYS.PROFILE(profile.id), JSON.stringify(profile));
  return profile;
}

// --- Search Index ---
export interface ContentIndexItem {
  id: string;
  title: string;
  description: string;
  type: string;
  creator: string;
  creatorAvatar: string;
  views: string;
  thumbnail: string;
  imageUrl?: string;
  videoUrl?: string;
  category: string;
  tags: string[];
  duration?: string;
  publishedAt: string;
  content?: string;
  likes?: number;
  comments?: number;
}

export async function indexContent(env: Env, item: ContentIndexItem): Promise<void> {
  const json = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  const index: ContentIndexItem[] = json ? JSON.parse(json) : [];
  // Replace if exists, else add
  const existingIdx = index.findIndex(i => i.id === item.id);
  if (existingIdx >= 0) {
    index[existingIdx] = item;
  } else {
    index.unshift(item);
  }
  // Keep max 1000 items
  await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.slice(0, 1000)));
}

export async function searchContent(env: Env, query: string): Promise<{ results: ContentIndexItem[]; totalCount: number }> {
  const json = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (!json) return { results: [], totalCount: 0 };
  const index: ContentIndexItem[] = JSON.parse(json);
  
  if (!query.trim()) {
    return { results: index.slice(0, 20), totalCount: index.length };
  }
  
  const q = query.toLowerCase().trim();
  const scored = index.map(item => {
    let score = 0;
    const searchable = [item.title, item.description, item.content, item.category, item.creator, ...item.tags]
      .filter(Boolean).join(' ').toLowerCase();
    
    if (searchable.includes(q)) score += 100;
    if (item.title.toLowerCase().includes(q)) score += 50;
    if (item.category.toLowerCase().includes(q)) score += 40;
    if (item.creator.toLowerCase().includes(q)) score += 35;
    if (item.description.toLowerCase().includes(q)) score += 30;
    if (item.content?.toLowerCase().includes(q)) score += 25;
    
    const tagMatches = item.tags.filter(t => t.toLowerCase().includes(q)).length;
    score += tagMatches * 20;
    
    return { item, score };
  });
  
  const threshold = 10;
  const matching = scored.filter(s => s.score >= threshold);
  matching.sort((a, b) => b.score - a.score);
  
  if (matching.length === 0) {
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, 12).map(s => s.item), totalCount: index.length };
  }
  
  return { results: matching.slice(0, 20).map(s => s.item), totalCount: matching.length };
}

// --- Likes / Votes (stored in KV as counters) ---
export async function likePost(env: Env, postId: string): Promise<{ liked: boolean; likes_count: number }> {
  const postJson = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (!postJson) throw new Error('Post not found');
  const post = JSON.parse(postJson) as Post;
  post.likes += 1;
  await env.EQUYVO_KV.put(KEYS.POST(postId), JSON.stringify(post));
  return { liked: true, likes_count: post.likes };
}

export async function unlikePost(env: Env, postId: string): Promise<{ liked: boolean; likes_count: number }> {
  const postJson = await env.EQUYVO_KV.get(KEYS.POST(postId));
  if (!postJson) throw new Error('Post not found');
  const post = JSON.parse(postJson) as Post;
  post.likes = Math.max(0, post.likes - 1);
  await env.EQUYVO_KV.put(KEYS.POST(postId), JSON.stringify(post));
  return { liked: false, likes_count: post.likes };
}

export async function voteThought(env: Env, thoughtId: string, voteType: 'upvote' | 'downvote'): Promise<{ success: boolean }> {
  // For now, simple toggle in KV
  const thoughtJson = await env.EQUYVO_KV.get(KEYS.THOUGHT(thoughtId));
  if (!thoughtJson) throw new Error('Thought not found');
  const thought = JSON.parse(thoughtJson) as Thought;
  // Simple vote tracking
  await env.EQUYVO_KV.put(KEYS.THOUGHT(thoughtId), JSON.stringify(thought));
  return { success: true };
}

// --- Delete Content ---
export async function deletePost(env: Env, postId: string): Promise<boolean> {
  // Remove from KV
  await env.EQUYVO_KV.delete(KEYS.POST(postId));
  // Remove from list
  const listJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(ids.filter(id => id !== postId)));
  }
  // Remove from content index
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== postId)));
  }
  return true;
}

export async function deleteThought(env: Env, thoughtId: string): Promise<boolean> {
  await env.EQUYVO_KV.delete(KEYS.THOUGHT(thoughtId));
  const listJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(ids.filter(id => id !== thoughtId)));
  }
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== thoughtId)));
  }
  return true;
}

export async function deleteStory(env: Env, storyId: string): Promise<boolean> {
  await env.EQUYVO_KV.delete(KEYS.STORY(storyId));
  const listJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(ids.filter(id => id !== storyId)));
  }
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== storyId)));
  }
  return true;
}

export async function deleteMoment(env: Env, momentId: string): Promise<boolean> {
  await env.EQUYVO_KV.delete(KEYS.MOMENT(momentId));
  const listJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  if (listJson) {
    const ids: string[] = JSON.parse(listJson);
    await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(ids.filter(id => id !== momentId)));
  }
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(index.filter((i: any) => i.id !== momentId)));
  }
  return true;
}

export async function deleteUserData(env: Env, userId: string): Promise<{ deletedPosts: number; deletedThoughts: number; deletedStories: number; deletedMoments: number }> {
  let deletedPosts = 0, deletedThoughts = 0, deletedStories = 0, deletedMoments = 0;

  // Delete profile
  await env.EQUYVO_KV.delete(KEYS.PROFILE(userId));

  // Delete all user's posts
  const postsJson = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (postsJson) {
    const ids: string[] = JSON.parse(postsJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const postJson = await env.EQUYVO_KV.get(KEYS.POST(id));
      if (postJson) {
        const post = JSON.parse(postJson);
        if (post.userId === userId || post.user_id === userId) {
          await env.EQUYVO_KV.delete(KEYS.POST(id));
          deletedPosts++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(remaining));
  }

  // Delete all user's thoughts
  const thoughtsJson = await env.EQUYVO_KV.get(KEYS.THOUGHTS);
  if (thoughtsJson) {
    const ids: string[] = JSON.parse(thoughtsJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const thoughtJson = await env.EQUYVO_KV.get(KEYS.THOUGHT(id));
      if (thoughtJson) {
        const thought = JSON.parse(thoughtJson);
        if (thought.user_id === userId || thought.userId === userId) {
          await env.EQUYVO_KV.delete(KEYS.THOUGHT(id));
          deletedThoughts++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(remaining));
  }

  // Delete all user's stories
  const storiesJson = await env.EQUYVO_KV.get(KEYS.STORIES);
  if (storiesJson) {
    const ids: string[] = JSON.parse(storiesJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const storyJson = await env.EQUYVO_KV.get(KEYS.STORY(id));
      if (storyJson) {
        const story = JSON.parse(storyJson);
        if (story.userId === userId || story.user_id === userId) {
          await env.EQUYVO_KV.delete(KEYS.STORY(id));
          deletedStories++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(remaining));
  }

  // Delete all user's moments
  const momentsJson = await env.EQUYVO_KV.get(KEYS.MOMENTS);
  if (momentsJson) {
    const ids: string[] = JSON.parse(momentsJson);
    const remaining: string[] = [];
    for (const id of ids) {
      const momentJson = await env.EQUYVO_KV.get(KEYS.MOMENT(id));
      if (momentJson) {
        const moment = JSON.parse(momentJson);
        if (moment.userId === userId || moment.user_id === userId) {
          await env.EQUYVO_KV.delete(KEYS.MOMENT(id));
          deletedMoments++;
        } else {
          remaining.push(id);
        }
      }
    }
    await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(remaining));
  }

  // Remove from content index
  const indexJson = await env.EQUYVO_KV.get(KEYS.CONTENT_INDEX);
  if (indexJson) {
    const index = JSON.parse(indexJson);
    await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(
      index.filter((i: any) => i.creator?.toLowerCase() !== userId.toLowerCase() && i.id !== `profile-${userId}`)
    ));
  }

  return { deletedPosts, deletedThoughts, deletedStories, deletedMoments };
}

// --- CORS Helper ---
export function corsHeaders(origin?: string): Record<string, string> {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://equyvo.pages.dev',
    'https://equyvo.com',
    'https://equyvo.acronous.com',
  ];
  const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : 'http://localhost:3000';
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}
