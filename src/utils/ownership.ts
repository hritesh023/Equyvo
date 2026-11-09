import { getStoredUser } from '@/lib/auth';

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** All identity strings for the current signed-in account (id, email, username). */
export function myIdentities(): string[] {
  try {
    const me = getStoredUser();
    if (!me) return [];
    return [
      (me as { id?: string }).id,
      (me as { email?: string }).email,
      (me as { username?: string }).username,
      typeof (me as { email?: string }).email === 'string'
        ? String((me as { email?: string }).email).split('@')[0]
        : '',
    ]
      .map(norm)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Every ownership-ish field an item may carry, normalized. */
export function ownerIdentities(item: Record<string, unknown> | null | undefined): string[] {
  if (!item || typeof item !== 'object') return [];
  const out = [
    (item as { ownerId?: unknown }).ownerId,
    (item as { userId?: unknown }).userId,
    (item as { user_id?: unknown }).user_id,
    (item as { authorId?: unknown }).authorId,
    (item as { creatorId?: unknown }).creatorId,
    (item as { creator?: unknown }).creator,
    (item as { user?: unknown }).user,
    (item as { username?: unknown }).username,
  ]
    .map(norm)
    .filter(Boolean);
  return Array.from(new Set(out));
}

/**
 * True when the signed-in account owns the content.
 * Checks server account ids first, display names as fallback (legacy items),
 * all case-insensitive. Extra ids can be supplied when the caller already
 * resolved them (e.g. postOwnerId / currentUserId props).
 */
export function isOwnContent(
  item?: Record<string, unknown> | null,
  opts?: { currentUserId?: string; postOwnerId?: string; postUserId?: string },
): boolean {
  const mine = new Set(myIdentities());
  if (opts?.currentUserId) mine.add(norm(opts.currentUserId));
  try {
    const me = getStoredUser();
    if (me?.email) mine.add(norm(me.email));
    if (me?.id) mine.add(norm(me.id));
    if ((me as { username?: string } | null)?.username)
      mine.add(norm((me as { username?: string }).username));
  } catch {
    /* ignore */
  }
  if (!mine.size) return false;

  const strongFields = [
    (item as any)?.ownerId,
    (item as any)?.userId,
    (item as any)?.user_id,
    (item as any)?.authorId,
    (item as any)?.creatorId,
    opts?.postOwnerId,
    opts?.postUserId,
  ].map(norm).filter(Boolean);

  const mineStrong = new Set([
    ...myIdentities().filter((x) => x && x.length > 8), // ids/emails, not short names
  ]);
  try {
    const me = getStoredUser();
    if (me?.id) mineStrong.add(norm(me.id));
    if (me?.email) mineStrong.add(norm(me.email));
  } catch { /* ignore */ }
  if (opts?.currentUserId) mineStrong.add(norm(opts.currentUserId));

  // When strong (account-id) fields exist, ONLY those decide ownership. This
  // prevents a shared display name from falsely attributing one account's
  // content to another account on the same or a different device.
  if (strongFields.length) {
    return strongFields.some((id) => mineStrong.has(id));
  }

  // Legacy fallback: only display-name fields, and only when no account id is
  // available anywhere on the item.
  const legacyFields = [
    (item as any)?.creator,
    (item as any)?.user,
    (item as any)?.username,
    (item as any)?.handle,
  ].map(norm).filter(Boolean);
  if (!legacyFields.length) return false;
  const mineNames = new Set(myIdentities().map(norm));
  try {
    const me = getStoredUser();
    if ((me as { username?: string } | null)?.username) mineNames.add(norm((me as { username?: string }).username));
    if (me?.email) mineNames.add(norm(String(me.email).split('@')[0]));
  } catch { /* ignore */ }
  return legacyFields.some((id) => mineNames.has(id));
}

/** Preferred stable id of the current user for API ownership checks. */
export function myOwnerId(): string {
  try {
    const me = getStoredUser();
    return String(me?.id || me?.email || '');
  } catch {
    return '';
  }
}
