// ── Equyvo social graph helpers ─────────────────────────────────────────────
// Client-side view over the server follow graph (/api/followers/:id,
// /api/following/:id) with instant local fallbacks so the Chats tabs and the
// profile follower/following sheets always render — even offline.
// The server remains the source of truth (incl. private-account gating).

import api from './api';
import { getFollowing as getLocalFollowing } from './feed-store';
import { getStoredUser } from './auth';

export interface SocialProfile {
  id: string;
  name: string;
  username: string;
  avatar: string;
  isPrivate?: boolean;
  verified?: boolean;
}

function meId(): string {
  try {
    const u = getStoredUser();
    return String(u?.id || u?.email || '');
  } catch {
    return '';
  }
}

function displayNameOf(p: unknown, fallback: string): string {
  const o = (p || {}) as Record<string, unknown>;
  const n =
    (typeof o.username === 'string' && o.username) ||
    (typeof o.name === 'string' && o.name) ||
    '';
  return n || fallback;
}

/** Best-effort profile summary for an id we only know by id/handle. */
export function summaryForId(id: string, extra?: Partial<SocialProfile>): SocialProfile {
  const clean = String(id || '').trim();
  const handle = clean.startsWith('@') ? clean : `@${clean.split('@')[0] || 'user'}`;
  return {
    id: clean || handle,
    name: extra?.name || handle.replace('@', ''),
    username: extra?.username || handle,
    avatar: extra?.avatar || '',
    isPrivate: extra?.isPrivate,
    verified: extra?.verified,
  };
}

function readCachedProfiles(): Record<string, SocialProfile> {
  try {
    const raw = localStorage.getItem('equyvo_social_profiles');
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function writeCachedProfiles(next: Record<string, SocialProfile>): void {
  try {
    const entries = Object.entries(next).slice(-400);
    localStorage.setItem('equyvo_social_profiles', JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* ignore */
  }
}

export function cacheProfiles(list: SocialProfile[]): void {
  if (!list.length) return;
  try {
    const cur = readCachedProfiles();
    for (const p of list) {
      if (p?.id) cur[p.id] = { ...cur[p.id], ...p };
    }
    writeCachedProfiles(cur);
  } catch {
    /* ignore */
  }
}

/** Local people the user knows (follows + chatted + self profile). Used as fallback. */
function localPeople(): SocialProfile[] {
  const out = new Map<string, SocialProfile>();
  try {
    for (const name of getLocalFollowing()) {
      const key = String(name);
      if (!key) continue;
      out.set(key.toLowerCase(), summaryForId(key));
    }
  } catch {
    /* ignore */
  }
  try {
    const raw = localStorage.getItem('equyvo_chat_contacts');
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      for (const c of arr) {
        const id = String(c?.id || c?.name || '');
        if (!id) continue;
        out.set(id.toLowerCase(), {
          id,
          name: String(c?.name || id),
          username: String(c?.name || id).startsWith('@') ? String(c?.name) : `@${String(c?.name || id)}`,
          avatar: String(c?.avatar || ''),
        });
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const cached = readCachedProfiles();
    for (const p of Object.values(cached)) {
      if (p?.id) out.set(String(p.id).toLowerCase(), p);
    }
  } catch {
    /* ignore */
  }
  return [...out.values()];
}

async function fetchIds(kind: 'followers' | 'following', userId: string): Promise<{ ids: string[]; restricted: boolean; profiles: SocialProfile[] }> {
  const id = userId || meId();
  if (!id) return { ids: [], restricted: false, profiles: [] };
  try {
    const res =
      kind === 'followers' ? await api.followers(id) : await api.following(id);
    const data = (res as { data?: { ids?: string[]; count?: number; restricted?: boolean; profiles?: SocialProfile[] } }).data;
    if (res.error || !data) throw new Error(res.error || 'empty');
    const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
    const profiles = Array.isArray(data.profiles) ? (data.profiles as SocialProfile[]) : [];
    if (profiles.length) cacheProfiles(profiles);
    return { ids, restricted: !!data.restricted, profiles };
  } catch {
    return { ids: [], restricted: false, profiles: [] };
  }
}

/** Accounts that follow `userId`. Falls back to local people when offline. */
export async function getFollowers(userId?: string): Promise<{ list: SocialProfile[]; restricted: boolean }> {
  const id = userId || meId();
  const { ids, restricted, profiles } = await fetchIds('followers', id);
  const byId = new Map<string, SocialProfile>();
  for (const p of profiles) byId.set(String(p.id).toLowerCase(), p);
  const cached = readCachedProfiles();
  const list: SocialProfile[] = ids.map((rawId) => {
    const key = String(rawId).toLowerCase();
    return (
      byId.get(key) ||
      (cached[rawId] as SocialProfile) ||
      (cached[key] as SocialProfile) ||
      summaryForId(rawId)
    );
  });
  if (!list.length && (!id || id === meId())) {
    // Local fallback: people we've chatted with act as followers so the tab
    // is never empty on a fresh device.
    return { list: localPeople().slice(0, 50), restricted: false };
  }
  return { list, restricted };
}

/** Accounts `userId` follows. Falls back to the instant local mirror. */
export async function getFollowing(userId?: string): Promise<{ list: SocialProfile[]; restricted: boolean }> {
  const id = userId || meId();
  const { ids, restricted, profiles } = await fetchIds('following', id);
  const byId = new Map<string, SocialProfile>();
  for (const p of profiles) byId.set(String(p.id).toLowerCase(), p);
  const cached = readCachedProfiles();
  let list: SocialProfile[] = ids.map((rawId) => {
    const key = String(rawId).toLowerCase();
    return (
      byId.get(key) ||
      (cached[rawId] as SocialProfile) ||
      (cached[key] as SocialProfile) ||
      summaryForId(rawId)
    );
  });
  if (!list.length && (!id || id === meId())) {
    const local = localPeople();
    // Merge explicit local follows (handles) even when server is empty.
    const seen = new Set(list.map((p) => p.id.toLowerCase()));
    for (const p of local) {
      if (!seen.has(p.id.toLowerCase())) {
        seen.add(p.id.toLowerCase());
        list.push(p);
      }
    }
  }
  return { list, restricted };
}

/**
 * Instagram-ish gating for follower/following sheets.
 * Public accounts: everyone can see. Private accounts: only the owner and
 * accounts that follow them (approved followers) can see the lists.
 */
export function canViewFollowLists(
  viewerId: string,
  target: { id?: string; isPrivate?: boolean } | null | undefined,
  viewerFollowsTarget: boolean,
): boolean {
  if (!target || target.isPrivate !== true) return true;
  if (viewerId && target.id && viewerId === target.id) return true;
  return viewerFollowsTarget;
}

export function myId(): string {
  return meId();
}

export { displayNameOf };
