import React, { useState, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useNavigate } from 'react-router-dom';
import { Home, Compass, PlusCircle, Video, MessageSquare, User, Search, Bell, LogOut, Settings, Globe, Camera } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useIsMobile } from "@/hooks/use-mobile";
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import SearchSuggest from './SearchSuggest';
import AppLogo from './AppLogo';
import { showSuccess } from '@/utils/toast';
import { navigateToProfile } from '@/utils/profile-navigation';
import { getStoredUser } from '@/lib/auth';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const navItems = [
  { name: 'Home', icon: Home, path: '/app/home' },
  { name: 'Discover', icon: Globe, path: '/app/discover' },
  { name: 'Create', icon: PlusCircle, path: '/app/create' },
  { name: 'Moments', icon: Camera, path: '/app/moments' },
  { name: 'Thoughts', icon: MessageSquare, path: '/app/thoughts' },
  { name: 'Profile', icon: User, path: '/app/profile' },
  { name: 'Settings', icon: Settings, path: '/app/settings' },
];

interface NavbarProps {
  user: any;
  onSignOut: () => Promise<void>;
}

const Navbar = ({ user, onSignOut }: NavbarProps) => {
  const location = useLocation();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

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
      {/* Mobile Top Bar — full-bleed incl. left/right display cutouts */}
      {isMobile && (
        <div className="mobile-top-nav-fill fixed inset-x-0 top-0 z-50 border-b border-border/50 bg-background/95 backdrop-blur-xl">
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
                onClick={() => navigateToProfile(navigate)}
                title="Your Profile"
              >
                <AvatarImage src={profileAvatar || effectiveUser.user_metadata?.avatar_url} alt={effectiveUser.email} />
                <AvatarFallback className="text-xs">{effectiveUser.email?.charAt(0).toUpperCase() || 'U'}</AvatarFallback>
              </Avatar>
            )}
          </div>
        </div>
      )}
      
      {/* Desktop Navigation — full-bleed bar, readable centered content */}
      {!isMobile && (
        <nav className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/95 shadow-lg backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-2 py-2 sm:px-3 md:px-4 md:py-3">
            {/* Logo */}
            <div className="flex items-center gap-1 sm:gap-2">
              <Link to="/" className="flex items-center gap-1 sm:gap-2">
                <AppLogo className="h-6 w-6 sm:h-7 sm:w-7 md:h-8 md:w-8" />
                <span className="text-sm sm:text-base md:text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-pink-400 via-purple-500 to-cyan-400 hidden sm:block leading-loose py-1" style={{ fontFamily: "'Pacifico', cursive" }}>Equyvo</span>
              </Link>
            </div>

            {/* AI-Powered Search Bar (Desktop) */}
            <div className="flex-grow max-w-lg mx-4">
              <SearchSuggest
                onSearch={handleSearch}
                placeholder="Search for content, users, tags... (Press '/' to focus)"
                className="w-full"
                showTrending={true}
                maxSuggestions={6}
              />
            </div>

            {/* Navigation Links (Desktop) */}
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
                    <span className="hidden xl:block">{item.name}</span>
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
                    onClick={() => navigateToProfile(navigate)}
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

      {/* Mobile Search Dialog */}
      {isMobile && (
        <Dialog open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
          <DialogContent className="sm:max-w-md bg-background/95 backdrop-blur-lg border-border/50" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Search Equyvo</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <SearchSuggest
                onSearch={handleMobileSearch}
                placeholder="Search for content, users, tags..."
                autoFocus={true}
                showTrending={false}
                maxSuggestions={5}
              />
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" className="w-full sm:w-auto">Done</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Mobile Bottom Navigation — full-bleed footer that max-fills every
          display: phones, foldables, tablets, landscape and external screens.
          Outer bar spans 100dvw incl. cutout insets; inner row centers content
          with a readable cap while each tab flex-fills its share. */}
      {isMobile && (
        <div className="mobile-bottom-nav-fill fixed inset-x-0 bottom-0 z-50 border-t border-border/50 bg-background/95 shadow-lg backdrop-blur-xl">
          <div className="mx-auto flex w-full max-w-3xl items-stretch justify-around px-2">
          {navItems.slice(0, 5).map((item) => (
            <Link
              key={item.name}
              to={item.path}
              className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs transition-all duration-200 hover:scale-105 touch-target mobile-nav-item ${location.pathname === item.path
                ? 'text-primary scale-105 bg-primary/10 mobile-nav-active'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/20 mobile-nav-inactive'
                }`}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              <span className="max-w-full truncate text-[10px] font-medium">{item.name}</span>
              <span className="sr-only">{item.name}</span>
            </Link>
          ))}
          {/* More options button */}
          <Link
            to="/app/settings"
            className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-2 text-xs transition-all duration-200 hover:scale-105 touch-target mobile-nav-item ${location.pathname === '/app/settings'
              ? 'text-primary scale-105 bg-primary/10 mobile-nav-active'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent/20 mobile-nav-inactive'
              }`}
          >
            <Settings className="h-5 w-5 shrink-0" />
            <span className="max-w-full truncate text-[10px] font-medium">More</span>
            <span className="sr-only">More options</span>
          </Link>
          </div>
        </div>
      )}
    </>
  );
};

export default Navbar;