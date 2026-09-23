// API client for Equyvo backend
// In development, proxies through Vite to local Pages Functions
// In production, same origin (Pages serves both frontend and functions)

const API_BASE = '/api';
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

/**
 * Dev-only, once-per-session hint. In local dev, vite proxies /api to a
 * Functions server on :8788 — when it isn't running every /api call fails
 * (empty 500s / network errors) and all feeds render empty. Production
 * serves Functions alongside the app, so this never fires there.
 */
function warnLocalApiOnce(path: string, status: number | string): void {
  try {
    if (!import.meta.env.DEV || localApiWarned) return;
    localApiWarned = true;
    console.warn(
      `[Equyvo] ${path} → ${status} with no backend body. ` +
        `Local dev proxies /api to http://localhost:8788 — start it with: npm run dev:api`,
    );
  } catch {
    /* ignore */
  }
}

async function request<T = any>(
  path: string,
  options?: RequestInit
): Promise<{ data?: T; error?: string }> {
  try {
    // Add cache-busting timestamp to GET requests
    const isGet = !options || !options.method || options.method === 'GET';
    const separator = path.includes('?') ? '&' : '?';
    const url = isGet ? `${API_BASE}${path}${separator}_t=${Date.now()}` : `${API_BASE}${path}`;
    const headers: Record<string, string> = authHeaders();
    const isFormData = options?.body instanceof FormData;
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, {
      headers,
      ...options,
    });
    // Error pages (vite proxy 500s, gateway HTML) are not JSON — never let
    // body parsing itself become the reported error.
    const json = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) {
      const bodyError =
        typeof json.error === 'string' && json.error ? json.error : null;
      if (!bodyError) warnLocalApiOnce(path, res.status);
      return { error: bodyError || `Request failed with status ${res.status}` };
    }
    return json as T;
  } catch (err: any) {
    warnLocalApiOnce(path, 'network');
    return { error: err?.message || 'Network error' };
  }
}

export const api = {
  // Posts
  getPosts: (limit = 50) =>
    request<{ data: any[]; error: null }>(`/posts?limit=${limit}`),

  createPost: (data: any) =>
    request<{ data: any; error: null }>('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Thoughts
  getThoughts: (limit = 20, offset = 0) =>
    request<{ data: any[]; error: null }>(`/thoughts?limit=${limit}&offset=${offset}`),

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
    request<{ data: any; error: null }>(`/profile/${userId}`),

  updateProfile: (data: any) =>
    request<{ data: any; error: null }>('/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  // Search
  search: (query: string) =>
    request<{ data: { results: any[]; totalCount: number; isAiRecommended: boolean }; error: null }>(
      `/search?q=${encodeURIComponent(query)}`
    ),

  // Content indexing (called after Cloudinary upload)
  indexContent: (data: any) =>
    request<{ data: { success: boolean }; error: null }>('/content-index', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // Delete
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

  // Upload file via backend (R2 warehouse primary, Cloudinary selective).
  // secureUrl is always the best delivery URL (R2 when bound) — render it
  // directly. No backend secrets ever reach the browser.
  uploadFile: (file: File | Blob, folder?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    if (folder) formData.append('folder', folder);
    return request<{
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
    }>('/upload', {
      method: 'POST',
      body: formData,
    });
  },

  // Get user's own posts
  getUserPosts: (userId: string, limit = 50) =>
    request<{ data: any[]; error: null }>(`/users/${userId}/posts?limit=${limit}`),

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

  // Creator economy MVP (money moves via Razorpay verify on api.acronous.com;
  // these endpoints only record verified intents server-side)
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

  // Health check
  health: () => request<{ status: string }>('/health'),
};

export default api;