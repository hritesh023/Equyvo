// Auth now uses Equyvo's own backend (no Cognito, no email verification).
// Kept as a thin HTTP client over /api/auth/*.
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

// Auth calls must never hang the splash screen or a sign-in button. 15s is
// long enough for a weak mobile network, short enough to show a real error.
const AUTH_TIMEOUT_MS = 15_000;

async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authNetworkError(err: unknown, fallback: string): string {
  return (err as { name?: string } | null)?.name === 'AbortError'
    ? 'The server took too long to respond. Check your connection and try again.'
    : fallback;
}

export interface User {
  id: string;
  email: string;
  username?: string;
  avatar?: string;
  fullName?: string;
}

export interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

const USER_KEY = 'equyvo_cognito_user';
const TOKEN_KEY = 'equyvo_cognito_token';

function decodeUserFromSession(session: any): User | null {
  try {
    const payload = session.getIdToken().decodePayload();
    return {
      id: payload.sub,
      email: payload.email,
      fullName: payload.name || payload['cognito:username'] || '',
      username: payload['cognito:username'] || payload.email.split('@')[0],
    };
  } catch {
    return null;
  }
}

function sessionToken(session: any): string | null {
  try {
    const idToken = session?.getIdToken?.();
    if (idToken && typeof idToken.getJwtToken === 'function') {
      return idToken.getJwtToken();
    }
  } catch {
    // mock sessions may not expose a real JWT
  }
  return null;
}

function storeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage errors
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  storeToken(token);
}

export function clearToken(): void {
  clearViewerCaches();
  clearStoredUser();
  storeToken(null);
}

/**
 * Remove every cache that belongs to the signed-in viewer (saved items, watch
 * history, reactions, local follow/chat caches, notifications). Prevents the
 * next account on the same device from inheriting another person's data.
 * Device settings (theme, language, ad/notification preferences) are kept.
 */
export function clearViewerCaches(): void {
  if (typeof localStorage === 'undefined') return;
  const keys = [
    'userProfile',
    'savedContentData',
    'savedPosts',
    'savedStories',
    'savedThoughts',
    'userReactedThoughts',
    'watchHistory',
    'equyvo_watch_history',
    'equyvo_saved_ids',
    'equyvo_liked_stories',
    'userUploadedStories',
    'equyvo_hidden_ids',
    'equyvo_following',
    'equyvo_social_profiles',
    'equyvo_chat_contacts',
    'equyvo_chat_v2_threads',
    'equyvo_chat_v2_messages',
    'equyvo_notif_dismissed_v1',
    'equyvo_notifications_v1',
    'equyvo_search_history',
    'search_events',
    'equyvo_active_plan',
    'equyvo_last_plan',
    'equyvo_active_live',
    'equyvo_live_notifications',
    'posts',
    'thoughts',
    'stories',
    'moments',
    'userMoments',
    'userThoughts',
    'contentData',
    'equyvo_content_cache',
  ];
  for (const key of keys) {
    try { localStorage.removeItem(key); } catch { /* best-effort */ }
  }
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<User> | null;
    // Corrupt / fake-shaped entries must never break auth-dependent screens:
    // a stored user has to at least identify itself, otherwise treat the
    // session as signed out (and clear the junk so it doesn't recur).
    if (!parsed || typeof parsed !== 'object') {
      localStorage.removeItem(USER_KEY);
      return null;
    }
    const hasId = typeof parsed.id === 'string' && (parsed.id as string).trim().length > 0;
    const hasEmail = typeof parsed.email === 'string' && (parsed.email as string).trim().length > 0;
    if (!hasId && !hasEmail) {
      localStorage.removeItem(USER_KEY);
      return null;
    }
    return parsed as User;
  } catch {
    return null;
  }
}

