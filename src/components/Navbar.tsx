import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { Link, useLocation } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { Home, PlusCircle, MessageSquare, User, LogOut, Settings, Globe, Camera, Search } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useIsMobile } from "@/hooks/use-mobile";
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import SearchSuggest from './SearchSuggest';
import AppLogo from './AppLogo';
import { showSuccess } from '@/utils/toast';
import { navigateToOwnProfile } from '@/utils/profile-navigation';
import { getStoredUser } from '@/lib/auth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Shared navigation surface: the top bar, the mobile bottom nav and the
 *  fullscreen desktop browse all render the same destinations. */
export const navItems = [
  { name: 'nav.home', icon: Home, path: '/app/home' },
  { name: 'nav.discover', icon: Globe, path: '/app/discover' },
  { name: 'nav.create', icon: PlusCircle, path: '/app/create' },
  { name: 'nav.moments', icon: Camera, path: '/app/moments' },
  { name: 'nav.thoughts', icon: MessageSquare, path: '/app/thoughts' },
  { name: 'nav.profile', icon: User, path: '/app/profile' },
  { name: 'nav.settings', icon: Settings, path: '/app/settings' },
];

interface NavbarProps {
  user: any;
  onSignOut: () => Promise<void>;
}

/**
 * Unibody bar measurement.
 *
 * The mobile shell is ONE BODY: [top bar] [content] [bottom nav] in normal
 * flow inside a 100dvh flex column — no fixed overlay bands, so no element
 * can ever be cut off behind the header (the bug that hit every page).
 *
 * Each in-flow bar publishes its exact rendered height to a CSS variable so
 * fixed screen overlays (notification panel, chat shells, moment slides…)
 * can anchor precisely to the content column on every device.
 */
