import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate, useNavigationType, useParams } from 'react-router-dom';
import { ThemeProvider } from './components/theme-provider';
import { ChatThemeProvider } from './contexts/ChatThemeContext';
import { I18nProvider } from './lib/i18n';
import { DisplayProvider } from './lib/display';
import Navbar, { MobileBottomNav } from './components/Navbar';
import Sidebar from './components/Sidebar';
import { Toaster } from './components/ui/sonner';

import ErrorBoundary from './components/ErrorBoundary'; 
import SplashScreen from './components/SplashScreen'; 
import { NetworkProvider } from './contexts/NetworkContext';
import { AudioProvider } from './contexts/AudioContext';
import { checkAuthStatus, signOutUser, getStoredUser, clearStoredUser, clearToken, setToken, User } from './lib/auth';
import { claimBilling } from './lib/billing';
import HomePage from './pages/HomePage';
import AuthPage from './pages/AuthPage';
import CreatePage from './pages/CreatePage';
import DiscoverPage from './pages/DiscoverPage';
import ProfilePage from './pages/ProfilePage';
import SettingsPage from './pages/SettingsPage';
import SearchPage from './pages/SearchPage';
import MomentsPage from './pages/MomentsPage';
import ThoughtsPage from './pages/ThoughtsPage';
import PricingPage from './pages/PricingPage';
import SubscriptionFeaturesPage from './pages/SubscriptionFeaturesPage';
import NotFound from './pages/NotFound';
import type { User as AppUser } from './lib/auth';
import { useIsMobile } from './hooks/use-mobile';
import { useIsTablet } from './hooks/use-tablet';
import { initializeAds } from './lib/admob-service';
import { useAdPlan } from './hooks/use-ad-plan';
import { useFeedBanner } from './hooks/use-feed-banner';
import { useInterstitialTrigger } from './hooks/use-interstitial';
import AdBanner from './components/ads/AdBanner';
import WebInterstitialAd from './components/ads/WebInterstitialAd';
import { initBackNavigation, setGoBack, trackNavigation } from './lib/back-navigation';

function extractTokenFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    setToken(token);
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
    return token;
  }
  return null;
}

/** Shared links use /posts/:id (and the older /profile/posts/:id); both open
 *  the post in the feed instead of dead-ending on the 404 page. */
const SharedPostRedirect = () => {
  const { postId } = useParams();
  return <Navigate to={`/app/home?post=${encodeURIComponent(postId || '')}`} replace />;
};

