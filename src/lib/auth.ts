import { userPool, getCurrentUser, getCurrentSession, signUp, signIn, signOut, confirmRegistration, resendConfirmationCode } from './aws';

// User interface for our app
export interface User {
  id: string;
  email: string;
  username?: string;
  avatar?: string;
  fullName?: string;
}

// Auth context interface
export interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

// Get current authenticated user details
export const getAuthenticatedUser = async (): Promise<User | null> => {
  try {
    if (!userPool) {
      console.log('No user pool, returning null user');
      return null;
    }

    const currentUser = getCurrentUser();
    if (!currentUser) {
      console.log('No current user, returning null');
      return null;
    }

    // Wrap session check in try-catch
    let session;
    try {
      session = await getCurrentSession();
    } catch (sessionError) {
      console.error('Session error:', sessionError);
      return null;
    }

    if (!session || !session.isValid()) {
      console.log('Invalid or no session, returning null');
      return null;
    }

    // Wrap token decoding in try-catch
    let payload;
    try {
      payload = session.getIdToken().decodePayload();
    } catch (tokenError) {
      console.error('Token decode error:', tokenError);
      return null;
    }
    
    return {
      id: payload.sub,
      email: payload.email,
      username: payload['cognito:username'] || payload.email,
      fullName: payload.name || payload.email.split('@')[0],
    };
  } catch (error) {
    console.error('Error getting authenticated user:', error);
    return null;
  }
};

// Sign up with email and password
export const signUpWithEmail = async (email: string, password: string) => {
  try {
    const result: any = await signUp(email, password);
    return {
      success: true,
      user: result.user,
      userConfirmed: result.userConfirmed,
    };
  } catch (error: any) {
    console.error('Sign up error:', error);
    return {
      success: false,
      error: error.message || 'Failed to sign up',
    };
  }
};

// Sign in with email and password
export const signInWithEmail = async (email: string, password: string) => {
  try {
    const session: any = await signIn(email, password);
    const payload = session.getIdToken().decodePayload();
    
    const user: User = {
      id: payload.sub,
      email: payload.email,
      username: payload['cognito:username'] || payload.email,
      fullName: payload.name || payload.email.split('@')[0],
    };

    return {
      success: true,
      user,
      session,
    };
  } catch (error: any) {
    console.error('Sign in error:', error);
    return {
      success: false,
      error: error.message || 'Failed to sign in',
    };
  }
};

// Sign out current user
export const signOutUser = () => {
  try {
    signOut();
    return { success: true };
  } catch (error: any) {
    console.error('Sign out error:', error);
    return {
      success: false,
      error: error.message || 'Failed to sign out',
    };
  }
};

// Confirm email registration
export const confirmEmail = async (email: string, code: string) => {
  try {
    const result: any = await confirmRegistration(email, code);
    return {
      success: true,
      result,
    };
  } catch (error: any) {
    console.error('Confirmation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to confirm email',
    };
  }
};

// Resend confirmation code
export const resendConfirmation = async (email: string) => {
  try {
    const result: any = await resendConfirmationCode(email);
    return {
      success: true,
      result,
    };
  } catch (error: any) {
    console.error('Resend confirmation error:', error);
    return {
      success: false,
      error: error.message || 'Failed to resend confirmation',
    };
  }
};

// ── localStorage auth helpers for mock/dev mode ──
const CURRENT_USER_KEY = 'equyvo_current_user';

export const storeCurrentUser = (user: User): void => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
  }
};

export const getStoredUser = (): User | null => {
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(CURRENT_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  return null;
};

export const clearStoredUser = (): void => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(CURRENT_USER_KEY);
    localStorage.removeItem('userProfile');
  }
};
// ── end helpers ──

// Check if user is authenticated
export const checkAuthStatus = async (): Promise<AuthState> => {
  try {
    // First check if userPool exists
    if (!userPool) {
      console.log('No user pool available, returning unauthenticated state');
      return {
        user: null,
        isLoading: false,
        isAuthenticated: false,
      };
    }

    const user = await getAuthenticatedUser();
    return {
      user,
      isLoading: false,
      isAuthenticated: !!user,
    };
  } catch (error) {
    console.error('Auth status check error:', error);
    // Return safe default state instead of crashing
    return {
      user: null,
      isLoading: false,
      isAuthenticated: false,
    };
  }
};
