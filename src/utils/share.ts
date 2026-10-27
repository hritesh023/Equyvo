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

export interface SharePayload {
  title: string;
  text?: string;
  url?: string;
}

async function copyLinkFallback(url: string): Promise<{ success: boolean; error?: string }> {
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
 * in-app picker. A user-dismissed OS share sheet counts as success.
 */
export async function openShareSheet(payload: SharePayload): Promise<{ success: boolean; error?: string }> {
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
      if (msg.includes('cancel')) return { success: true };
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
      if ((err as Error)?.name === 'AbortError') return { success: true };
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

  return shareContent(title, text, url);
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
