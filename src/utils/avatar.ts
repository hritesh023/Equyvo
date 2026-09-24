// Real-data-only avatar helpers.
//
// The app must never render a fake/bot avatar. These helpers resolve the
// authentic uploaded avatar from content/profile objects, and return '' when
// no real avatar exists so callers render initials instead of inventing one
// (e.g. picsum seeds, pravatar, dicebear, unsplash portraits).

/** First non-empty real avatar URL from the given candidates. */
export function resolveAvatar(...candidates: Array<unknown>): string {
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const s = c.trim();
    if (!s) continue;
    // Never treat demo/placeholder services as a real avatar.
    const low = s.toLowerCase();
    if (
      low.includes('picsum.photos') ||
      low.includes('pravatar') ||
      low.includes('dicebear') ||
      low.includes('robohash') ||
      low.includes('unsplash')
    ) {
      continue;
    }
    return s;
  }
  return '';
}

/** Pull the real avatar out of a content item (post/story/moment/thought). */
export function avatarOf(content: unknown): string {
  const c = (content || {}) as Record<string, unknown>;
  return resolveAvatar(
    c.avatar,
    (c as { creatorAvatar?: unknown }).creatorAvatar,
    (c as { avatarUrl?: unknown }).avatarUrl,
    (c as { avatar_url?: unknown }).avatar_url,
    (c as { profileImage?: unknown }).profileImage,
    (c as { authorAvatar?: unknown }).authorAvatar,
    (c as { userAvatar?: unknown }).userAvatar,
  );
}

/** Initials for the fallback circle when no real photo exists. */
export function avatarInitials(name: unknown): string {
  const s = String(name || '').trim();
  if (!s) return '';
  if (s.startsWith('@')) return s.slice(1, 3).toUpperCase();
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
