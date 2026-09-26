import { getStoredUser } from './auth';
import { resolveAvatar, avatarInitials } from '@/utils/avatar';
import api from './api';

export interface CommentIdentity {
  id: string;
  name: string;
  avatar: string;
  initials: string;
}

let profileCache: { at: number; id: string; avatar: string; name: string } | null = null;

/** Real signed-in identity for commenting. Never invents a name or avatar:
 *  the display name falls back to the account email prefix and the avatar to
 *  '' (initials rendered) when the user uploaded no profile photo. An empty
 *  id means "not signed in" — the composer disables itself instead of
 *  showing a fake/bot stand-in. */
export function myCommentIdentity(): CommentIdentity {
  const u = getStoredUser();
  let name = '';
  let avatar = '';
  try {
    const rawProfile = localStorage.getItem('userProfile');
    const p = rawProfile ? JSON.parse(rawProfile) : null;
    name = String(p?.username || p?.name || '').trim();
    avatar = resolveAvatar(p?.avatar, (u as { avatar?: unknown } | null)?.avatar);
  } catch {
    /* storage unreadable — fall back to the stored session */
  }
  if (!name && u) {
    const emailPrefix =
      typeof u.email === 'string' && u.email.includes('@')
        ? u.email.split('@')[0].trim()
        : '';
    name = String(u.username || u.fullName || emailPrefix || '').trim().slice(0, 80);
  }
  const id = String((u && (u.id || u.email)) || '');
  // Signed in but no usable display name (shouldn't happen): use the id
  // prefix rather than a generic "User" so the composer never shows a bot.
  if (id && !name) name = id.includes('@') ? id.split('@')[0].slice(0, 80) : id.slice(0, 80);
  if (!name) name = id ? id.slice(0, 80) : '';
  return { id, name, avatar, initials: avatarInitials(name) || '?' };
}

/** Best-effort refresh of the cached server profile so renames / new profile
 *  photos reflect in the comment composer. Never throws; cache is per-session
 *  (60s) to avoid a profile fetch on every sheet open. */
export async function refreshMyCommentIdentity(): Promise<CommentIdentity> {
  const base = myCommentIdentity();
  if (!base.id) return base;
  try {
    const now = Date.now();
    if (profileCache && profileCache.id === base.id && now - profileCache.at < 60_000) {
      return {
        id: base.id,
        name: profileCache.name || base.name,
        avatar: profileCache.avatar || base.avatar,
        initials: avatarInitials(profileCache.name || base.name) || '?',
      };
    }
    const res = await api.getProfile(base.id);
    const p = (res as { data?: { username?: string; name?: string; avatar?: string } }).data;
    if (!res.error && p) {
      const name = String(p.username || p.name || '').trim() || base.name;
      const avatar = resolveAvatar(p.avatar, base.avatar);
      profileCache = { at: now, id: base.id, avatar, name };
      return { id: base.id, name, avatar, initials: avatarInitials(name) || '?' };
    }
  } catch {
    /* offline — local identity stands */
  }
  return base;
}
