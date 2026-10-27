export interface SharePayload {
  title: string;
  text?: string;
  url?: string;
}

export interface SharePlatformUsage {
  count: number;
  lastUsedAt: number;
}

const USAGE_STORAGE_KEY = 'equyvo_share_platform_usage_v1';
export const SHARE_SHEET_EVENT = 'equyvo:open-share-sheet';

/**
 * Read the user's per-platform share usage ledger so the Share Sheet can rank
 * platforms by recent and frequent usage. If the user has no recorded history
 * yet, we also check document.referrer / navigator.userAgent for an initial
 * platform hint (e.g. opened from WhatsApp, Instagram, Telegram, X, Facebook).
 */
export function getSharePlatformUsage(): Record<string, SharePlatformUsage> {
  if (typeof window === 'undefined') return {};
  let stored: Record<string, SharePlatformUsage> = {};
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed;
    }
  } catch {
    stored = {};
  }

  // Seed a subtle referrer/in-app browser hint if no history exists yet.
  if (Object.keys(stored).length === 0) {
    try {
      const context = `${document.referrer || ''} ${navigator.userAgent || ''}`.toLowerCase();
      const hints: Array<[string, RegExp]> = [
        ['whatsapp', /whatsapp|wa\.me/],
        ['instagram', /instagram|ig\.me/],
        ['telegram', /telegram|t\.me/],
        ['x', /twitter|x\.com|t\.co/],
        ['facebook', /facebook|fb\.com|fbav|fban/],
        ['reddit', /reddit/],
        ['linkedin', /linkedin/],
        ['snapchat', /snapchat/],
      ];
      const now = Date.now();
      for (const [id, re] of hints) {
        if (re.test(context)) {
          stored[id] = { count: 1, lastUsedAt: now };
        }
      }
    } catch {
      /* ignore */
    }
  }

  return stored;
}

/** Record that the user chose a platform so it sorts first next time. */
export function recordSharePlatformUsage(platformId: string): void {
  if (typeof window === 'undefined' || !platformId) return;
  try {
    const current = getSharePlatformUsage();
    const prev = current[platformId] || { count: 0, lastUsedAt: 0 };
    current[platformId] = {
      count: (Number(prev.count) || 0) + 1,
      lastUsedAt: Date.now(),
    };
    localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* ignore storage errors */
  }
}

/**
 * Open the app-wide Share Sheet with platform options ranked by the user's
 * recent app/platform usage. Never auto-copies to the clipboard on open —
 * copying only happens when the user explicitly taps "Copy link".
 */
export function openShareSheet(payload: SharePayload): { success: boolean } {
  if (typeof window === 'undefined') {
    return { success: false };
  }
  const detail: Required<SharePayload> = {
    title: String(payload.title || 'Check this out on Equyvo').trim(),
    text: String(payload.text || '').trim(),
    url: String(payload.url || window.location.href).trim(),
  };
  window.dispatchEvent(new CustomEvent(SHARE_SHEET_EVENT, { detail }));
  return { success: true };
}

export const shareContent = async (title: string, text: string, url?: string) => {
  if (typeof window === 'undefined') {
    return { success: false, error: 'Sharing is not available right now' };
  }
  openShareSheet({
    title: title || 'Check this out on Equyvo',
    text: text || '',
    url: url || window.location.origin,
  });
  return { success: true, sheet: true };
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
