import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { signInWithEmail, signUpWithEmail, confirmEmail, resendConfirmation } from '../lib/auth';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Eye, EyeOff, Globe, Lock } from 'lucide-react';
import AppLogo from '../components/AppLogo';
import type { User } from '../lib/auth';

interface AuthPageProps {
  onAuthSuccess?: (user: User) => void;
}

const AuthPage = ({ onAuthSuccess }: AuthPageProps) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Safe internal return path (e.g. /auth?next=/pricing after an expired
  // session interrupted checkout). External URLs are never honored.
  const next = (() => {
    const n = searchParams.get('next');
    return n && n.startsWith('/') && !n.startsWith('//') ? n : '/app/home';
  })();
  const [activeTab, setActiveTab] = useState('signup');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [showSignupPassword, setShowSignupPassword] = useState(false);
  // Account type chosen right at signup: public (everyone sees your posts)
  // or private (only approved followers see them).
  const [signupIsPrivate, setSignupIsPrivate] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Email-confirmation flow (Cognito requires verifying the email before
  // sign-in works). Shown when sign-up / sign-in reports an unconfirmed account.
  const [confirmMode, setConfirmMode] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const goHome = (user: User) => {
    onAuthSuccess?.(user);
    navigate(next);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await signInWithEmail(loginEmail, loginPassword);
      if (result.success && result.user) {
        goHome(result.user);
      } else {
        const msg = result.error || 'Sign in failed';
        if (/confirm your email/i.test(msg)) {
          setConfirmEmail(loginEmail);
          setConfirmPassword(loginPassword);
          setConfirmMode(true);
        } else {
          setError(msg);
        }
      }
    } catch {
      setError('Sign in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await confirmEmail(confirmEmail, confirmCode.trim());
      if (!r.success) {
        setError(r.error || 'Confirmation failed');
        return;
      }
      const result = await signInWithEmail(confirmEmail, confirmPassword);
      if (result.success && result.user) {
        goHome(result.user);
      } else {
        setError(result.error || 'Sign in failed');
        setConfirmMode(false);
        setActiveTab('login');
        setLoginEmail(confirmEmail);
      }
    } catch {
      setError('Confirmation failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setLoading(true);
    try {
      const r = await resendConfirmation(confirmEmail);
      if (!r.success) setError(r.error || 'Could not resend code');
      else setError(''); // success; keep quiet
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await signUpWithEmail(signupEmail, signupPassword, signupName, { isPrivate: signupIsPrivate });
      if (result.success && result.user) {
        // Try to sign in immediately (auto-confirm pools). If the account
        // still needs email verification, fall into the confirm flow instead
        // of dropping the user into a half-authenticated state.
        const signIn = await signInWithEmail(signupEmail, signupPassword);
        if (signIn.success && signIn.user) {
          goHome(signIn.user);
        } else if (/confirm your email/i.test(signIn.error || '')) {
          setConfirmEmail(signupEmail);
          setConfirmPassword(signupPassword);
          setConfirmMode(true);
        } else {
          // Account created but sign-in unavailable right now; show confirm
          // flow proactively so the user can verify when the code arrives.
          setConfirmEmail(signupEmail);
          setConfirmPassword(signupPassword);
          setConfirmMode(true);
        }
      } else {
        const msg = result.error || 'Sign up failed';
        if (/already exists/i.test(msg)) {
          // The email is already registered: route the user to sign in /
          // confirm instead of dead-ending.
          setLoginEmail(signupEmail);
          setLoginPassword(signupPassword);
          setActiveTab('login');
          setError('An account with this email already exists. Try signing in, or confirm your email if you never verified it.');
        } else {
          setError(msg);
        }
      }
    } catch {
      setError('Sign up failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleTabChange = (value: string) => {
    if (value === 'login' && activeTab === 'signup' && signupEmail) {
      setLoginEmail(signupEmail);
      setLoginPassword(signupPassword);
    }
    if (value === 'signup' && activeTab === 'login' && loginEmail) {
      setSignupEmail(loginEmail);
      setSignupPassword(loginPassword);
    }
    setActiveTab(value);
    setError('');
  };

  return (
    <Card className="w-full max-w-md border-border/50 bg-card/50 backdrop-blur-xl mx-auto">
      <CardHeader className="text-center space-y-1">
        <div className="mx-auto mb-2 w-16 h-16 rounded-2xl bg-gradient-to-br from-pink-500 to-purple-600 flex items-center justify-center overflow-hidden">
          <AppLogo alt="Equyvo" className="w-full h-full object-cover" />
        </div>
        <CardTitle className="text-2xl font-bold">Welcome to Equyvo</CardTitle>
        <CardDescription className="text-muted-foreground">
          Sign in to your account or create a new one
        </CardDescription>
      </CardHeader>
      <CardContent>
        {confirmMode ? (
          <form onSubmit={handleConfirm} className="space-y-4">
            <div className="text-center space-y-1 mb-2">
              <p className="text-sm font-medium">Confirm your email</p>
              <p className="text-xs text-muted-foreground">
                We sent a 6-digit code to <span className="font-medium">{confirmEmail}</span>. Enter it below to activate your account.
              </p>
            </div>
            {error && (
              <div className="bg-destructive/10 border border-destructive/20 text-destructive text-sm rounded-lg px-4 py-2.5">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="confirm-code">Confirmation code</Label>
              <Input
                id="confirm-code"
                type="text"
                inputMode="numeric"
                placeholder="123456"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                required
                autoComplete="one-time-code"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Confirming...' : 'Confirm & Sign In'}
            </Button>
            <div className="flex items-center justify-between text-xs">
              <button type="button" onClick={handleResend} className="text-primary hover:underline" disabled={loading}>
                Resend code
              </button>
              <button type="button" onClick={() => { setConfirmMode(false); setError(''); setActiveTab('login'); setLoginEmail(confirmEmail); }} className="text-muted-foreground hover:text-foreground">
                Back to sign in
              </button>
            </div>
          </form>
        ) : (
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
          <TabsList className="w-full mb-6">
            <TabsTrigger value="signup" className="flex-1">Sign Up</TabsTrigger>
            <TabsTrigger value="login" className="flex-1">Sign In</TabsTrigger>
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
                <div className="relative">
                  <Input
                    id="login-password"
                    type={showLoginPassword ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="current-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword(!showLoginPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                  >
                    {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
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
                <div className="relative">
                  <Input
                    id="signup-password"
                    type={showSignupPassword ? 'text' : 'password'}
                    placeholder="Create a password (min 6 characters)"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSignupPassword(!showSignupPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                    aria-label={showSignupPassword ? 'Hide password' : 'Show password'}
                  >
                    {showSignupPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Account type</Label>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Account type">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!signupIsPrivate}
                    onClick={() => setSignupIsPrivate(false)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                      !signupIsPrivate
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Globe className="h-4 w-4" />
                    <span className="text-left">
                      Public
                      <span className="block text-xs font-normal opacity-70">Everyone sees your posts</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={signupIsPrivate}
                    onClick={() => setSignupIsPrivate(true)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                      signupIsPrivate
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <Lock className="h-4 w-4" />
                    <span className="text-left">
                      Private
                      <span className="block text-xs font-normal opacity-70">Followers you approve only</span>
                    </span>
                  </button>
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Creating account...' : 'Create Account'}
              </Button>
            </form>
          </TabsContent>
        </Tabs>
        )}
      </CardContent>
    </Card>
  );
};

export default AuthPage;
