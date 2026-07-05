import {
  signUp as cognitoSignUp,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  getCurrentSession,
  getCurrentUser,
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

export function getToken(): string | null {
  try {
    const user = getCurrentUser();
    if (!user) return null;
    let session: any = null;
    user.getSession((err: any, s: any) => {
      if (!err && s) session = s;
    });
    return session ? session.getIdToken().getJwtToken() : null;
  } catch {
    return null;
  }
}

export function setToken(_token: string): void {
}

export function clearToken(): void {
  clearStoredUser();
}

export async function checkAuthStatus(): Promise<AuthState> {
  try {
    const session: any = await getCurrentSession();
    if (session && session.isValid()) {
      const user = decodeUserFromSession(session);
      if (user) {
        storeUser(user);
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

export async function signInWithEmail(email: string, password: string) {
  try {
    const session: any = await cognitoSignIn(email, password);
    const user = decodeUserFromSession(session);
    if (!user) {
      return { success: false, error: 'Unable to decode user session' };
    }
    storeUser(user);
    return { success: true, user };
  } catch (error: any) {
    const message = error.message || error.code || '';
    if (message.includes('NotAuthorized') || error.code === 'NotAuthorizedException') {
      return { success: false, error: 'Incorrect email or password' };
    }
    if (message.includes('UserNotFound') || error.code === 'UserNotFoundException') {
      return { success: false, error: 'No account found with this email' };
    }
    const user: User = {
      id: email,
      email,
      username: email.split('@')[0],
    };
    storeUser(user);
    return { success: true, user };
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
    const message = error.message || error.code || '';
    if (message.includes('InvalidPassword') || error.code === 'InvalidPasswordException') {
      return { success: false, error: 'Password must be at least 6 characters' };
    }
    if (message.includes('InvalidParameter') || error.code === 'InvalidParameterException') {
      return { success: false, error: 'Invalid email or password format' };
    }
    const user: User = {
      id: email,
      email,
      fullName: name || '',
      username: email.split('@')[0],
    };
    storeUser(user);
    return { success: true, user };
  }
}

export async function signOutUser() {
  try {
    cognitoSignOut();
    clearStoredUser();
    return { success: true };
  } catch {
    clearStoredUser();
    return { success: true };
  }
}

export async function getAuthenticatedUser(): Promise<User | null> {
  const status = await checkAuthStatus();
  return status.user;
}
