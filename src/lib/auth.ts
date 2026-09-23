import {
  signUp as cognitoSignUp,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  getCurrentSession,
} from './aws';

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
  clearStoredUser();
  storeToken(null);
}

export function getStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeUser(user: User): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredUser(): void {
  localStorage.removeItem(USER_KEY);
}

export async function checkAuthStatus(): Promise<AuthState> {
  try {
    const session: any = await getCurrentSession();
    if (session && session.isValid()) {
      const user = decodeUserFromSession(session);
      if (user) {
        storeUser(user);
        storeToken(sessionToken(session));
        return { user, isLoading: false, isAuthenticated: true };
      }
    }
  } catch {
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

export async function signInWithEmail(email: string, password: string) {
  try {
    const session: any = await cognitoSignIn(email, password);
    const user = decodeUserFromSession(session);
    if (!user) {
      return { success: false, error: 'Unable to decode user session' };
    }
    storeUser(user);
    storeToken(sessionToken(session));
    return { success: true, user };
  } catch (error: any) {
    const message = toErrorMessage(error, '');
    const code = errorCode(error);
    if (message.includes('NotAuthorized') || code === 'NotAuthorizedException') {
      return { success: false, error: 'Incorrect email or password' };
    }
    if (message.includes('UserNotFound') || code === 'UserNotFoundException') {
      return { success: false, error: 'No account found with this email' };
    }
    if (message.includes('UserNotConfirmed') || code === 'UserNotConfirmedException') {
      return { success: false, error: 'Please confirm your email with the code we sent' };
    }
    if (message.includes('Network') || message.includes('fetch') || message.includes('Failed to fetch')) {
      return { success: false, error: 'Network error. Check your connection and try again.' };
    }
    if (message.includes('ResourceNotFound') || code === 'ResourceNotFoundException') {
      // The configured Cognito User Pool / App Client does not exist
      // (deleted pool, wrong region, or wrong ID in env). Retrying can't
      // help — log the actionable cause for the developer.
      try {
        console.error('[auth] Cognito ResourceNotFound: check VITE_AWS_USER_POOL_ID / VITE_AWS_APP_CLIENT_ID / VITE_AWS_REGION');
      } catch { /* ignore */ }
      return { success: false, error: 'Sign-in is temporarily unavailable. Please try again later.' };
    }
    // Production safety: NEVER silently create a local session when auth fails.
    // A fake local user would bypass server-side ownership + quota checks.
    return { success: false, error: message || 'Sign in failed. Please try again.' };
  }
}

export async function signUpWithEmail(email: string, password: string, name?: string) {
  try {
    const result: any = await cognitoSignUp(email, password, name || '');
    const user: User = {
      id: result.userSub || email,
      email,
      fullName: name || '',
      username: email.split('@')[0],
    };
    storeUser(user);
    return { success: true, user };
  } catch (error: any) {
    const message = toErrorMessage(error, '');
    const code = errorCode(error);
    if (message.includes('InvalidPassword') || code === 'InvalidPasswordException') {
      return { success: false, error: 'Password must be at least 6 characters' };
    }
    if (message.includes('InvalidParameter') || code === 'InvalidParameterException') {
      return { success: false, error: 'Invalid email or password format' };
    }
    if (message.includes('UsernameExists') || code === 'UsernameExistsException') {
      return { success: false, error: 'An account with this email already exists. Try signing in.' };
    }
    if (message.includes('Network') || message.includes('fetch') || message.includes('Failed to fetch')) {
      return { success: false, error: 'Network error. Check your connection and try again.' };
    }
    if (message.includes('ResourceNotFound') || code === 'ResourceNotFoundException') {
      // The configured Cognito User Pool / App Client does not exist
      // (deleted pool, wrong region, or wrong ID in env). Retrying can't help.
      try {
        console.error('[auth] Cognito ResourceNotFound: check VITE_AWS_USER_POOL_ID / VITE_AWS_APP_CLIENT_ID / VITE_AWS_REGION');
      } catch { /* ignore */ }
      return { success: false, error: 'Sign-up is temporarily unavailable. Please try again later.' };
    }
    // Production safety: do not create a fake session on signup failure.
    return { success: false, error: message || 'Sign up failed. Please try again.' };
  }
}

export async function signOutUser() {
  try {
    cognitoSignOut();
    clearStoredUser();
    storeToken(null);
    return { success: true };
  } catch {
    clearStoredUser();
    storeToken(null);
    return { success: true };
  }
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
  const stored = getToken();
  if (stored) return stored;
  try {
    const session: any = await getCurrentSession();
    const fresh = sessionToken(session);
    if (fresh) {
      storeToken(fresh);
      return fresh;
    }
  } catch {
    // Silent refresh failed — caller routes to re-auth with return URL.
  }
  return null;
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const status = await checkAuthStatus();
  return status.user;
}
