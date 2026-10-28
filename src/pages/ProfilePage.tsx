import React, { useState, useEffect, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Settings, Edit, ThumbsUp, MessageCircle, Share2, Video, MessageSquare, MoreVertical, Maximize, Repeat, Bookmark, Clock, History, X, Eye, Play, Camera, Volume2, VolumeX, Trash, AlertTriangle, BadgeCheck } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sharePost } from '@/utils/share';
import { showSuccess, showError } from '@/utils/toast';
import { FullscreenContent, Post } from '@/types';

interface UserProfile {
  id: string;
  name: string;
  username: string;
  avatar: string;
  bio?: string;
  posts: Post[];
  followers: number;
  following: number;
  [key: string]: unknown;
}

import EditProfileModal from '@/components/EditProfileModal';
import EditPostModal from '@/components/EditPostModal';
import CommentSection from '@/components/CommentSection';
import SafeFullscreenViewer from '@/components/SafeFullscreenViewer';
import VotingButtons from '@/components/VotingButtons';
import StandardPostMenu from '@/components/StandardPostMenu';
import WatchHistorySection from '@/components/WatchHistorySection';
// import UniversalMediaViewer from '@/components/UniversalMediaViewer';
import Moments from '@/components/Moments';
import VideoSeekBar from '@/components/VideoSeekBar';
import { voteOnThought, likeThought } from '@/lib/thoughts';
import { evalLike, evalVote } from '@/lib/human-eval';
import { getStoredUser, clearViewerCaches } from '@/lib/auth';
import { deleteContent } from '@/utils/delete';
import { setContentVisibility } from '@/utils/visibility';
import ReportModal from '@/components/ReportModal';
import FollowListModal from '@/components/FollowListModal';
import FollowButton from '@/components/FollowButton';
import { getFollowers, getFollowing, canViewFollowLists, myId, type SocialProfile } from '@/lib/social';
import { navigateToProfile } from '@/utils/profile-navigation';
import { pickDisplayName, profilePreviewFrom, userNameOf } from '@/lib/identity';
import { toCount, bumpCount } from '@/lib/count';
import api from '@/lib/api';
import { isVideoItem } from '@/lib/feed-store';
import { normalizeContentList, normalizeContentItem, resolveMediaFields } from '@/lib/media';

const ownerIdOf = (post: unknown): string => {
  const p = (post || {}) as Record<string, unknown>;
  return String(p.ownerId || p.userId || p.user_id || p.authorId || p.creatorId || '');
};

const myAccountId = (): string => {
  try {
    const u = getStoredUser();
    return String(u?.id || u?.email || '');
  } catch {
    return '';
  }
};

/** Real media only: hide a broken image instead of swapping in fake art. */
const hideBrokenImg = (e: React.SyntheticEvent<HTMLImageElement>) => {
  try {
    (e.target as HTMLImageElement).style.display = 'none';
  } catch {
    /* ignore */
  }
};

const createDefaultProfile = (user?: { email?: string; fullName?: string; username?: string; id?: string }) => {
  const displayName = user?.fullName || (user?.email ? user.email.split('@')[0] : '');
  const handle = user?.username || (user?.email ? `@${user.email.split('@')[0]}` : '');
  return {
    _userEmail: user?.email || '',
    id: user?.id || '',
    name: displayName,
    username: handle,
    avatar: '',
    bio: '',
    followers: 0,
    following: 0,
    posts: [] as Post[],
  };
};

const normalizeIdentity = (value: unknown): string => {
  let raw = String(value ?? '').trim();
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  return raw.replace(/^@+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
};

const createTargetPlaceholder = (target: string, preview?: { name?: string; username?: string; avatar?: string; bio?: string } | null) => ({
  ...createDefaultProfile({}),
  id: '',
  // Never render the raw route id as a person. Until the server answers, show
  // a preview handed over by the previous screen (real name/avatar), or a
  // skeleton — not an opaque identifier.
  name: preview?.name || '',
  username: preview?.username
    ? (preview.username.startsWith('@') ? preview.username : `@${preview.username}`)
    : '',
  avatar: preview?.avatar || '',
  bio: preview?.bio || '',
  posts: [] as Post[],
  _placeholder: true,
  _routeTarget: target,
});

const readCachedOwnProfile = () => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem('userProfile');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // Older versions cached a raw media array/object on posts, which then
    // rendered as <img src="[object Object]">. Repair the cache on read.
    if (Array.isArray(parsed.posts)) {
      parsed.posts = normalizeContentList(parsed.posts);
    }
    if (Array.isArray(parsed.savedContent)) {
      parsed.savedContent = normalizeContentList(parsed.savedContent);
    }
    return parsed;
  } catch {
    return null;
  }
};

