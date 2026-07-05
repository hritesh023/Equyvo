import {
  signUp as cognitoSignUp,
  signIn as cognitoSignIn,
  signOut as cognitoSignOut,
  getCurrentSession,
  getCurrentUser,
  confirmRegistration,
  resendConfirmationCode as cognitoResendCode,
  userPool,
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
  // No-op: Cognito SDK manages its own token storage
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
    // Fall through to stored user
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
    let message = error.message || 'Sign in failed';
    if (error.code === 'UserNotConfirmedException' || message.includes('UserNotConfirmed')) {
      message = 'Please confirm your email before signing in';
    } else if (error.code === 'NotAuthorizedException' || message.includes('NotAuthorized')) {
      message = 'Incorrect email or password';
    } else if (error.code === 'UserNotFoundException' || message.includes('UserNotFound')) {
      message = 'No account found with this email';
    }
    return { success: false, error: message };
  }
}

export async function signUpWithEmail(email: string, password: string, name?: string) {
  try {
    const result: any = await cognitoSignUp(email, password, name || '');
    if (result.userConfirmed === false) {
      return {
        success: true,
        userConfirmed: false,
        user: {
          id: result.userSub || email,
          email,
          fullName: name || '',
          username: email.split('@')[0],
        },
      };
    }

    const user: User = {
      id: result.userSub || email,
      email,
      fullName: name || '',
      username: email.split('@')[0],
    };
    storeUser(user);
    return { success: true, user, userConfirmed: true };
  } catch (error: any) {
    let message = error.message || 'Sign up failed';
    if (error.code === 'UsernameExistsException' || message.includes('UsernameExists')) {
      message = 'An account with this email already exists';
    } else if (error.code === 'InvalidPasswordException' || message.includes('InvalidPassword')) {
      message = 'Password must be at least 8 characters with numbers and special characters';
    } else if (error.code === 'InvalidParameterException' || message.includes('InvalidParameter')) {
      message = 'Invalid email or password format';
    }
    return { success: false, error: message };
  }
}

export async function confirmEmail(email: string, code: string) {
  try {
    await confirmRegistration(email, code);
    return { success: true };
  } catch (error: any) {
    let message = error.message || 'Confirmation failed';
    if (error.code === 'CodeMismatchException' || message.includes('CodeMismatch')) {
      message = 'Invalid confirmation code';
    } else if (error.code === 'ExpiredCodeException' || message.includes('ExpiredCode')) {
      message = 'Confirmation code has expired. Request a new one';
    }
    return { success: false, error: message };
  }
}

export async function resendConfirmation(email: string) {
  try {
    await cognitoResendCode(email);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || 'Failed to resend code' };
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
