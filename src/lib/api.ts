// API client for Equyvo backend
// In development, proxies through Vite to local Pages Functions
// In production, same origin (Pages serves both frontend and functions)

function resolveApiBase(): string {
  try {
    const cap = (window as any)?.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      return 'https://equyvo.pages.dev/api';
    }
  } catch { /* ignore */ }
  return '/api';
}
const API_BASE = resolveApiBase();
const USER_KEY = 'equyvo_cognito_user';
const TOKEN_KEY = 'equyvo_cognito_token';

// Attach caller identity headers so the backend can enforce ownership
// and rate limits on write operations. A real Cognito JWT is sent as a
// Bearer token when available; otherwise the stored user id is sent.
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const stored = localStorage.getItem(USER_KEY);
    if (stored) {
      const user = JSON.parse(stored);
      const id = user?.id || user?.email || '';
      if (id) headers['X-User-Id'] = String(id);
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers['Authorization'] = 'Bearer ' + token;
  } catch {
    // ignore storage errors
  }
  return headers;
}

let localApiWarned = false;

const PAYWALL_CODES = new Set([
  'QUOTA_STORAGE',
  'QUOTA_MONTHLY',
  'QUOTA_FILE_SIZE',
  'QUOTA_VIDEO_LENGTH',
  'quota_exceeded',
  'out_of_credits',
]);

/** True when a backend body signals a quota/paywall limit. */
export function isPaywallBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (b.type === 'paywall') return true;
  const code = b.code ?? b.error;
  return typeof code === 'string' && (PAYWALL_CODES.has(code) || code.startsWith('QUOTA_'));
}

let lastPaywallRedirect = 0;

/**
 * Global paywall funnel: any 402/quota response anywhere in the app lands
 * the user on /pricing (throttled, keeps the reason in sessionStorage).
 * Returns true when the error was a paywall.
 */
export function handlePaywall(status: number, body: unknown): boolean {
  if (status !== 402 && !isPaywallBody(body)) return false;
  try {
    window.dispatchEvent(new CustomEvent('equyvo:paywall', { detail: { status, body } }));
    try {
      sessionStorage.setItem('equyvo_paywall', JSON.stringify({ at: new Date().toISOString(), body }));
    } catch { /* ignore */ }
  } catch { /* ignore */ }
  try {
    const now = Date.now();
    const path = window.location.pathname || '';
    if (!path.startsWith('/pricing') && !path.startsWith('/app/pricing') && now - lastPaywallRedirect > 3000) {
      lastPaywallRedirect = now;
      // Small delay so the caller can toast the reason first.
      setTimeout(() => {
        if (!window.location.pathname.startsWith('/pricing') && !window.location.pathname.startsWith('/app/pricing')) {
          window.location.href = '/pricing';
        }
      }, 1200);
    }
  } catch { /* ignore */ }
  return true;
}

/**
 * Dev-only, once-per-session hint. In local dev, /api is served by the local
 * API server — when it isn't running every /api call fails and all feeds
 * render empty. Production serves the API alongside the app, so this never
 * fires there.
 */
function warnLocalApiOnce(path: string, status: number | string): void {
  try {
    if (!import.meta.env.DEV || localApiWarned) return;
    localApiWarned = true;
    console.warn(
      `[Equyvo] ${path} → ${status} with no API response body. ` +
        `Start the local API server with: npm run dev:api`,
    );
  } catch {
    /* ignore */
  }
}

// Every request is bounded. Without a timeout a dropped mobile connection
// leaves the UI spinning forever; uploads still get a generous budget.
const REQUEST_TIMEOUT_MS = { read: 12_000, write: 30_000, upload: 180_000 } as const;

function isFormBody(body: BodyInit | null | undefined): boolean {
  try {
    return typeof FormData !== 'undefined' && body instanceof FormData;
  } catch {
    return false;
  }
}

