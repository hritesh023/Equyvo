import api from '@/lib/api';
import { getStoredUser } from '@/lib/auth';
import { Post } from '@/types';
import { isOwnContent } from '@/utils/ownership';

/**
 * Reactions are Equyvo's "repost/retweet" action. Reacting to somebody else's
 * content creates a REAL content item owned by the reacting account, labelled
 * "You reacted to this post", so it shows up in that account's own profile.
 * The backend stays authoritative: the server stamps ownership from the
 * verified caller, exactly like any normal upload.
 */

export const REACTION_LABEL = 'You reacted to this post';
export const REACTION_TYPE = 'reacted';

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** Stable, server-valid id for the mirrored reacted copy of an item. */
export function reactedCopyId(originalId: string): string {
  const safe = String(originalId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 52);
  return `react_${safe || Date.now()}`;
}

/** True when the signed-in account may react (i.e. it is NOT their own item). */
export function canReactTo(item: Record<string, unknown> | null | undefined, currentUserId?: string): boolean {
  if (!item) return false;
  if (isOwnContent(item, { currentUserId })) return false;
  // Thoughts carry their author as a nested `user` object; ownership.ts only
  // reads flat fields, so check that shape explicitly as well.
  const nestedId = norm((item as any)?.user?.id ?? (item as any)?.user?._id);
  if (nestedId) {
    const me = getStoredUser() as any;
    const mine = [me?.id, me?.email, me?.username, currentUserId].filter(Boolean).map(norm);
    if (mine.includes(nestedId)) return false;
  }
  return true;
}

/** Is this exact item the user's own "reacted" mirrored copy? */
export function isReactedCopy(item: Record<string, unknown> | null | undefined): boolean {
  if (!item) return false;
  return (
    (item as any).reacted === true ||
    norm((item as any).type) === REACTION_TYPE ||
    norm((item as any).contentType) === REACTION_TYPE
  );
}

function displayName(): string {
  const me = getStoredUser() as any;
  return String(me?.username || me?.name || (me?.email ? String(me.email).split('@')[0] : '') || 'You').slice(0, 80);
}

function currentAvatar(): string {
  try {
    const raw = localStorage.getItem('userProfile');
    const profile = raw ? JSON.parse(raw) : null;
    return String(profile?.avatar || '');
  } catch {
    return '';
  }
}

/**
 * Build the "you reacted to this post" content that becomes the user's own.
 * Media/quoted fields are copied so the reacted card is a useful quote-post,
 * while the visible caption is exactly the requested label.
 */
export function buildReactedCopy(source: Post, kind: 'post' | 'thought' = 'post'): Post {
  const id = reactedCopyId(String(source?.id || ''));
  const author = displayName();
  const originalId = String(source?.id || '');
  const originalAuthor = String(
    (source as any)?.originalAuthor ||
    (typeof source?.user === 'string' ? source.user : (source as any)?.user?.username) ||
    (source as any)?.creator ||
    '',
  ).slice(0, 80);
  const originalText = String(
    (source as any)?.quotedContent ?? source?.content ?? source?.caption ?? (source as any)?.text ?? '',
  ).slice(0, 500);

  return {
    id,
    type: REACTION_TYPE as Post['type'],
    reacted: true,
    contentType: REACTION_TYPE,
    originalPostId: originalId,
    originalThoughtId: originalId,
    originalAuthor,
    quotedContent: originalText,
    user: author,
    creator: author,
    avatar: currentAvatar(),
    content: REACTION_LABEL,
    time: 'just now',
    createdAt: new Date().toISOString(),
    likes: 0,
    comments: 0,
    shares: 0,
    reacts: 0,
    views: 0,
    visibility: (source as any)?.visibility || 'public',
    tags: ['reacted'],
    // Quote-card media (never invented — only what the original actually had).
    media: (source as any)?.media || source?.videoUrl || source?.image || '',
    videoUrl: source?.videoUrl || '',
    image: source?.image || source?.thumbnail || '',
    thumbnail: source?.thumbnail || source?.image || '',
    mediaType: (source as any)?.mediaType,
  } as Post;
}

/** Persist the reacted copy as real backend content owned by the caller. */
export async function persistReaction(
  source: Post,
  kind: 'post' | 'thought' = 'post',
): Promise<{ copy: Post | null; error: string | null }> {
  const copy = buildReactedCopy(source, kind);
  try {
    const { error } = kind === 'thought'
      ? await api.createThought(copy)
      : await api.createPost(copy);
    if (error) return { copy: null, error };
    return { copy, error: null };
  } catch (e) {
    return { copy: null, error: e instanceof Error ? e.message : 'Could not save reaction' };
  }
}

/** Remove the mirrored reacted copy when the reaction is undone. */
export async function removeReaction(originalId: string, kind: 'post' | 'thought' = 'post'): Promise<void> {
  const id = reactedCopyId(originalId);
  try {
    if (kind === 'thought') await api.deleteThought(id);
    else await api.deletePost(id);
  } catch {
    /* best effort — server ownership rules still apply */
  }
}
