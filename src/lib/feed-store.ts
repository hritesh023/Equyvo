// ── Equyvo unified feed store ───────────────────────────────────────────────
// Single source of truth for content-type routing + follow graph + media URLs.
// Guarantees:
//  - every upload lands in the RIGHT surfaces only (strict type routing)
//  - every surface refreshes live on `userPostCreated` / `userPostDeleted`
//  - photo previews show the FULL image (no object-cover cropping)
//  - video moments never show a photo thumbnail and vice-versa

import api from './api';
import { fetchMoments, fetchPosts, fetchStories } from './data';
import { getThoughts } from './thoughts';

export type FeedContentType =
  | 'post'
  | 'photo'
  | 'video'
  | 'moment'
  | 'thought'
  | 'story'
  | 'text-story'
  | 'live';

export interface UnifiedItem {
  id: string;
  type: FeedContentType | string;
  user?: string;
  creator?: string;
  userId?: string;
  avatar?: string;
  content?: string;
  title?: string;
  image?: string;
  thumbnail?: string;
  media?: string;
  videoUrl?: string;
  video?: string;
  mediaType?: string;
  createdAt?: string;
  created_at?: string;
  time?: string;
  likes?: number;
  likes_count?: number;
  comments?: number;
  comments_count?: number;
  shares?: number;
  views?: number | string;
  category?: string;
  tags?: string[];
  isLive?: boolean;
  live?: boolean;
  [key: string]: unknown;
}

// ── Type routing: which surfaces may show which types ──────────────────────
// Rule: a photo uploaded via Photos NEVER appears in Moments; a moment NEVER
// appears in the photo-only grid, etc. ForYou/Following/Discover are curated
// unions (not "everything dumped everywhere").

const SURFACE_ALLOWLIST: Record<string, Set<string>> = {
  // Vertical short-video feed: moments only.
  moments: new Set(['moment']),
  // Text-first feed: thoughts only.
  thoughts: new Set(['thought']),
  // Story rail: stories only.
  stories: new Set(['story', 'text-story']),
  // Personalised home feed: everything EXCEPT ephemeral stories/live.
  // (stories live in the rail; live has its own banner.)
  foryou: new Set(['post', 'photo', 'video', 'moment', 'thought']),
  // Same as ForYou but restricted to followed creators.
  following: new Set(['post', 'photo', 'video', 'moment', 'thought']),
  // Explore: durable media (no ephemeral stories).
  discover: new Set(['post', 'photo', 'video', 'moment', 'thought', 'live']),
};

export function allowedForSurface(type: string | undefined, surface: keyof typeof SURFACE_ALLOWLIST): boolean {
  if (!type) return false;
  const t = String(type).toLowerCase();
  // Legacy aliases: backend stores posts for photos/videos.
  const norm = t === 'image' ? 'photo' : t;
  return SURFACE_ALLOWLIST[surface]?.has(norm) ?? false;
}

// ── Media helpers: resolve display URLs without ever mixing photo/video ────

export function isVideoItem(item: UnifiedItem): boolean {
  if (String(item.mediaType || '').toLowerCase() === 'video') return true;
  const v = item.videoUrl || item.video || '';
  const img = item.image || item.thumbnail || item.media || '';
  // A video URL that differs from the image is a real video.
  if (typeof v === 'string' && v && v !== img) return true;
  if (String(item.type).toLowerCase() === 'video') return Boolean(v);
  if (String(item.type).toLowerCase() === 'moment') {
    // Moments can be photo OR video — trust mediaType/videoUrl, not the type.
    return Boolean(v);
  }
  return false;
}

/** Best playable video URL (empty when the item is photo/text-only). */
export function videoUrlOf(item: UnifiedItem): string {
  const v = (item.videoUrl || item.video || '') as string;
  if (v) return v;
  // Some writers store the video in `media` with mediaType=video.
  if (String(item.mediaType).toLowerCase() === 'video' && typeof item.media === 'string') return item.media;
  return '';
}

/**
 * Best full (uncropped) image URL for previews.
 * Never returns a video URL — callers must use videoUrlOf() for video.
 */
