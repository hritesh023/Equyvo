"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThumbsUp, MessageCircle, Share2, Plus, Play, MoreHorizontal, Bookmark, X, Sparkles, Users } from 'lucide-react';
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import ChatSidebar from '@/components/ChatSidebar';
import StoryViewer from '@/components/StoryViewer';
import Moments from '@/components/Moments';
import FullscreenViewer from '@/components/FullscreenViewer';
import CommentSection from '@/components/CommentSection';
import { showSuccess } from '@/utils/toast';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useNavigate } from 'react-router-dom';
import ForYouFeed from '@/components/ForYouFeed';
import FollowingFeed from '@/components/FollowingFeed';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ReportModal from '@/components/ReportModal';
import { fetchPosts, fetchMoments, fetchStories } from '@/lib/data';
import { getThoughts } from '@/lib/thoughts';
import { allowedForSurface, creatorOf, getFollowing, hideFromMyView } from '@/lib/feed-store';
import { getAuthenticatedUser, getStoredUser } from '@/lib/auth';
import { isOwnContent } from '@/utils/ownership';
import { deleteContent } from '@/utils/delete';
import { FullscreenContent, Post, Story } from '@/types';
import { useIsMobile } from '@/hooks/use-mobile';
import { useIsTablet } from '@/hooks/use-tablet';
import { navigateToProfile } from '@/utils/profile-navigation';
import { brainFeedSuggest, brainLearn } from '@/lib/brain';
import InFeedAdGate from '@/components/ads/InFeedAdGate';

