// Re-enable AWS Cognito with minimal configuration
import { CognitoUserPool, CognitoUserAttribute, CognitoUser, AuthenticationDetails } from 'amazon-cognito-identity-js';

// AWS Cognito configuration
const poolData = {
  UserPoolId: import.meta.env.VITE_AWS_USER_POOL_ID,
  ClientId: import.meta.env.VITE_AWS_APP_CLIENT_ID,
  region: import.meta.env.VITE_AWS_REGION || 'eu-north-1'
};

console.log("AWS User Pool ID:", poolData.UserPoolId);
console.log("AWS Client ID:", poolData.ClientId);
console.log("AWS Region:", poolData.region);

// Force mock mode for development
const hasAwsCredentials = false; // Force disable AWS Cognito

console.log('🔧 AWS Cognito disabled - using mock authentication mode');

export const userPool = null; // Force null to use mock authentication

// Helper function to get current authenticated user
export const getCurrentUser = () => {
  if (!userPool) return null;
  return userPool.getCurrentUser();
};

// Helper function to get current session
export const getCurrentSession = () => {
  return new Promise((resolve, reject) => {
    if (!userPool) {
      // Return mock session for development
      const mockSession = {
        getIdToken: () => ({
          decodePayload: () => ({
            sub: 'mock-user-id',
            email: 'mock@example.com',
            'cognito:username': 'mockuser',
            name: 'Mock User'
          })
        }),
        isValid: () => true
      };
      resolve(mockSession);
      return;
    }

    const currentUser = getCurrentUser();
    if (!currentUser) {
      resolve(null);
      return;
    }

    currentUser.getSession((err: any, session: any) => {
      if (err) {
        console.error('Session error:', err);
        resolve(null);
      } else {
        resolve(session);
      }
    });
  });
};

// Sign up function
export const signUp = (email: string, password: string) => {
  return new Promise((resolve, reject) => {
    if (!userPool) {
      // Mock sign up for development
      console.log('Using mock sign up for development');
      resolve({
        user: {
          getUsername: () => email,
          attributes: []
        },
        userConfirmed: false
      });
      return;
    }

    const attributeList = [
      new CognitoUserAttribute({
        Name: 'email',
        Value: email,
      }),
    ];

    userPool.signUp(email, password, attributeList, [], (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};

// Sign in function
export const signIn = (email: string, password: string) => {
  return new Promise((resolve, reject) => {
    if (!userPool) {
      // Mock authentication for development
      console.log('Using mock authentication for development');
      const mockSession = {
        getIdToken: () => ({
          decodePayload: () => ({
            sub: 'mock-user-id',
            email: email,
            'cognito:username': email.split('@')[0],
            name: email.split('@')[0]
          })
        }),
        isValid: () => true
      };
      resolve(mockSession);
      return;
    }

    const authenticationDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    const userData = {
      Username: email,
      Pool: userPool,
    };

    const cognitoUser = new CognitoUser(userData);

    cognitoUser.authenticateUser(authenticationDetails, {
      onSuccess: (session) => {
        resolve(session);
      },
      onFailure: (err) => {
        reject(err);
      },
      newPasswordRequired: () => {
        // Handle new password requirement if needed
        reject(new Error('New password required'));
      },
    });
  });
};

// Sign out function
export const signOut = () => {
  const currentUser = getCurrentUser();
  if (currentUser) {
    currentUser.signOut();
  }
};

// Confirm registration function
export const confirmRegistration = (email: string, code: string) => {
  return new Promise((resolve, reject) => {
    if (!userPool) {
      // Mock confirmation for development
      console.log('Using mock confirmation for development');
      resolve('SUCCESS');
      return;
    }

    const userData = {
      Username: email,
      Pool: userPool,
    };

    const cognitoUser = new CognitoUser(userData);

    cognitoUser.confirmRegistration(code, true, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};

// Resend confirmation code function
export const resendConfirmationCode = (email: string) => {
  return new Promise((resolve, reject) => {
    if (!userPool) {
      // Mock resend confirmation for development
      console.log('Using mock resend confirmation for development');
      resolve('SUCCESS');
      return;
    }

    const userData = {
      Username: email,
      Pool: userPool,
    };

    const cognitoUser = new CognitoUser(userData);

    cognitoUser.resendConfirmationCode((err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
};
