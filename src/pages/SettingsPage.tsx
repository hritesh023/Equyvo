import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import {
  Bell,
  Shield,
  Palette,
  LogOut,
  Globe,
  Lock,
  Eye,
  EyeOff,
  Trash2,
  User,
  Mail,
  Megaphone
} from 'lucide-react';
import { getAuthenticatedUser, signOutUser } from '@/lib/auth';
import { showSuccess, showError } from '@/utils/toast';
import { useNavigate } from 'react-router-dom';
import { useTheme } from '@/components/theme-provider';
import { requestPushPermission, syncNotificationsFromServer } from '@/lib/notifications';
import { LANGUAGES, languageLabel } from '@/lib/i18n/languages';
import { useI18n } from '@/lib/i18n';
import api from '@/lib/api';

// Language picker (searchable, grouped: India & South Asia first, then the
// world). Selecting applies instantly app-wide — no reload needed.
const LANGUAGE_LIST = [
  ...LANGUAGES.filter((l) => l.group === 'indian'),
  ...LANGUAGES.filter((l) => l.group === 'world'),
];

const LanguagePickerCard = () => {
  const { language, setLanguage, t } = useI18n();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = q
    ? LANGUAGE_LIST.filter((l) => l.native.toLowerCase().includes(q) || l.english.toLowerCase().includes(q) || l.code.toLowerCase().includes(q))
    : LANGUAGE_LIST;
  const indian = filtered.filter((l) => l.group === 'indian');
  const world = filtered.filter((l) => l.group === 'world');

  const row = (l: typeof LANGUAGE_LIST[number]) => (
    <button
      key={l.code}
      type="button"
      onClick={() => {
        setLanguage(l.code);
        showSuccess(`${t('settings.language')}: ${languageLabel(l.code)}`);
      }}
      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
        language === l.code
          ? 'border-primary/60 bg-primary/10 text-primary'
          : 'border-border/50 hover:border-border hover:bg-accent/30'
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="font-medium">{l.native}</span>
        <span className="truncate text-xs text-muted-foreground">{l.english}</span>
      </span>
      {language === l.code && <span className="text-xs font-semibold">✓</span>}
    </button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t('settings.language')}
        </CardTitle>
        <CardDescription>{t('settings.languageDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('lang.searchPlaceholder')}
          className="max-w-sm"
          aria-label={t('lang.searchPlaceholder')}
        />
        <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
          {indian.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('settings.groupIndian')} ({indian.length})
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {indian.map(row)}
              </div>
            </div>
          )}
          {world.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('settings.groupWorld')} ({world.length})
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {world.map(row)}
              </div>
            </div>
          )}
          {filtered.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">{t('common.error')}</p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.languageNote')}</p>
      </CardContent>
    </Card>
  );
};