const HomePage = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const showChatsTab = isMobile || isTablet;
  const [showStoryViewer, setShowStoryViewer] = useState(false);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [savedStories, setSavedStories] = useState<Set<string>>(new Set());
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [commentedPosts, setCommentedPosts] = useState<Set<string>>(new Set());
  const [sharedPosts, setSharedPosts] = useState<Set<string>>(new Set());
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [fullscreenContent, setFullscreenContent] = useState<FullscreenContent | null>(null);
  const [fullscreenType, setFullscreenType] = useState<'post' | 'live' | 'video' | 'moment' | 'image' | 'thought' | 'reacted' | 'story'>('moment');
  const [likedMoments, setLikedMoments] = useState<Set<string>>(new Set());
  const [commentSectionOpen, setCommentSectionOpen] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedPostUser, setSelectedPostUser] = useState<string>('');
  const [followedCreators, setFollowedCreators] = useState<Set<string>>(new Set());
  const [userHasStories, setUserHasStories] = useState(false);
  const [activeTab, setActiveTab] = useState<'foryou' | 'following' | 'chats'>('foryou');
  useEffect(() => {
    if (!showChatsTab && activeTab === 'chats') {
      setActiveTab('foryou');
    }
  }, [showChatsTab, activeTab]);
  // Persisted follow graph — Following tab filters on this (was hardcoded []).
  const [followingAccounts, setFollowingAccounts] = useState<string[]>(() => {
    try { return getFollowing(); } catch { return []; }
  });
  useEffect(() => {
    const sync = () => {
      try { setFollowingAccounts(getFollowing()); } catch { /* ignore */ }
    };
    window.addEventListener('followChanged', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('followChanged', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const [reportModalOpen, setReportModalOpen] = useState<string | null>(null);
  const [userAvatar, setUserAvatar] = useState<string>('');
  const [liveNotification, setLiveNotification] = useState<{ title: string; user: string; thumbnail: string } | null>(null);
  useEffect(() => {
    const savedProfile = localStorage.getItem('userProfile');
    if (savedProfile) {
      const parsed = JSON.parse(savedProfile);
      if (parsed.avatar) setUserAvatar(parsed.avatar);
    }
    const handleProfileUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.avatar) setUserAvatar(detail.avatar);
    };
    window.addEventListener('profileUpdated', handleProfileUpdate);
    return () => window.removeEventListener('profileUpdated', handleProfileUpdate);
  }, []);


  
  // Real posts data from the API
  const [enhancedPosts, setEnhancedPosts] = useState<Post[]>([]);
  const [isLoadingPosts, setIsLoadingPosts] = useState(true);
  const deletedPostIds = useRef<Set<string>>(new Set());

  const currentUserId = (() => {
    const u = getStoredUser();
    return u?.username || u?.email?.split('@')[0] || '';
  })();

  // Brain-powered personalised feed suggestions (learned from engagement).
  const [brainInterests, setBrainInterests] = useState<string[]>(['technology', 'nature', 'lifestyle', 'AI']);
  const [engagementLog, setEngagementLog] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const taught = engagementLog;
    brainFeedSuggest(currentUserId || 'anonymous', taught.slice(-12)).then((suggestions) => {
      if (cancelled) return;
      if (suggestions.length > 0) {
        setBrainInterests(prev => Array.from(new Set([...prev, ...suggestions])).slice(0, 10));
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagementLog.length]);

  const teachBrain = (label: string, opts?: { feedback?: number; response?: string }) => {
    if (!label) return;
    setEngagementLog(prev => [...prev.slice(-15), label]);
    brainLearn({
      query: label,
      response: opts?.response,
      feedback: opts?.feedback,
      sessionId: currentUserId || 'anonymous',
      source: 'equivo-feed',
      routeType: 'general_chat',
    });
  };

  // Unified ForYou feed: posts + photos + videos + moments + thoughts.
  // Strict type routing keeps stories/live out of this surface; the Moments
  // rail below shows moment-type items in vertical cards.
  useEffect(() => {
    const loadPosts = async () => {
      try {
        setIsLoadingPosts(true);
        const user = await getAuthenticatedUser();
        const [posts, moments] = await Promise.all([
          fetchPosts(user?.id).catch(() => []),
          fetchMoments(30).catch(() => []),
        ]);
        const thoughtsRes = await getThoughts(30, 0).catch(() => ({ data: [] as never[] }));
        const thoughts = ((thoughtsRes as { data: any[] }).data || []).map((t: any) => {
          const mediaArr = Array.isArray(t.media) ? t.media : [];
          const firstMedia = mediaArr[0] as { type?: string; url?: string; thumbnail?: string } | undefined;
          const videoUrl = firstMedia?.type === 'video' ? firstMedia.url || '' : (t.videoUrl || '');
          const image = firstMedia && firstMedia.type !== 'video' ? firstMedia.url || firstMedia.thumbnail || '' : (t.image || t.image_url || t.thumbnail || '');
          return {
            id: t.id,
            user: t.user?.username || t.creator || t.user_id || 'Unknown',
            avatar: t.user?.avatar_url || t.avatar || '',
            time: t.created_at ? new Date(t.created_at).toLocaleString() : (t.time || 'just now'),
            content: t.content || '',
            image,
            thumbnail: firstMedia?.thumbnail || image,
            media: firstMedia?.url || image,
            videoUrl,
            mediaType: videoUrl ? 'video' : (image ? 'image' : 'text'),
            likes: t.likes_count ?? t.likes ?? 0,
            reacts: t.reacts_count ?? t.reacts ?? 0,
            comments: t.comments_count ?? t.comments ?? 0,
            shares: t.shares_count ?? t.shares ?? 0,
            type: 'thought',
            tags: t.tags || [],
            categories: t.categories || [],
            upvotes_count: t.upvotes_count,
            downvotes_count: t.downvotes_count,
            user_vote: t.user_vote,
            createdAt: t.created_at || t.createdAt,
          };
        });
        const momentPosts = (moments as any[]).map((m: any) => ({
          ...m,
          type: 'moment',
          user: m.user || m.creator || 'Unknown',
        }));
        const merged = [...(posts as any[]), ...momentPosts, ...thoughts]
          .filter((p: any) => allowedForSurface(String(p.type || 'post'), 'foryou'))
          .filter((post: any) => !deletedPostIds.current.has(post.id))
          .sort((a: any, b: any) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return tb - ta;
          });
        setEnhancedPosts(merged as Post[]);
      } catch {
        setEnhancedPosts([]);
      } finally {
        setIsLoadingPosts(false);
      }
    };

    loadPosts();

    const handlePostCreated = () => { loadPosts(); };
    window.addEventListener('userPostCreated', handlePostCreated);
    window.addEventListener('feedRefresh', handlePostCreated);
    window.addEventListener('momentCreated', handlePostCreated);
    window.addEventListener('thoughtCreated', handlePostCreated);
    return () => {
      window.removeEventListener('userPostCreated', handlePostCreated);
      window.removeEventListener('feedRefresh', handlePostCreated);
      window.removeEventListener('momentCreated', handlePostCreated);
      window.removeEventListener('thoughtCreated', handlePostCreated);
    };
  }, []);

  // Check if user has uploaded stories (simulated for demo)
  useEffect(() => {
    // In a real app, this would check against a database or context
    // For demo purposes, we'll simulate that the user has no stories initially
    // You can change this to true to test the behavior when user has stories
    const checkUserStories = () => {
      // Check localStorage or context for user stories
      const userStories = localStorage.getItem('userUploadedStories');
      setUserHasStories(!!userStories && JSON.parse(userStories).length > 0);
    };

    checkUserStories();
    
    // Listen for story uploads from other components
    const handleStoryUpload = (event: CustomEvent) => {
      setUserHasStories(true);
      // Store in localStorage for persistence
      localStorage.setItem('userUploadedStories', JSON.stringify(event.detail));
    };

    window.addEventListener('storyUploaded', handleStoryUpload as EventListener);
    
    return () => {
      window.removeEventListener('storyUploaded', handleStoryUpload as EventListener);
    };
  }, []);

  // Real stories data from mock data
  const [stories, setStories] = useState<Story[]>([]);
  const [isLoadingStories, setIsLoadingStories] = useState(true);

  // Fetch stories + refresh live when a story is uploaded
  useEffect(() => {
    const loadStories = async () => {
      try {
        setIsLoadingStories(true);
        const stories = await fetchStories();
        setStories(stories);
      } catch {
        setStories([]);
      } finally {
        setIsLoadingStories(false);
      }
    };

    loadStories();
    const refresh = () => loadStories();
    window.addEventListener('userPostCreated', refresh);
    window.addEventListener('storyUploaded', refresh);
    return () => {
      window.removeEventListener('userPostCreated', refresh);
      window.removeEventListener('storyUploaded', refresh);
    };
  }, []);

  // Real moments data from mock data
  const [moments, setMoments] = useState<any[]>([]);
  const [isLoadingMoments, setIsLoadingMoments] = useState(true);

  // Fetch moments + refresh live when a moment is uploaded
  useEffect(() => {
    const loadMoments = async () => {
      try {
        setIsLoadingMoments(true);
        const items = await fetchMoments();
        // Strict routing: only moment-type items in the Moments rail.
        setMoments(
          (items as any[]).filter((m: any) =>
            allowedForSurface(String((m as any).type || 'moment'), 'moments'),
          ),
        );
      } catch {
        setMoments([]);
      } finally {
        setIsLoadingMoments(false);
      }
    };

    loadMoments();
    const refresh = () => loadMoments();
    window.addEventListener('userPostCreated', refresh);
    window.addEventListener('momentCreated', refresh);
    window.addEventListener('feedRefresh', refresh);
    return () => {
      window.removeEventListener('userPostCreated', refresh);
      window.removeEventListener('momentCreated', refresh);
      window.removeEventListener('feedRefresh', refresh);
    };
  }, []);

  // Check for active live stream and listen for live notifications
  useEffect(() => {
    const activeLive = localStorage.getItem('equyvo_active_live');
    if (activeLive) {
      try {
        const liveData = JSON.parse(activeLive);
        setLiveNotification({ title: liveData.title, user: liveData.user, thumbnail: liveData.thumbnail || '' });
      } catch {}
    }

    const handleUserWentLive = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setLiveNotification({ title: detail.title, user: detail.user, thumbnail: detail.thumbnail || '' });
    };
    const handleUserWentOffline = () => {
      setLiveNotification(null);
    };

    window.addEventListener('userWentLive', handleUserWentLive);
    window.addEventListener('userWentOffline', handleUserWentOffline);
    return () => {
      window.removeEventListener('userWentLive', handleUserWentLive);
      window.removeEventListener('userWentOffline', handleUserWentOffline);
    };
  }, []);

  // Story handlers
  const handleStoryClick = (index: number) => {
    setCurrentStoryIndex(index);
    setShowStoryViewer(true);
  };

  const handleNextStory = () => {
    if (currentStoryIndex < stories.length - 1) {
      setCurrentStoryIndex(prev => prev + 1);
    } else {
      setShowStoryViewer(false);
    }
  };

  const handlePreviousStory = () => {
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(prev => prev - 1);
    }
  };

  const handleCloseStoryViewer = () => {
    setShowStoryViewer(false);
  };

  const handleSaveStory = (storyId: string) => {
    setSavedStories(prev => {
      const newSet = new Set(prev);
      if (newSet.has(storyId)) {
        newSet.delete(storyId);
        showSuccess('🗑️ Story removed from saved');
      } else {
        newSet.add(storyId);
        showSuccess('📌 Story saved successfully!');
      }
      return newSet;
    });
  };

  const handleDeleteStory = async (storyId: string) => {
    const story = stories.find(s => s.id === storyId) as unknown as Record<string, unknown> | undefined;
    if (story && !isOwnContent(story)) {
      hideFromMyView(storyId);
      setStories(prev => prev.filter(s => s.id !== storyId));
      showSuccess("Hidden from your view. You won't see it again.");
      return;
    }
    try {
      await deleteContent({
        postId: storyId,
        contentType: 'story',
        onDeleteComplete: (id) => {
          setStories(prev => prev.filter(s => s.id !== id));
        },
      });
    } catch {
      // deleteContent already explained what happened.
    }
  };

  const handleHideStory = (storyId: string) => {
    const story = stories.find(s => s.id === storyId);
    if (story && isOwnContent(story as unknown as Record<string, unknown>)) {
      showSuccess('This is yours — you can delete it instead.');
      return;
    }
    hideFromMyView(storyId);
    setStories(prev => prev.filter(s => s.id !== storyId));
    showSuccess("Hidden from your view. You won't see it again.");
  };

  // Handle create story button click
  const handleCreateStoryClick = () => {
    if (!userHasStories) {
      navigate('/create');
    } else {
      // If user already has stories, show story viewer or do nothing
      showSuccess('You already have stories uploaded!');
    }
  };

  // Moments handlers - open TikTok-style feed
  const handleFullscreen = (content: FullscreenContent | any) => {
    navigate('/app/moments');
  };

  const handleComment = (momentId: string, user: string) => {
    setSelectedPostId(momentId);
    setSelectedPostUser(user);
    setCommentSectionOpen(true);
  };

  const handleLikeMoment = (momentId: string) => {
    setLikedMoments(prev => {
      const newSet = new Set(prev);
      if (newSet.has(momentId)) {
        newSet.delete(momentId);
        showSuccess('💔 Moment unliked');
      } else {
        newSet.add(momentId);
        showSuccess('❤️ Moment liked!');
        teachBrain(`moment:${momentId}`);
      }
      return newSet;
    });
  };

  const handleCloseFullscreen = () => {
    setFullscreenContent(null);
  };

  // Post action handlers
  const handleLikePost = (postId: string) => {
    setLikedPosts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(postId)) {
        newSet.delete(postId);
        showSuccess('💔 Post unliked');
      } else {
        newSet.add(postId);
        showSuccess('❤️ Post liked!');
        const p = enhancedPosts.find(x => x.id === postId);
        teachBrain(p?.content?.slice(0, 120) || p?.type || postId);
      }
      return newSet;
    });
    
    // Update the post likes count
    setEnhancedPosts(prev => prev.map(post => 
      post.id === postId 
        ? { ...post, likes: likedPosts.has(postId) ? post.likes - 1 : post.likes + 1 }
        : post
    ));
  };

  const handleCommentPost = (postId: string, postUser?: string) => {
    const post = enhancedPosts.find(p => p.id === postId);
    setSelectedPostId(postId);
    setSelectedPostUser(postUser || post?.user || 'Unknown');
    setCommentedPosts(prev => {
      const newSet = new Set(prev);
      newSet.add(postId);
      return newSet;
    });
    setCommentSectionOpen(true);
  };

  const handleReactPost = (postId: string) => {
    setCommentedPosts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(postId)) {
        newSet.delete(postId);
        showSuccess('💔 Post unreacted');
      } else {
        newSet.add(postId);
        showSuccess('🔄 Post reacted!');
        const p = enhancedPosts.find(x => x.id === postId);
        teachBrain(p?.content?.slice(0, 120) || p?.type || postId);
      }
      return newSet;
    });
    
    // Update the post reacts count
    setEnhancedPosts(prev => prev.map(post => 
      post.id === postId 
        ? { ...post, reacts: commentedPosts.has(postId) ? post.reacts - 1 : post.reacts + 1 }
        : post
    ));
  };

  const handleSharePost = (post: Post) => {
    setSharedPosts(prev => {
      const newSet = new Set(prev);
      newSet.add(post.id);
      return newSet;
    });
    teachBrain(post?.content?.slice(0, 120) || post?.type || post.id);
    if (navigator.share) {
      navigator.share({
        title: 'Check out this post!',
        text: 'Amazing content on Equyvo',
        url: window.location.href
      }).catch(() => {
        navigator.clipboard.writeText(window.location.href);
        showSuccess('🔗 Post link copied to clipboard!');
      });
    } else {
      navigator.clipboard.writeText(window.location.href);
      showSuccess('🔗 Post link copied to clipboard!');
    }
  };

  const handleSavePost = (postId: string) => {
    setSavedPosts(prev => {
      const newSet = new Set(prev);
      const post = enhancedPosts.find(p => p.id === postId);
      
      if (newSet.has(postId)) {
        newSet.delete(postId);
        showSuccess('🗑️ Post removed from saved');
        
        // Dispatch event to notify profile page
        window.dispatchEvent(new CustomEvent('contentUnsaved', { 
          detail: { postId, content: post } 
        }));
      } else {
        newSet.add(postId);
        showSuccess('📌 Post saved successfully!');
        teachBrain(post?.content?.slice(0, 120) || post?.type || postId, { feedback: 0.9 });
        
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
        
        // Dispatch event to notify profile page
        window.dispatchEvent(new CustomEvent('contentSaved', { 
          detail: { postId, content: post } 
        }));
      }
      return newSet;
    });
  };

  const handleFullscreenPost = (post: any) => {
    setFullscreenContent(post);
    const postType = post.type || post.contentType || 'post';
    setFullscreenType(postType === 'moment' || postType === 'video' ? postType : 'post');
  };

  const handleReportPost = (postId: string) => {
    setReportModalOpen(postId);
  };

  const handleDeletePost = (postId: string) => {
    deletedPostIds.current.add(postId);
    setEnhancedPosts(prev => prev.filter(post => post.id !== postId));
  };

  const handleAddToHistory = (post: Post) => {
    // Add to history functionality
  };

  const handleVote = (postId: string, voteType: 'upvote' | 'downvote') => {
    // Handle voting functionality
  };

  const handleFollow = (creatorId: string) => {
    setFollowedCreators(prev => {
      const newSet = new Set(prev);
      if (newSet.has(creatorId)) {
        newSet.delete(creatorId);
        showSuccess(`Unfollowed creator`);
      } else {
        newSet.add(creatorId);
        showSuccess(`Following creator!`);
      }
      return newSet;
    });
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 relative w-full">
      {/* Main Content Feed */}
      <div className="flex-1 space-y-4 lg:space-y-8 w-full lg:max-w-2xl lg:mx-0 px-4 sm:px-6 lg:px-0">

        {/* Live Notification Banner */}
        {liveNotification && (
          <div className="bg-red-600 rounded-xl p-4 flex items-center gap-3 shadow-lg">
            <div className="w-3 h-3 bg-white rounded-full animate-pulse flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm truncate">
                {liveNotification.user} is live!
              </p>
              <p className="text-white/80 text-xs truncate">
                {liveNotification.title}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="flex-shrink-0"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('viewLiveStream', { detail: liveNotification }));
              }}
            >
              <Play className="h-3 w-3 mr-1" /> Watch
            </Button>
          </div>
        )}

        {/* Story Panel (Facebook Style but Unique) */}
        <div className="relative">
          <ScrollArea className="w-full whitespace-nowrap rounded-xl">
            <div className="flex space-x-3 lg:space-x-4 p-1">
              {/* Add Story Button */}
              <div 
                className="relative w-28 h-44 lg:w-32 lg:h-52 flex-shrink-0 cursor-pointer group"
                onClick={handleCreateStoryClick}
              >
                <div className="absolute inset-0 bg-secondary rounded-xl overflow-hidden transition-transform duration-300 group-hover:scale-[1.02]">
                  <div className="h-2/3 bg-primary/20 flex items-center justify-center">
                    <Avatar className="w-12 h-12 lg:w-16 lg:h-16 border-4 border-background">
                      <AvatarImage src={userAvatar || ''} />
                      <AvatarFallback className="text-xs lg:text-sm">ME</AvatarFallback>
                    </Avatar>
                  </div>
                  <div className="h-1/3 bg-secondary flex flex-col items-center justify-start pt-4 lg:pt-6 relative">
                    <div className="absolute -top-3 lg:-top-4 w-6 h-6 lg:w-8 lg:h-8 bg-primary rounded-full flex items-center justify-center border-4 border-secondary text-white shadow-lg">
                      <Plus className="w-3 h-3 lg:w-5 lg:h-5" />
                    </div>
                    <span className="font-semibold text-xs lg:text-sm">Create Story</span>
                  </div>
                </div>
              </div>

              {/* Stories or Loading State */}
              {isLoadingStories ? (
                // Loading skeleton for stories
                Array.from({ length: 5 }).map((_, index) => (
                  <div key={`skeleton-${index}`} className="relative w-28 h-44 lg:w-32 lg:h-52 flex-shrink-0">
                    <div className="absolute inset-0 bg-gray-200 rounded-xl animate-pulse" />
                  </div>
                ))
              ) : stories.length === 0 ? (
                // Empty state for stories
                <div className="flex items-center justify-center w-full h-44 lg:h-52 text-muted-foreground">
                  <p className="text-xs lg:text-sm">No stories available yet</p>
                </div>
              ) : (
                // Real stories
                stories.map((story, index) => (
                  <div 
                    key={story.id} 
                    className="relative w-28 h-44 lg:w-32 lg:h-52 flex-shrink-0 cursor-pointer group"
                    onClick={() => handleStoryClick(index)}
                  >
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-400 to-pink-400 rounded-xl overflow-hidden">
                      <div className="absolute top-2 left-2 w-8 h-8 lg:w-10 lg:h-10 rounded-full border-2 border-primary p-0.5 z-10">
                        <Avatar 
                          className="w-full h-full border-2 border-black cursor-pointer hover:ring-2 hover:ring-white/50 transition-all duration-200"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigateToProfile(navigate, story.userId, story.user);
                          }}
                          title={`${story.user}'s Profile`}
                        >
                          <AvatarImage src={story.avatar} />
                          <AvatarFallback>{story.user.substring(0, 2)}</AvatarFallback>
                        </Avatar>
                      </div>
                      <img src={story.image} alt={story.user} className="w-full h-full object-cover" />
                      <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent">
                        <p className="text-white text-xs font-medium truncate">{story.user}</p>
                        <p className="text-white/80 text-xs">{story.time}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <ScrollBar orientation="horizontal" className="hidden" />
          </ScrollArea>
        </div>

        {/* Moments Section (Short Videos) */}
        {isLoadingMoments ? (
          <div className="flex justify-center items-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            <p className="ml-4 text-muted-foreground">Loading moments...</p>
          </div>
        ) : moments.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No moments available yet</p>
          </div>
        ) : (
          <Moments 
            moments={moments}
            onFullscreen={handleFullscreen}
            onComment={handleComment}
            onLike={handleLikeMoment}
            likedMoments={likedMoments}
            isHomePage={true}
            isMomentsPage={false}
          />
        )}

        {/* Sponsored — one calm native slot between sections. Never on video,
            never auto-playing: just a dismissible card that keeps the feed free. */}
        <InFeedAdGate placement="home-between" />

        {/* Main Feed with For You, Following, and optionally Chats tabs */}
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'foryou' | 'following' | 'chats')} className="w-full">
          <TabsList className={`grid w-full mb-4 lg:mb-6 max-w-sm sm:max-w-md mx-auto bg-muted/50 backdrop-blur-sm ${showChatsTab ? 'grid-cols-3' : 'grid-cols-2'}`}>         
            <TabsTrigger value="foryou" className="flex items-center justify-center gap-1 lg:gap-2 text-xs sm:text-sm lg:text-sm w-full data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Sparkles className="w-3 h-3 lg:w-4 lg:h-4 flex-shrink-0" />
              <span className="truncate font-medium">For You</span>
            </TabsTrigger>
            <TabsTrigger value="following" className="flex items-center justify-center gap-1 lg:gap-2 text-xs sm:text-sm lg:text-sm w-full data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Users className="w-3 h-3 lg:w-4 lg:h-4 flex-shrink-0" />
              <span className="truncate font-medium">Following</span>
            </TabsTrigger>
            {showChatsTab && (
              <TabsTrigger value="chats" className="flex items-center justify-center gap-1 lg:gap-2 text-xs sm:text-sm lg:text-sm w-full data-[state=active]:bg-background data-[state=active]:shadow-sm">
                <MessageCircle className="w-3 h-3 lg:w-4 lg:h-4 flex-shrink-0" />
                <span className="truncate font-medium">Chats</span>
              </TabsTrigger>
            )}
          </TabsList>
          
          <TabsContent value="foryou" className="mt-0">
            {isLoadingPosts ? (
              <div className="flex justify-center items-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                <p className="ml-4 text-muted-foreground">Loading posts...</p>
              </div>
            ) : enhancedPosts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">No posts available yet</p>
              </div>
            ) : (
              <ForYouFeed
                posts={enhancedPosts}
                userInterests={brainInterests}
                userCategories={['tech', 'lifestyle']}
                onLike={handleLikePost}
                onReact={handleReactPost}
                onComment={handleCommentPost}
                onShare={handleSharePost}
                onFullscreen={handleFullscreenPost}
                onReport={handleReportPost}
                onDelete={handleDeletePost}
                onAddToHistory={handleAddToHistory}
                onVote={handleVote}
                likedPosts={likedPosts}
                reactedPosts={commentedPosts}
                currentUserId={currentUserId}
                postLikes={Object.fromEntries(enhancedPosts.map(p => [p.id, p.likes]))}
                postReacts={Object.fromEntries(enhancedPosts.map(p => [p.id, p.reacts]))}
                postCommentCounts={Object.fromEntries(enhancedPosts.map(p => [p.id, p.comments]))}
              />
            )}
          </TabsContent>
          
          <TabsContent value="following" className="mt-0">
            {isLoadingPosts ? (
              <div className="flex justify-center items-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                <p className="ml-4 text-muted-foreground">Loading posts...</p>
              </div>
            ) : enhancedPosts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">No posts from people you follow</p>
              </div>
            ) : (
              <FollowingFeed
                posts={enhancedPosts}
                followingAccounts={followingAccounts}
                onLike={handleLikePost}
                onReact={handleReactPost}
                onComment={handleCommentPost}
                onShare={handleSharePost}
                onFullscreen={handleFullscreenPost}
                onReport={handleReportPost}
                onDelete={handleDeletePost}
                onAddToHistory={handleAddToHistory}
                onVote={handleVote}
                likedPosts={likedPosts}
                reactedPosts={commentedPosts}
                currentUserId={currentUserId}
                postLikes={Object.fromEntries(enhancedPosts.map(p => [p.id, p.likes]))}
                postReacts={Object.fromEntries(enhancedPosts.map(p => [p.id, p.reacts]))}
                postCommentCounts={Object.fromEntries(enhancedPosts.map(p => [p.id, p.comments]))}
              />
            )}
          </TabsContent>

          {showChatsTab && (
            <TabsContent value="chats" className="mt-0">
              <ChatSidebar isMobile={true} />
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* Chat Sidebar (Desktop Only) */}
      <div className="hidden xl:block w-80 relative">
        <ChatSidebar />
      </div>

      {/* Story Viewer */}
      {showStoryViewer && (
        <StoryViewer
          stories={stories}
          currentIndex={currentStoryIndex}
          onClose={handleCloseStoryViewer}
          onNext={handleNextStory}
          onPrevious={handlePreviousStory}
          onDeleteStory={handleDeleteStory}
          onHideStory={handleHideStory}
        />
      )}

      {/* Fullscreen Viewer */}
      {fullscreenContent && (
        <FullscreenViewer
          content={fullscreenContent}
          type={fullscreenType}
          onClose={handleCloseFullscreen}
          onFollow={handleFollow}
          followedCreators={followedCreators}
          onContentChange={(content) => setFullscreenContent(content)}
        />
      )}

      {/* Comment Section */}
      <CommentSection
        isOpen={commentSectionOpen}
        onClose={() => setCommentSectionOpen(false)}
        postId={selectedPostId || ''}
        postUser={selectedPostUser}
      />

      {/* Report Modal */}
      <ReportModal
        isOpen={reportModalOpen !== null}
        onClose={() => setReportModalOpen(null)}
        contentId={reportModalOpen || ''}
        contentType="post"
      />
    </div>
  );
};

export default HomePage;