function requestTimeout(options: RequestInit | undefined, isGet: boolean): number {
  if (isFormBody(options?.body)) return REQUEST_TIMEOUT_MS.upload;
  return isGet ? REQUEST_TIMEOUT_MS.read : REQUEST_TIMEOUT_MS.write;
}

/** True when this device still holds a token that the server just rejected. */
function hasStoredToken(): boolean {
  try {
    return !!localStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
}

async function request<T = any>(
  path: string,
  options?: RequestInit
): Promise<{ data?: T; error?: string }> {
  // Resilience: idempotent GETs survive flaky mobile networks with one quiet
  // retry (network failure or transient 502/503/504). Mutations are never
  // retried automatically — they may not be safe to replay.
  const isGet = !options || !options.method || options.method === 'GET';
  const attempts = isGet ? 2 : 1;
  let lastError: string | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout(options, isGet));
    try {
      // Add cache-busting timestamp to GET requests
      const separator = path.includes('?') ? '&' : '?';
      const url = isGet ? `${API_BASE}${path}${separator}_t=${Date.now()}` : `${API_BASE}${path}`;
      const headers: Record<string, string> = authHeaders();
      if (!isFormBody(options?.body)) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(url, {
        headers,
        ...options,
        signal: controller.signal,
      });
      // Error pages (vite proxy 500s, gateway HTML) are not JSON — never let
      // body parsing itself become the reported error.
      const json = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        // A token the server rejects means the local session is dead. Tell the
        // app once so it can re-authenticate instead of looping on 401s.
        if (res.status === 401 && hasStoredToken()) {
          try { window.dispatchEvent(new CustomEvent('equyvo:session-expired')); } catch { /* ignore */ }
        }
        // Transient gateway/server hiccup on a read: one silent retry.
        if (isGet && attempt === 0 && (res.status === 502 || res.status === 503 || res.status === 504)) {
          lastError = `Request failed with status ${res.status}`;
          warnLocalApiOnce(path, res.status);
          continue;
        }
        // Quota/paywall responses redirect to /pricing everywhere (throttled).
        handlePaywall(res.status, json);
        const bodyError =
          typeof json.error === 'string' && json.error ? json.error : null;
        if (!bodyError) warnLocalApiOnce(path, res.status);
        return { error: bodyError || `Request failed with status ${res.status}` };
      }
      return json as T;
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      const message = aborted
        ? 'Request timed out. Check your connection and try again.'
        : (err?.message || 'Network error');
      if (isGet && attempt === 0) {
        lastError = message;
        continue;
      }
      warnLocalApiOnce(path, 'network');
      return { error: message || lastError || 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }
  warnLocalApiOnce(path, lastError || 'network');
  return { error: lastError || 'Network error' };
}

// Upload sizing contract:
// • ≤ 8MB  → single-shot POST /api/upload (unchanged legacy path).
// • > 8MB  → resumable chunked flow (POST /upload/init → PUT /upload/part ×
//            N → POST /upload/complete) streaming 8MB parts one request at a
//            time, so long videos / vlogs / live recordings cannot blow a
//            request body, worker memory or a mobile network. Per-part hash
//            chain on the server keeps identity verifiable.
export type UploadPhase = 'screening' | 'processing' | 'uploading' | 'finalizing' | 'done';

export interface UploadProgress {
  loaded: number;
  total: number;
  phase: UploadPhase;
}

export interface UploadResult {
  publicId: string | null;
  secureUrl: string;
  originalUrl: string;
  delivery: 'r2' | 'cloudinary';
  store: 'r2+cloudinary' | 'r2' | 'cloudinary';
  r2Key: string | null;
  variants: { thumbnail: string; optimized?: string; sd?: string; hd?: string } | null;
  deduped?: boolean;
  planId?: string;
  resourceType: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
  createdAt: string;
  duration?: number;
  chunked?: boolean;
}

/** Server rejects with a quota code or message on any cap breach. */
function throwUploadError(message: string, code?: string): never {
  const e = new Error(message) as Error & { code?: string };
  if (code) e.code = code;
  throw e;
}