const SettingsPage = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [notifications, setNotifications] = useState(() => {
    return localStorage.getItem('notifications') === 'true';
  });
  // Appearance is driven by the app-wide theme only. This screen never
  // touches the document class itself, so just opening Settings can never
  // flip a light-mode user into dark mode.
  const { theme, setTheme } = useTheme();
  const darkMode =
    theme === 'dark' ||
    (theme === 'system' &&
      (typeof window === 'undefined' ||
        (typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches)));
  const setDarkMode = (next: boolean) => setTheme(next ? 'dark' : 'light');
  const [privateProfile, setPrivateProfile] = useState(() => {
    return localStorage.getItem('privateProfile') === 'true';
  });
  const [privacySaving, setPrivacySaving] = useState(false);
  const [showEmail, setShowEmail] = useState(() => {
    return localStorage.getItem('showEmail') === 'true';
  });
  const [emailNotifications, setEmailNotifications] = useState(() => {
    return localStorage.getItem('emailNotifications') !== 'false';
  });
  const [pushUploads, setPushUploads] = useState(() => {
    return localStorage.getItem('pushUploads') !== 'false';
  });
  const [liveAlerts, setLiveAlerts] = useState(() => {
    return localStorage.getItem('liveAlerts') !== 'false';
  });
  const [messageRequests, setMessageRequests] = useState(() => {
    return localStorage.getItem('messageRequests') !== 'false';
  });
  const [compactView, setCompactView] = useState(() => {
    return localStorage.getItem('compactView') === 'true';
  });
  const [personalizedAds, setPersonalizedAds] = useState(() => {
    return localStorage.getItem('equyvo_ads_personalized') !== 'false';
  });

  useEffect(() => {
    const getCurrentUser = async () => {
      try {
        const user = await getAuthenticatedUser();
        setUser(user as any);
        // Sync the toggle with the server account type (source of truth).
        if (user?.id) {
          api.getProfile(user.id).then(({ data, error }) => {
            if (!error && data && typeof (data as any).isPrivate === 'boolean') {
              setPrivateProfile((data as any).isPrivate);
              try {
                localStorage.setItem('privateProfile', String((data as any).isPrivate));
              } catch { /* ignore */ }
            }
          }).catch(() => {});
        }
      } catch {
      }
    };

    getCurrentUser();
  }, []);

  // Owner-only account-type change. The server enforces visibility for every
  // request; the local flag is just a cache. Reverts on failure.
  const handlePrivateProfileChange = async (next: boolean) => {
    const prev = privateProfile;
    setPrivateProfile(next);
    try {
      localStorage.setItem('privateProfile', String(next));
    } catch { /* ignore */ }
    const me = user;
    if (!me?.id) {
      showError('Please sign in to change your account type.');
      setPrivateProfile(prev);
      return;
    }
    setPrivacySaving(true);
    try {
      const { error } = await api.updateProfile({
        id: me.id,
        isPrivate: next,
        accountType: next ? 'private' : 'public',
      });
      if (error) throw new Error(error);
      showSuccess(next ? 'Your account is now private. Only approved followers see your posts.' : 'Your account is now public. Everyone can see your posts.');
      try {
        window.dispatchEvent(new CustomEvent('feedRefresh'));
      } catch { /* ignore */ }
    } catch (err: any) {
      setPrivateProfile(prev);
      try {
        localStorage.setItem('privateProfile', String(prev));
      } catch { /* ignore */ }
      showError(err?.message || 'Could not update your account type. Please try again.');
    } finally {
      setPrivacySaving(false);
    }
  };

  // Save settings to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('notifications', notifications.toString());
  }, [notifications]);

  useEffect(() => {
    localStorage.setItem('privateProfile', privateProfile.toString());
  }, [privateProfile]);

  useEffect(() => {
    localStorage.setItem('showEmail', showEmail.toString());
  }, [showEmail]);

  useEffect(() => {
    localStorage.setItem('emailNotifications', emailNotifications.toString());
  }, [emailNotifications]);

  useEffect(() => {
    localStorage.setItem('pushUploads', pushUploads.toString());
  }, [pushUploads]);

  useEffect(() => {
    localStorage.setItem('liveAlerts', liveAlerts.toString());
  }, [liveAlerts]);

  const handlePushToggle = async (next: boolean) => {
    setNotifications(next);
    try {
      localStorage.setItem('notifications', String(next));
    } catch { /* ignore */ }
    try {
      window.dispatchEvent(new CustomEvent('settingsChanged', { detail: { key: 'notifications', value: next } }));
    } catch { /* ignore */ }
    if (next) {
      const granted = await requestPushPermission();
      if (!granted) {
        showError('System notifications are blocked in the browser. Enable them to get follow/live/upload alerts.');
      } else {
        showSuccess('Push notifications on — you will get follow, live and new-upload alerts.');
      }
      syncNotificationsFromServer().catch(() => {});
    } else {
      showSuccess('Push notifications off — you will no longer get system alerts. In-app notifications still work.');
    }
  };

  // Every toggle persists immediately, notifies the rest of the app, and
  // confirms visibly — no dead switches.
  const applyToggle = (key: string, value: boolean, onMsg: string, offMsg: string) => {
    try {
      localStorage.setItem(key, String(value));
    } catch { /* ignore */ }
    try {
      window.dispatchEvent(new CustomEvent('settingsChanged', { detail: { key, value } }));
    } catch { /* ignore */ }
    showSuccess(value ? onMsg : offMsg);
  };

  const handleShowEmailChange = async (next: boolean) => {
    setShowEmail(next);
    applyToggle('showEmail', next, 'Your email will be shown on your profile.', 'Your email is hidden from your profile.');
    // Persist to the server profile too so it applies on every device.
    try {
      if (user?.id) {
        await api.updateProfile({ id: user.id, showEmail: next });
      }
    } catch { /* local flag is the fallback */ }
  };

  const handleCompactChange = (next: boolean) => {
    setCompactView(next);
    try {
      document.documentElement.classList.toggle('equyvo-compact', next);
    } catch { /* ignore */ }
    applyToggle('compactView', next, 'Compact view on — denser feeds.', 'Comfortable view restored.');
  };

  // Apply compact mode class on mount so the toggle visibly changes the app.
  useEffect(() => {
    try {
      document.documentElement.classList.toggle('equyvo-compact', compactView);
    } catch { /* ignore */ }
  }, [compactView]);

  useEffect(() => {
    localStorage.setItem('equyvo_ads_personalized', personalizedAds.toString());
  }, [personalizedAds]);

  // One-time cleanup of the legacy per-page key this screen used to write.
  // It is no longer read anywhere, so a stale 'dark' value can't override
  // the app-wide choice anymore.
  useEffect(() => {
    try {
      localStorage.removeItem('theme');
    } catch {
      /* ignore */
    }
  }, []);

  const handleSignOut = async () => {
    const result = await signOutUser();
    if (result.success) {
      showSuccess("Signed out successfully!");
      navigate('/auth');
    } else {
      showError(result.error || "Failed to sign out");
    }
  };

  const handleDeleteAccount = async () => {
    if (confirm("Are you sure you want to delete your account? All your data will be permanently removed. This action cannot be undone.")) {
      try {
        // Delete user data from the server
        const userId = user?.id || localStorage.getItem('equyvo_cognito_user') || '';
        if (userId) {
          const { error } = await api.deleteUserData(userId);
          if (error) console.error('Failed to delete user data:', error);
        }
        // Clear all local data
        localStorage.removeItem('userProfile');
        localStorage.removeItem('savedPosts');
        localStorage.removeItem('savedStories');
        localStorage.removeItem('watchHistory');
        localStorage.removeItem('savedContentData');
        localStorage.removeItem('userReactedThoughts');
        localStorage.removeItem('equyvo_search_history');
        // Sign out
        const result = await signOutUser();
        if (result.success) {
          showSuccess("Your account and all data have been deleted.");
          navigate('/auth');
        } else {
          showError(result.error || "Failed to process account deletion");
        }
      } catch (error: any) {
        showError(error.message || "Failed to delete account");
      }
    }
  };

  const handleContactSupport = async () => {
    const email = 'support@equyvo.app';
    try {
      await navigator.clipboard.writeText(email);
    } catch { /* clipboard may be unavailable */ }
    showSuccess(`Support email copied: ${email}`);
    try {
      window.open(`mailto:${email}?subject=${encodeURIComponent('Equyvo support request')}`, '_blank');
    } catch { /* ignore */ }
  };

  const handleViewProfile = () => {
    showSuccess('Opening your profile…');
    navigate('/app/profile');
  };

  const handleSeePlans = () => {
    navigate('/app/pricing');
  };

  const { t } = useI18n();

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-3xl font-bold">{t('nav.settings')}</h1>
      </div>

      {/* Privacy Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            {t('settings.privacy')}
          </CardTitle>
          <CardDescription>
            Control your privacy and security settings
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Private Profile</Label>
              <p className="text-sm text-muted-foreground">
                Only approved followers can see your posts
              </p>
            </div>
            <Switch
              checked={privateProfile}
              disabled={privacySaving}
              onCheckedChange={handlePrivateProfileChange}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Show Email</Label>
              <p className="text-sm text-muted-foreground">
                Display email on your profile
              </p>
            </div>
            <Switch 
              checked={showEmail}
              onCheckedChange={handleShowEmailChange}
            />
          </div>
        </CardContent>
      </Card>

      {/* Notification Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t('settings.notifications')}
          </CardTitle>
          <CardDescription>
            Manage how you receive notifications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Push Notifications</Label>
              <p className="text-sm text-muted-foreground">
                Follow requests, accepts, live alerts + new uploads (system notification)
              </p>
            </div>
            <Switch
              checked={notifications}
              onCheckedChange={handlePushToggle}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>New-upload alerts</Label>
              <p className="text-sm text-muted-foreground">
                Notify me when accounts I follow post (requires Push on)
              </p>
            </div>
            <Switch
              checked={pushUploads}
              onCheckedChange={(next) => {
                setPushUploads(next);
                applyToggle('pushUploads', next, 'New-upload alerts on.', 'New-upload alerts off.');
              }}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Live alerts</Label>
              <p className="text-sm text-muted-foreground">
                Notify me when someone I follow goes live
              </p>
            </div>
            <Switch
              checked={liveAlerts}
              onCheckedChange={(next) => {
                setLiveAlerts(next);
                applyToggle('liveAlerts', next, 'Live alerts on.', 'Live alerts off.');
              }}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Email Notifications</Label>
              <p className="text-sm text-muted-foreground">
                Receive updates via email
              </p>
            </div>
            <Switch 
              checked={emailNotifications}
              onCheckedChange={(next) => {
                setEmailNotifications(next);
                applyToggle('emailNotifications', next, 'Email updates on.', 'Email updates off.');
              }}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Message Requests</Label>
              <p className="text-sm text-muted-foreground">
                Allow message requests from anyone
              </p>
            </div>
            <Switch 
              checked={messageRequests}
              onCheckedChange={(next) => {
                setMessageRequests(next);
                applyToggle('messageRequests', next, 'Message requests allowed from anyone.', 'Message requests limited to people you follow.');
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5" />
            {t('settings.appearance')}
          </CardTitle>
          <CardDescription>
            Customize how Equyvo looks for you
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('settings.darkMode')}</Label>
              <p className="text-sm text-muted-foreground">
                Use dark theme across the app
              </p>
            </div>
            <Switch 
              checked={darkMode}
              onCheckedChange={(next) => {
                setDarkMode(next);
                showSuccess(next ? 'Dark mode on.' : 'Light mode on.');
              }}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Compact View</Label>
              <p className="text-sm text-muted-foreground">
                Show more content in less space
              </p>
            </div>
            <Switch 
              checked={compactView}
              onCheckedChange={handleCompactChange}
            />
          </div>
        </CardContent>
      </Card>

      {/* Language */}
      <LanguagePickerCard />

      {/* Ads & Privacy */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            Ads & Privacy
          </CardTitle>
          <CardDescription>
            Equyvo shows only quiet sponsored cards in feeds — never before or
            in the middle of a video. Here is your control.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Personalized ads</Label>
              <p className="text-sm text-muted-foreground">
                More relevant sponsored cards. Off = generic ads only.
              </p>
            </div>
            <Switch
              checked={personalizedAds}
              onCheckedChange={(next) => {
                setPersonalizedAds(next);
                applyToggle('equyvo_ads_personalized', next, 'Personalized sponsored cards on.', 'Generic sponsored cards only.');
              }}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>Go ad-free</Label>
              <p className="text-sm text-muted-foreground">
                Premium and Creator plans remove all sponsored cards.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={handleSeePlans}>
              See plans
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Account */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            {t('settings.account')}
          </CardTitle>
          <CardDescription>
            Manage your profile and account
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button 
            variant="outline" 
            onClick={handleViewProfile}
            className="w-full justify-start"
          >
            <User className="h-4 w-4 mr-2" />
            {t('action.viewProfile')}
          </Button>

          <Separator />

          <Button 
            variant="outline" 
            onClick={handleContactSupport}
            className="w-full justify-start"
          >
            <Mail className="h-4 w-4 mr-2" />
            {t('settings.contactSupport')}
          </Button>

          <Separator />

          <Button 
            variant="destructive" 
            onClick={handleDeleteAccount}
            className="w-full justify-start"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Account
          </Button>
        </CardContent>
      </Card>

      {/* Sign Out */}
      <Card>
        <CardContent className="pt-6">
          <Button 
            variant="outline" 
            onClick={handleSignOut}
            className="w-full justify-start"
          >
            <LogOut className="h-4 w-4 mr-2" />
            {t('action.signOut')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default SettingsPage;