export function imageUrlOf(item: UnifiedItem): string {
  const candidates = [item.image, item.thumbnail, typeof item.media === 'string' ? item.media : '', item.fallbackImage as string];
  for (const c of candidates) {
    if (typeof c === 'string' && c && !c.endsWith('.mp4') && !c.includes('/video/upload/')) return c;
    // Hosted video delivery URLs are the exception — skip them here.
    if (typeof c === 'string' && c && c.includes('res.cloudinary.com/') && c.includes('/video/')) continue;
    if (typeof c === 'string' && c && (c.startsWith('http') || c.startsWith('/') || c.startsWith('blob:') || c.startsWith('data:'))) {
      // Direct video file URLs end with .mp4/.webm/.mov — skip those too.
      if (/\.(mp4|webm|mov)(\?|$)/i.test(c)) continue;
      return c;
    }
  }
  return '';
}

/** Creator display name regardless of which field the writer used. */
export function creatorOf(item: UnifiedItem): string {
  return String(item.user || item.creator || item.user_id || item.userId || 'Unknown');
}

/** Best display image for a story card/viewer (photo itself or video poster).
 * Prefers an uploaded custom cover (`thumbnail`), then the photo, then any
 * non-video media URL. Never returns a video URL. */
export function storyImageOf(item: unknown): string {
  const s = (item || {}) as Record<string, unknown>;
  const media = typeof s.media === 'string' ? s.media : '';
  const candidates = [s.thumbnail, s.image, media, s.fallbackImage];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    // Skip playable video URLs — callers use storyVideoOf() for those.
    if (/\.(mp4|webm|mov)(\?|$)/i.test(c)) continue;
    if (c.includes('/video/upload/')) continue;
    return c;
  }
  return '';
}

/** Best playable video URL for a story (empty for photo/text stories). */
export function storyVideoOf(item: unknown): string {
  const s = (item || {}) as Record<string, unknown>;
  const direct = (s.video || s.videoUrl || '') as string;
  if (typeof direct === 'string' && direct) return direct;
  const media = typeof s.media === 'string' ? s.media : '';
  if (String(s.mediaType || '').toLowerCase() === 'video' && media) return media;
  if (String(s.type || '').toLowerCase() === 'video' && media && /\.(mp4|webm|mov)(\?|$)/i.test(media)) return media;
  return '';
}

/** Stable timestamp for sorting (newest first). */
export function timeOf(item: UnifiedItem): number {
  const raw = item.createdAt || item.created_at || item.publishedAt || item.time;
  const t = raw ? new Date(String(raw)).getTime() : NaN;
  if (Number.isFinite(t)) return t;
  const idNum = parseInt(String(item.id || '').slice(0, 13), 10);
  return Number.isFinite(idNum) ? idNum : 0;
}

// ── Per-viewer hide list ───────────────────────────────────────────────────
// Hiding is strictly personal: it removes the item from THIS account's view
// only (all devices via server fetch + local filter). It never deletes
// anything from Equyvo — only the owning account can delete its content.
const HIDDEN_KEY = 'equyvo_hidden_ids';

export function getHiddenIds(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isHidden(id: string): boolean {
  if (!id) return false;
  try {
    return getHiddenIds().includes(String(id));
  } catch {
    return false;
  }
}

export function hideFromMyView(id: string): string[] {
  const cur = getHiddenIds();
  const sid = String(id);
  const next = cur.includes(sid) ? cur : [...cur, sid].slice(-2000);
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent('contentHidden', { detail: { id: sid } }));
    window.dispatchEvent(new CustomEvent('feedRefresh'));
  } catch { /* ignore */ }
  return next;
}

export function unhideFromMyView(id: string): string[] {
  const next = getHiddenIds().filter((x) => x !== String(id));
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent('feedRefresh'));
  } catch { /* ignore */ }
  return next;
}

/** Drop per-viewer-hidden items from any feed list. */
export function withoutHidden<T extends { id?: string }>(items: T[]): T[] {
  let hidden: Set<string>;
  try {
    hidden = new Set(getHiddenIds());
  } catch {
    return items;
  }
  if (!hidden.size) return items;
  return items.filter((i) => !hidden.has(String((i as { id?: string }).id)));
}

// ── Follow graph (local, instant, cross-tab) ───────────────────────────────
// Local mirror of the server-side follow graph (see api.follow/unfollow).
// The server is the source of truth across devices; this keeps the UI instant.

const FOLLOW_KEY = 'equyvo_following';

