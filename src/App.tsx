import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { BrowserRouter as Router, Navigate, useLocation, useNavigate, useNavigationType, useParams, useRoutes, type RouteObject } from 'react-router-dom';
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
// Route-level code splitting: only the landing page ships in the entry
// bundle. Heavy pages (create/compose, feeds, chat-heavy profile, pricing)
// are fetched on demand — this is the safe way to split without the static
// import cycles that broke a previous manualChunks experiment.
const AuthPage = lazy(() => import('./pages/AuthPage'));
const CreatePage = lazy(() => import('./pages/CreatePage'));
const DiscoverPage = lazy(() => import('./pages/DiscoverPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const MomentsPage = lazy(() => import('./pages/MomentsPage'));
const UseAudioPage = lazy(() => import('./pages/UseAudioPage'));
const ThoughtsPage = lazy(() => import('./pages/ThoughtsPage'));
const PricingPage = lazy(() => import('./pages/PricingPage'));
const SubscriptionFeaturesPage = lazy(() => import('./pages/SubscriptionFeaturesPage'));
const NotFound = lazy(() => import('./pages/NotFound'));

const RouteFallback = () => (
  <div className="flex min-h-[45vh] w-full items-center justify-center" role="status" aria-label="Loading">
    <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />
  </div>
);
import type { User as AppUser } from './lib/auth';
import { useIsMobile } from './hooks/use-mobile';
import { useIsTablet } from './hooks/use-tablet';
import { useNavMode } from './hooks/use-nav-mode';
import { initializeAds } from './lib/admob-service';
import AppOpenAd from './components/AppOpenAd';
import { useAdPlan } from './hooks/use-ad-plan';
import { useInterstitialAds } from './hooks/use-interstitial-ads';
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

const MAIN_TABS = ['/app/home', '/app/discover', '/app/create', '/app/moments', '/app/thoughts', '/app/profile'];

/** Every route as data so useRoutes() can resolve one element while we keep
 *  already-visited pages mounted (React Router's <Routes> unmounts the old
 *  route, which wiped CreatePage's selected upload tab, drafts and feed
 *  scroll position on every tab switch). */
const ROUTES: RouteObject[] = [
  { path: '/', element: <HomePage /> },
  { path: '/app/home', element: <HomePage /> },
  { path: '/app/discover', element: <DiscoverPage /> },
  { path: '/app/create', element: <CreatePage /> },
  { path: '/app/moments', element: <MomentsPage /> },
  { path: '/app/use-audio', element: <UseAudioPage /> },
  { path: '/app/thoughts', element: <ThoughtsPage /> },
  { path: '/app/profile', element: <ProfilePage /> },
  { path: '/app/profile/:userId', element: <ProfilePage /> },
  { path: '/app/profile/@:username', element: <ProfilePage /> },
  { path: '/app/settings', element: <SettingsPage /> },
  { path: '/app/search', element: <SearchPage /> },
  { path: '/discover', element: <DiscoverPage /> },
  { path: '/create', element: <CreatePage /> },
  { path: '/moments', element: <MomentsPage /> },
  { path: '/use-audio', element: <UseAudioPage /> },
  { path: '/thoughts', element: <ThoughtsPage /> },
  { path: '/profile', element: <ProfilePage /> },
  { path: '/profile/posts/:postId', element: <SharedPostRedirect /> },
  { path: '/posts/:postId', element: <SharedPostRedirect /> },
  { path: '/profile/:userId', element: <ProfilePage /> },
  { path: '/profile/@:username', element: <ProfilePage /> },
  { path: '/pricing', element: <PricingPage /> },
  { path: '/features', element: <SubscriptionFeaturesPage /> },
  { path: '/app/features', element: <SubscriptionFeaturesPage /> },
  { path: '/app/pricing', element: <PricingPage /> },
  { path: '/settings', element: <SettingsPage /> },
  { path: '/search', element: <SearchPage /> },
  { path: '*', element: <NotFound /> },
];

/** Canonical key for a route. The `/app` and legacy top-level URLs render the
 *  same page, so they share one cached instance (and one saved scroll spot). */
const pageCacheKey = (pathname: string): string => {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/app' || p === '/app/home' || p === '/home') return 'home';
  return p.startsWith('/app/') ? p.slice(4) : p;
};

/** Keep-alive page renderer. Visited pages stay mounted but hidden, so local
 *  component state (selected composer tab, drafts, players, loaded feeds)
 *  survives navigation. Inactive pages use display:none; the active wrapper
 *  uses display:contents so layout is identical to a plain route render. */
const CachedPageRoutes: React.FC = () => {
  const location = useLocation();
  const matched = useRoutes(ROUTES);
  const key = pageCacheKey(location.pathname);
  const isRedirect = /^\/posts\/[^/]+$/.test(location.pathname) || /^\/profile\/posts\/[^/]+$/.test(location.pathname);
  const [cache, setCache] = useState<{ key: string; node: React.ReactNode }[]>([]);

  // Register a first visit during render (idempotent) so the page mounts once
  // with no blank frame and its state is kept from then on.
  if (!isRedirect && !cache.some((e) => e.key === key)) {
    setCache((prev) => (prev.some((e) => e.key === key) ? prev : [...prev, { key, node: matched }]));
  }

  return (
    <>
      {cache.map((entry) => (
        <div
          key={entry.key}
          data-equyvo-page={entry.key}
          style={{ display: !isRedirect && entry.key === key ? 'contents' : 'none' }}
        >
          {entry.node}
        </div>
      ))}
      {isRedirect && matched}
    </>
  );
};

const AppContent = () => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  useNavMode();

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

  // Interstitial ads at natural breaks (Free tier only, never during content).
  const adPlan = useAdPlan();
  useInterstitialAds();

  // Set sidebar initial state based on device
  useEffect(() => {
    if (isTablet) {
      setIsSidebarOpen(false);
    } else {
      setIsSidebarOpen(true);
    }
  }, [isTablet]);

  // Hide the mobile bottom nav while a chat conversation is open so it can't
  // overlay the message composer.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent)?.detail;
      setChatOpen(!!detail?.open);
    };
    window.addEventListener('equyvo:chat-open', handler);
    return () => window.removeEventListener('equyvo:chat-open', handler);
  }, []);

  // Per-page scroll memory. Pages stay mounted now, but they all share the
  // single <main> scroll container (or the window on desktop), so we remember
  // where each page was and put it back when the user returns to it.
  const mainRef = useRef<HTMLElement | null>(null);
  const [navHidden, setNavHidden] = useState(false);
  const lastScrollTopRef = useRef(0);
  const scrollMemoryRef = useRef<Record<string, { main: number; win: number }>>({});
  const scrollPathRef = useRef(pageCacheKey(location.pathname));
  scrollPathRef.current = pageCacheKey(location.pathname);
  const handleMainScroll = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    const st = el.scrollTop;
    const k = scrollPathRef.current;
    scrollMemoryRef.current[k] = { ...(scrollMemoryRef.current[k] || { win: 0 }), main: st };
    const delta = st - lastScrollTopRef.current;
    if (st <= 0) setNavHidden(false);
    else if (delta > 6) setNavHidden(true);
    else if (delta < -6) setNavHidden(false);
    lastScrollTopRef.current = st;
  }, []);
  useEffect(() => {
    const onWindowScroll = () => {
      const k = scrollPathRef.current;
      scrollMemoryRef.current[k] = { ...(scrollMemoryRef.current[k] || { main: 0 }), win: window.scrollY || 0 };
    };
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    return () => window.removeEventListener('scroll', onWindowScroll);
  }, []);
  const setMainRef = useCallback((node: HTMLElement | null) => {
    if (mainRef.current && mainRef.current !== node) {
      mainRef.current.removeEventListener('scroll', handleMainScroll);
    }
    mainRef.current = node;
    if (node) {
      node.addEventListener('scroll', handleMainScroll, { passive: true });
    }
  }, [handleMainScroll]);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchStartTargetRef = useRef<EventTarget | null>(null);

  // In-place finger-following swipe (hold pauses).
  const swipeDraggingRef = useRef<boolean>(false);
  const swipeDxRef = useRef<number>(0);
  const swipeWidthRef = useRef<number>(0);
  const swipeOriginalTransformRef = useRef<string>('');
  const swipeTargetIdxRef = useRef<number>(-1);
  const zoomSurfaceRef = useRef<HTMLElement | null>(null);
  const swipeCommitTimerRef = useRef<number | null>(null);
  const swipeResetTimerRef = useRef<number | null>(null);
  const [slideClass, setSlideClass] = useState('');
  const lastTabIdxRef = useRef(-1);
  const viewTransitionInProgressRef = useRef<boolean>(false);

  // Swipe sensitivity: balanced so a deliberate horizontal swipe changes pages
  // (including mid-screen swipes, which still get the adjoint transition),
  // while small drags / vertical scrolls do not trigger accidental turns.
  const SWIPE_MIN_DX = 130;       // px of horizontal travel required
  const SWIPE_RATIO = 2.2;        // horizontal travel must dominate vertical

  // Swipe between top-level tabs (mobile-style horizontal paging).
  const handleMainTouchStart = (e: React.TouchEvent) => {
    const t = e.touches?.[0];
    if (!t) return;
    const target = e.target as HTMLElement | null;
    // Never hijack touches while a fullscreen media viewer is open (seeking,
    // tapping, etc. must not trigger page swipe or tab navigation).
    if (document.querySelector('[data-fullscreen-viewer="true"]')) {
      touchStartRef.current = null;
      touchStartTargetRef.current = null;
      return;
    }
    // Never hijack swipes that begin on text inputs or the seek bar.
    if (target && target.closest && target.closest('input,textarea,[role="slider"],.touch-none')) {
      touchStartRef.current = null;
      touchStartTargetRef.current = null;
      return;
    }
    // Don't hijack horizontal swipes inside in-page scrollers (tabs, carousels).
    if (target && target.closest && target.closest('[role="tablist"], [data-no-page-swipe], .overflow-x-auto, .overflow-x-scroll, .snap-x')) {
      touchStartRef.current = null;
      touchStartTargetRef.current = null;
      return;
    }
    const path = location.pathname === '/' ? '/app/home' : location.pathname;
    const idx = MAIN_TABS.findIndex((p) => path === p || path.startsWith(p + '/'));
    if (idx < 0) return;
    touchStartRef.current = { x: t.clientX, y: t.clientY };
    touchStartTargetRef.current = e.target;
    swipeDraggingRef.current = false;
    swipeDxRef.current = 0;
    swipeWidthRef.current = (e.currentTarget as HTMLElement)?.clientWidth || window.innerWidth;
    (window as any).__equyvoSwiping = true;
    // Stop any in-flight CSS slide animation so it can't fight the swipe transform.
    setSlideClass('');
    // Cancel any in-flight swipe commit/reset so a new gesture can't stack on
    // top of a half-finished transform animation (the source of the "stuck
    // zoomed page" glitch after repeated swipes).
    if (swipeCommitTimerRef.current) { clearTimeout(swipeCommitTimerRef.current); swipeCommitTimerRef.current = null; }
    if (swipeResetTimerRef.current) { clearTimeout(swipeResetTimerRef.current); swipeResetTimerRef.current = null; }
    const zs = document.querySelector('.equyvo-zoom-surface') as HTMLElement | null;
    zoomSurfaceRef.current = zs;
    if (zs) {
      // Drop any leftover translateX a previous (interrupted) swipe may have
      // left behind, so the captured baseline is clean.
      if (zs.style.transform && zs.style.transform.includes('translateX')) {
        zs.style.transform = zs.style.transform.replace(/\s*translateX\([^)]*\)/g, '').trim();
        zs.style.transition = '';
      }
      swipeOriginalTransformRef.current = zs.style.transform || '';
    } else {
      swipeOriginalTransformRef.current = '';
    }
  };
  const handleMainTouchMove = (e: React.TouchEvent) => {
    if (document.querySelector('[data-fullscreen-viewer="true"]')) return;
    if (!e.touches || e.touches.length !== 1) return;
    const start = touchStartRef.current;
    if (!start) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (!swipeDraggingRef.current) {
      if (Math.abs(dx) < 8) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) { touchStartRef.current = null; (window as any).__equyvoSwiping = false; return; }
      const path = location.pathname === '/' ? '/app/home' : location.pathname;
      const idx = MAIN_TABS.findIndex((p) => path === p || path.startsWith(p + '/'));
      const nextIdx = dx < 0 ? idx + 1 : idx - 1;
      if (idx < 0 || nextIdx < 0 || nextIdx >= MAIN_TABS.length) { touchStartRef.current = null; (window as any).__equyvoSwiping = false; return; }
      swipeDraggingRef.current = true;
      swipeTargetIdxRef.current = nextIdx;
      swipeDxRef.current = dx;
    }

    if (swipeDraggingRef.current) {
      const width = swipeWidthRef.current;
      const clamped = Math.max(-width, Math.min(width, dx));
      swipeDxRef.current = clamped;
      const zs = zoomSurfaceRef.current;
      if (zs) {
        zs.style.transition = 'none';
        zs.style.transform = (swipeOriginalTransformRef.current || '') + ' translateX(' + clamped + 'px)';
      }
    }
  };

  const handleMainTouchCancel = () => {
    (window as any).__equyvoSwiping = false;
    if (swipeCommitTimerRef.current) { clearTimeout(swipeCommitTimerRef.current); swipeCommitTimerRef.current = null; }
    if (swipeResetTimerRef.current) { clearTimeout(swipeResetTimerRef.current); swipeResetTimerRef.current = null; }
    const zs = document.querySelector('.equyvo-zoom-surface') as HTMLElement | null;
    if (zs) {
      zs.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
      zs.style.transform = swipeOriginalTransformRef.current || '';
      const timer = window.setTimeout(() => { if (zs) zs.style.transition = ''; }, 220);
      swipeResetTimerRef.current = timer;
    }
    touchStartRef.current = null;
    swipeDraggingRef.current = false;
    swipeDxRef.current = 0;
  };

  const handleMainTouchEnd = (e: React.TouchEvent) => {
    // Cancel any in-flight swipe timers from a previous gesture.
    if (swipeCommitTimerRef.current) { clearTimeout(swipeCommitTimerRef.current); swipeCommitTimerRef.current = null; }
    if (swipeResetTimerRef.current) { clearTimeout(swipeResetTimerRef.current); swipeResetTimerRef.current = null; }

    const start = touchStartRef.current;
    const wasDragging = swipeDraggingRef.current;
    touchStartRef.current = null;
    touchStartTargetRef.current = null;
    (window as any).__equyvoSwiping = false;

    const zs = zoomSurfaceRef.current;

    if (wasDragging) {
      const dx = swipeDxRef.current;
      const width = swipeWidthRef.current;
      const targetIdx = swipeTargetIdxRef.current;
      const threshold = Math.min(80, width * 0.2);
      const commit = Math.abs(dx) >= threshold && targetIdx >= 0;

      if (commit) {
        if (zs) {
          zs.style.transition = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
          zs.style.transform = (swipeOriginalTransformRef.current || '') + ' translateX(' + (dx < 0 ? -width : width) + 'px)';
        }
        const timer = window.setTimeout(() => {
          swipeCommitTimerRef.current = null;
          if (zs) {
            zs.style.transform = swipeOriginalTransformRef.current || '';
            zs.style.transition = '';
          }
          document.documentElement.dataset.vtDir = dx < 0 ? 'forward' : 'back';
          navigate(MAIN_TABS[targetIdx]);
        }, 200);
        swipeCommitTimerRef.current = timer;
      } else {
        if (zs) {
          zs.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)';
          zs.style.transform = swipeOriginalTransformRef.current || '';
          const timer = window.setTimeout(() => { if (zs) zs.style.transition = ''; }, 220);
          swipeResetTimerRef.current = timer;
        }
      }
      swipeDraggingRef.current = false;
      swipeDxRef.current = 0;
      return;
    }

    // Stable swipe (no drag)
    if (!start) return;
    const t = e.changedTouches?.[0];
    if (!t) return;
    const dx2 = t.clientX - start.x;
    const dy2 = t.clientY - start.y;
    const adx = Math.abs(dx2);
    const ady = Math.abs(dy2);
    if (adx < SWIPE_MIN_DX) return;
    if (adx < ady * SWIPE_RATIO) return;
    const path = location.pathname === '/' ? '/app/home' : location.pathname;
    const idx = MAIN_TABS.findIndex((p) => path === p || path.startsWith(p + '/'));
    if (idx < 0) return;
    const nextIdx = dx2 < 0 ? idx + 1 : idx - 1;
    if (nextIdx < 0 || nextIdx >= MAIN_TABS.length) return;

    const targetPath = MAIN_TABS[nextIdx];
    document.documentElement.dataset.vtDir = dx2 < 0 ? 'forward' : 'back';

    const vt = (document as any).startViewTransition;
    if (typeof vt === 'function' && !viewTransitionInProgressRef.current) {
      try {
        const transition = vt.call(document, () => {
          flushSync(() => navigate(targetPath));
        });
        viewTransitionInProgressRef.current = true;
        if (transition && typeof transition.finished?.then === 'function') {
          transition.finished.finally(() => { viewTransitionInProgressRef.current = false; });
        } else {
          window.setTimeout(() => { viewTransitionInProgressRef.current = false; }, 700);
        }
        return;
      } catch { /* fall through to plain navigate */ }
    }
    navigate(targetPath);
  };

  useEffect(() => {
    // Restore this page's last scroll offset (fresh pages start at the top).
    const saved = scrollMemoryRef.current[pageCacheKey(location.pathname)] || { main: 0, win: 0 };
    const restore = () => {
      const el = mainRef.current;
      if (el) {
        el.scrollTop = saved.main;
        lastScrollTopRef.current = saved.main;
      }
      window.scrollTo(0, saved.win);
      setNavHidden(saved.main > 0);
    };
    restore();
    const raf = window.requestAnimationFrame(restore);
    // Never leave a swipe transform behind after a route change — that is
    // what made pages stay shifted/zoomed after repeated swipes.
    const zs = document.querySelector('.equyvo-zoom-surface') as HTMLElement | null;
    if (zs && zs.style.transform && zs.style.transform.includes('translateX')) {
      zs.style.transform = zs.style.transform.replace(/\s*translateX\([^)]*\)/g, '').trim();
      zs.style.transition = '';
    }
    return () => window.cancelAnimationFrame(raf);
  }, [location.pathname]);

  // Animate tab switches for swipe navigation (CSS fallback for browsers
  // without the View Transitions API). When View Transitions are available the
  // browser drives the adjoint slide, so we skip the CSS one to avoid a
  // double animation.
  const hasViewTransitions = typeof (document as any).startViewTransition === 'function';
  useEffect(() => {
    const path = location.pathname === '/' ? '/app/home' : location.pathname;
    const idx = MAIN_TABS.findIndex((p) => path === p || path.startsWith(p + '/'));
    if (idx < 0) return;
    const prev = lastTabIdxRef.current;
    if (prev >= 0 && prev !== idx) {
      if (!hasViewTransitions) {
        setSlideClass(idx > prev ? 'slide-in-left' : 'slide-in-right');
        const timer = window.setTimeout(() => setSlideClass(''), 520);
        lastTabIdxRef.current = idx;
        return () => window.clearTimeout(timer);
      }
      lastTabIdxRef.current = idx;
      return;
    }
    lastTabIdxRef.current = idx;
  }, [location.pathname, hasViewTransitions]);

  useEffect(() => {
    const initAuth = async () => {
      try {
        extractTokenFromUrl();
        const authStatus = await checkAuthStatus();
        if (authStatus.isAuthenticated && authStatus.user) {
          setUser(authStatus.user);
          claimBilling().then((c) => {
            if (c && c.granted.length) {
              window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: c.granted[0] } }));
            }
          }).catch(() => { /* ignore */ });
        } else {
          const storedUser = getStoredUser();
          if (storedUser) {
            setUser(storedUser);
          }
        }
      } catch (e) {
        console.error('initAuth failed', e);
      } finally {
        setIsLoading(false);
      }
    };
    initAuth();
    const fallback = window.setTimeout(() => setIsLoading(false), 8000);
    return () => window.clearTimeout(fallback);
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
        <Suspense fallback={<RouteFallback />}>
          <AuthPage onAuthSuccess={(u) => {
            setUser(u);
            // Guest paid earlier with this email? Link it now.
            claimBilling().then((c) => {
              if (c && c.granted.length) {
                window.dispatchEvent(new CustomEvent('planChanged', { detail: { plan: c.granted[0] } }));
              }
            }).catch(() => { /* billing claim is best-effort */ });
          }} />
        </Suspense>
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
    <div className="flex flex-col overflow-hidden bg-background text-foreground h-screen h-[100svh] md:h-auto md:min-h-screen md:overflow-visible">
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
        <main ref={setMainRef} className={`flex-1 w-full min-h-0 overflow-y-auto ${isMobile ? 'overscroll-contain pb-8' : ''} edge-fill`} style={{ touchAction: 'pan-y', overflowX: 'hidden' }} onTouchStart={handleMainTouchStart} onTouchMove={handleMainTouchMove} onTouchEnd={handleMainTouchEnd} onTouchCancel={handleMainTouchCancel}>
        <AppOpenAd />
        {/* Page-local boundary: a failure in one route renders an inline
            recovery card (navbar/bottom nav stay usable) and resets on the
            next navigation instead of a full-app "reload" wall. */}
        <ErrorBoundary>
         <div className={`equyvo-zoom-surface ${slideClass}`} data-equyvo-zoom-surface="true">
         <Suspense fallback={<RouteFallback />}>
          <CachedPageRoutes />
          </Suspense>
         </div>
        </ErrorBoundary>
      </main>
      {/* Mobile bottom nav: last row of the unibody — in flow, never
          overlaying content. Desktop/tablet uses the top nav instead. */}
      {shouldShowNavbar && !chatOpen && !navHidden && <MobileBottomNav />}
      <Toaster />

    </div>
  </div>
  );
};

const App = () => {
  React.useEffect(() => {
    // Let the system keyboard (Gboard etc.) use its normal autofill/suggestion
    // behaviour on every text field, without adding any custom keyboard UI.
    const apply = (root: ParentNode) => {
      try {
        root.querySelectorAll('input, textarea').forEach((el) => {
          const input = el as HTMLInputElement | HTMLTextAreaElement;
          if (!input.getAttribute('autocomplete')) input.setAttribute('autocomplete', 'on');
          if (!input.getAttribute('autocorrect')) input.setAttribute('autocorrect', 'on');
          if (!input.getAttribute('spellcheck')) input.setAttribute('spellcheck', 'true');
        });
      } catch { /* ignore */ }
    };
    apply(document);
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n instanceof Element) apply(n);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);
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