const CHUNK_PART_SIZE = 8 * 1024 * 1024;
const PART_TIMEOUT_MS = 180_000;

function extFromBlob(blob: Blob): string {
  try {
    const name = (blob as File).name || '';
    let ext = name ? String(name.split('.').pop() || '') : '';
    ext = ext.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (ext && ext.length <= 8) return ext;
    const t = (blob.type || '').toLowerCase();
    const m = t.match(/(mp4|webm|mov|m4a|mpeg|mp3|aac|ogg|wav|jpeg|jpg|png|webp|heic|avif|gif)/);
    if (m) return m[1];
  } catch { /* ignore */ }
  return 'bin';
}

/** One PUT /upload/part with timeout + few retries; returns nothing on fail. */
async function uploadOnePart(
  uploadId: string,
  partIndex: number,
  chunk: Blob,
): Promise<{ data?: { partIndex: number; etag: string; bytes: number }; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PART_TIMEOUT_MS);
  try {
    const fd = new FormData();
    fd.append('file', chunk);
    return await request(
      `/upload/part?uploadId=${encodeURIComponent(uploadId)}&partIndex=${partIndex}`,
      { method: 'PUT', body: fd, signal: ctrl.signal },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Chunked uploader for big files. Throws Error on failure (aborts session). */
async function uploadChunked(
  payload: Blob,
  folder: string | undefined,
  meta: { duration?: number } | undefined,
  onProgress: (loaded: number, phase: UploadPhase) => void,
): Promise<{ data?: UploadResult; error?: string }> {
  const type = (payload as File).type || 'application/octet-stream';
  const total = payload.size;
  const init = await request<{ chunked: boolean; uploadId?: string; partSize?: number; r2Key?: string | null }>(
    '/upload/init',
    {
      method: 'POST',
      body: JSON.stringify({
        size: total,
        type,
        name: (payload as File).name || '',
        folder: folder || 'equyvo/uploads',
        ext: extFromBlob(payload),
      }),
    },
  );
  if (init.error) throwUploadError(init.error);
  const started = init.data;
  if (!started || started.chunked !== true || !started.uploadId) {
    // Server prefers the direct path (cap changed / small file) — fall back.
    const formData = new FormData();
    formData.append('file', payload);
    if (folder) formData.append('folder', folder);
    const res = await request<UploadResult>('/upload', { method: 'POST', body: formData });
    if (res.data) onProgress(total, 'done');
    return res;
  }
  const uploadId = started.uploadId;
  const partSize = started.partSize || CHUNK_PART_SIZE;
  const totalParts = Math.ceil(total / partSize);
  let uploaded = 0;
  onProgress(0, 'uploading');
  try {
    for (let partIndex = 1; partIndex <= totalParts; partIndex++) {
      const start = (partIndex - 1) * partSize;
      const end = Math.min(start + partSize, total);
      const chunk = payload.slice(start, end);
      let lastErr: string | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await uploadOnePart(uploadId, partIndex, chunk);
          if (res.error) {
            // Session gone / quota answer — retrying cannot help.
            throwUploadError(res.error, (/UPLOAD_SESSION_GONE/.test(res.error) ? 'UPLOAD_SESSION_GONE' : undefined));
          }
          lastErr = null;
          break;
        } catch (e) {
          if (e instanceof Error && (e as Error & { code?: string }).code === 'UPLOAD_SESSION_GONE') throw e;
          lastErr = e instanceof Error ? e.message : 'Chunk upload failed';
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (lastErr) throwUploadError(lastErr);
      uploaded = end;
      onProgress(uploaded, 'uploading');
    }
    onProgress(total, 'finalizing');
    const comp = await request<UploadResult>('/upload/complete', {
      method: 'POST',
      body: JSON.stringify({ uploadId, duration: meta?.duration }),
    });
    if (comp.error) throwUploadError(comp.error);
    onProgress(total, 'done');
    if (!comp.data) throwUploadError('Upload finished without a result');
    return comp;
  } catch (fatal) {
    try { void request('/upload/abort', { method: 'POST', body: JSON.stringify({ uploadId }) }); } catch { /* best effort */ }
    throw fatal;
  }
}

export const api = {
  // Posts
  getPosts: (limit = 50) =>
    request<{ data: any[]; error: null }>(`/posts?limit=${limit}`),

  // One content item (post / thought / story / moment) by id — used by
  // shared links so /posts/:id never dead-ends on a 404 or the feed top.
  getContentItem: (id: string) =>
    request<{ data: any; error: null }>(`/content/${encodeURIComponent(id)}`),

  createPost: (data: any) =>
    request<{ data: any; error: null }>('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Thoughts
  getThoughts: (limit = 20, offset = 0) =>
    request<{ data: any[]; error: null }>(`/thoughts?limit=${limit}&offset=${offset}`),

  // Thoughts — trending topics. Server-side engagement-weighted algorithm
  // (tags + #hashtags of real thoughts; recency decay; 24h velocity trend).
  // The endpoint re-computes server-side and clients poll it, so the
  // section auto-updates on its own.
  getThoughtsTrending: () =>
    request<{ data: { topics: Array<{ name: string; count: number; score: number; trend: 'up' | 'down' | 'stable' }>; source: string; computedAt: number; cached?: boolean }; error: null }>(`/thoughts/trending`),

  createThought: (data: any) =>
    request<{ data: any; error: null }>('/thoughts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Stories
  getStories: (limit = 20) =>
    request<{ data: any[]; error: null }>(`/stories?limit=${limit}`),

  createStory: (data: any) =>
    request<{ data: any; error: null }>('/stories', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Moments
  getMoments: (limit = 20) =>
    request<{ data: any[]; error: null }>(`/moments?limit=${limit}`),

  createMoment: (data: any) =>
    request<{ data: any; error: null }>('/moments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Profile
  getProfile: (userId: string) =>
    request<{ data: any; error: null }>(`/profile/${encodeURIComponent(userId)}`),

  updateProfile: (data: any) =>
    request<{ data: any; error: null }>('/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Display-name change quota (server-enforced source of truth). Also
  // carries the Creator Pro verified-name state (verified / verifiedName /
  // canChangeNameAt) so the editor can show the monthly rename lock.
  getNameQuota: () =>
    request<{ data: {
      used: number; quota: number; remaining: number;
      verified?: boolean; verifiedName?: string; canChangeNameAt?: number;
    }; error: null }>(
      '/profile/name-quota'
    ),

  // Verified-name availability for Creator Pro: can THIS account claim
  // `name` as its verified identity? Server is the single source of truth.
  checkVerifiedName: (name: string) =>
    request<{ data: {
      available: boolean; reason: string;
      verified?: boolean; verifiedName?: string; canChangeAt?: number;
      creatorProActive?: boolean;
    }; error: null }>(
      `/profile/verify-name-check?name=${encodeURIComponent(name)}`
    ),

  // Search — unified people + content search (real data only, honest empty).
  search: (query: string, limit = 20) =>
    request<{ data: { results: any[]; users?: any[]; totalCount: number; userCount?: number; isAiRecommended: boolean }; error: null }>(
      `/search?q=${encodeURIComponent(query)}&limit=${limit}`
    ),

  // Content indexing (called after media upload)
  indexContent: (data: any) =>
    request<{ data: { success: boolean }; error: null }>('/content-index', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Content update (owner-only): edit text + visibility
  // (public | followers | private). Used for "hide from public" without delete.
  updatePost: (id: string, data: any) =>
    request<{ data: any; error: null }>(`/posts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateThought: (id: string, data: any) =>
    request<{ data: any; error: null }>(`/thoughts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateStory: (id: string, data: any) =>
    request<{ data: any; error: null }>(`/stories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateMoment: (id: string, data: any) =>
    request<{ data: any; error: null }>(`/moments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Reports (community safety). Any signed-in account can report any content
  // except its own. Returns a generic acknowledgement only.
  // `reasons` supports the checkbox multi-select UI; `reason` stays for compat.
  reportContent: (data: { kind: string; id: string; reason?: string; reasons?: string[]; details?: string }) =>
    request<{ data: { ok: boolean }; error: null }>('/report', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Social graph sheets (Instagram-ish). Private accounts return
  // { restricted: true, ids: [] } for strangers — enforced server-side.
  followers: (userId: string) =>
    request<{ data: { count: number; ids: string[]; restricted?: boolean; profiles?: any[] }; error: null }>(
      `/followers/${encodeURIComponent(userId)}`,
    ),

  following: (userId: string) =>
    request<{ data: { count: number; ids: string[]; restricted?: boolean; profiles?: any[] }; error: null }>(
      `/following/${encodeURIComponent(userId)}`,
    ),

  // Notifications (follow requests/accepts, live, uploads). Server merge is
  // best-effort; the local center always works offline.
  notifications: () =>
    request<{ data: { items: any[] }; error: null }>('/notifications'),

  notificationsRead: (ids?: string[]) =>
    request<{ data: { ok: boolean }; error: null }>('/notifications/read', {
      method: 'POST',
      body: JSON.stringify({ ids: ids || [] }),
    }),

  notificationsClear: (ids?: string[]) =>
    request<{ data: { ok: boolean }; error: null }>('/notifications/clear', {
      method: 'POST',
      body: JSON.stringify({ ids: ids ? [...ids] : null }),
    }),

  // Chat transport. Ticks: sent = reached server, delivered/seen via polling.
  // Gating (followers ↔ following) is enforced server-side; strangers get 403.
  chatSend: (peer: string, data: { id?: string; text?: string; type?: string; fileUrl?: string; fileName?: string; durationSec?: number }) =>
    request<{ data: { id: string; delivered: boolean }; error: null }>(`/chat/${encodeURIComponent(peer)}/send`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  chatDelete: (peer: string, id: string, forEveryone?: boolean) =>
    request<{ data: { ok: boolean }; error: null }>(`/chat/${encodeURIComponent(peer)}/delete`, {
      method: 'POST',
      body: JSON.stringify({ id, forEveryone: !!forEveryone }),
    }),

  chatMessages: (peer: string, limit = 100) =>
    request<{ data: { messages: any[] }; error: null }>(`/chat/${encodeURIComponent(peer)}/messages?limit=${limit}`),

  chatSeen: (peer: string) =>
    request<{ data: { ok: boolean }; error: null }>(`/chat/${encodeURIComponent(peer)}/seen`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  chatDelivered: (peer: string, id: string) =>
    request<{ data: { ok: boolean }; error: null }>(`/chat/${encodeURIComponent(peer)}/delivered`, {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),

  chatThreads: () =>
    request<{ data: { threads: any[] }; error: null }>('/chat/threads'),

  // Who is live now (all discoverable live accounts; followed first).
  liveNow: () =>
    request<{ data: { live: any[] }; error: null }>('/live/now'),

  // Broadcast presence — makes "Go live" visible to every account, not just
  // this device's localStorage.
  liveStart: (data: { contentId?: string; title?: string; thumbnail?: string } = {}) =>
    request<{ data: { live: boolean; liveAt: string | null }; error: null }>('/live/start', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  liveStop: () =>
    request<{ data: { live: boolean; liveAt: string | null }; error: null }>('/live/stop', {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // Real (server-persisted) likes/reactions. `action: toggle` makes the server
  // decide from its own ledger, so double taps cannot double-count.
  like: (itemId: string, action: 'like' | 'unlike' | 'toggle' = 'toggle') =>
    request<{ data: { id: string; likes: number; reacts: number; hasLiked: boolean }; error: null }>('/likes', {
      method: 'POST',
      body: JSON.stringify({ itemId, action }),
    }),

  react: (itemId: string, action: 'react' | 'unreact' | 'toggle' = 'toggle') =>
    request<{ data: { id: string; likes: number; reacts: number; hasLiked: boolean }; error: null }>('/react', {
      method: 'POST',
      body: JSON.stringify({ itemId, action }),
    }),

  // Follow graph (server-side source of truth; works across devices).
  follow: (target: string) =>
    request<{ data: { isFollowing: boolean; pending: boolean; isPrivate?: boolean }; error: null }>('/follow', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),

  unfollow: (target: string) =>
    request<{ data: { isFollowing: boolean; pending: boolean }; error: null }>(
      `/follow/${encodeURIComponent(target)}`,
      { method: 'DELETE' },
    ),

  followStatus: (target: string) =>
    request<{ data: { isFollowing: boolean; pending: boolean }; error: null }>(
      `/follow/status?target=${encodeURIComponent(target)}`,
    ),

  followRequests: () =>
    request<{ data: { requests: string[] }; error: null }>('/follow/requests'),

  followAccept: (requester: string) =>
    request<{ data: { accepted: boolean }; error: null }>('/follow/accept', {
      method: 'POST',
      body: JSON.stringify({ requester }),
    }),

  followDecline: (requester: string) =>
    request<{ data: { declined: boolean }; error: null }>('/follow/decline', {
      method: 'POST',
      body: JSON.stringify({ requester }),
    }),

  // Delete (strictly owner-only — the server rejects non-owners).
  deletePost: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/posts/${id}`, { method: 'DELETE' }),

  deleteThought: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/thoughts/${id}`, { method: 'DELETE' }),

  deleteStory: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/stories/${id}`, { method: 'DELETE' }),

  deleteMoment: (id: string) =>
    request<{ data: { success: boolean }; error: null }>(`/moments/${id}`, { method: 'DELETE' }),

  deleteUserData: (userId: string) =>
    request<{ data: { success: boolean }; error: null }>(`/user/${userId}/data`, { method: 'DELETE' }),

  // Upload a file via the app's own API. secureUrl is always the best
  // delivery URL — render it directly. Media is compressed client-side first
  // (images -> WebP) to keep R2 storage costs flat.
  // SAFETY GATE: every upload is screened before the bytes leave the device
  // (see lib/moderation.ts). Blocks throw ContentBlockedError so callers can
  // show the warning; infrastructure failures never block uploads.
  uploadFile: async (
    file: File | Blob,
    folder?: string,
    onProgress?: (p: UploadProgress) => void,
    meta?: { duration?: number },
  ) => {
    const step = (loaded: number, totalCount: number, phase: UploadPhase) => {
      try { onProgress?.({ loaded: Math.min(loaded, Math.max(totalCount, 1)), total: Math.max(totalCount, 1), phase }); } catch { /* observer errors never break uploads */ }
    };
    step(0, 1, 'screening');
    try {
      const mod = await import('./moderation');
      const screen = await mod.screenMedia(file, { kind: folder || 'upload' });
      if (screen.verdict !== 'allow') {
        throw new mod.ContentBlockedError(
          screen.message || 'This content isn’t allowed on Equyvo (adult, violent, exploitative or otherwise prohibited media).',
          screen.category || 'unspecified',
        );
      }
    } catch (e) {
      // Only the deliberate block should stop the upload — anything else
      // (network hiccup, sampling quirk) fails open and the publish-time
      // server moderation still applies.
      if (e instanceof Error && (e as Error).name === 'ContentBlockedError') throw e;
    }
    step(0, 1, 'processing');
    let payload: File | Blob = file;
    try {
      const { compressMedia } = await import('./compress');
      const compressed = await compressMedia(file);
      // Compression helps; it must never make the payload bigger.
      if (compressed && (!compressed.size || compressed.size <= (file.size || compressed.size))) {
        payload = compressed;
      }
    } catch { /* fall back to original on any compression error */ }
    const total = payload.size;
    if (total <= CHUNK_PART_SIZE) {
      const formData = new FormData();
      formData.append('file', payload);
      if (folder) formData.append('folder', folder);
      const res = await request<UploadResult>('/upload', {
        method: 'POST',
        body: formData,
      });
      step(total, total, res.data ? 'done' : 'uploading');
      return res;
    }
    return await uploadChunked(payload, folder, meta, (loaded, phase) => step(loaded, total, phase));
  },

  // Get user's own posts
  getUserPosts: (userId: string, limit = 50) =>
    request<{ data: any[]; error: null }>(`/users/${userId}/posts?limit=${limit}`),

  // Every collection for one account (posts + thoughts + stories + moments),
  // visibility-enforced server-side — the cross-device / cross-account feed.
  getUserContent: (userId: string) =>
    request<{
      data: { posts: any[]; thoughts: any[]; stories: any[]; moments: any[] };
      error: null;
    }>(`/users/${encodeURIComponent(userId)}/content`),

  // Plans (public catalog — quotas only, no secrets) + usage (authenticated)
  getPlans: () =>
    request<{ data: { plans: any[]; platformFeeBps: number }; error: null }>('/plans'),

  getUsage: () =>
    request<{
      data: {
        planId: string; planLabel: string; source: string;
        usedBytes: number; quotaBytes: number; usedPct: number;
        files: number; monthlyUploads: number; monthlyCap: number;
        maxUploadMB: number; maxVideoSec: number;
      };
      error: null;
    }>('/me/usage'),

  // Creator economy (payments are verified server-side; these endpoints
  // only record verified intents)
  creatorSetup: (data: { displayName?: string; bio?: string; tipEnabled?: boolean; subPriceInr?: number }) =>
    request<{ data: any; error: null }>('/creator/setup', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getCreator: (userId: string) =>
    request<{ data: any; error: null }>(`/creator/${encodeURIComponent(userId)}`),

  sendTip: (data: { to: string; amountInr: number; paymentId?: string }) =>
    request<{ data: any; error: null }>('/tips', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  subscribe: (data: { creator: string; plan?: string; amountInr: number; paymentId?: string }) =>
    request<{ data: any; error: null }>('/subscriptions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  adsEligibility: () =>
    request<{ data: { planId: string; ads: string; showAds: boolean }; error: null }>('/ads/eligibility'),

  // ---- Comments (persistent per-media discussions) ----
  // Tapping a media's comment button lists that media's comments via
  // getComments; posting, replying, liking, sharing, pinning (owner) and the
  // owner's enable/disable switch are below. Identity always comes from the
  // signed-in account + stored profile — never invented on the client.
  getComments: (contentId: string) =>
    request<{
      data: {
        comments: any[];
        totalCount: number;
        commentsEnabled: boolean;
        ownerId: string;
        isOwner: boolean;
      };
      error: null;
    }>(`/comments?contentId=${encodeURIComponent(contentId)}`),

  postComment: (data: { contentId: string; text: string; parentId?: string | null }) =>
    request<{ data: { comment: any }; error: null }>('/comments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateComment: (id: string, data: { text: string }) =>
    request<{ data: { comment: any }; error: null }>(`/comments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteComment: (id: string) =>
    request<{ data: { ok: boolean; deleted: number }; error: null }>(
      `/comments/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  likeComment: (id: string) =>
    request<{ data: { comment: any }; error: null }>(`/comments/${encodeURIComponent(id)}/like`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  shareComment: (id: string) =>
    request<{ data: { comment: any; shareUrl: string; shareText: string }; error: null }>(
      `/comments/${encodeURIComponent(id)}/share`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  pinComment: (id: string) =>
    request<{ data: { comment: any }; error: null }>(`/comments/${encodeURIComponent(id)}/pin`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  setCommentSettings: (contentId: string, enabled: boolean) =>
    request<{ data: { contentId: string; commentsEnabled: boolean }; error: null }>(
      `/content/${encodeURIComponent(contentId)}/comment-settings`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    ),

  // Health check
  health: () => request<{ status: string }>('/health'),
};

export default api;