// Device-native sharing only.
//
// Every share entry point in the app funnels through openShareSheet(). It
// opens the OS share sheet — the Capacitor Share plugin on native builds,
// navigator.share (Web Share API) on web — and never renders a custom
// in-app "share sheet". When the device exposes no share target at all
// (e.g. an older desktop browser), the link is copied to the clipboard
// instead, so the gesture always does something useful.

import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { showError, showSuccess } from '@/utils/toast';
import api from '@/lib/api';

export interface SharePayload {
  title: string;
  text?: string;
  url?: string;
}

export interface ShareResult {
  /** The device/browser accepted the share or copied the link. */
  success: boolean;
  /** True when the user dismissed the native share UI without sharing. */
  cancelled?: boolean;
  /** Server-side engagement was persisted and the returned count is safe to use. */
  recorded?: boolean;
  alreadyShared?: boolean;
  shares?: number;
  error?: string;
}

async function copyLinkFallback(url: string): Promise<ShareResult> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    showSuccess('Link copied to clipboard');
    return { success: true };
  } catch {
    const error = 'Sharing is not available on this device';
    showError(error);
    return { success: false, error };
  }
}

/**
 * Open the device's default share UI for the given payload. Safe to call
 * fire-and-forget from click handlers: it never rejects and never renders an
 * in-app picker. A user-dismissed OS share sheet is deliberately NOT treated
 * as a share: there is no completed user action to record in the ledger.
 */
export async function openShareSheet(payload: SharePayload): Promise<ShareResult> {
  if (typeof window === 'undefined') {
    return { success: false, error: 'Sharing is not available right now' };
  }
  const title = String(payload.title || 'Check this out on Equyvo').trim();
  const text = String(payload.text || '').trim();
  const url = String(payload.url || window.location.href).trim();

  // Native builds (APK/AAB): the Capacitor plugin opens the Android/iOS
  // system share intent directly.
  if (Capacitor.isNativePlatform()) {
    try {
      await Share.share({ title, text: text || title, url, dialogTitle: title });
      return { success: true };
    } catch (err) {
      const msg = String((err as Error)?.message || '').toLowerCase();
      // User dismissed the system sheet — not an error.
      if (msg.includes('cancel')) return { success: false, cancelled: true };
      // Otherwise fall through to the web share / clipboard path.
    }
  }

  // Web (mobile browsers + PWAs): the Web Share API opens the OS sheet.
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text: text || title, url });
      return { success: true };
    } catch (err) {
      // User dismissed the OS sheet — not an error.
      if ((err as Error)?.name === 'AbortError') return { success: false, cancelled: true };
      // Any other failure (lost gesture, no share targets) → copy fallback.
    }
  }

  return copyLinkFallback(url);
}

export const shareContent = async (title: string, text: string, url?: string) => {
  if (typeof window === 'undefined') {
    return { success: false, error: 'Sharing is not available right now' };
  }
  return openShareSheet({
    title: title || 'Check this out on Equyvo',
    text: text || '',
    url: url || window.location.origin,
  });
};

export const sharePost = async (post: {
  id: string;
  user: string;
  content: string;
  image?: string;
}) => {
  if (typeof window === 'undefined') {
    return { success: false, error: 'Sharing is not available right now' };
  }

  const title = `Post by ${post.user || 'creator'} on Equyvo`;
  const text = post.content || '';
  const url = `${window.location.origin}/app/home?post=${encodeURIComponent(post.id)}`;

  return shareItem(post.id, { title, text, url });
};

export const shareProfile = async (user: {
  id: string;
  username: string;
  bio?: string;
}) => {
  if (typeof window === 'undefined') {
    return { success: false, error: 'Sharing is not available right now' };
  }

  const title = `${user.username} on Equyvo`;
  const text = user.bio || `Check out ${user.username}'s profile on Equyvo!`;
  const url = `${window.location.origin}/profile/${encodeURIComponent(user.id)}`;

  return shareContent(title, text, url);
};

// ── One share per account per item ─────────────────────────────────────────
// The server keeps the authoritative `sharedBy` ledger and refuses to
// increment twice for the same account. The client mirrors that ledger in
// localStorage so repeat taps don't even optimistically bump the number
// (otherwise the UI would jump +1 and snap back when the server answers).
const SHARED_ITEMS_KEY = 'equyvo_shared_items';

