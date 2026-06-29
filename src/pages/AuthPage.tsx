import React from 'react';

const AUTH_URL = import.meta.env.VITE_AUTH_URL || 'https://auth.acronous.com';

const AuthPage = () => {
  React.useEffect(() => {
    const currentUrl = window.location.origin + '/app/home';
    window.location.href = `${AUTH_URL}/login?redirect=${encodeURIComponent(currentUrl)}`;
  }, []);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="text-center space-y-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
        <p className="text-muted-foreground">Redirecting to sign in...</p>
      </div>
    </div>
  );
};

export default AuthPage;