function storeUser(user: User): void {
  try {
    // Switching accounts on one device must never inherit the previous
    // viewer's saved items, history, reactions, follow/chat caches or profile.
    const prevRaw = localStorage.getItem(USER_KEY);
    if (prevRaw) {
      try {
        const prev = JSON.parse(prevRaw) as Partial<User> | null;
        const prevId = String(prev?.id || prev?.email || '').trim().toLowerCase();
        const nextId = String(user?.id || user?.email || '').trim().toLowerCase();
        if (prevId && nextId && prevId !== nextId) clearViewerCaches();
      } catch { /* ignore corrupt cache */ }
    }
  } catch { /* ignore storage errors */ }
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredUser(): void {
  localStorage.removeItem(USER_KEY);
}

function decodeCentralJWT(token: string): User | null {
  // Central Acronous JWT from dashboard SSO (?token=): HS256 {id,email,name}.
  // Accepted without a Cognito session so one account works everywhere.
  // Signature is verified server-side on every /api call; here we only check
  // shape + expiry for UI state (never for authorization).
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const payload = JSON.parse(atob(padded));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    const id = payload.id || payload.sub || payload.user_id || payload.email;
    if (!id) return null;
    const email = String(payload.email || (String(id).includes('@') ? id : ''));
    return {
      id: String(id),
      email,
      fullName: String(payload.name || payload.username || ''),
      username: String(payload.username || payload.name || (email ? email.split('@')[0] : String(id))),
    };
  } catch {
    return null;
  }
}

export async function checkAuthStatus(): Promise<AuthState> {
  const t = getToken();
  if (t) {
    // Central SSO token (?token= from the Acronous dashboard) is a JWT we can
    // validate locally for UI purposes even when /auth/me doesn't know it.
    const centralUser = decodeCentralJWT(t);
    try {
      const r = await authFetch(API_BASE + '/auth/me', { headers: { Authorization: 'Bearer ' + t } });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.user) {
        const u = j.user;
        const user: User = {
          id: u.id,
          email: u.email,
          fullName: u.name || u.fullName || '',
          username: u.username || u.name || (u.email ? String(u.email).split('@')[0] : ''),
        };
        storeUser(user);
        return { user, isLoading: false, isAuthenticated: true };
      }
      // A definitive rejection means this device's session is dead. Drop the
      // token and the cached identity so the app asks for a fresh sign-in
      // instead of pretending to be signed in while every write 401s.
      if (r.status === 401 && !centralUser) {
        storeToken(null);
        clearStoredUser();
        return { user: null, isLoading: false, isAuthenticated: false };
      }
    } catch { /* network/timeout — keep the cached session below */ }
    if (centralUser) {
      storeUser(centralUser);
      return { user: centralUser, isLoading: false, isAuthenticated: true };
    }
  }

  const stored = getStoredUser();
  if (stored) {
    return { user: stored, isLoading: false, isAuthenticated: true };
  }

  return { user: null, isLoading: false, isAuthenticated: false };
}

/**
 * Normalize any thrown/rejected value into a human-readable message.
 * The Cognito library can reject with null / non-Error payloads on network
 * failures — reading `.message` off those used to throw a second TypeError
 * ("Cannot read properties of null") or surface a bare "null" in the UI.
 * This never throws and never returns "null"/"undefined" text.
 */
function toErrorMessage(error: unknown, fallback: string): string {
  try {
    if (typeof error === 'string') {
      const s = error.trim();
      return s && s !== 'null' && s !== 'undefined' ? s : fallback;
    }
    const anyErr = error as { message?: unknown; code?: unknown } | null | undefined;
    const raw = anyErr?.message ?? anyErr?.code;
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s && s !== 'null' && s !== 'undefined') return s;
      return fallback;
    }
    if (raw !== undefined && raw !== null) {
      const s = String(raw).trim();
      if (s && s !== 'null' && s !== 'undefined' && s !== '[object Object]') return s;
    }
  } catch {
    // fall through to fallback
  }
  return fallback;
}

function errorCode(error: unknown): string {
  try {
    const anyErr = error as { code?: unknown } | null | undefined;
    return typeof anyErr?.code === 'string' ? anyErr.code : '';
  } catch {
    return '';
  }
}

