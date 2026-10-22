import type { NavigateFunction } from 'react-router-dom';

interface User {
  id?: string;
  userId?: string;
  uid?: string;
  user_id?: string;
  ownerId?: string;
  authorId?: string;
  creatorId?: string;
  username?: string;
  handle?: string;
  name?: string;
}

/**
 * Owner-resolution for ANY content object. Real rows always store the
 * creator's account id on one of these fields (creatorId sometimes carried
 * a username historically — it is read LAST, so a username there still
 * resolves through the username route). Never invents ids.
 */
export function ownerIdOf(item: any): string {
  if (!item || typeof item !== 'object') return '';
  const candidates = [
    (item as any).userId,
    (item as any).user_id,
    (item as any).ownerId,
    (item as any).authorId,
    (item as any).uid,
    (item as any).creatorId,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (typeof c === 'number' && Number.isFinite(c)) return String(c);
  }
  // Hydrated user objects (thoughts store user: { id, username, ... }).
  const nested = (item as any).user;
  if (nested && typeof nested === 'object') {
    const nestedId = nested.id ?? nested.user_id ?? nested.userId;
    if (typeof nestedId === 'string' && nestedId.trim()) return nestedId.trim();
    const nestedName = nested.username ?? nested.handle;
    if (typeof nestedName === 'string' && nestedName.trim()) return nestedName.trim();
  }
  return '';
}

/** Placeholders that must never be treated as a real account id. */
export function isPlaceholderId(id: string | number | undefined | null): boolean {
  if (id === undefined || id === null) return true;
  const v = String(id).trim();
  if (!v) return true;
  const lowered = v.toLowerCase();
  return (
    lowered === 'unknown' ||
    lowered === 'anonymous' ||
    lowered === 'me' ||
    lowered.startsWith('user-') ||   // invented "user-{name}" placeholders
    lowered.startsWith('temp-') ||
    lowered.startsWith('guest-')
  );
}

function cleanName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/^@/, '').trim() : '';
}

/**
 * The single profile-navigation entry point.
 *
 *   navigateToProfile(navigate, ownerId, username)
 *   navigateToProfile(navigate, contentObject)
 *
 * Routes by the real owner id when one exists, else by the username
 * (/profile/@handle). NEVER falls back to the viewer's own profile — with
 * neither a real id nor a username there is no destination to show, so
 * navigation is skipped instead of landing on a wrong account.
 */
export const navigateToProfile = (
  navigate: NavigateFunction,
  userIdOrItem?: string | number | any,
  username?: string,
) => {
  let userId: string | undefined;
  let nameArg = username;

  if (userIdOrItem && typeof userIdOrItem === 'object') {
    userId = ownerIdOf(userIdOrItem) || undefined;
    nameArg =
      nameArg ??
      userIdOrItem.user ??
      userIdOrItem.username ??
      userIdOrItem.creator ??
      userIdOrItem.handle;
  } else {
    userId =
      userIdOrItem === undefined || userIdOrItem === null
        ? undefined
        : String(userIdOrItem);
  }

  const userName = cleanName(nameArg);

  if (!isPlaceholderId(userId) && userId) {
    navigate(`/profile/${encodeURIComponent(String(userId).trim())}`);
    return;
  }
  if (userName && !isPlaceholderId(userName)) {
    navigate(`/profile/@${encodeURIComponent(userName)}`);
    return;
  }
  // No resolvable account — do nothing rather than open a wrong profile.
};

/** Explicitly open the signed-in user's own profile (header avatar). */
export const navigateToOwnProfile = (navigate: NavigateFunction) => {
  navigate('/app/profile');
};

export const getProfileUrl = (userId?: string | number, username?: string) => {
  const userName = cleanName(username);
  if (!isPlaceholderId(userId) && userId !== undefined) {
    return `/profile/${encodeURIComponent(String(userId).trim())}`;
  }
  if (userName && !isPlaceholderId(userName)) {
    return `/profile/@${encodeURIComponent(userName)}`;
  }
  return '/app/profile';
};

export const getUserId = (user: User) => {
  return user?.id || user?.userId || user?.uid || user?.user_id || user?.ownerId || user?.authorId;
};

export const getUsername = (user: User) => {
  return user?.username || user?.handle || user?.name?.toLowerCase().replace(/\s+/g, '-');
};
