import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithEmail, signUpWithEmail, confirmEmail, resendConfirmation } from '../lib/auth';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import type { User } from '../lib/auth';

interface AuthPageProps {
  onAuthSuccess?: (user: User) => void;
}

const AuthPage = ({ onAuthSuccess }: AuthPageProps) => {
  const navigate = useNavigate();
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await signInWithEmail(loginEmail, loginPassword);
    setLoading(false);
    if (result.success) {
      onAuthSuccess?.(result.user);
      navigate('/app/home');
    } else {
      setError(result.error || 'Sign in failed');
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await signUpWithEmail(signupEmail, signupPassword, signupName);
    setLoading(false);
    if (result.success && result.userConfirmed !== false) {
      onAuthSuccess?.(result.user);
      navigate('/app/home');
    } else if (result.success && result.userConfirmed === false) {
      setPendingEmail(signupEmail);
      setError('A verification code has been sent to your email');
    } else {
      setError(result.error || 'Sign up failed');
    }
  };

  const handleConfirm = async () => {
    if (!confirmCode.trim()) return;
    setError('');
    setLoading(true);
    const result = await confirmEmail(pendingEmail, confirmCode.trim());
    setLoading(false);
    if (result.success) {
      const loginResult = await signInWithEmail(pendingEmail, signupPassword);
      if (loginResult.success) {
        onAuthSuccess?.(loginResult.user);
        navigate('/app/home');
      } else {
        navigate('/auth');
      }
    } else {
      setError(result.error || 'Confirmation failed');
    }
  };

  const handleResendCode = async () => {
    setError('');
    setLoading(true);
    const result = await resendConfirmation(pendingEmail);
    setLoading(false);
    if (result.success) {
      setError('A new verification code has been sent');
    } else {
      setError(result.error || 'Failed to resend code');
    }
  };

  if (pendingEmail) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-md border-border/50 bg-card/50 backdrop-blur-xl">
          <CardHeader className="text-center space-y-1">
            <div className="mx-auto mb-2 w-16 h-16 rounded-2xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center">
              <span className="text-2xl font-bold text-white">Eq</span>
            </div>
            <CardTitle className="text-2xl font-bold">Verify your email</CardTitle>
            <CardDescription className="text-muted-foreground">
              Enter the verification code sent to <span className="text-foreground font-medium">{pendingEmail}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-lg px-4 py-2.5 mb-4">
                {error}
              </div>
            )}
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="confirm-code">Verification Code</Label>
                <Input
                  id="confirm-code"
                  type="text"
                  placeholder="Enter 6-digit code"
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                />
              </div>
              <Button onClick={handleConfirm} className="w-full" disabled={loading || confirmCode.trim().length < 6}>
                {loading ? 'Verifying...' : 'Verify Email'}
              </Button>
              <div className="text-center">
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={loading}
                  className="text-sm text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
                >
                  Resend verification code
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md border-border/50 bg-card/50 backdrop-blur-xl">
        <CardHeader className="text-center space-y-1">
          <div className="mx-auto mb-2 w-16 h-16 rounded-2xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center">
            <span className="text-2xl font-bold text-white">Eq</span>
          </div>
          <CardTitle className="text-2xl font-bold">Welcome to Equyvo</CardTitle>
          <CardDescription className="text-muted-foreground">
            Sign in to your account or create a new one
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="login" className="w-full">
            <TabsList className="w-full mb-6">
              <TabsTrigger value="login" className="flex-1">Sign In</TabsTrigger>
              <TabsTrigger value="signup" className="flex-1">Sign Up</TabsTrigger>
            </TabsList>

            {error && (
              <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-lg px-4 py-2.5 mb-4">
                {error}
              </div>
            )}

            <TabsContent value="login">
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="login-email">Email</Label>
                  <Input
                    id="login-email"
                    type="email"
                    placeholder="you@example.com"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoCapitalize="off"
                    spellCheck="false"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password">Password</Label>
                  <Input
                    id="login-password"
                    type="password"
                    placeholder="Enter your password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="current-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? 'Signing in...' : 'Sign In'}
                </Button>
              </form>
            </TabsContent>

            <TabsContent value="signup">
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="signup-name">Full Name</Label>
                  <Input
                    id="signup-name"
                    type="text"
                    placeholder="John Doe"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    autoComplete="name"
                    autoCapitalize="words"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email</Label>
                  <Input
                    id="signup-email"
                    type="email"
                    placeholder="you@example.com"
                    value={signupEmail}
                    onChange={(e) => setSignupEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoCapitalize="off"
                    spellCheck="false"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password">Password</Label>
                  <Input
                    id="signup-password"
                    type="password"
                    placeholder="Create a password (min 6 characters)"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? 'Creating account...' : 'Create Account'}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
};

export default AuthPage;