const PENDING_PRIVACY_KEY = 'equyvo_pending_account_type';

function storePendingPrivacy(isPrivate: boolean): void {
  try {
    localStorage.setItem(PENDING_PRIVACY_KEY, isPrivate ? 'private' : 'public');
  } catch { /* ignore */ }
}

function takePendingPrivacy(): 'private' | 'public' | null {
  try {
    const raw = localStorage.getItem(PENDING_PRIVACY_KEY);
    if (raw === 'private' || raw === 'public') {
      localStorage.removeItem(PENDING_PRIVACY_KEY);
      return raw;
    }
  } catch { /* ignore */ }
  return null;
}

// Best-effort: persist the chosen account type to the server profile so it
// applies on every device. Never blocks auth when the API is unreachable
// (e.g. email not yet confirmed) — the choice stays queued locally.
async function applyAccountType(user: User, isPrivate: boolean): Promise<void> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const id = user?.id || user?.email || '';
      if (id) headers['X-User-Id'] = String(id);
    } catch { /* ignore */ }
    await authFetch('/api/profile', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.fullName || user.username || '',
        username: user.username || '',
        isPrivate,
        accountType: isPrivate ? 'private' : 'public',
      }),
    }).catch(() => null);
  } catch { /* best-effort */ }
}

export async function signInWithEmail(email: string, password: string) {
  try {
    const r = await authFetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.token || !j.user) {
      return { success: false, error: (j && (j.error || j.message)) || 'Invalid email or password' };
    }
    const u = j.user;
    const user: User = {
      id: u.id,
      email: u.email,
      fullName: u.name || u.fullName || '',
      username: u.username || u.name || (u.email ? String(u.email).split('@')[0] : ''),
    };
    storeUser(user);
    storeToken(j.token);
    const pending = takePendingPrivacy();
    if (pending) await applyAccountType(user, pending === 'private');
    return { success: true, user };
  } catch (err) {
    return { success: false, error: authNetworkError(err, 'Network error. Check your connection and try again.') };
  }
}

export async function signUpWithEmail(
  email: string,
  password: string,
  name?: string,
  opts?: { isPrivate?: boolean },
) {
  try {
    const isPrivate = opts?.isPrivate === true;
    const r = await authFetch(API_BASE + '/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: name || '', isPrivate }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.token || !j.user) {
      const msg = (j && (j.error || j.message)) || 'Sign up failed';
      if (r.status === 409) return { success: false, error: 'An account with this email already exists. Try signing in.' };
      return { success: false, error: msg };
    }
    const u = j.user;
    const user: User = {
      id: u.id,
      email: u.email,
      fullName: u.name || name || '',
      username: u.username || u.name || (u.email ? String(u.email).split('@')[0] : ''),
    };
    storeUser(user);
    storeToken(j.token);
    storePendingPrivacy(isPrivate);
    await applyAccountType(user, isPrivate);
    return { success: true, user };
  } catch (err) {
    return { success: false, error: authNetworkError(err, 'Network error. Check your connection and try again.') };
  }
}

// No email verification is required anymore. These are retained as no-ops so
// older callers/UI keep compiling.
export async function confirmEmail(_email: string, _code: string): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}
export async function resendConfirmation(_email: string): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}

export async function signOutUser(): Promise<{ success: boolean; error?: string }> {
  const t = getToken();
  if (t) {
    try { await authFetch(API_BASE + '/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }); } catch { /* ignore */ }
  }
  clearViewerCaches();
  clearStoredUser();
  storeToken(null);
  return { success: true };
}

export function hasStoredUser(): boolean {
  return getStoredUser() !== null;
}

/**
 * Best-effort auth token for server calls (billing, entitlements).
 * A stored user can outlive its token (expired / refreshed-away session),
 * which used to surface as a dead-end "Please sign in first" on the
 * subscription screen. This tries a silent Cognito refresh before giving up.
 */
export async function getAuthToken(): Promise<string | null> {
  return getToken();
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const status = await checkAuthStatus();
  return status.user;
}