function sharedItemsRef(): Set<string> {
  try {
    const raw = localStorage.getItem(SHARED_ITEMS_KEY);
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

function actorKeyOf(): string {
  try {
    const stored = localStorage.getItem('equyvo_cognito_user');
    const user = stored ? JSON.parse(stored) : null;
    return String(user?.id || user?.email || 'anon').toLowerCase();
  } catch {
    return 'anon';
  }
}

/** True when the signed-in account already shared this item before. */
export function hasSharedItem(itemId: string): boolean {
  if (!itemId) return false;
  return sharedItemsRef().has(`${actorKeyOf()}:${itemId}`);
}

/** Record that the signed-in account shared this item (first time only). */
export function markItemShared(itemId: string): void {
  if (!itemId) return;
  try {
    const key = `${actorKeyOf()}:${itemId}`;
    const set = sharedItemsRef();
    if (set.has(key)) return;
    set.add(key);
    localStorage.setItem(SHARED_ITEMS_KEY, JSON.stringify([...set].slice(-2000)));
  } catch {
    // storage full/private mode: the server ledger still protects the count
  }
}

// ── Authoritative share recording ──────────────────────────────────────────
// Opening a share sheet is not enough to update a counter. Every content share
// waits for the device/browser to accept the share first, then asks the API to
// apply its one-account-per-item ledger. The API response (never an optimistic
// client increment) is the only value callers should render.
const pendingShares = new Map<string, Promise<ShareResult>>();

function shareRequestKey(scope: string, itemId: string): string {
  return `${scope}:${actorKeyOf()}:${itemId}`;
}

function numericShareCount(data: unknown): number | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as { shares?: unknown; shares_count?: unknown };
  const count = Number(record.shares ?? record.shares_count);
  return Number.isFinite(count) && count >= 0 ? count : undefined;
}

async function performRecordedShare(
  scope: 'content' | 'comment',
  itemId: string,
  payload: SharePayload,
): Promise<ShareResult> {
  const opened = await openShareSheet(payload);
  if (!opened.success) return opened;

  const response = scope === 'comment'
    ? await api.shareComment(itemId)
    : await api.share(itemId);
  const data = response.data as any;
  const count = numericShareCount(scope === 'comment' ? data?.comment : data);
  const alreadyShared = scope === 'comment'
    ? Boolean(data?.comment?.alreadyShared ?? data?.alreadyShared)
    : Boolean(data?.alreadyShared);

  // An offline/unknown response must never look like a counted share. The
  // share itself succeeded, but the counter is not authoritative until the
  // server confirms it.
  if (response.error || !data || count === undefined || data.offline) {
    return {
      ...opened,
      recorded: false,
      error: response.error || 'The share was sent, but its count could not be saved yet.',
    };
  }

  markItemShared(itemId);
  return { ...opened, recorded: true, shares: count, alreadyShared };
}

/** Share a content item and persist exactly one share for this account/item. */
export function shareItem(itemId: string, payload: SharePayload): Promise<ShareResult> {
  const id = String(itemId || '').trim();
  if (!id) return openShareSheet(payload);
  const key = shareRequestKey('content', id);
  const inFlight = pendingShares.get(key);
  if (inFlight) return inFlight;
  const request = performRecordedShare('content', id, payload).catch((err) => ({
    success: false,
    recorded: false,
    error: String((err as Error)?.message || 'Could not record this share.'),
  } satisfies ShareResult)).finally(() => {
    pendingShares.delete(key);
  });
  pendingShares.set(key, request);
  return request;
}

/** Share a comment and use the comment's own one-account ledger. */
export function shareCommentItem(commentId: string, payload: SharePayload): Promise<ShareResult> {
  const id = String(commentId || '').trim();
  if (!id) return openShareSheet(payload);
  const key = shareRequestKey('comment', id);
  const inFlight = pendingShares.get(key);
  if (inFlight) return inFlight;
  const request = performRecordedShare('comment', id, payload).catch((err) => ({
    success: false,
    recorded: false,
    error: String((err as Error)?.message || 'Could not record this share.'),
  } satisfies ShareResult)).finally(() => {
    pendingShares.delete(key);
  });
  pendingShares.set(key, request);
  return request;
}
