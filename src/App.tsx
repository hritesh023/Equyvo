import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './components/theme-provider';
import { ChatThemeProvider } from './contexts/ChatThemeContext';
import { I18nProvider } from './lib/i18n';
import Navbar, { MobileBottomNav } from './components/Navbar';
import Sidebar from './components/Sidebar';
import { Toaster } from './components/ui/sonner';
import SplashScreen from './components/SplashScreen';
import ErrorBoundary from './components/ErrorBoundary'; 
import { NetworkProvider } from './contexts/NetworkContext';
import { AudioProvider } from './contexts/AudioContext';
import { checkAuthStatus, signOutUser, getStoredUser, clearStoredUser, setToken, User } from './lib/auth';
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
import NotFound from './pages/NotFound';
import type { User as AppUser } from './lib/auth';
import { useIsMobile } from './hooks/use-mobile';
import { useIsTablet } from './hooks/use-tablet';
import { initializeAds } from './lib/admob-service';
import { useAdPlan } from './hooks/use-ad-plan';
import { useFeedBanner } from './hooks/use-feed-banner';

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

const AppContent = () => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();

  // Adaptive feed banner (Free tier, feed routes only — never on video).
  const adPlan = useAdPlan();
  useFeedBanner({ pathname: location.pathname, plan: adPlan });

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
    if (!isLoading && !user && !isAuthPage) {
      navigate('/auth');
    }
  }, [isLoading, user, isAuthPage, navigate]);

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
    /* Unibody shell (phones): ONE body — [top bar] [scrollable content]
       [bottom nav] stacked in normal flow inside a 100dvh flex column.
       The bars own their rows, so no page element can ever be cut off
       behind them (full-viewport overlays keep their safe-area anchoring
       via measured --equyvo-bar-* vars). Desktop keeps the classic
       scrolling window. */
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
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/app/home" element={<HomePage />} />
          <Route path="/app/discover" element={<DiscoverPage />} />
          <Route path="/app/create" element={<CreatePage />} />
          <Route path="/app/moments" element={<MomentsPage />} />
          <Route path="/app/thoughts" element={<ThoughtsPage />} />
          <Route path="/app/profile" element={<ProfilePage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
          <Route path="/app/search" element={<SearchPage />} />
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/moments" element={<MomentsPage />} />
          <Route path="/thoughts" element={<ThoughtsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/profile/:userId" element={<ProfilePage />} />
          <Route path="/profile/@:username" element={<ProfilePage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/app/pricing" element={<PricingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
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
              <Router>
                <ErrorBoundary>
                  <AppContent />
                </ErrorBoundary>
              </Router>
            </I18nProvider>
          </NetworkProvider>
        </AudioProvider>
      </ChatThemeProvider>
    </ThemeProvider>
  );
};
export default App;