const ProfilePage = () => {
  const { userId, username } = useParams();
  const _storedUser = getStoredUser();
  const viewerId = String(_storedUser?.id || '').trim();
  const viewerEmail = String(_storedUser?.email || '').trim().toLowerCase();
  const viewerUsername = normalizeIdentity(_storedUser?.username || _storedUser?.fullName || '');
  // A route is the viewer's OWN profile only when the target matches their
  // account id or username. Email is never an identity for routing — legacy
  // email links resolve through the server's canonical account mapping.
  const rawRouteTarget = String(userId || username || '').trim();
  const routeTarget = (() => {
    try { return decodeURIComponent(rawRouteTarget).replace(/^@+/, '').trim(); } catch { return rawRouteTarget.replace(/^@+/, '').trim(); }
  })();
  const hasRouteTarget = routeTarget.length > 0;
  const isOwnProfile = !hasRouteTarget || (
    // Only an explicit account-id match counts as self before the server
    // resolves the route target. Username/display-name routes go through the
    // server canonicalizer so another person's profile is never treated as the
    // viewer's own page.
    !!viewerId && normalizeIdentity(routeTarget) === normalizeIdentity(viewerId)
  );
  const location = useLocation();
  const navigate = useNavigate();

  // Profile preview handed over by search / feed navigation. It lets the real
  // name + avatar paint on the first frame instead of flashing the raw id.
  const routePreview = React.useMemo(() => {
    const raw = (location.state as { profilePreview?: unknown } | null)?.profilePreview;
    const preview = profilePreviewFrom(raw);
    if (!preview) return null;
    const target = normalizeIdentity(routeTarget);
    if (!target) return preview;
    const matches = [preview.id, preview.username]
      .map((value) => normalizeIdentity(value))
      .some((value) => !!value && value === target);
    return matches ? preview : null;
  }, [routeTarget, location.key, location.state]);

  // Bot profiles removed — app only shows the authenticated user's profile

  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [postLikes, setPostLikes] = useState<{ [key: string]: number }>({});
  const [reactedPosts, setReactedPosts] = useState<Set<string>>(new Set());
  const [postReacts, setPostReacts] = useState<{ [key: string]: number }>({});
  const [voting, setVoting] = useState<string | null>(null);
  const [liking, setLiking] = useState<string | null>(null);
  const [userReactedPosts, setUserReactedPosts] = useState<Post[]>([]);
  const [showEditProfileModal, setShowEditProfileModal] = useState(false);
  const [showReportProfile, setShowReportProfile] = useState(false);
  const [showEditPostModal, setShowEditPostModal] = useState(false);
  const [currentEditingPost, setCurrentEditingPost] = useState<Post | null>(null);
  const [showCommentSection, setShowCommentSection] = useState(false);
  const [currentPostId, setCurrentPostId] = useState<string>('');
  const [currentPostUser, setCurrentPostUser] = useState<string>('');
  const [fullscreenContent, setFullscreenContent] = useState<FullscreenContent | null>(null);
  const [universalMediaContent, setUniversalMediaContent] = useState<FullscreenContent | null>(null);
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [savedStories, setSavedStories] = useState<Set<string>>(new Set());
  const [watchHistory, setWatchHistory] = useState<Post[]>([]);
  const [allSavedContent, setAllSavedContent] = useState<Post[]>([]);

  // Video state management
  const [playingVideos, setPlayingVideos] = useState<Set<string>>(new Set());
  const [isMuted, setIsMuted] = useState(true);
  const [videoErrors, setVideoErrors] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState<{ [key: string]: boolean }>({});
  const [videoProgress, setVideoProgress] = useState<{ [key: string]: number }>({});
  const [videoDuration, setVideoDuration] = useState<{ [key: string]: number }>({});
  const [currentTime, setCurrentTime] = useState<{ [key: string]: number }>({});
  const [isSeeking, setIsSeeking] = useState(false);
  const videoRefs = useRef<{ [key: string]: HTMLVideoElement }>({});

  // The profile shown is ALWAYS the routed target. Viewing someone else never
  // starts from the viewer's cached profile (that was the bug where a clicked
  // user appeared to be "you").
  const [userProfile, setUserProfile] = useState(() => {
    if (hasRouteTarget && !isOwnProfile) {
      return createTargetPlaceholder(routeTarget, routePreview);
    }
    const savedProfile = readCachedOwnProfile();
    if (savedProfile) return savedProfile;
    return createDefaultProfile(getStoredUser());
  });
  const [resolvedTarget, setResolvedTarget] = useState<{ route: string; id: string; isOwner: boolean }>({
    route: '',
    id: '',
    isOwner: false,
  });
  const resolvedTargetId = resolvedTarget.route === routeTarget ? resolvedTarget.id : '';
  const [profileLookupFailed, setProfileLookupFailed] = useState(false);
  // The loaded profile is self ONLY when the route is self (/app/profile,
  // /profile, or /profile/<viewerId>) or the server resolved THIS exact route
  // target to the signed-in viewer's own account. Viewing any other person's
  // profile is never self-view — not even for a single transition frame.
  const isSelfView = !hasRouteTarget || isOwnProfile || (
    resolvedTarget.route === routeTarget &&
    (resolvedTarget.isOwner ||
      (!!viewerId && !!resolvedTarget.id && normalizeIdentity(resolvedTarget.id) === normalizeIdentity(viewerId)))
  );
  // A target profile with no real identity yet (no preview, server still
  // answering) renders skeletons instead of the raw route id.
  const profilePending =
    !profileLookupFailed &&
    (userProfile as Record<string, unknown>)._placeholder === true &&
    !pickDisplayName(userProfile.name, userProfile.username);
  const [activeTab, setActiveTab] = useState<string>('posts');
  // History and Saved are strictly private to the owner's own profile page.
  // Another person's profile must never show or activate those tabs.
  const effectiveTab = !isSelfView && (activeTab === 'history' || activeTab === 'saved')
    ? 'posts'
    : activeTab;
  React.useEffect(() => {
    if (!isSelfView && (activeTab === 'history' || activeTab === 'saved')) {
      setActiveTab('posts');
    }
  }, [isSelfView, activeTab, routeTarget]);
  // Saved / history / reacted content belongs to the signed-in viewer. It must
  // never be merged into another person's profile.
  const viewerReactedPosts = isSelfView
    ? userReactedPosts.map(post => ({ ...post, isReacted: true }))
    : [];

  // One-time local collections for the signed-in account (saved/history/etc).
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem('savedPosts');
      if (saved) setSavedPosts(new Set(JSON.parse(saved)));
    } catch { /* ignore corrupt cache */ }
    try {
      const savedStoriesData = localStorage.getItem('savedStories');
      if (savedStoriesData) setSavedStories(new Set(JSON.parse(savedStoriesData)));
    } catch { /* ignore corrupt cache */ }
    try {
      const history = localStorage.getItem('watchHistory');
      if (history) {
        const parsed = JSON.parse(history);
        if (Array.isArray(parsed)) setWatchHistory(parsed);
      }
    } catch { /* ignore corrupt cache */ }
    try {
      const savedReactedThoughts = localStorage.getItem('userReactedThoughts');
      if (savedReactedThoughts) {
        const reactedThoughts = JSON.parse(savedReactedThoughts);
        if (Array.isArray(reactedThoughts)) setUserReactedPosts(reactedThoughts as Post[]);
      }
    } catch { /* ignore corrupt cache */ }
  }, []);

  // Resolve the routed profile. Re-runs whenever the route target changes, so
  // clicking from one profile to another never leaves the previous account on
  // screen (and never falls back to the viewer's own profile).
  React.useEffect(() => {
    let cancelled = false;
    const currentUser = getStoredUser();
    const currentId = String(currentUser?.id || '').trim();
    setProfileLookupFailed(false);

    if (hasRouteTarget && !isOwnProfile) {
      setResolvedTarget({ route: routeTarget, id: '', isOwner: false });
      setUserProfile(createTargetPlaceholder(routeTarget, routePreview));

      (async () => {
        const profileRes = await api.getProfile(routeTarget);
        if (cancelled) return;
        const data = profileRes?.data;
        if (!data || profileRes.error) {
          setProfileLookupFailed(true);
          return;
        }
        // The server resolves @handle/username/name aliases to the canonical
        // account id. Content is then loaded for that id — never the alias.
        const canonicalId = String(data.id || '').trim() || routeTarget;
        const isOwner =
          data.isOwner === true ||
          (!!currentId && normalizeIdentity(canonicalId) === normalizeIdentity(currentId));
        setResolvedTarget({ route: routeTarget, id: canonicalId, isOwner });
        setUserProfile({
          ...createTargetPlaceholder(routeTarget, routePreview),
          ...data,
          id: canonicalId,
          name: pickDisplayName(data.name, data.username) || routePreview?.name || '',
          username: data.username || routePreview?.username || routeTarget,
          posts: [] as Post[],
          // Server data is real, not a placeholder any more. The persistence
          // effect still writes only when this is the viewer's own account.
          _placeholder: false,
        } as typeof userProfile);

        const contentRes = await api.getUserContent(canonicalId);
        if (cancelled) return;
        let serverItems: Post[] = [];
        if (!contentRes.error && contentRes.data && typeof contentRes.data === 'object') {
          const d = contentRes.data as any;
          serverItems = [
            ...((d.posts || []) as Post[]),
            ...((d.thoughts || []) as any[]).map((t: any) => ({ ...t, type: t.type || 'thought' })),
            ...((d.stories || []) as any[]).map((s: any) => ({ ...s, type: s.type || 'story' })),
            ...((d.moments || []) as any[]).map((m: any) => ({ ...m, type: 'moment' })),
          ] as Post[];
        }
        if (serverItems.length) {
          setUserProfile(prev => ({ ...prev, posts: serverItems }));
          return;
        }
        // Legacy fallback: posts-only endpoint for accounts whose content
        // predates the aggregate endpoint.
        const legacy = await api.getUserPosts(canonicalId);
        if (cancelled || legacy.error || !Array.isArray(legacy.data)) return;
        setUserProfile(prev => {
          const existing = prev.posts || [];
          const serverById = new Map((legacy.data as Post[]).map((p) => [p.id, p]));
          return { ...prev, posts: [...(legacy.data as Post[]), ...existing.filter(p => !serverById.has(p.id))] };
        });
      })().catch(() => {
        if (!cancelled) setProfileLookupFailed(true);
      });

      return () => { cancelled = true; };
    }

    // ── OWN PROFILE (/app/profile or a route that is truly the viewer) ──
    setResolvedTarget({ route: routeTarget, id: currentId, isOwner: true });
    const savedProfile = readCachedOwnProfile();

    if (savedProfile && currentUser) {
      const belongsToViewer =
        normalizeIdentity(savedProfile.id) === normalizeIdentity(currentUser.id) ||
        (!!currentUser.email && String(savedProfile._userEmail || '').toLowerCase() === String(currentUser.email).toLowerCase());
      if (belongsToViewer) {
        setUserProfile(savedProfile);
      } else {
        const fresh = createDefaultProfile(currentUser);
        setUserProfile(fresh);
        try { localStorage.setItem('userProfile', JSON.stringify(fresh)); } catch { /* ignore */ }
      }
    } else if (savedProfile && !currentUser) {
      try { localStorage.removeItem('userProfile'); } catch { /* ignore */ }
    } else if (!savedProfile && currentUser) {
      const fresh = createDefaultProfile(currentUser);
      setUserProfile(fresh);
      try { localStorage.setItem('userProfile', JSON.stringify(fresh)); } catch { /* ignore */ }
    }

    if (currentUser?.id) {
      api.getProfile(currentUser.id).then(serverProfile => {
        if (cancelled || !serverProfile?.data) return;
        const profile = serverProfile.data;
        const displayName = pickDisplayName(profile.name, profile.username);
        setUserProfile(prev => ({
          ...prev,
          ...profile,
          name: displayName || prev.name,
          username: profile.username || prev.username,
          _userEmail: currentUser?.email || prev._userEmail,
          posts: prev.posts || [],
        }));
      }).catch(() => {});

      // Fetch ALL of the user's server content (posts + thoughts + stories
      // + moments) and merge with the local cache, so uploads from any
      // device appear in the profile and stay visible to other accounts.
      api.getUserContent(currentUser.id).then(({ data, error }) => {
        if (cancelled || error || !data || typeof data !== 'object') return;
        const serverItems = [
          ...((data as any).posts || []),
          ...((data as any).thoughts || []).map((t: any) => ({ ...t, type: t.type || 'thought' })),
          ...((data as any).stories || []).map((s: any) => ({ ...s, type: s.type || 'story' })),
          ...((data as any).moments || []).map((m: any) => ({ ...m, type: 'moment' })),
        ];
        if (!serverItems.length) return;
        setUserProfile(prev => {
          const existing = prev.posts || [];
          const serverById = new Map(serverItems.map((p: any) => [p.id, p]));
          // Server wins on conflicts (authoritative across devices).
          const posts = [...serverItems, ...existing.filter(p => !serverById.has(p.id))];
          return { ...prev, posts };
        });
      }).catch(() => {});
      // Legacy fallback: posts-only endpoint.
      api.getUserPosts(currentUser.id).then(({ data, error }) => {
        if (cancelled || error || !Array.isArray(data)) return;
        setUserProfile(prev => {
          const existing = prev.posts || [];
          const serverById = new Map(data.map(p => [p.id, p]));
          const posts = [...data, ...existing.filter(p => !serverById.has(p.id))];
          return { ...prev, posts };
        });
      }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [hasRouteTarget, isOwnProfile, routeTarget, routePreview]);

  // Persist ONLY the signed-in viewer's own profile. Previously every viewed
  // profile was written to `userProfile`, which corrupted local identity and
  // made CreatePage stamp uploads with the wrong author.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isSelfView) return;
    const profile = userProfile as Record<string, unknown>;
    if (!profile || profile._placeholder === true) return;
    const currentUser = getStoredUser();
    if (!currentUser) return;
    const idMatch = !!viewerId && normalizeIdentity(profile.id) === normalizeIdentity(viewerId);
    const emailMatch = !!viewerEmail && String(profile._userEmail || profile.email || '').toLowerCase() === viewerEmail;
    if (!idMatch && !emailMatch) return;
    try { localStorage.setItem('userProfile', JSON.stringify(profile)); } catch { /* storage is best-effort */ }
  }, [userProfile, isSelfView, viewerId, viewerEmail]);

  // Save saved posts to localStorage whenever they change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('savedPosts', JSON.stringify(Array.from(savedPosts)));
    }
  }, [savedPosts]);

  // Save saved stories to localStorage whenever they change
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('savedStories', JSON.stringify(Array.from(savedStories)));
    }
  }, [savedStories]);

  // Save watch history to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('watchHistory', JSON.stringify(watchHistory));
    }
  }, [watchHistory]);

  // Listen for save/unsave events from other components
  useEffect(() => {
    const handleContentSaved = (event: CustomEvent) => {
      const { postId, content } = event.detail;
      
      // Update saved posts set
      setSavedPosts(prev => new Set(prev).add(postId));
      
      // Trigger re-gathering of saved content
      setTimeout(() => {
        const savedContentData = localStorage.getItem('savedContentData');
        const savedContent = savedContentData ? JSON.parse(savedContentData) : {};
        const allContent = Object.values(savedContent);
        
        // Also include user's own posts that are saved (for backward compatibility)
        const userSavedPosts = userProfile.posts.filter(post => savedPosts.has(post.id) && !savedContent[post.id]);
        allContent.push(...userSavedPosts);

        // Also include watch history items that are saved (for backward compatibility)
        const savedHistoryItems = watchHistory.filter(item => savedPosts.has(item.id) && !savedContent[item.id]);
        allContent.push(...savedHistoryItems);

        // Sort by savedAt date if available, otherwise by time
        allContent.sort((a: Post, b: Post) => {
          const dateA = a.savedAt ? new Date(a.savedAt).getTime() : 0;
          const dateB = b.savedAt ? new Date(b.savedAt).getTime() : 0;
          return dateB - dateA; // Most recent first
        });

        setAllSavedContent(allContent as Post[]);
      }, 100);
    };

    const handleContentUnsaved = (event: CustomEvent) => {
      const { postId, content } = event.detail;
      
      // Update saved posts set
      setSavedPosts(prev => {
        const newSet = new Set(prev);
        newSet.delete(postId);
        return newSet;
      });
      
      // Remove from all saved content immediately
      setAllSavedContent(prev => {
        const filtered = prev.filter(item => item.id !== postId);
        return filtered;
      });
      
      // Also remove from savedContentData localStorage
      const savedContentData = localStorage.getItem('savedContentData');
      if (savedContentData) {
        const savedContent = JSON.parse(savedContentData);
        delete savedContent[postId];
        localStorage.setItem('savedContentData', JSON.stringify(savedContent));
      }
    };

    // Listen for thought reacted events from ThoughtsPage
    const handleThoughtReacted = (event: CustomEvent) => {
      const { userReactedThought, userReactedThoughts } = event.detail;
      
      // Add the reacted thought to user's reacted posts
      setUserReactedPosts(prev => [userReactedThought as Post, ...prev] as Post[]);
    };

    // Listen for thought unreacted events from ThoughtsPage
    const handleThoughtUnreacted = (event: CustomEvent) => {
      const { thoughtId, userReactedThoughts } = event.detail;
      
      // Remove the reacted thought from user's reacted posts
      setUserReactedPosts(prev => prev.filter(p => (p as any).originalThoughtId !== thoughtId));
    };

    const handleUserPostCreated = (_event: CustomEvent) => {
      // Local cache belongs to the viewer only. Never replace another user's
      // profile with the viewer's own posts while visiting their page.
      if (!isSelfView) return;
      try {
        const saved = readCachedOwnProfile();
        if (saved) setUserProfile(saved);
      } catch {}
    };

    const handleUserPostDeleted = (_event: CustomEvent) => {
      if (!isSelfView) return;
      try {
        const saved = readCachedOwnProfile();
        if (saved) setUserProfile(saved);
      } catch {}
    };

    window.addEventListener('contentSaved', handleContentSaved as EventListener);
    window.addEventListener('contentUnsaved', handleContentUnsaved as EventListener);
    window.addEventListener('thoughtReacted', handleThoughtReacted as EventListener);
    window.addEventListener('thoughtUnreacted', handleThoughtUnreacted as EventListener);
    window.addEventListener('userPostCreated', handleUserPostCreated as EventListener);
    window.addEventListener('userPostDeleted', handleUserPostDeleted as EventListener);
    
    return () => {
      window.removeEventListener('contentSaved', handleContentSaved as EventListener);
      window.removeEventListener('contentUnsaved', handleContentUnsaved as EventListener);
      window.removeEventListener('thoughtReacted', handleThoughtReacted as EventListener);
      window.removeEventListener('thoughtUnreacted', handleThoughtUnreacted as EventListener);
      window.removeEventListener('userPostCreated', handleUserPostCreated as EventListener);
      window.removeEventListener('userPostDeleted', handleUserPostDeleted as EventListener);
    };
  }, [savedPosts, userProfile.posts, watchHistory, isSelfView]); // Add missing dependencies

  // Handle split view video selection
  useEffect(() => {
    const handleSplitViewVideoSelected = (event: CustomEvent) => {
      const { content } = event.detail;
      
      // Set the new content immediately
      setFullscreenContent(content);
      
      // Clear temp content to avoid duplicate processing
      (window as unknown as { tempFullscreenContent?: FullscreenContent }).tempFullscreenContent = null;
    };

    window.addEventListener('splitViewVideoSelected', handleSplitViewVideoSelected as EventListener);
    
    return () => {
      window.removeEventListener('splitViewVideoSelected', handleSplitViewVideoSelected as EventListener);
    };
  }, []);

  // Gather all saved content from different sources
  useEffect(() => {
    const gatherAllSavedContent = () => {
      // Get saved content data from localStorage
      const savedContentData = localStorage.getItem('savedContentData');
      const savedContent = savedContentData ? JSON.parse(savedContentData) : {};
      
      // Convert saved content object to array
      const allContent = Object.values(savedContent);
      
      // Also include user's own posts that are saved (for backward compatibility)
      // But only if they're not already in savedContentData
      const userSavedPosts = userProfile.posts.filter(post => 
        savedPosts.has(post.id) && !savedContent[post.id]
      );
      allContent.push(...userSavedPosts);

      // Also include watch history items that are saved (for backward compatibility)
      // But only if they're not already in savedContentData
      const savedHistoryItems = watchHistory.filter(item => 
        savedPosts.has(item.id) && !savedContent[item.id]
      );
      allContent.push(...savedHistoryItems);

      // Sort by savedAt date if available, otherwise by time
      allContent.sort((a: Post, b: Post) => {
        const dateA = a.savedAt ? new Date(a.savedAt).getTime() : 0;
        const dateB = b.savedAt ? new Date(b.savedAt).getTime() : 0;
        return dateB - dateA; // Most recent first
      });

      setAllSavedContent(allContent as Post[]);
    };

    gatherAllSavedContent();
  }, [savedPosts, userProfile.posts, watchHistory]);

  // Initialize post likes and retweets
  React.useEffect(() => {
    const likesMap: { [key: string]: number } = {};
    const reactsMap: { [key: string]: number } = {};
    userProfile.posts.forEach(post => {
      likesMap[post.id] = post.likes;
      reactsMap[post.id] = post.reacts || 0;
    });
    setPostLikes(likesMap);
    setPostReacts(reactsMap);
  }, []);

  const handleLike = (postId: string) => {
    const liking = !likedPosts.has(postId);
    // Human eval first (fire-and-forget).
    try { evalLike(postId, liking); } catch { /* never block */ }
    const base = toCount(postLikes[postId] ?? userProfile.posts.find(p => p.id === postId)?.likes);
    const newLikedPosts = new Set(likedPosts);
    const newPostLikes = { ...postLikes };

    if (likedPosts.has(postId)) {
      newLikedPosts.delete(postId);
      newPostLikes[postId] = Math.max(0, base - 1);
    } else {
      newLikedPosts.add(postId);
      // Counters can be missing for posts loaded outside the initial map
      // (saved/history items) — starting from 0 here rendered "NaN likes".
      newPostLikes[postId] = bumpCount(base, +1);
    }

    setLikedPosts(newLikedPosts);
    setPostLikes(newPostLikes);
    // Persist so the owner is notified and the count is shared across devices.
    api.like(postId, liking ? 'like' : 'unlike').then(({ data }) => {
      if (data && typeof data.likes === 'number') {
        setPostLikes(prev => ({ ...prev, [postId]: data.likes }));
      }
    }).catch(() => undefined);
  };

  const handleVote = async (thoughtId: string, voteType: 'upvote' | 'downvote') => {
    // Human eval first (fire-and-forget): votes are explicit labels.
    try { evalVote(thoughtId, voteType); } catch { /* never block */ }
    try {
      setVoting(thoughtId);
      
      const postIndex = userProfile.posts.findIndex(p => p.id === thoughtId);
      if (postIndex === -1) return;
      
      const post = userProfile.posts[postIndex];
      // Votes are REAL counters only: never fabricate them from likes (that
      // made every like look like it also upvoted the post). Missing/zero
      // ledger counts simply start at 0.
      const currentUpvotes = toCount((post as any).upvotes_count);
      const currentDownvotes = toCount((post as any).downvotes_count);
      
      let newUpvotes = currentUpvotes;
      let newDownvotes = currentDownvotes;
      let newUserVote: 'upvote' | 'downvote' | null = voteType;
      
      if ((post as any).user_vote === voteType) {
        // Remove vote
        newUserVote = null;
        if (voteType === 'upvote') {
          newUpvotes = Math.max(0, newUpvotes - 1);
        } else {
          newDownvotes = Math.max(0, newDownvotes - 1);
        }
      } else if ((post as any).user_vote) {
        // Change vote
        if ((post as any).user_vote === 'upvote' && voteType === 'downvote') {
          newUpvotes = Math.max(0, newUpvotes - 1);
          newDownvotes = newDownvotes + 1;
        } else if ((post as any).user_vote === 'downvote' && voteType === 'upvote') {
          newUpvotes = newUpvotes + 1;
          newDownvotes = Math.max(0, newDownvotes - 1);
        }
      } else {
        // New vote
        if (voteType === 'upvote') {
          newUpvotes = newUpvotes + 1;
        } else {
          newDownvotes = newDownvotes + 1;
        }
      }
      
      const updatedPosts = [...userProfile.posts];
      updatedPosts[postIndex] = {
        ...post,
        upvotes_count: newUpvotes,
        downvotes_count: newDownvotes,
        user_vote: newUserVote
      };
      
      setUserProfile(prev => ({
        ...prev,
        posts: updatedPosts
      }));
      
      // Sync with database — send the TARGET state ("none" when toggling off)
      // so a double-press removal survives reloads, then adopt the server's
      // authoritative ledger counts.
      const result = await voteOnThought({ thought_id: thoughtId, vote_type: newUserVote ?? 'none' });
      if (!result.success) {
        // Revert local state on error
        setUserProfile(prev => ({
          ...prev,
          posts: userProfile.posts
        }));
      } else {
        setUserProfile(prev => ({
          ...prev,
          posts: prev.posts.map(p => p.id === thoughtId
            ? {
                ...p,
                upvotes_count: result.upvotes_count,
                downvotes_count: result.downvotes_count,
                user_vote: result.user_vote,
              }
            : p),
        }));
      }
    } catch (error) {
      // Handle vote error - revert local state
      setUserProfile(prev => ({
        ...prev,
        posts: userProfile.posts
      }));
    } finally {
      setVoting(null);
    }
  };

  const handleReact = (postId: string) => {
    const newReactedPosts = new Set(reactedPosts);
    const newPostReacts = { ...postReacts };
    const post = userProfile.posts.find(p => p.id === postId);

    if (reactedPosts.has(postId)) {
      // Remove reaction and remove from user's reacted posts
      newReactedPosts.delete(postId);
      newPostReacts[postId] = bumpCount(newPostReacts[postId], -1);
      setUserReactedPosts(prev => prev.filter(p => p.originalPostId !== postId));
      showSuccess('Reaction removed - post no longer yours');
    } else {
      // Add reaction and make it user's own post
      newReactedPosts.add(postId);
      newPostReacts[postId] = bumpCount(newPostReacts[postId], +1);

      if (post) {
        // Real identity of the signed-in account — never a placeholder name.
        const displayName = String(
          userProfile.username || userProfile.name || 'User',
        ).slice(0, 80);
        const userReactedPost: Post = {
          id: `user-reacted-${postId}`,
          originalPostId: postId,
          user: displayName,
          avatar: userProfile.avatar || '',
          time: 'Just now',
          content: `🔄 Reacted to: ${post.content}`,
          likes: post.likes,
          reacts: (post.reacts || 0) + 1,
          comments: post.comments,
          shares: post.shares,
          originalAuthor: post.user,
          type: post.type as 'post' | 'thought' | 'reacted' | 'moment' | 'video',
          media: post.media,
          mediaType: post.mediaType as 'video' | 'image' | 'moment',
          videoUrl: post.videoUrl
        };
        setUserReactedPosts(prev => [userReactedPost as Post, ...prev] as Post[]);
      }
      showSuccess('🔄 Post reacted! This post is now yours too!');
    }

    setReactedPosts(newReactedPosts);
    setPostReacts(newPostReacts);
    // Persist the reaction (owner notification + cross-device count).
    api.react(postId, reactedPosts.has(postId) ? 'unreact' : 'react').then(({ data }) => {
      if (data && typeof data.reacts === 'number') {
        setPostReacts(prev => ({ ...prev, [postId]: data.reacts }));
      }
    }).catch(() => undefined);
  };


  const handleShare = async (post: Post) => {
    const result = await sharePost({
      id: post.id,
      user: post.user,
      content: post.content || '',
      image: post.media || post.image
    });
    if (!result.success && !result.cancelled) {
      showError(result.error || 'Share failed');
      return;
    }
    if (result.success && result.recorded === false) {
      showError(result.error || 'The share count could not be saved');
      return;
    }
    if (result.recorded && typeof result.shares === 'number') {
      setUserProfile(prev => ({
        ...prev,
        posts: (prev.posts || []).map(p => (p.id === post.id ? { ...p, shares: result.shares } : p)),
      }));
    }
  };

  const handleSave = (postId: string) => {
    const newSavedPosts = new Set(savedPosts);
    const post = userProfile.posts.find(p => p.id === postId) || 
                 allSavedContent.find(item => item.id === postId);

    if (savedPosts.has(postId)) {
      newSavedPosts.delete(postId);
      showSuccess('Removed from saved');
      
      // Dispatch event to notify other components
      window.dispatchEvent(new CustomEvent('contentUnsaved', { 
        detail: { postId, content: post } 
      }));
    } else {
      newSavedPosts.add(postId);
      showSuccess('Saved to collection');
      
      // Store full content data when saving
      if (post) {
        const savedContentData = localStorage.getItem('savedContentData');
        const savedContent = savedContentData ? JSON.parse(savedContentData) : {};
        savedContent[postId] = {
          ...post,
          savedAt: new Date().toISOString()
        };
        localStorage.setItem('savedContentData', JSON.stringify(savedContent));
      }
      
      // Dispatch event to notify other components
      window.dispatchEvent(new CustomEvent('contentSaved', { 
        detail: { postId, content: post } 
      }));
    }

    setSavedPosts(newSavedPosts);
  };

  const handleSaveStory = (storyId: string) => {
    const newSavedStories = new Set(savedStories);

    if (savedStories.has(storyId)) {
      newSavedStories.delete(storyId);
      showSuccess('Story removed from saved');
    } else {
      newSavedStories.add(storyId);
      showSuccess('Story saved successfully!');
    }

    setSavedStories(newSavedStories);
  };

  const addToWatchHistory = (post: Post) => {
    const historyItem = {
      ...post,
      watchedAt: new Date().toISOString(),
      watchDuration: 0
    };
    
    const newHistory = [historyItem, ...watchHistory.filter(h => h.id !== post.id)].slice(0, 50); // Keep last 50 items
    setWatchHistory(newHistory);
    
    // Also dispatch event for global tracking
    window.dispatchEvent(new CustomEvent('contentWatched', { 
      detail: { content: historyItem } 
    }));
  };

  const handleComment = (postId: string, postUser: string) => {
    setCurrentPostId(postId);
    setCurrentPostUser(postUser);
    setShowCommentSection(true);
  };



  const handleEditProfile = () => {
    setShowEditProfileModal(true);
  };

  const handleSaveProfile = async (updatedProfile: Partial<UserProfile>) => {
    const currentUser = getStoredUser();
    const prevSnapshot = userProfile;
    const merged = { ...userProfile, ...updatedProfile, _userEmail: currentUser?.email || userProfile._userEmail };
    setUserProfile(merged as unknown as typeof userProfile);
    // Persist locally so every surface reads the fresh name/avatar on next
    // load, and keep the auth record in sync so NEW uploads are stamped with
    // the updated name (CreatePage reads it for the `user` field).
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('userProfile', JSON.stringify(merged));
        if (currentUser) {
          const nextUsername =
            (merged as unknown as Record<string, unknown>).username as string ||
            (merged as unknown as Record<string, unknown>).name as string ||
            currentUser.username;
          const nextFullName =
            (merged as unknown as Record<string, unknown>).name as string ||
            currentUser.fullName;
          localStorage.setItem(
            'equyvo_cognito_user',
            JSON.stringify({
              ...currentUser,
              username: nextUsername,
              fullName: nextFullName,
              avatar: (merged as unknown as Record<string, unknown>).avatar || (currentUser as unknown as Record<string, unknown>).avatar,
            }),
          );
        }
      }
    } catch { /* storage is best-effort */ }
    try {
      const res = (await api.updateProfile(merged)) as unknown as {
        error?: string;
        code?: string;
        quota?: number;
      };
      // Server-enforced display-name quota (402 NAME_CHANGE_QUOTA): roll back
      // the optimistic rename so no surface shows a name the server rejected.
      if (res && (res.code === 'NAME_CHANGE_QUOTA' || /name change/i.test(res.error || ''))) {
        setUserProfile(prevSnapshot);
        try {
          if (typeof window !== 'undefined') {
            localStorage.setItem('userProfile', JSON.stringify(prevSnapshot));
          }
        } catch { /* storage is best-effort */ }
        showError(
          `You have used all ${res.quota || 2} profile name changes. Buy Premium to get 2 more — your photo can still be updated for free.`,
        );
        return;
      }
      await api.indexContent({
        id: merged.id || currentUser?.id || 'profile',
        title: merged.name || merged.username || 'User',
        description: merged.bio || '',
        type: 'post',
        creator: merged.name || merged.username || 'user',
        creatorAvatar: merged.avatar || '',
        views: '0',
        thumbnail: merged.avatar || '',
        category: 'profile',
        tags: ['profile', merged.name?.toLowerCase() || '', merged.username?.toLowerCase() || ''],
        publishedAt: new Date().toISOString(),
        content: merged.bio || '',
      });
    } catch {}
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('profileUpdated', { detail: { ...updatedProfile, _userEmail: currentUser?.email } }));
    }
  };

  const handleEditPost = (post: Post) => {
    setCurrentEditingPost(post);
    setShowEditPostModal(true);
  };

  const handleSavePost = (updatedPost: Partial<Post>) => {
    setUserProfile(prev => ({
      ...prev,
      posts: prev.posts.map(post =>
        post.id === updatedPost.id ? updatedPost as Post : post
      )
    } as typeof prev));
  };

  const handleDeletePost = async (postId: string) => {
    const post = userProfile.posts.find(p => p.id === postId);
    try {
      await deleteContent({
        postId,
        contentType: (post?.type as any) || 'post',
        onDeleteComplete: (id) => {
          setUserProfile(prev => ({
            ...prev,
            posts: prev.posts.filter(p => p.id !== id)
          }));
        }
      });
    } catch {}
  };

  // Delete all user data
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handleDeleteAllData = () => {
    setShowDeleteConfirm(true);
  };

  const confirmDeleteAllData = async () => {
    const currentUser = getStoredUser();
    const userId = currentUser?.id || userProfile.id || userProfile._userEmail;
    if (!userId) {
      showError('Cannot identify user to delete');
      setShowDeleteConfirm(false);
      return;
    }
    try {
      const { error } = await api.deleteUserData(userId);
      if (error) {
        showError('Failed to delete data: ' + error);
      } else {
        // Clear every viewer-scoped local cache (saved items, history,
        // reactions, local follow/chat caches, notifications).
        clearViewerCaches();
        setUserProfile(createDefaultProfile(currentUser));
        setSavedPosts(new Set());
        setSavedStories(new Set());
        setWatchHistory([]);
        setAllSavedContent([]);
        setUserReactedPosts([]);
        showSuccess('All your data has been deleted successfully');
      }
    } catch (err: any) {
      showError('Failed to delete data: ' + (err.message || 'Unknown error'));
    }
    setShowDeleteConfirm(false);
  };

  // Menu handlers for standardized menu
  const [reportPostId, setReportPostId] = useState<string | null>(null);
  const [reportPostType, setReportPostType] = useState<'post' | 'thought' | 'moment' | 'comment'>('post');

  // Followers / following sheets (Instagram-ish, privacy-gated server-side).
  const [showFollowers, setShowFollowers] = useState(false);
  const [showFollowing, setShowFollowing] = useState(false);
  const [followerList, setFollowerList] = useState<SocialProfile[]>([]);
  const [followingList, setFollowingList] = useState<SocialProfile[]>([]);
  const [restrictedFollowers, setRestrictedFollowers] = useState(false);
  const [restrictedFollowing, setRestrictedFollowing] = useState(false);
  const [listsLoading, setListsLoading] = useState(false);

  // Followers/following always belong to the routed profile. Use the canonical
  // id the server resolved for that target; fall back to the route alias only
  // while the lookup is still in flight. Never fall back to the viewer's id —
  // that showed the viewer's own lists on someone else's profile.
  const targetProfileId: string = (() => {
    if (resolvedTargetId) return resolvedTargetId;
    if (hasRouteTarget && !isOwnProfile) return routeTarget;
    return String((userProfile as { id?: string })?.id || viewerId || '');
  })();

  const openFollowers = async () => {
    setShowFollowers(true);
    setListsLoading(true);
    try {
      const me = myId();
      // Client-side pre-gate for instant feedback; server re-gates for truth.
      let viewerFollows = me === targetProfileId;
      if (!viewerFollows && targetProfileId) {
        try {
          const st = await api.followStatus(targetProfileId);
          viewerFollows = !!(st as { data?: { isFollowing?: boolean } }).data?.isFollowing;
        } catch { /* ignore */ }
      }
      const isPrivate = (userProfile as { isPrivate?: boolean })?.isPrivate === true;
      if (!canViewFollowLists(me, { id: targetProfileId, isPrivate }, viewerFollows)) {
        setRestrictedFollowers(true);
        setFollowerList([]);
      } else {
        const { list, restricted } = await getFollowers(targetProfileId);
        setFollowerList(list);
        setRestrictedFollowers(restricted);
      }
    } finally {
      setListsLoading(false);
    }
  };

  const openFollowing = async () => {
    setShowFollowing(true);
    setListsLoading(true);
    try {
      const me = myId();
      let viewerFollows = me === targetProfileId;
      if (!viewerFollows && targetProfileId) {
        try {
          const st = await api.followStatus(targetProfileId);
          viewerFollows = !!(st as { data?: { isFollowing?: boolean } }).data?.isFollowing;
        } catch { /* ignore */ }
      }
      const isPrivate = (userProfile as { isPrivate?: boolean })?.isPrivate === true;
      if (!canViewFollowLists(me, { id: targetProfileId, isPrivate }, viewerFollows)) {
        setRestrictedFollowing(true);
        setFollowingList([]);
      } else {
        const { list, restricted } = await getFollowing(targetProfileId);
        setFollowingList(list);
        setRestrictedFollowing(restricted);
      }
    } finally {
      setListsLoading(false);
    }
  };

  // Live follower/following counters. Following someone dispatches
  // `followChanged` from FollowButton; adjust the visible counters immediately
  // (the target's followers, and the viewer's own following) and refresh an
  // open followers/following sheet. The next profile read still derives the
  // authoritative numbers from the follow graph server-side.
  React.useEffect(() => {
    let cancelled = false;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const followed = detail.following === true;
      const pending = detail.pending === true;
      const target = String(detail.target || detail.userId || '');
      if (!target || pending) return;
      const me = normalizeIdentity(myId());
      const targetKey = normalizeIdentity(target);
      const shownKey = normalizeIdentity(targetProfileId);
      const isTargetProfile = !!targetKey && !!shownKey && targetKey === shownKey;
      const isViewer = !!me && targetKey === me;
      setUserProfile(prev => {
        let followers = Number(prev.followers || 0);
        let following = Number(prev.following || 0);
        if (isTargetProfile && targetKey !== me) {
          followers = Math.max(0, followers + (followed ? 1 : -1));
        }
        if (isSelfView && !isViewer) {
          following = Math.max(0, following + (followed ? 1 : -1));
        }
        return { ...prev, followers, following };
      });
      if (cancelled) return;
      if (showFollowers) void openFollowers();
      if (showFollowing) void openFollowing();
    };
    window.addEventListener('followChanged', refresh as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener('followChanged', refresh as EventListener);
    };
    // openFollowers/openFollowing intentionally re-created with the sheet state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetProfileId, isSelfView, showFollowers, showFollowing, viewerId]);

  const handleReport = (postId: string) => {
    const post = userProfile.posts.find(p => p.id === postId);
    const t = String(post?.type || 'post').toLowerCase();
    setReportPostType(t === 'moment' ? 'moment' : t === 'thought' ? 'thought' : 'post');
    setReportPostId(postId);
  };

  // Owner-only "hide from public": flips server visibility to private so the
  // post disappears for every other account on every device (no delete).
  const handleHide = async (postId: string) => {
    const post = userProfile.posts.find(p => p.id === postId);
    const ok = await setContentVisibility(postId, (post?.type as string) || 'post', 'private');
    if (ok) {
      setUserProfile(prev => ({
        ...prev,
        posts: prev.posts.map(p => (p.id === postId ? ({ ...p, visibility: 'private' } as Post) : p)),
      }));
    }
  };

  // Owner-only story-cover removal: clears the custom thumbnail on the
  // server (owner-checked) and mirrors locally, so the story keeps its media
  // but drops the cover everywhere on next fetch.
  const handleRemoveStoryCover = async (storyId: string) => {
    try {
      const { error } = await api.updateStory(storyId, { thumbnail: '' });
      if (error) {
        showError("Couldn't remove the cover. Please try again.");
        return;
      }
      setUserProfile(prev => ({
        ...prev,
        posts: prev.posts.map(p => (p.id === storyId ? ({ ...p, thumbnail: '' } as Post) : p)),
      }));
      showSuccess('Story cover removed');
    } catch {
      showError("Couldn't remove the cover. Please try again.");
    }
  };

  const handleCopyLink = (postId: string) => {
    const shareUrl = `${window.location.origin}/app/home?post=${encodeURIComponent(postId)}`;
    navigator.clipboard.writeText(shareUrl)
      .then(() => showSuccess('🔗 Link copied to clipboard!'))
      .catch(() => showError("Couldn't copy the link."));
  };

  const handleMenuShare = (postId: string) => {
    const post = userProfile.posts.find(p => p.id === postId);
    if (post) {
      void sharePost({
        id: post.id,
        user: post.user,
        content: post.content || '',
        image: post.media || post.image,
      });
    }
  };


  const handleFullscreen = (post: Post) => {
    // Track content view in history
    addToWatchHistory(post);
    const isMoment = post.type === 'moment' || post.mediaType === 'moment';
    const media = resolveMediaFields(post as unknown as Record<string, unknown>);
    
    // Enhanced content structure for fullscreen viewer with complete metadata
    const mediaContent = {
      ...post,
      type: isMoment ? 'moment' : (post.type || post.mediaType || (media.videoUrl ? 'video' : 'image')),
      videoUrl: media.videoUrl,
      media: media.media || post.image,
      thumbnail: media.thumbnail || post.image,
      mediaType: media.videoUrl ? 'video' : 'image',
      creator: post.user || 'Unknown',
      content: post.content || '',
      likes: post.likes || 0,
      comments: post.comments || 0,
      views: post.views || 0,
      time: post.time || '',
      published: post.time || '',
      duration: post.duration,
      description: post.content || '',
      creatorId: post.user || 'unknown',
      // Only real values: never invent verified/subscriber counts.
      verified: (post as any).verified === true,
      fallbackImage: media.thumbnail || post.image,
      // Ensure proper aspect ratio and orientation for moments
      aspectRatio: isMoment ? '9/16' : media.image ? '16/9' : undefined,
      forcePortrait: isMoment,
      viewMode: isMoment ? 'fullscreen' : undefined
    };
    
    setFullscreenContent(mediaContent);
  };

  // A Moments card needs clean media strings no matter what the source row
  // looked like (legacy arrays/objects included).
  const toMomentView = (post: Post) => {
    const media = resolveMediaFields(post as unknown as Record<string, unknown>);
    return {
      id: post.id,
      user: post.user,
      userId: ownerIdOf(post) || undefined,
      ownerId: ownerIdOf(post) || undefined,
      content: post.content || '',
      image: media.image,
      video: media.videoUrl || undefined,
      videoUrl: media.videoUrl || undefined,
      thumbnail: media.thumbnail,
      likes: post.likes,
      comments: post.comments,
      shares: post.shares,
      time: post.time,
      avatar: post.avatar,
      fallbackImage: media.thumbnail,
      media: media.media,
      mediaType: (media.videoUrl ? 'video' : 'image') as 'video' | 'image',
      views: post.views || 0,
    };
  };

  const closeFullscreen = () => {
    setFullscreenContent(null);
  };

  const closeUniversalMediaViewer = () => {
    setUniversalMediaContent(null);
  };

  // Video handling functions
  const handleVideoPlayPause = async (postId: string) => {
    const video = videoRefs.current[postId];
    if (!video || videoErrors.has(postId)) return;

    const newPlayingVideos = new Set(playingVideos);

    if (playingVideos.has(postId)) {
      video.pause();
      newPlayingVideos.delete(postId);
    } else {
      // Track video play in history
      const post = userProfile.posts.find(p => p.id === postId) || 
                   userReactedPosts.find(p => p.id === postId);
      if (post) {
        addToWatchHistory(post);
      }
      
      // Pause all other videos first
      Object.keys(videoRefs.current).forEach(id => {
        if (id !== postId && videoRefs.current[id]) {
          videoRefs.current[id].pause();
        }
      });

      newPlayingVideos.clear();
      newPlayingVideos.add(postId);
      setIsLoading(prev => ({ ...prev, [postId]: true }));

      video.muted = isMuted;
      video.currentTime = 0;

      try {
        await video.play();
        setIsLoading(prev => ({ ...prev, [postId]: false }));
      } catch (error) {
        video.muted = true;
        try {
          await video.play();
          setIsLoading(prev => ({ ...prev, [postId]: false }));
        } catch (e) {
          handleVideoError(postId, e);
        }
      }
    }

    setPlayingVideos(newPlayingVideos);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
    // Update all video elements
    Object.values(videoRefs.current).forEach(video => {
      if (video) {
        video.muted = !isMuted;
      }
    });
  };

  const handleVideoError = (postId: string, error?: Event | React.SyntheticEvent) => {
    setVideoErrors(prev => new Set(prev).add(postId));
    setPlayingVideos(prev => {
      const newSet = new Set(prev);
      newSet.delete(postId);
      return newSet;
    });
    setIsLoading(prev => ({ ...prev, [postId]: false }));
  };

  const handleTimeUpdate = (postId: string, video: HTMLVideoElement) => {
    if (!isSeeking && video.duration) {
      const progress = (video.currentTime / video.duration) * 100;
      const newProgress = { ...videoProgress };
      const newCurrentTime = { ...currentTime };
      newProgress[postId] = progress || 0;
      newCurrentTime[postId] = video.currentTime || 0;
      setVideoProgress(newProgress);
      setCurrentTime(newCurrentTime);
    }
  };

  const handleLoadedMetadata = (postId: string, video: HTMLVideoElement) => {
    const newDuration = { ...videoDuration };
    newDuration[postId] = video.duration || 0;
    setVideoDuration(newDuration);
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="space-y-6">
      {/* Profile Header */}
      <Card className="p-4 md:p-6">
        {profileLookupFailed && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>This profile could not be loaded. Check the name or username and try again.</span>
          </div>
        )}
        <div className="flex flex-col items-center text-center">
          <Avatar className="h-20 w-20 md:h-24 md:w-24 mb-3 md:mb-4">
            {userProfile.avatar ? (
              <AvatarImage src={userProfile.avatar} />
            ) : null}
            <AvatarFallback className="text-lg md:text-xl">
              {userProfile.name?.substring(0, 2) || ''}
            </AvatarFallback>
          </Avatar>
          <h1 className="text-xl md:text-3xl font-bold flex items-center gap-2">
            {userProfile.name || (profilePending ? (
              <span className="inline-block h-7 w-40 animate-pulse rounded bg-muted" aria-label="Loading profile" />
            ) : '')}
            {(userProfile as { verified?: boolean }).verified === true && (
              <span title="Creator Pro verified name" aria-label="Verified" className="text-pink-500">
                <BadgeCheck className="h-5 w-5 md:h-7 md:w-7" />
              </span>
            )}
          </h1>
          {userProfile.username ? (
            <p className="text-muted-foreground mb-2 text-sm md:text-base">{userProfile.username}</p>
          ) : profilePending ? (
            <span className="mb-2 mt-1 inline-block h-4 w-28 animate-pulse rounded bg-muted" aria-label="Loading username" />
          ) : null}
          {userProfile.bio ? (
            <p className="text-center max-w-md mb-3 md:mb-4 text-sm md:text-base px-2">{userProfile.bio}</p>
          ) : profilePending ? (
            <span className="mb-3 mt-1 inline-block h-4 w-56 animate-pulse rounded bg-muted" aria-label="Loading bio" />
          ) : null}
          <div className="flex gap-3 md:gap-4 mb-3 md:mb-4">
            <button type="button" onClick={openFollowers} className="flex flex-col items-center rounded-lg px-3 py-1 hover:bg-secondary/40" title="See followers">
              <span className="font-bold text-sm md:text-base">{profilePending ? '—' : userProfile.followers}</span>
              <span className="text-xs md:text-sm text-muted-foreground underline-offset-2 hover:underline">Followers</span>
            </button>
            <button type="button" onClick={openFollowing} className="flex flex-col items-center rounded-lg px-3 py-1 hover:bg-secondary/40" title="See following">
              <span className="font-bold text-sm md:text-base">{profilePending ? '—' : userProfile.following}</span>
              <span className="text-xs md:text-sm text-muted-foreground underline-offset-2 hover:underline">Following</span>
            </button>
          </div>
          <div className="flex gap-2 flex-wrap justify-center">
            {isSelfView ? (
              <>
                <Button variant="outline" size="sm" className="flex items-center gap-2 text-xs md:text-sm" onClick={handleEditProfile}>
                  <Edit className="h-3 w-3 md:h-4 md:w-4" /> <span className="hidden xs:inline">Edit Profile</span><span className="xs:hidden">Edit</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 md:h-10 md:w-10"
                  onClick={() => navigate('/app/settings')}
                  aria-label="Open settings"
                  title="Open settings"
                >
                  <Settings className="h-3 w-3 md:h-4 md:w-4" />
                </Button>
              </>
            ) : (
              <>
                <FollowButton userId={resolvedTargetId || routeTarget} />
                <Button variant="outline" size="sm" className="flex items-center gap-2 text-xs md:text-sm" onClick={() => setShowReportProfile(true)}>
                  <AlertTriangle className="h-3 w-3 md:h-4 md:w-4" /> Report
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      {/* User Content Tabs — History and Saved are strictly private to the
          signed-in owner's own profile page and are never rendered or
          selectable when viewing another person's profile. */}
      <Tabs
        value={effectiveTab}
        onValueChange={(val) => {
          if (!isSelfView && (val === 'history' || val === 'saved')) return;
          setActiveTab(val);
        }}
        className="w-full"
      >
        <TabsList className={`flex w-full max-w-full justify-start gap-1.5 overflow-x-auto scroll-px-3 scrollbar-hide bg-transparent py-1 pl-1 pr-6 h-auto md:grid ${isSelfView ? 'md:grid-cols-7' : 'md:grid-cols-5'} md:overflow-visible md:bg-muted md:rounded-md md:pr-1`}>
          <TabsTrigger value="posts" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">All Posts</TabsTrigger>
          <TabsTrigger value="stories" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">Stories</TabsTrigger>
          <TabsTrigger value="moments" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">Moments</TabsTrigger>
          <TabsTrigger value="videos" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">Videos</TabsTrigger>
          <TabsTrigger value="thoughts" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">Thoughts</TabsTrigger>
          {isSelfView && (
            <>
              <TabsTrigger value="history" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">History</TabsTrigger>
              <TabsTrigger value="saved" className="shrink-0 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:text-sm">Saved</TabsTrigger>
            </>
          )}
          <span aria-hidden="true" className="w-1 shrink-0 md:hidden" />
        </TabsList>
        <TabsContent value="posts" className="mt-4 md:mt-6 space-y-3 md:space-y-4">
          {/* Combine user's original posts with reacted posts (owner only) */}
          {[
            ...viewerReactedPosts,
            ...userProfile.posts
          ].length > 0 ? (
            <>
              {/* Filter moments and render them with Moments component */}
              {[...viewerReactedPosts, ...userProfile.posts]
                .filter(post => post.type === 'moment' && isVideoItem(post as any)).length > 0 && (
                <div className="space-y-4">
                  <h4 className="text-sm font-medium text-muted-foreground">Moments</h4>
                  <Moments
                    moments={[...viewerReactedPosts, ...userProfile.posts]
                      .filter(post => post.type === 'moment' && isVideoItem(post as any)).map(toMomentView)}
                    onFullscreen={(moment) => {
                      const fullPost = [...viewerReactedPosts, ...userProfile.posts]
                        .find(p => p.id === moment.id) || moment as unknown as Post;
                      addToWatchHistory(fullPost);
                      handleFullscreen(fullPost);
                    }}
                    onComment={(momentId, user) => handleComment(momentId, user)}
                    onLike={(momentId) => handleLike(momentId)}
                    onDelete={(momentId) => {
                      setUserProfile(prev => ({
                        ...prev,
                        posts: prev.posts.filter(p => p.id !== momentId),
                      }));
                    }}
                    likedMoments={likedPosts}
                    isHomePage={false}
                    isMomentsPage={true}
                  />
                </div>
              )}

              {/* Render non-moment posts as regular cards */}
              {[...viewerReactedPosts, ...userProfile.posts]
                .filter(post => post.type !== 'moment').map((post) => normalizeContentItem<Post>(post)).map((post) => (
                <Card key={post.id} className={`p-3 md:p-4 slide-up ${post.isReacted ? 'border-green-200 bg-green-50/50' : ''}`}>
                  <CardHeader className="flex flex-row items-center justify-between p-0 mb-3 md:mb-4">
                    <div className="flex items-center gap-2 md:gap-3">
                      {post.isReacted ? (
                        <Repeat className="h-4 w-4 md:h-5 md:w-5 text-green-600" />
                      ) : (
                        <MessageSquare className="h-4 w-4 md:h-5 md:w-5 text-primary" />
                      )}
                      <div>
                        <CardTitle className={`text-sm md:text-base capitalize ${post.isReacted ? 'text-green-600' : ''}`}>
                          {post.isReacted ? 'Reacted Post' : post.type}
                        </CardTitle>
                        <p className="text-xs md:text-sm text-muted-foreground">
                          {post.time}
                          {post.isReacted && ` • Reacted to ${(post as any).originalAuthor}'s post`}
                        </p>
                      </div>
                    </div>

                    {/* 3-dot menu — every item (post, video, story, thought) is manageable here */}
                    <StandardPostMenu
                      postId={post.id}
                      postUserId={ownerIdOf(post) || (typeof post.user === 'string' ? post.user : String((post as { creator?: unknown }).creator || ''))}
                      postOwnerId={ownerIdOf(post)}
                      currentUserId={myAccountId()}
                      contentType={String(post.type || (post as { mediaType?: string }).mediaType || 'post')}
                      isProfilePage={true}
                      onReport={handleReport}
                      onDelete={() => handleDeletePost(post.id)}
                      onDeleted={(id) => {
                        setUserProfile(prev => ({
                          ...prev,
                          posts: prev.posts.filter(p => p.id !== id)
                        }));
                      }}
                      onEdit={() => handleEditPost(post)}
                      onHide={() => handleHide(post.id)}
                      onHidden={(id) => {
                        setUserProfile(prev => ({
                          ...prev,
                          posts: prev.posts.map(p => (p.id === id ? ({ ...p, visibility: 'private' } as Post) : p)),
                        }));
                      }}
                      onShare={handleMenuShare}
                      onCopyLink={handleCopyLink}
                    />
                  </CardHeader>
                  <CardContent className="p-0">
                    <p className="mb-3 md:mb-4 text-sm md:text-base">{post.content}</p>

                    {(post.media || post.image || post.thumbnail) && (
                      post.mediaType === 'video' || post.type === 'video' ? (
                        post.videoUrl || post.video ? (
                          <video
                            src={post.videoUrl || post.video}
                            poster={post.thumbnail || post.image || post.media}
                            className="w-full rounded-lg mb-3 md:mb-4 object-contain bg-black max-h-60 md:max-h-80 cursor-pointer"
                            muted
                            loop
                            playsInline
                            preload="metadata"
                            onClick={() => handleFullscreen(post)}
                            onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                            onMouseLeave={(e) => e.currentTarget.pause()}
                          />
                        ) : (
                          <img
                            src={post.thumbnail || post.image || post.media}
                            alt="Post media"
                            loading="lazy"
                            className="w-full rounded-lg mb-3 md:mb-4 object-contain bg-black max-h-60 md:max-h-80 cursor-pointer"
                            onClick={() => handleFullscreen(post)}
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              // Retry once with a cache-bust before hiding broken art.
                              const attempts = Number(target.dataset.mediaRetry || '0');
                              const base = target.getAttribute('src') || '';
                              if (base && attempts < 1) {
                                target.dataset.mediaRetry = String(attempts + 1);
                                target.src = `${base}${base.includes('?') ? '&' : '?'}retry=${attempts + 1}`;
                              } else {
                                target.style.display = 'none';
                              }
                            }}
                          />
                        )
                      ) : (
                        <img
                          src={post.thumbnail || post.image || post.media}
                          alt="Post media"
                          loading="lazy"
                          className="w-full rounded-lg mb-3 md:mb-4 object-contain bg-black max-h-60 md:max-h-80 cursor-pointer"
                          onClick={() => handleFullscreen(post)}
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                          }}
                        />
                      )
                    )}
                    <div className="flex items-center gap-1 md:gap-2 flex-wrap">
                      {post.isReacted ? (
                        <>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="flex items-center gap-1 text-green-600 text-xs md:text-sm"
                            onClick={() => {
                              // Find the original post ID and remove reaction
                              const originalPostId = (post as any).originalPostId || (post as any).originalThoughtId;
                              if (originalPostId) {
                                // Remove from user reacted posts
                                setUserReactedPosts(prev => prev.filter(p => (p as any).originalPostId !== originalPostId && (p as any).originalThoughtId !== originalPostId));
                                // Update localStorage
                                const updatedReactedPosts = userReactedPosts.filter(p => (p as any).originalPostId !== originalPostId && (p as any).originalThoughtId !== originalPostId);
                                localStorage.setItem('userReactedThoughts', JSON.stringify(updatedReactedPosts));
                                showSuccess('Reaction removed');
                              }
                            }}
                          >
                            <Repeat className="h-3 w-3 md:h-4 md:w-4 fill-current" />
                            <span className="font-medium">{(post as any).reacts || 0}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="flex items-center gap-1 text-xs md:text-sm"
                            onClick={() => handleComment(post.id, post.user)}
                          >
                            <MessageCircle className="h-3 w-3 md:h-4 md:w-4" /> <span className="font-medium">{toCount(post.comments)}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="flex items-center gap-1 text-xs md:text-sm"
                            onClick={() => handleShare(post)}
                          >
                            <Share2 className="h-3 w-3 md:h-4 md:w-4" /> <span className="font-medium hidden sm:inline">{toCount(post.shares)}</span><span className="font-medium sm:hidden">{toCount(post.shares) > 0 ? toCount(post.shares) : ''}</span>
                          </Button>
                        </>
                      ) : post.type === 'thought' ? (
                        <VotingButtons
                          thoughtId={post.id}
                          upvotesCount={toCount((post as any).upvotes_count)}
                          downvotesCount={toCount((post as any).downvotes_count)}
                          likesCount={toCount(post.likes)}
                          userVote={post.user_vote || null}
                          userHasLiked={likedPosts.has(post.id)}
                          onVote={handleVote}
                          onLike={(thoughtId) => {
                            handleLike(thoughtId);
                          }}
                          disabled={voting === post.id || liking === post.id}
                          size="sm"
                        />
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={`flex items-center gap-1 text-xs md:text-sm ${likedPosts.has(post.id) ? 'text-red-500' : ''}`}
                          onClick={() => handleLike(post.id)}
                        >
                          <ThumbsUp className={`h-3 w-3 md:h-4 md:w-4 ${likedPosts.has(post.id) ? 'fill-current' : ''}`} />
                          <span className="font-medium">{toCount(postLikes[post.id] ?? post.likes)}</span>
                        </Button>
                      )}
                      {!post.isReacted && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="flex items-center gap-1 text-xs md:text-sm"
                            onClick={() => handleComment(post.id, post.user)}
                          >
                            <MessageCircle className="h-3 w-3 md:h-4 md:w-4" /> <span className="font-medium">{post.comments}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="flex items-center gap-1 text-xs md:text-sm"
                            onClick={() => handleShare(post)}
                          >
                            <Share2 className="h-3 w-3 md:h-4 md:w-4" /> <span className="font-medium hidden sm:inline">{post.shares}</span><span className="font-medium sm:hidden">{post.shares > 0 ? post.shares : ''}</span>
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`flex items-center gap-1 text-xs md:text-sm ${savedPosts.has(post.id) ? 'text-blue-500' : ''}`}
                        onClick={() => handleSave(post.id)}
                      >
                        <Bookmark className={`h-3 w-3 md:h-4 md:w-4 ${savedPosts.has(post.id) ? 'fill-current' : ''}`} />
                      </Button>
                      {post.media && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex items-center gap-1 text-xs md:text-sm"
                          onClick={() => {
                            handleFullscreen(post);
                            addToWatchHistory(post);
                          }}
                          title="View in fullscreen"
                        >
                          <Maximize className="h-3 w-3 md:h-4 md:w-4" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </>
          ) : (
            <p className="text-center text-muted-foreground">No posts yet. Share something!</p>
          )}
        </TabsContent>
        <TabsContent value="stories" className="mt-6 space-y-4">
          {userProfile.posts.filter(p => p.type === 'story' || (p as { type?: string }).type === 'text-story').length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {userProfile.posts.filter(p => p.type === 'story' || (p as { type?: string }).type === 'text-story').map((story) => (
                <Card key={story.id} className="overflow-hidden">
                  <div className="relative aspect-[9/16] bg-black">
                    {story.type !== 'text-story' && (story.thumbnail || story.image || story.media) ? (
                      <img
                        src={story.thumbnail || story.image || story.media}
                        alt={story.content || 'Story'}
                        loading="lazy"
                        className="w-full h-full object-cover cursor-pointer"
                        onClick={() => handleFullscreen(story)}
                        onError={hideBrokenImg}
                      />
                    ) : (
                      <div
                        className="w-full h-full flex items-center justify-center p-4 text-center cursor-pointer"
                        onClick={() => handleFullscreen(story)}
                      >
                        <p className="text-white text-sm line-clamp-6">{story.content || 'Story'}</p>
                      </div>
                    )}
                    <div
                      className="absolute top-2 right-2 rounded-full bg-black/60 backdrop-blur-sm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <StandardPostMenu
                        postId={story.id}
                        postUserId={ownerIdOf(story) || (typeof story.user === 'string' ? story.user : '')}
                        postOwnerId={ownerIdOf(story)}
                        currentUserId={myAccountId()}
                        contentType="story"
                        isProfilePage={true}
                        onReport={handleReport}
                        onDelete={() => handleDeletePost(story.id)}
                        onDeleted={(id) => {
                          setUserProfile(prev => ({
                            ...prev,
                            posts: prev.posts.filter(p => p.id !== id)
                          }));
                        }}
                        onEdit={() => handleEditPost(story)}
                        onHide={() => handleHide(story.id)}
                        onHidden={(id) => {
                          setUserProfile(prev => ({
                            ...prev,
                            posts: prev.posts.map(p => (p.id === id ? ({ ...p, visibility: 'private' } as Post) : p)),
                          }));
                        }}
                        onShare={handleMenuShare}
                        onCopyLink={handleCopyLink}
                        className="text-white hover:text-white"
                      />
                    </div>
                  </div>
                  <CardContent className="p-3">
                    <p className="text-sm font-medium line-clamp-2 leading-tight mb-1">{story.content || 'Story'}</p>
                    <p className="text-xs text-muted-foreground mb-2">{story.time || ''}{typeof story.views !== 'undefined' ? ` • ${story.views} views` : ''}</p>
                    {isSelfView && (
                      <div className="flex gap-2 flex-wrap">
                        {story.type !== 'text-story' && story.thumbnail ? (
                          <Button variant="outline" size="sm" className="text-xs" onClick={() => handleRemoveStoryCover(story.id)}>
                            <X className="h-3 w-3 mr-1" /> Remove cover
                          </Button>
                        ) : null}
                        <Button variant="destructive" size="sm" className="text-xs" onClick={() => handleDeletePost(story.id)}>
                          <Trash className="h-3 w-3 mr-1" /> Delete story
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Camera className="h-10 w-10 mx-auto mb-2 opacity-20" />
              <p>No stories yet — they appear here for 24 hours after you post</p>
            </div>
          )}
        </TabsContent>

        <TabsContent value="moments" className="mt-6">
          <Moments
            moments={userProfile.posts.filter(post => post.type === 'moment' && isVideoItem(post as any)).map(toMomentView)}
            onFullscreen={(moment) => {
              const fullPost = userProfile.posts.find(p => p.id === moment.id) || moment as unknown as Post;
              addToWatchHistory(fullPost);
              handleFullscreen(fullPost);
            }}
            onComment={(momentId, user) => handleComment(momentId, user)}
            onLike={(momentId) => handleLike(momentId)}
            likedMoments={likedPosts}
            isHomePage={false}
            isMomentsPage={true}
          />
        </TabsContent>

        <TabsContent value="videos" className="mt-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {userProfile.posts.filter(post => (post.type === 'video' || (post.mediaType === 'video' && post.type !== 'moment'))).map((post) => normalizeContentItem<Post>(post)).map((video) => (
              <Card key={video.id} className="overflow-hidden cursor-pointer hover:shadow-md transition-shadow" onClick={() => {
              addToWatchHistory(video);
              handleFullscreen(video);
            }}>
                <div className="relative aspect-video bg-black">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Play className="h-10 w-10 text-white opacity-80" />
                  </div>
                  <img
                    src={video.thumbnail || video.media}
                    alt={video.content}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-1 rounded">
                    {video.duration || 'Video'}
                  </div>
                  <div
                    className="absolute top-2 right-2 rounded-full bg-black/60 backdrop-blur-sm"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <StandardPostMenu
                      postId={video.id}
                      postUserId={ownerIdOf(video) || (typeof video.user === 'string' ? video.user : '')}
                      postOwnerId={ownerIdOf(video)}
                      currentUserId={myAccountId()}
                      contentType="video"
                      isProfilePage={true}
                      onReport={handleReport}
                      onDelete={() => handleDeletePost(video.id)}
                      onDeleted={(id) => {
                        setUserProfile(prev => ({
                          ...prev,
                          posts: prev.posts.filter(p => p.id !== id)
                        }));
                      }}
                      onEdit={() => handleEditPost(video)}
                      onHide={() => handleHide(video.id)}
                      onHidden={(id) => {
                        setUserProfile(prev => ({
                          ...prev,
                          posts: prev.posts.map(p => (p.id === id ? ({ ...p, visibility: 'private' } as Post) : p)),
                        }));
                      }}
                      onShare={handleMenuShare}
                      onCopyLink={handleCopyLink}
                      className="text-white hover:text-white"
                    />
                  </div>
                </div>
                <CardContent className="p-3">
                  <h3 className="font-semibold line-clamp-2 leading-tight mb-1">{video.content}</h3>
                  <p className="text-xs text-muted-foreground">{video.views} views • {video.time}</p>
                </CardContent>
              </Card>
            ))}
            {userProfile.posts.filter(post => (post.type === 'video' || (post.mediaType === 'video' && post.type !== 'moment'))).length === 0 && (
              <div className="col-span-full text-center py-8 text-muted-foreground">
                <Video className="h-10 w-10 mx-auto mb-2 opacity-20" />
                <p>No long-form videos yet</p>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="thoughts" className="mt-6 space-y-4">
          {[...viewerReactedPosts, ...userProfile.posts.filter(p => p.type === 'thought')].length > 0 ? (
            [...viewerReactedPosts, ...userProfile.posts.filter(p => p.type === 'thought')].map((post) => (
              <Card key={post.id} className={`p-4 slide-up ${post.isReacted ? 'border-green-200 bg-green-50/50' : ''}`}>
                <CardHeader className="flex flex-row items-center justify-between p-0 mb-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => navigateToProfile(navigate, ownerIdOf(post), typeof post.user === 'string' ? post.user : undefined, post)}
                      className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                      aria-label={`Open ${typeof post.user === 'string' ? post.user : 'author'}'s profile`}
                      title={`Open ${typeof post.user === 'string' ? post.user : 'author'}'s profile`}
                    >
                      <Avatar className="h-10 w-10 cursor-pointer">
                        {post.avatar || userProfile.avatar ? <AvatarImage src={post.avatar || userProfile.avatar} /> : null}
                        <AvatarFallback>{(userNameOf(post) || userProfile.name || 'U').substring(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                    </button>
                    <div>
                      <button
                        type="button"
                        onClick={() => navigateToProfile(navigate, ownerIdOf(post), typeof post.user === 'string' ? post.user : undefined, post)}
                        className="text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        title={`Open ${typeof post.user === 'string' ? post.user : 'author'}'s profile`}
                      >
                        <CardTitle className={`text-base ${post.isReacted ? 'text-green-600' : ''}`}>{userNameOf(post)}</CardTitle>
                      </button>
                      <p className="text-sm text-muted-foreground">
                        {post.time}
                        {post.isReacted && ` • Reacted to ${(post as any).originalAuthor}'s post`}
                      </p>
                    </div>
                  </div>
                  {!(post as { isReacted?: boolean }).isReacted && (
                    <StandardPostMenu
                      postId={post.id}
                      postUserId={ownerIdOf(post) || (typeof post.user === 'string' ? post.user : (post.user && typeof post.user === 'object' ? ((post.user as any).id || (post.user as any).username || '') : ''))}
                      postOwnerId={ownerIdOf(post)}
                      currentUserId={myAccountId()}
                      contentType="thought"
                      isProfilePage={true}
                      onReport={handleReport}
                      onDelete={() => handleDeletePost(post.id)}
                      onDeleted={(id) => {
                        setUserProfile(prev => ({
                          ...prev,
                          posts: prev.posts.filter(p => p.id !== id)
                        }));
                      }}
                      onEdit={() => handleEditPost(post)}
                      onHide={() => handleHide(post.id)}
                      onHidden={(id) => {
                        setUserProfile(prev => ({
                          ...prev,
                          posts: prev.posts.map(p => (p.id === id ? ({ ...p, visibility: 'private' } as Post) : p)),
                        }));
                      }}
                      onShare={handleMenuShare}
                      onCopyLink={handleCopyLink}
                    />
                  )}
                </CardHeader>
                <CardContent className="p-0">
                  <p className="mb-4">{post.content}</p>
                  {post.media && (
                    <div className="mb-4">
                      {post.mediaType === 'video' ? (
                        <div className="relative w-full rounded-lg overflow-hidden bg-black" style={{ aspectRatio: '9/16', maxHeight: '320px' }}>
                          <img
                            src={post.thumbnail || post.media}
                            alt="Video thumbnail"
                            className="absolute inset-0 w-full h-full object-cover"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              // Real media only: rewrite broken art, never swap in a fake image.
                              const attempts = Number(target.dataset.mediaRetry || '0');
                              const base = target.getAttribute('src') || '';
                              if (base && attempts < 1) {
                                target.dataset.mediaRetry = String(attempts + 1);
                                target.src = `${base}${base.includes('?') ? '&' : '?'}retry=${attempts + 1}`;
                              } else {
                                target.style.display = 'none';
                              }
                            }}
                          />
                          {post.videoUrl ? (
                          <video
                            ref={(el) => { if (el) videoRefs.current[post.id] = el; }}
                            src={post.videoUrl}
                            className="absolute inset-0 w-full h-full object-cover cursor-pointer"
                            muted={isMuted}
                            loop
                            playsInline
                            preload="metadata"
                            onClick={() => handleVideoPlayPause(post.id)}
                            onError={(e) => handleVideoError(post.id, e)}
                            onTimeUpdate={() => handleTimeUpdate(post.id, videoRefs.current[post.id])}
                            onLoadedMetadata={() => handleLoadedMetadata(post.id, videoRefs.current[post.id])}
                            onMouseEnter={(e) => {
                              const video = e.target as HTMLVideoElement;
                              video.play().catch(() => {});
                            }}
                            onMouseLeave={(e) => {
                              const video = e.target as HTMLVideoElement;
                              video.pause();
                            }}
                          />
                          ) : null}
                          {isLoading[post.id] && (
                            <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                              <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white"></div>
                            </div>
                          )}
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            {!playingVideos.has(post.id) && (
                              <div className="bg-black/50 backdrop-blur-sm rounded-full p-2">
                                <Play className="h-4 w-4 text-white" />
                              </div>
                            )}
                          </div>
                          <div className="absolute top-2 right-2 bg-black/60 backdrop-blur-sm rounded-full px-2 py-1">
                            <Video className="h-3 w-3 text-white" />
                          </div>
                          {/* Progress Bar — hover/drag shows a small preview window */}
                          {playingVideos.has(post.id) && (
                            <div
                              className="absolute bottom-2 left-2 right-2 z-20"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <VideoSeekBar
                                videoRef={{ get current() { return videoRefs.current[post.id] || null; } } as React.RefObject<HTMLVideoElement | null>}
                                currentTime={currentTime[post.id] || 0}
                                duration={videoDuration[post.id] || 0}
                                onSeek={(t) => {
                                  const v = videoRefs.current[post.id];
                                  if (!v || !Number.isFinite(t)) return;
                                  try {
                                    v.currentTime = Math.max(0, t);
                                  } catch {
                                    /* ignore */
                                  }
                                  setCurrentTime(prev => ({ ...prev, [post.id]: t }));
                                }}
                                compact
                              />
                            </div>
                          )}
                        </div>
                      ) : (
                        <img
                          src={post.media}
                          alt="Post media"
                          loading="lazy"
                          className="w-full rounded-lg object-contain bg-black max-h-80 cursor-pointer"
                          onClick={() => handleFullscreen(post)}
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            // Real media only: hide broken art, never swap in a fake image.
                            target.style.display = 'none';
                          }}
                        />
                      )}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {post.isReacted ? (
                      <>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="flex items-center gap-1 text-green-600"
                          onClick={() => {
                            // Find the original thought ID and remove reaction
                            const originalThoughtId = (post as any).originalThoughtId;
                            if (originalThoughtId) {
                              // Remove from user reacted posts
                              setUserReactedPosts(prev => prev.filter(p => (p as any).originalThoughtId !== originalThoughtId));
                              // Update localStorage
                              const updatedReactedPosts = userReactedPosts.filter(p => (p as any).originalThoughtId !== originalThoughtId);
                              localStorage.setItem('userReactedThoughts', JSON.stringify(updatedReactedPosts));
                              showSuccess('Reaction removed');
                            }
                          }}
                        >
                          <Repeat className="h-4 w-4 fill-current" />
                          <span className="font-medium">{(post as any).reacts || 0}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex items-center gap-1"
                          onClick={() => handleComment(post.id, (post as any).user || (post as any).username || 'Unknown')}
                          aria-label={`Comment on this thought (${post.comments} comments)`}
                          title="View comments"
                        >
                          <MessageCircle className="h-4 w-4" /> <span className="font-medium">{toCount(post.comments)}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex items-center gap-1"
                          onClick={() => handleShare(post as unknown as Post)}
                          aria-label={`Share this thought (${toCount(post.shares)} shares)`}
                          title="Share this thought"
                        >
                          <Share2 className="h-4 w-4" /> <span className="font-medium">{toCount(post.shares)}</span>
                        </Button>
                      </>
                    ) : (
                      <VotingButtons
                        thoughtId={post.id}
                        upvotesCount={toCount((post as any).upvotes_count)}
                        downvotesCount={toCount((post as any).downvotes_count)}
                        likesCount={toCount(post.likes)}
                        userVote={post.user_vote || null}
                        userHasLiked={likedPosts.has(post.id)}
                        onVote={handleVote}
                        onLike={(thoughtId) => {
                          handleLike(thoughtId);
                        }}
                        disabled={voting === post.id || liking === post.id}
                        size="sm"
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <MessageSquare className="h-10 w-10 mx-auto mb-2 opacity-20" />
              <p>No thoughts yet</p>
            </div>
          )}
        </TabsContent>

        {isSelfView && (
          <TabsContent value="history" className="mt-6 space-y-4">
            <WatchHistorySection
              watchHistory={watchHistory}
              savedPosts={savedPosts}
              onClearHistory={() => {
                setWatchHistory([]);
                localStorage.removeItem('watchHistory');
                showSuccess('Watch history cleared');
              }}
              onRemoveItem={(index) => {
                setWatchHistory(prev => prev.filter((_, i) => i !== index));
              }}
              onFullscreen={handleFullscreen}
              onSave={handleSave}
            />
          </TabsContent>
        )}

        {isSelfView && (
          <TabsContent value="saved" className="mt-6 space-y-4">
          {/* All Saved Content */}
          <Card className="p-6">
            <CardTitle className="flex items-center gap-2 mb-4">
              <Bookmark className="h-5 w-5" />
              Saved Content
            </CardTitle>
            {allSavedContent.length > 0 ? (
              <div className="space-y-4">
                {allSavedContent.map((post) => (
                  <Card key={post.id} className="p-4">
                    <div className="flex items-center gap-3 mb-3">
                      {post.type === 'moment' ? (
                        <Video className="h-5 w-5 text-primary" />
                      ) : post.type === 'thought' ? (
                        <MessageSquare className="h-5 w-5 text-primary" />
                      ) : post.type === 'story' ? (
                        <Bookmark className="h-5 w-5 text-blue-500" />
                      ) : post.mediaType === 'video' ? (
                        <Video className="h-5 w-5 text-primary" />
                      ) : (
                        <MessageSquare className="h-5 w-5 text-primary" />
                      )}
                      <div className="flex-1">
                        <p className="font-medium">{post.content || post.title || post.caption || 'Saved content'}</p>
                        <p className="text-sm text-muted-foreground">
                          {post.user || post.creator || 'Unknown'} • {post.time || 'Recently'}
                          {post.type === 'story' && ' • Story'}
                        </p>
                        {post.views && (
                          <div className="flex items-center gap-1 mt-1">
                            <Eye className="h-3 w-3 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground">{post.views} views</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {(post.media || post.thumbnail || post.image) && (
                      <div className="mb-3">
                        {(post.mediaType === 'video' || post.type === 'video') && (post.videoUrl || post.video) ? (
                          <video
                            src={post.videoUrl || post.video}
                            className="w-full rounded-lg object-contain bg-black max-h-60 cursor-pointer"
                            muted
                            loop
                            playsInline
                            preload="metadata"
                            onClick={() => handleFullscreen(post)}
                            onMouseEnter={(e) => e.currentTarget.play().catch(() => {})}
                            onMouseLeave={(e) => e.currentTarget.pause()}
                            onError={(e) => {
                              // One dropped range request must not blank the
                              // saved item — retry with a cache-bust.
                              const v = e.currentTarget;
                              const attempts = Number(v.dataset.savedRetry || '0');
                              const base = post.videoUrl || post.video || '';
                              if (base && attempts < 2) {
                                v.dataset.savedRetry = String(attempts + 1);
                                v.src = `${base}${base.includes('?') ? '&' : '?'}retry=${attempts + 1}`;
                                v.load();
                              }
                            }}
                          />
                        ) : (
                          <img
                            src={post.media || post.thumbnail || post.image}
                            alt="Saved content"
                            loading="lazy"
                            className="w-full rounded-lg object-contain bg-black max-h-60 cursor-pointer"
                            onClick={() => handleFullscreen(post)}
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              // Real media only: rewrite broken art, never swap in a fake image.
                              const attempts = Number(target.dataset.mediaRetry || '0');
                              const base = target.getAttribute('src') || '';
                              if (base && attempts < 1) {
                                target.dataset.mediaRetry = String(attempts + 1);
                                target.src = `${base}${base.includes('?') ? '&' : '?'}retry=${attempts + 1}`;
                              } else {
                                target.style.display = 'none';
                              }
                            }}
                          />
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`flex items-center gap-1 ${savedPosts.has(post.id) ? 'text-blue-500' : ''}`}
                        onClick={() => handleSave(post.id)}
                      >
                        <Bookmark className={`h-4 w-4 ${savedPosts.has(post.id) ? 'fill-current' : ''}`} />
                      </Button>
                      {post.likes && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex items-center gap-1"
                          onClick={() => handleFullscreen(post as unknown as Post)}
                          aria-label={`View post with ${post.likes} likes`}
                          title="Open post details"
                        >
                          <ThumbsUp className="h-4 w-4" /> {toCount(post.likes)}
                        </Button>
                      )}
                      {post.comments && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="flex items-center gap-1"
                          onClick={() => handleComment(post.id, (post as any).user || (post as any).creator || 'Unknown')}
                          aria-label={`View ${post.comments} comments`}
                          title="View comments"
                        >
                          <MessageCircle className="h-4 w-4" /> {post.comments}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleFullscreen(post)}
                      >
                        <Maximize className="h-4 w-4" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center py-12">
                <Bookmark className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-muted-foreground text-lg mb-2">No saved content yet</p>
                <p className="text-muted-foreground text-sm">Start saving posts and stories you love to see them here!</p>
              </div>
            )}
          </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* Report Profile Modal */}
      {showReportProfile && (
        <ReportModal
          isOpen={showReportProfile}
          onClose={() => setShowReportProfile(false)}
          contentId={resolvedTargetId || routeTarget}
          contentType="profile"
        />
      )}

      {/* Edit Profile Modal */}
      <EditProfileModal
        isOpen={showEditProfileModal}
        onClose={() => setShowEditProfileModal(false)}
        currentProfile={{
          name: userProfile.name,
          username: userProfile.username.replace('@', ''),
          bio: userProfile.bio,
          avatar: userProfile.avatar,
        }}
        onSave={handleSaveProfile}
      />

      {/* Edit Post Modal */}
      {currentEditingPost && (
        <EditPostModal
          isOpen={showEditPostModal}
          onClose={() => setShowEditPostModal(false)}
          currentPost={{
            id: currentEditingPost.id,
            content: currentEditingPost.content || '',
            type: currentEditingPost.type || 'post',
            image: currentEditingPost.media || currentEditingPost.image
          }}
          onSave={handleSavePost}
        />
      )}

      {/* Comment Section */}
      <CommentSection
        isOpen={showCommentSection}
        onClose={() => setShowCommentSection(false)}
        postId={currentPostId}
        postUser={currentPostUser}
        showPinOptions={true}
      />

      {/* Report Modal */}
      {reportPostId && (
        <ReportModal
          isOpen={!!reportPostId}
          onClose={() => setReportPostId(null)}
          contentId={reportPostId}
          contentType={reportPostType}
        />
      )}

      {/* Followers / Following sheets */}
      <FollowListModal
        open={showFollowers}
        onOpenChange={setShowFollowers}
        title={`Followers · ${followerList.length || userProfile.followers || 0}`}
        list={followerList}
        restricted={restrictedFollowers}
        loading={listsLoading}
        emptyHint="No followers yet. Share your profile to grow."
      />
      <FollowListModal
        open={showFollowing}
        onOpenChange={setShowFollowing}
        title={`Following · ${followingList.length || userProfile.following || 0}`}
        list={followingList}
        restricted={restrictedFollowing}
        loading={listsLoading}
        emptyHint="Not following anyone yet."
      />

      {/* Fullscreen Viewer */}
      {fullscreenContent && (
        <FullscreenViewer
          content={fullscreenContent}
          type={fullscreenContent.type || (fullscreenContent.mediaType === 'video' ? 'video' : fullscreenContent.mediaType === 'image' ? 'image' : 'live')}
          onClose={closeFullscreen}
          onComment={(videoId, creator) => handleComment(videoId, creator)}
          onShare={handleShare}
        />
      )}

      {/* Delete All Data Confirmation Dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <Card className="w-full max-w-md mx-4 p-6">
            <CardHeader className="p-0 mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                  <AlertTriangle className="h-6 w-6 text-red-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">Delete All Your Data</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">This action cannot be undone</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <p className="text-sm mb-4">
                This will permanently delete all your posts, thoughts, stories, moments, profile data, 
                and saved content from Equyvo. Your account will remain active but all your content will be removed.
              </p>
              <div className="flex gap-3 justify-end">
                <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={confirmDeleteAllData}>
                  <Trash className="h-4 w-4 mr-2" />
                  Delete Everything
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};

export default ProfilePage;
