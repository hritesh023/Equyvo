import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider } from './components/theme-provider';
import { ChatThemeProvider } from './contexts/ChatThemeContext';
import Navbar from './components/Navbar';
import Sidebar from './components/Sidebar';
import { Toaster } from './components/ui/sonner';
import SplashScreen from './components/SplashScreen';
import ErrorBoundary from './components/ErrorBoundary'; 
import { NetworkProvider } from './contexts/NetworkContext';
import { AudioProvider } from './contexts/AudioContext';
import { checkAuthStatus, signOutUser, getStoredUser, clearStoredUser, setToken, User } from './lib/auth';
import HomePage from './pages/HomePage';
import AuthPage from './pages/AuthPage';
import CreatePage from './pages/CreatePage';
import DiscoverPage from './pages/DiscoverPage';
import ProfilePage from './pages/ProfilePage';
import SettingsPage from './pages/SettingsPage';
import SearchPage from './pages/SearchPage';
import MomentsPage from './pages/MomentsPage';
import ThoughtsPage from './pages/ThoughtsPage';
import NotFound from './pages/NotFound';
import type { User as AppUser } from './lib/auth';
import { useIsMobile } from './hooks/use-mobile';
import { useIsTablet } from './hooks/use-tablet';

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

  // Set sidebar initial state based on device
  useEffect(() => {
    if (isTablet) {
      setIsSidebarOpen(false);
    } else {
      setIsSidebarOpen(true);
    }
  }, [isTablet]);

  // Scroll to top when route changes
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    const initAuth = async () => {
      extractTokenFromUrl();
      const authStatus = await checkAuthStatus();
      if (authStatus.isAuthenticated && authStatus.user) {
        setUser(authStatus.user);
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

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Sidebar - Desktop Only */}
      {shouldShowNavbar && <Sidebar isOpen={isSidebarOpen} onToggle={toggleSidebar} />}
      
      {/* Main Content Area */}
      <div className={`flex-1 flex flex-col transition-all duration-300 ease-in-out ${
        isSidebarOpen && !isMobile ? 'lg:ml-64' : 'lg:ml-0'
      }`}>
        {shouldShowNavbar && <Navbar user={user} onSignOut={handleSignOut} />}
        <main className={`flex-1 overflow-y-auto ${
          shouldShowNavbar 
            ? (location.pathname === '/moments' || location.pathname === '/app/moments' 
                ? 'w-full pt-14 pb-16 md:pt-0 md:pb-0' 
                : 'w-full pt-14 pb-16 md:pt-0 md:pb-0') 
            : 'w-full'
        }`}>
        <Routes>
          {}
          <Route path="/" element={<HomePage />} />
          <Route path="/auth" element={<AuthPage onAuthSuccess={(u) => setUser(u)} />} />
          {}
          <Route path="/app/home" element={<HomePage />} />
          <Route path="/app/discover" element={<DiscoverPage />} />
          <Route path="/app/create" element={<CreatePage />} />
          <Route path="/app/moments" element={<MomentsPage />} />
          <Route path="/app/thoughts" element={<ThoughtsPage />} />
          <Route path="/app/profile" element={<ProfilePage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
          <Route path="/app/search" element={<SearchPage />} />
          {}
          <Route path="/discover" element={<DiscoverPage />} />
          <Route path="/create" element={<CreatePage />} />
          <Route path="/moments" element={<MomentsPage />} />
          <Route path="/thoughts" element={<ThoughtsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/profile/:userId" element={<ProfilePage />} />
          <Route path="/profile/@:username" element={<ProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/search" element={<SearchPage />} />
          {}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
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
  if (!showApp) {
    return <SplashScreen onFinish={() => setShowApp(true)} />;
  }
  return (
    <ThemeProvider defaultTheme="dark">
      <ChatThemeProvider>
        <AudioProvider>
          <NetworkProvider>
            <Router>
              <ErrorBoundary>
                <AppContent />
              </ErrorBoundary>
            </Router>
          </NetworkProvider>
        </AudioProvider>
      </ChatThemeProvider>
    </ThemeProvider>
  );
};
export default App;
