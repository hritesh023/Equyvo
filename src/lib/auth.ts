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

const AUTH_URL = import.meta.env.VITE_AUTH_URL || 'https://auth.acronous.com';
const TOKEN_KEY = 'acronous_token';
const USER_KEY = 'acronous_user';

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[2]) : null;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY) || getCookie(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  document.cookie = `${TOKEN_KEY}=; Domain=.acronous.com; Path=/; Max-Age=0`;
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

function redirectToLogin() {
  const currentUrl = window.location.href;
  window.location.href = `${AUTH_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;
}

export async function checkAuthStatus(): Promise<AuthState> {
  const token = getToken();
  if (!token) {
    return { user: null, isLoading: false, isAuthenticated: false };
  }

  try {
    const res = await fetch(`${AUTH_URL}/api/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.valid && data.user) {
      const user: User = {
        id: data.user.id,
        email: data.user.email,
        fullName: data.user.name,
        username: data.user.email.split('@')[0],
      };
      storeUser(user);
      return { user, isLoading: false, isAuthenticated: true };
    }
    clearToken();
    return { user: null, isLoading: false, isAuthenticated: false };
  } catch {
    const stored = getStoredUser();
    if (stored) {
      return { user: stored, isLoading: false, isAuthenticated: true };
    }
    return { user: null, isLoading: false, isAuthenticated: false };
  }
}

export async function signInWithEmail(email: string, password: string) {
  try {
    const res = await fetch(`${AUTH_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    });
    const data = await res.json();
    if (data.success) {
      setToken(data.token);
      const user: User = {
        id: data.user.id,
        email: data.user.email,
        fullName: data.user.name,
        username: data.user.email.split('@')[0],
      };
      storeUser(user);
      return { success: true, user };
    }
    return { success: false, error: data.error || 'Sign in failed' };
  } catch (error: any) {
    return { success: false, error: error.message || 'Network error' };
  }
}

export async function signUpWithEmail(email: string, password: string, name?: string) {
  try {
    const res = await fetch(`${AUTH_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name }),
      credentials: 'include',
    });
    const data = await res.json();
    if (data.success) {
      setToken(data.token);
      const user: User = {
        id: data.user.id,
        email: data.user.email,
        fullName: data.user.name,
        username: data.user.email.split('@')[0],
      };
      storeUser(user);
      return { success: true, user };
    }
    return { success: false, error: data.error || 'Sign up failed' };
  } catch (error: any) {
    return { success: false, error: error.message || 'Network error' };
  }
}

export async function signOutUser() {
  try {
    await fetch(`${AUTH_URL}/api/auth/logout`, { method: 'POST' });
    clearToken();
    return { success: true };
  } catch {
    clearToken();
    return { success: true };
  }
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const status = await checkAuthStatus();
  return status.user;
}

export async function confirmEmail(_email: string, _code: string) {
  return { success: false, error: 'Email confirmation is not required with centralized auth' };
}

export async function resendConfirmation(_email: string) {
  return { success: false, error: 'Not applicable' };
}