export function getFollowing(): string[] {
  try {
    const raw = localStorage.getItem(FOLLOW_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isFollowing(name: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return getFollowing().some((f) => f.toLowerCase() === lower);
}

export function setFollowing(name: string, follow: boolean): string[] {
  const cur = getFollowing();
  const lower = String(name || '').toLowerCase();
  let next: string[];
  if (follow) {
    next = cur.some((f) => f.toLowerCase() === lower) ? cur : [...cur, String(name)];
  } else {
    next = cur.filter((f) => f.toLowerCase() !== lower);
  }
  try {
    localStorage.setItem(FOLLOW_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent('followChanged', { detail: { following: next } }));
  } catch { /* ignore */ }
  return next;
}

export function toggleFollowing(name: string): { following: boolean; list: string[] } {
  const nextFollowing = !isFollowing(name);
  const list = setFollowing(name, nextFollowing);
  return { following: nextFollowing, list };
}

// ── Unified fetchers ───────────────────────────────────────────────────────

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** Fetch every durable type once; callers filter via allowedForSurface(). */
export async function fetchUnifiedFeed(): Promise<UnifiedItem[]> {
  const [posts, moments, stories] = await Promise.all([
    safe(fetchPosts(undefined, 50), []),
    safe(fetchMoments(30), []),
    safe(fetchStories(20), []),
  ]);
  const thoughtsRes = await safe(getThoughts(30, 0), { data: [] as never[], error: null });
  const thoughts = (thoughtsRes as { data: UnifiedItem[] }).data || [];

  const norm = [
    ...(posts as UnifiedItem[]),
    ...(moments as UnifiedItem[]),
    ...(stories as UnifiedItem[]),
    ...thoughts.map((t) => ({ ...t, type: 'thought' as const })),
  ];
  // Newest first — uploads appear instantly at the top.
  // Per-viewer hides apply everywhere (hidden ≠ deleted: only the owner can
  // delete; everyone else only hides from their own view).
  return withoutHidden(norm.sort((a, b) => timeOf(b) - timeOf(a)));
}

export async function fetchSurfaceFeed(
  surface: keyof typeof SURFACE_ALLOWLIST,
  opts?: { followingOnly?: boolean; userId?: string },
): Promise<UnifiedItem[]> {
  const all = await fetchUnifiedFeed();
  let items = all.filter((i) => allowedForSurface(String(i.type || 'post'), surface));
  if (opts?.followingOnly) {
    const following = getFollowing().map((f) => f.toLowerCase());
    const followingSet = new Set(following);
    items = items.filter((i) => {
      const c = creatorOf(i).toLowerCase();
      if (followingSet.has(c)) return true;
      // Server-flagged following + own posts (so a new user sees their upload).
      if ((i as { isFollowing?: boolean }).isFollowing) return true;
      if (opts.userId && String(i.userId || i.user_id || '').toLowerCase() === String(opts.userId).toLowerCase()) return true;
      return false;
    });
  }
  return items;
}

/** Notify every feed surface that fresh content exists (profile already does). */
export function broadcastPostCreated(post: Record<string, unknown>, type: string): void {
  try {
    window.dispatchEvent(new CustomEvent('userPostCreated', { detail: { post, type } }));
    // Dedicated channels so Moments/Thoughts/Discover refresh even if they
    // ignore the generic event today.
    const channel =
      type === 'moment' ? 'momentCreated' : type === 'thought' ? 'thoughtCreated' : type === 'story' || type === 'text-story' ? 'storyUploaded' : 'feedRefresh';
    window.dispatchEvent(new CustomEvent(channel, { detail: { post, type } }));
  } catch { /* ignore */ }
}

/** Generate a client-side poster for videos that arrived without a thumbnail.
 * Returns '' for non-video files. Never throws. */
export function captureVideoPoster(file: File | Blob): Promise<string> {
  return new Promise((resolve) => {
    try {
      if (typeof document === 'undefined') return resolve('');
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = url;
      const done = (poster: string) => {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        resolve(poster);
      };
      video.onloadeddata = () => {
        try {
          video.currentTime = Math.min(0.5, (video.duration || 1) / 3);
        } catch { done(''); }
      };
      video.onseeked = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth || 320;
          canvas.height = video.videoHeight || 480;
          const ctx = canvas.getContext('2d');
          if (!ctx) return done('');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          done(canvas.toDataURL('image/jpeg', 0.7));
        } catch { done(''); }
      };
      video.onerror = () => done('');
      setTimeout(() => done(''), 4000);
    } catch {
      resolve('');
    }
  });
}

export { FOLLOW_KEY };
export type { UnifiedItem as FeedItem };