function useFlowBarMeasure(
  ref: React.RefObject<HTMLElement | null>,
  cssVar: '--equyvo-bar-top' | '--equyvo-bar-bottom',
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty(cssVar, `${h}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener('resize', publish);
    window.visualViewport?.addEventListener('resize', publish);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', publish);
      window.visualViewport?.removeEventListener('resize', publish);
    };
  }, [ref, cssVar]);
}

const Navbar = ({ user, onSignOut }: NavbarProps) => {
  const { t } = useI18n();
  const location = useLocation();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const topBarRef = useRef<HTMLDivElement>(null);

  // Publish the exact top-bar height (--equyvo-bar-top) so fixed screen
  // overlays (notification panel, chat shells, search split view…) anchor
  // precisely below the restored header on every device.
  useFlowBarMeasure(topBarRef, '--equyvo-bar-top');

  // Close the mobile search dialog as soon as navigation happens (e.g.
  // tapping a profile in the suggestions) so it never traps the user.
  useEffect(() => {
    setMobileSearchOpen(false);
  }, [location.pathname]);

  // Handle null user gracefully: check stored user as fallback.
  // No invented fallback identity — without a real account nothing renders.
  const effectiveUser = user || getStoredUser() || null;

  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);

  // Reload avatar when user changes (new sign-in)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedProfile = localStorage.getItem('userProfile');
      if (savedProfile) {
        const parsed = JSON.parse(savedProfile);
        if (parsed.avatar) {
          setProfileAvatar(parsed.avatar);
        } else {
          setProfileAvatar(null);
        }
      } else {
        setProfileAvatar(null);
      }

      const handleProfileUpdate = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        if (detail?.avatar) {
          setProfileAvatar(detail.avatar);
        } else if (detail && !detail.avatar) {
          // Profile cleared — reset avatar
          setProfileAvatar(null);
        }
      };

      window.addEventListener('profileUpdated', handleProfileUpdate);
      return () => window.removeEventListener('profileUpdated', handleProfileUpdate);
    }
  }, [user]);


  const handleSearch = useCallback((query: string) => {
    showSuccess(`Searching for "${query}"...`);
    navigate(`/app/search?q=${encodeURIComponent(query)}`);
  }, [navigate]);

  const handleMobileSearch = useCallback((query: string) => {
    showSuccess(`Searching for "${query}"...`);
    navigate(`/app/search?q=${encodeURIComponent(query)}`);
    setMobileSearchOpen(false);
  }, [navigate]);


  return (
    <>
      {/* Mobile Top Bar — the OLD header design (as at commit 498a408),
          restored verbatim: logo + "Equyvo" wordmark left, then search,
          notifications, theme and profile avatar in one row. IN FLOW at the
          top of the unibody shell — it owns its row, so content can never
          slide under it; safe-area padding keeps it clear of the status
          bar / notch (edge-to-edge contract unchanged). */}
      {isMobile && (
        <div
          ref={topBarRef}
          className="mobile-top-nav-fill relative z-50 shrink-0 border-b border-border/50 bg-background"
        >
          <div className="flex items-center justify-between px-3 py-2">
            {/* Logo and Search */}
            <div className="flex items-center gap-2 flex-1">
              <Link to="/" className="flex items-center gap-2">
                <AppLogo className="h-6 w-6" />
                <span className="text-sm font-bold bg-clip-text text-transparent bg-gradient-to-r from-pink-400 via-purple-500 to-cyan-400 leading-loose py-1" style={{ fontFamily: "'Pacifico', cursive" }}>Equyvo</span>
              </Link>
            </div>

            {/* Search Button */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileSearchOpen(true)}
              aria-label="Search Equyvo"
              className="text-foreground hover:bg-accent/50 transition-all duration-200 h-8 w-8"
            >
              <Search className="h-4 w-4" />
            </Button>

            {/* Theme Toggle + Notifications */}
            <NotificationBell />
            <ThemeToggle />

            {/* User Avatar */}
            {effectiveUser && (
              <Avatar
                className="h-6 w-6 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all duration-200"
                onClick={() => navigateToOwnProfile(navigate)}
                title="Your Profile"
              >
                <AvatarImage src={profileAvatar || effectiveUser.user_metadata?.avatar_url} alt={effectiveUser.email} />
                <AvatarFallback className="text-xs">{effectiveUser.email?.charAt(0).toUpperCase() || 'U'}</AvatarFallback>
              </Avatar>
            )}
          </div>
        </div>
      )}

      {/* Desktop Navigation — full-bleed bar, readable centered content. */}
      {!isMobile && (
        <nav className="z-50 w-full bg-background">
          <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-2 py-2 sm:px-3 md:px-4 md:py-3">
            {/* Logo */}
            <div className="flex items-center gap-1 sm:gap-2">
              <Link to="/" className="flex items-center gap-1 sm:gap-2">
                <AppLogo className="h-6 w-6 sm:h-7 sm:w-7 md:h-8 md:w-8" />
                <span className="text-sm sm:text-base md:text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-pink-400 via-purple-500 to-cyan-400 hidden sm:block leading-loose py-1" style={{ fontFamily: "'Pacifico', cursive" }}>Equyvo</span>
              </Link>
            </div>

            {/* AI-Powered Search Bar (Desktop) */}
            <div className="flex-grow min-w-0 max-w-lg mx-4">
              <SearchSuggest
                onSearch={handleSearch}
                placeholder="Search for content, users, tags... (Press '/' to focus)"
                className="w-full"
                showTrending={true}
                maxSuggestions={6}
              />
            </div>

            {/* Navigation Links (Desktop) — labels appear from 2xl so the bar
                never overflows on 1280-1535px screens (icons still navigate) */}
            <div className="flex items-center gap-1 sm:gap-2 md:gap-4">
              <div className="hidden lg:flex items-center gap-4 xl:gap-6">
                {navItems.map((item) => (
                  <Link
                    key={item.name}
                    to={item.path}
                    className={`flex items-center gap-1 text-sm font-medium transition-colors hover:text-primary ${location.pathname === item.path ? 'text-primary' : 'text-muted-foreground'
                      }`}
                  >
                    <item.icon className="h-4 w-4" />
                    <span className="hidden 2xl:block">{t(item.name)}</span>
                  </Link>
                ))}
              </div>

              {/* Notifications + Theme Toggle */}
              <NotificationBell />
              <ThemeToggle />

              {/* User Section */}
              {effectiveUser ? (
                <div className="flex items-center gap-1 sm:gap-2">
                  <Avatar 
                    className="h-6 w-6 sm:h-7 sm:w-7 md:h-8 md:w-8 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all duration-200"
                    onClick={() => navigateToOwnProfile(navigate)}
                    title="Your Profile"
                  >
                    <AvatarImage src={profileAvatar || effectiveUser.user_metadata?.avatar_url} alt={effectiveUser.email} />
                    <AvatarFallback className="text-xs sm:text-sm md:text-sm">{effectiveUser.email?.charAt(0).toUpperCase() || 'U'}</AvatarFallback>
                  </Avatar>
                  {user && <Button variant="ghost" size="icon" onClick={onSignOut} title="Sign Out" className="h-6 w-6 sm:h-8 sm:w-8 md:h-10 md:w-10">
                    <LogOut className="h-2 w-2 sm:h-3 sm:w-3 md:h-4 md:w-4" />
                  </Button>}
                </div>
              ) : (
                <Button onClick={() => navigate('/auth')} size="sm" className="text-xs sm:text-sm md:text-sm px-2 sm:px-3 md:px-4">
                  Sign In
                </Button>
              )}
            </div>
          </div>
        </nav>
      )}

      {/* Mobile Search — full-screen overlay so suggestions never clip */}
      {isMobile && (
        <Dialog open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
          <DialogContent className="fixed inset-0 w-full h-full max-w-none translate-x-0 translate-y-0 sm:inset-auto sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:w-[95vw] sm:max-w-md sm:h-auto sm:max-h-[90vh] rounded-none sm:rounded-lg bg-background/95 backdrop-blur-lg border-border/50 overflow-y-auto eq-safe-top" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Search Equyvo</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <SearchSuggest
                onSearch={handleMobileSearch}
                onClose={() => setMobileSearchOpen(false)}
                placeholder="Search for content, users, tags..."
                autoFocus={true}
                showTrending={false}
                maxSuggestions={5}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

/**
 * Mobile Bottom Navigation — IN FLOW at the bottom of the unibody shell
 * (rendered by App.tsx after <main>). Its safe-area padding keeps it clear
 * of the gesture bar, and it can never overlay page content because it
 * occupies its own row below the scrollable column.
 * Rendered on every page — including search/tag browse — so the app
 * navigation (Home, Discover, Create, Moments…) is always reachable.
 */
export function MobileBottomNav() {
  const { t } = useI18n();
  const location = useLocation();
  const isMobile = useIsMobile();
  const barRef = useRef<HTMLDivElement>(null);

  // Publish the exact bottom-nav height (--equyvo-bar-bottom).
  useFlowBarMeasure(barRef, '--equyvo-bar-bottom');

  if (!isMobile) return null;

  return (
    <div
      ref={barRef}
      className="mobile-bottom-nav-fill relative z-50 shrink-0 border-t border-border/50 bg-background shadow-lg"
    >
      <div className="mx-auto flex w-full max-w-3xl items-stretch justify-around px-2">
      {navItems.slice(0, 6).map((item) => (
        <Link
          key={item.name}
          to={item.path}
          className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs transition-all duration-200 hover:scale-105 touch-target mobile-nav-item ${location.pathname === item.path
            ? 'text-primary scale-105 bg-primary/10 mobile-nav-active'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent/20 mobile-nav-inactive'
            }`}
        >
          <item.icon className="h-5 w-5 shrink-0" />
          <span className="max-w-full truncate text-[10px] font-medium">{t(item.name)}</span>
          <span className="sr-only">{t(item.name)}</span>
        </Link>
      ))}
      </div>
    </div>
  );
}

export default Navbar;
