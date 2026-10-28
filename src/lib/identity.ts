/**
 * One source of truth for "who is this?" in the UI.
 *
 * The app stores the auth record (`equyvo_cognito_user`) and the editable
 * profile (`userProfile`) separately. Reading either one directly produced
 * "anonymous" authors and raw ids leaking into profile headers. Everything
 * that needs a display name, username or avatar should come through here.
 */
import { getStoredUser, type User } from './auth';

const PLACEHOLDER_NAMES = new Set([
  'anonymous',
  'unknown',
  'user',
  'someone',
  'guest',
  'null',
  'undefined',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ViewerIdentity {
  id: string;
  email: string;
  name: string;
  username: string;
  avatar: string;
}

export interface ProfilePreview {
  id: string;
  name: string;
  username: string;
  avatar: string;
  bio?: string;
}

export function isEmailAddress(value: unknown): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? '').trim());
}

/** True for values that must never be shown as a person's identity. */
export function isPlaceholderName(value: unknown): boolean {
  const s = String(value ?? '').trim().replace(/^@+/, '');
  if (!s) return true;
  if (s === '[object Object]') return true;
  if (PLACEHOLDER_NAMES.has(s.toLowerCase())) return true;
  if (UUID_RE.test(s)) return true;
  return false;
}

/** First value that looks like a real display name (never an email/id). */
export function pickDisplayName(...values: unknown[]): string {
  for (const value of values) {
    if (value && typeof value === 'object') continue;
    const s = String(value ?? '').trim().replace(/^@+/, '');
    if (!s || isEmailAddress(s) || isPlaceholderName(s)) continue;
    return s.slice(0, 80);
  }
  return '';
}

/** Turn an email into a human-ish fallback without exposing the full address. */
export function nameFromEmail(email: unknown): string {
  const value = String(email ?? '').trim();
  if (!value || !isEmailAddress(value)) return '';
  const local = value.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local.slice(0, 80);
}

export function nameOfUser(user: unknown): string {
  if (!user) return '';
  if (typeof user === 'string') return pickDisplayName(user);
  if (typeof user === 'object') {
    const u = user as Record<string, unknown>;
    return pickDisplayName(u.username, u.name, u.fullName, u.handle);
  }
  return '';
}

export function usernameOfUser(user: unknown): string {
  if (!user) return '';
  if (typeof user === 'string') return pickDisplayName(user);
  if (typeof user === 'object') {
    const u = user as Record<string, unknown>;
    return pickDisplayName(u.username, u.handle, u.name);
  }
  return '';
}

/** Avatar from either a hydrated user object or a flat item. */
export function avatarOfUser(user: unknown): string {
  if (!user || typeof user !== 'object') return '';
  const u = user as Record<string, unknown>;
  const value = u.avatar_url ?? u.avatarUrl ?? u.avatar ?? u.photo ?? u.profileImage;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Safe author name for anything rendered in a feed: handles `user` being a
 * string, a hydrated object, or missing entirely.
 */
export function userNameOf(item: unknown): string {
  if (!item) return '';
  if (typeof item === 'string') return pickDisplayName(item);
  if (typeof item !== 'object') return '';
  const it = item as Record<string, unknown>;
  return (
    nameOfUser(it.user) ||
    pickDisplayName(it.userName, it.creator, it.creatorName, it.author) ||
    'User'
  );
}

function readOwnCachedProfile(user: User | null): Record<string, unknown> | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem('userProfile');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!user) return parsed as Record<string, unknown>;
    // Never borrow a cache left behind by a different account on this device.
    const cacheIds = [parsed.id, parsed._userEmail].map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
    const userIds = [user.id, user.email].map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
    if (cacheIds.length && userIds.length && !cacheIds.some((id) => userIds.includes(id))) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The freshest identity available on this device. Never returns "anonymous". */
export function currentAuthor(): ViewerIdentity {
  let user: User | null = null;
  try {
    user = getStoredUser();
  } catch { /* storage unavailable */ }

  const cached = readOwnCachedProfile(user);
  const email = String(user?.email || cached?._userEmail || '').trim();
  const id = String(user?.id || cached?.id || '').trim();

  const username =
    pickDisplayName(cached?.username, cached?.name, user?.username, user?.fullName) ||
    nameFromEmail(email);
  const name =
    pickDisplayName(cached?.name, cached?.username, user?.fullName, user?.username) ||
    username;
  const avatar = String(cached?.avatar || user?.avatar || '').trim();

  return { id, email, name, username, avatar };
}

/** Normalize a user row from search/suggestions into a profile preview. */
export function profilePreviewFrom(source: unknown): ProfilePreview | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as Record<string, unknown>;
  const id = String(s.id ?? s.userId ?? s.user_id ?? '').trim();
  const name =
    pickDisplayName(s.name, s.username, s.handle) ||
    nameFromEmail(s.email);
  const username = pickDisplayName(s.username, s.handle, s.name) || name;
  const avatar = avatarOfUser(s);
  if (!id && !name && !avatar) return null;
  const bio = typeof s.bio === 'string' ? s.bio : '';
  return { id, name: name || username, username: username || name, avatar, bio };
}