const AppContent = () => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();

  // ── Hardware/system back wiring ────────────────────────────────────────
  // Every source navigation is mirrored into the coordinator's in-app depth:
  // link taps/stores push, history back pops — so the Android back button
  // walks the PREVIOUS page instead of closing the app. React Router is also
  // handed over as the "go to previous page" implementation.
  const navigationType = useNavigationType();
  const firstNavMirror = useRef(true);
  useEffect(() => {
    // The initial deep-load is not a navigation — don't count it.
    if (firstNavMirror.current) { firstNavMirror.current = false; return; }
    trackNavigation(navigationType);
    // location.key changes on EVERY navigation (even same-path pushes).
  }, [location.key]);
  useEffect(() => {
    setGoBack(() => navigate(-1));
  }, [navigate]);

  // Adaptive feed banner (Free tier, feed routes only — never on video).
  const adPlan = useAdPlan();
  useFeedBanner({ pathname: location.pathname, plan: adPlan });
  // Interstitials only at natural content-session ends (never mid-watch).
  useInterstitialTrigger({ pathname: location.pathname, plan: adPlan });

  // Set sidebar initial state based on device
  useEffect(() => {
    if (isTablet) {
      setIsSidebarOpen(false);
    } else {
      setIsSidebarOpen(true);
    }
  }, [isTablet]);

  // Scroll to top when route changes (the unibody shell scrolls inside the
  // <main> column on phones; the window scrolls on desktop).
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    window.scrollTo(0, 0);
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [location.pathname]);

  useEffect(() => {
    const initAuth = async () => {
      extractTokenFromUrl();
      const authStatus = await checkAuthStatus();
      if (authStatus.isAuthenticated && authStatus.user) {
        setUser(authStatus.user);
        // Link any guest-paid plan (same email) to this account.
        claimBilling().then((c) => {
          if (c && c.granted.length) {
            window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: c.granted[0] } }));
          }
        });
      } else {
        const storedUser = getStoredUser();
        if (storedUser) {
          setUser(storedUser);
        }
      }
      setIsLoading(false);
    };
    initAuth();
  }, []);

  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  const isAuthPage = location.pathname === '/auth';
  // Pricing is browsable signed-out: buyers tap a plan and go straight to
  // Razorpay (guest email checkout) — never bounced through the sign-in wall
  // ("tap 1999 → Sign in failed" regression).
  const isPricingPage = location.pathname === '/pricing' || location.pathname === '/app/pricing';
  const shouldShowNavbar = user && !isAuthPage;

  const handleSignOut = async () => {
    try {
      const result = await signOutUser();
      if (result.success) {
        clearStoredUser();
        // Drop the cached plan so the next account on this device gets
        // correct ad behaviour (never inherit someone else's Premium).
        try {
          localStorage.removeItem('equyvo_active_plan');
        } catch { /* ignore */ }
        window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: null } }));
        setUser(null);
        navigate('/auth');
      }
    } catch {
      // Sign out failed silently
    }
  };

  useEffect(() => {
    if (!isLoading && !user && !isAuthPage && !isPricingPage) {
      // Preserve the deep link (shared post, profile, search) across sign-in.
      const next = location.pathname + location.search;
      navigate('/auth?next=' + encodeURIComponent(next), { replace: true });
    }
  }, [isLoading, user, isAuthPage, isPricingPage, navigate, location.pathname, location.search]);

  // A token the server rejects (expired/revoked session) must not leave the
  // app looking signed-in while every write silently fails. Sign out once and
  // send the user back through auth, returning to where they were.
  const sessionExpiryHandled = useRef(0);
  useEffect(() => {
    const onSessionExpired = () => {
      const now = Date.now();
      if (now - sessionExpiryHandled.current < 5000) return;
      sessionExpiryHandled.current = now;
      clearToken();
      setUser(null);
      if (window.location.pathname === '/auth') return;
      const next = window.location.pathname + window.location.search;
      navigate('/auth?next=' + encodeURIComponent(next), { replace: true });
    };
    window.addEventListener('equyvo:session-expired', onSessionExpired);
    return () => window.removeEventListener('equyvo:session-expired', onSessionExpired);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="text-muted-foreground">Loading Equyvo...</p>
        </div>
      </div>
    );
  }

  if (isAuthPage) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
        <AuthPage onAuthSuccess={(u) => {
          setUser(u);
          // Guest paid earlier with this email? Link it now.
          claimBilling().then((c) => {
            if (c && c.granted.length) {
              window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: c.granted[0] } }));
            }
          });
        }} />
        <Toaster />
      </div>
    );
  }

  return (
    /* Unibody shell (phones): ONE body — [top header] [scrollable content]
       [bottom nav] stacked in normal flow inside a 100dvh flex column.
       The top header (logo, search, notifications, profile) owns its row
       and reserves the OS status-bar safe area itself, so the content
       column needs no extra padding (that would create a double gap).
       Desktop keeps the top nav + sidebar. */
    <div className="flex flex-col overflow-hidden bg-background text-foreground h-screen h-[100dvh] md:h-auto md:min-h-screen md:overflow-visible">
      {shouldShowNavbar && <Sidebar isOpen={isSidebarOpen} onToggle={toggleSidebar} />}
      
      <div className={`flex-1 flex flex-col min-h-0 transition-all duration-300 ease-in-out ${
        isSidebarOpen && !isMobile ? 'lg:ml-64' : 'lg:ml-0'
      }`}>
        {shouldShowNavbar && <Navbar user={user} onSignOut={handleSignOut} />}
        {/* Scrollable content column of the unibody: flex-1 so it exactly
            fills the space between the in-flow top bar and bottom nav;
            edge-fill covers curved left/right display edges. Fixed
            screen overlays (notification panel, fullscreen viewers)
            anchor themselves via .nav-top-safe/.nav-bottom-safe. */}
        <main ref={mainRef} className={`flex-1 w-full min-h-0 overflow-y-auto ${isMobile ? 'overscroll-contain' : ''} edge-fill`}>
        {/* Page-local boundary: a failure in one route renders an inline
            recovery card (navbar/bottom nav stay usable) and resets on the
            next navigation instead of a full-app "reload" wall. */}
        <ErrorBoundary>
         <div className="equyvo-zoom-surface" data-equyvo-zoom-surface="true">
         <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/app/home" element={<HomePage />} />
          <Route path="/app/discover" element={<DiscoverPage />} />
          <Route path="/app/create" element={<CreatePage />} />
          <Route path="/app/moments" element={<MomentsPage />} />
          <Route path="/app/thoughts" element={<ThoughtsPage />} />
          <Route path="/app/profile" element={<ProfilePage />} />
          <Route path="/app/profile/:userId" element={<ProfilePage />} />
          <Route path="/app/profile/@:username" element={<ProfilePage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
          <Route path="/app/search" element={<SearchPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/moments" element={<MomentsPage />} />
          <Route path="/thoughts" element={<ThoughtsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/profile/posts/:postId" element={<SharedPostRedirect />} />
          <Route path="/posts/:postId" element={<SharedPostRedirect />} />
          <Route path="/profile/:userId" element={<ProfilePage />} />
          <Route path="/profile/@:username" element={<ProfilePage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/features" element={<SubscriptionFeaturesPage />} />
          <Route path="/app/features" element={<SubscriptionFeaturesPage />} />
          <Route path="/app/pricing" element={<PricingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="*" element={<NotFound />} />
         </Routes>
         </div>
        </ErrorBoundary>
      </main>
      {/* Web banner ad: in-flow above the bottom nav, every non-auth page,
          free plan only. Native uses the AdMob overlay instead. */}
      <AdBanner pathname={location.pathname} />
      <WebInterstitialAd pathname={location.pathname} />
      {/* Mobile bottom nav: last row of the unibody — in flow, never
          overlaying content. Desktop/tablet uses the top nav instead. */}
      {shouldShowNavbar && <MobileBottomNav />}
      <Toaster />
    </div>
  </div>
  );
};

const App = () => {
  const [showApp, setShowApp] = useState(false);
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setShowApp(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);
  // Initialize Mobile Ads SDK once (no-op on web; real fill on native shell).
  React.useEffect(() => {
    initializeAds();
    initBackNavigation();
  }, []);

  if (!showApp) {
    return <SplashScreen onFinish={() => setShowApp(true)} />;
  }

  return (
    <ThemeProvider defaultTheme="dark">
      <ChatThemeProvider>
        <AudioProvider>
          <NetworkProvider>
            <I18nProvider>
              <DisplayProvider>
                <Router>
                  <ErrorBoundary>
                    <AppContent />
                  </ErrorBoundary>
                </Router>
              </DisplayProvider>
            </I18nProvider>
          </NetworkProvider>
        </AudioProvider>
      </ChatThemeProvider>
    </ThemeProvider>
  );
};
export default App;
