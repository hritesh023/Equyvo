import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Flame, Video, Image, Music, Radio, Users,
  LayoutGrid as Grid, ThumbsUp, MessageCircle, Share2, MoreVertical, Hash,
  Filter, SortDesc, Clock, TrendingUp, ChevronDown, List, Monitor, Maximize2
} from 'lucide-react';
import { showSuccess } from '@/utils/toast';
import FullscreenViewer from '@/components/FullscreenViewer';
import FullscreenBrowse from '@/components/FullscreenBrowse';
import CommentSection from '@/components/CommentSection';
import SearchSuggest from '@/components/SearchSuggest';
import StandardPostMenu from '@/components/StandardPostMenu';
import ReportModal from '@/components/ReportModal';
import SaveButton from '@/components/SaveButton';
import { useNavigate } from 'react-router-dom';
import { navigateToProfile } from '@/utils/profile-navigation';
import type { FullscreenContent, ContentType } from '@/types';
import InFeedAdGate from '@/components/ads/InFeedAdGate';
import { allowedForSurface, creatorOf, imageUrlOf, timeOf, videoUrlOf } from '@/lib/feed-store';
import { fetchMoments, fetchPosts } from '@/lib/data';
import { getThoughts } from '@/lib/thoughts';
import { evalLike } from '@/lib/human-eval';

/** Image that never shows a broken-image icon: renders a neutral placeholder
 *  when the URL is empty or fails to load (production hardening). */
const DiscoverImg: React.FC<{ src?: string; alt?: string; className?: string }> = ({
  src,
  alt = 'Post',
  className = '',
}) => {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [src]);
  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center bg-muted ${className}`}>
        <Image className="w-8 h-8 text-muted-foreground/50" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
    />
  );
};

/** Production rule: media the app cannot render is never shown. An item is
 *  renderable when it is live OR has a playable video URL OR a real image URL. */
const hasRenderableMedia = (i: any): boolean => {
  if (i?.isLive || i?.live || String(i?.type || '').toLowerCase() === 'live') return true;
  const v = String(i?.videoUrl || '').trim();
  const img = String(i?.image || i?.thumbnail || '').trim();
  return Boolean(v || img);
};

/** Build the fullscreen payload for any discover card (single place, so every
 *  card — public uploads included — opens correctly with actions working). */
const toFullscreen = (
  item: any,
  likes: number | undefined,
): { content: FullscreenContent; type: ContentType } => {
  const card = String(item.contentType || '').toLowerCase();
  const isLive = card === 'live' || !!item.isLive || !!item.live;
  const isVideo = card === 'video' || !!item.videoUrl || String(item.mediaType || '').toLowerCase() === 'video';
  const type: ContentType = isLive ? 'live' : isVideo ? 'moment' : 'image';
  return {
    content: {
      id: item.id,
      type,
      contentType: isLive ? 'live' : isVideo ? 'video' : 'image',
      forcePortrait: isVideo && !isLive,
      title: item.title,
      creator: item.creator,
      creatorId: item.creatorId || `user-${item.creator}`,
      image: item.image,
      thumbnail: item.thumbnail || item.image,
      videoUrl: item.videoUrl,
      mediaUrl: item.videoUrl || item.image,
      likes: likes ?? item.likes,
      comments: item.comments,
      category: item.category,
      isLive: item.isLive,
      live: item.live,
      views: item.views,
      duration: item.duration,
    },
    type,
  };
};

const DiscoverPage = () => {
  const [activeTab, setActiveTab] = useState('grid');
  const [fullscreenContent, setFullscreenContent] = useState<FullscreenContent | null>(null);
  const [fullscreenType, setFullscreenType] = useState<ContentType>('image');
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [commentedPosts, setCommentedPosts] = useState<Set<string>>(new Set());
  const [sharedPosts, setSharedPosts] = useState<Set<string>>(new Set());
  const [postLikes, setPostLikes] = useState<Map<string, number>>(new Map());
  const [commentSectionOpen, setCommentSectionOpen] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedPostUser, setSelectedPostUser] = useState<string>('');
  const [reportModalOpen, setReportModalOpen] = useState<string | null>(null);
  const [fullscreenBrowseOpen, setFullscreenBrowseOpen] = useState(false);
  
  // New state for filtering and sorting
  const [sortBy, setSortBy] = useState<'relevance' | 'trending' | 'newest' | 'popular'>('relevance');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [timeFilter, setTimeFilter] = useState<'today' | 'week' | 'month' | 'all'>('all');
  const [contentTypeFilter, setContentTypeFilter] = useState<string>('all');
  
  const navigate = useNavigate();

  const handleSearch = useCallback((query: string) => {
    showSuccess(`Searching for "${query}"...`);
    navigate(`/app/search?q=${encodeURIComponent(query)}`);
  }, [navigate]);

  const handleExpandFullscreen = () => {
    // This will be called when the expand button is clicked in minimized mode
    // The FullscreenViewer will handle restoring the content
  };

  const handleFullscreenBrowse = () => {
    setFullscreenBrowseOpen(true);
  };

  const handleOpenFullscreen = (content: FullscreenContent, type: ContentType) => {
    setFullscreenContent(content);
    setFullscreenType(type);
  };

  const baseLikesOf = (contentId: string): number => {
    const mapped = postLikes.get(contentId);
    if (typeof mapped === 'number') return mapped;
    const found = discoverItems.find((d) => d.id === contentId);
    const n = Number(found?.likes);
    return Number.isFinite(n) ? n : 0;
  };

  const handleLike = (contentId: string) => {
    const liking = !likedPosts.has(contentId);
    // Human eval first (fire-and-forget).
    try { evalLike(contentId, liking); } catch { /* never block */ }
    setLikedPosts(prev => {
      const newSet = new Set(prev);
      const isCurrentlyLiked = newSet.has(contentId);

      if (isCurrentlyLiked) {
        newSet.delete(contentId);
        showSuccess('💔 Post unliked');
        // Decrement likes (from the true base count, not 0)
        setPostLikes(prevLikes => {
          const newLikes = new Map(prevLikes);
          const currentLikes = prevLikes.has(contentId) ? (prevLikes.get(contentId) as number) : baseLikesOf(contentId);
          newLikes.set(contentId, Math.max(0, currentLikes - 1));
          return newLikes;
        });
      } else {
        newSet.add(contentId);
        showSuccess('❤️ Post liked!');
        // Increment likes (from the true base count, not 0)
        setPostLikes(prevLikes => {
          const newLikes = new Map(prevLikes);
          const currentLikes = prevLikes.has(contentId) ? (prevLikes.get(contentId) as number) : baseLikesOf(contentId);
          newLikes.set(contentId, currentLikes + 1);
          return newLikes;
        });
      }
      return newSet;
    });
  };

  const handleComment = (contentId: string, user?: string) => {
    setSelectedPostId(contentId);
    setSelectedPostUser(user || 'User');
    setCommentedPosts(prev => {
      const newSet = new Set(prev);
      newSet.add(contentId);
      return newSet;
    });
    setCommentSectionOpen(true);
  };

  const handleShare = (content: any) => {
    setSharedPosts(prev => {
      const newSet = new Set(prev);
      newSet.add(content.id);
      return newSet;
    });
    if (navigator.share) {
      navigator.share({
        title: content.title || 'Discover Content',
        text: 'Check out this content!',
        url: window.location.href
      }).catch(() => {
        navigator.clipboard.writeText(window.location.href);
        showSuccess('🔗 Link copied to clipboard!');
      });
    } else {
      navigator.clipboard.writeText(window.location.href);
      showSuccess('🔗 Link copied to clipboard!');
    }
  };

  const handleCloseFullscreen = () => {
    setFullscreenContent(null);
  };

  // Menu handlers
  const handleReport = (postId: string) => {
    setReportModalOpen(postId);
  };

  const handleHide = (postId: string) => {
    showSuccess('Content hidden from discover');
  };

  const handleCopyLink = (postId: string) => {
    const shareUrl = `${window.location.origin}/discover/${postId}`;
    navigator.clipboard.writeText(shareUrl);
    showSuccess('🔗 Link copied to clipboard!');
  };

  // Handle reopening fullscreen from minimized state
  useEffect(() => {
    const handleReopenFullscreen = (event: any) => {
      const content = event.detail;
      setFullscreenContent(content);
    };

    // Handle split view video selection
    const handleSplitViewVideoSelected = (event: CustomEvent) => {
      const { content } = event.detail;
      
      // Set the new content immediately
      setFullscreenContent(content);
      setFullscreenType(content.type || 'video');
      
      // Clear temp content to avoid duplicate processing
      (window as any).tempFullscreenContent = null;
    };

    window.addEventListener('reopenFullscreen', handleReopenFullscreen);
    window.addEventListener('splitViewVideoSelected', handleSplitViewVideoSelected as EventListener);
    
    return () => {
      window.removeEventListener('reopenFullscreen', handleReopenFullscreen);
      window.removeEventListener('splitViewVideoSelected', handleSplitViewVideoSelected as EventListener);
    };
  }, []);

  // Check for temp content on mount
  useEffect(() => {
    if ((window as any).tempFullscreenContent) {
      setFullscreenContent((window as any).tempFullscreenContent);
      (window as any).tempFullscreenContent = null;
    }
  }, []);

  // Categories for filtering
  const categories = [
    { id: 'all', name: 'All Categories', icon: Grid },
    { id: 'photography', name: 'Photography', icon: Image },
    { id: 'video', name: 'Video', icon: Video },
    { id: 'music', name: 'Music', icon: Music },
    { id: 'live', name: 'Live', icon: Radio },
    { id: 'art', name: 'Art & Design', icon: Image },
    { id: 'gaming', name: 'Gaming', icon: Video },
    { id: 'education', name: 'Education', icon: Video },
  ];

  const contentTypes = [
    { id: 'all', name: 'All Content' },
    { id: 'image', name: 'Images' },
    { id: 'video', name: 'Videos' },
    { id: 'live', name: 'Live Streams' },
  ];

  // Tags data for different sections
  const sectionTags = {
    grid: ['#photography', '#art', '#nature', '#urban', '#portraits', '#street', '#landscape', '#minimalist'],
    trending: ['#viral', '#trending', '#popular', '#hot', '#featured', '#explore', '#fyp', '#foryou'],
    live: ['#gaming', '#music', '#talk', '#sports', '#news', '#entertainment', '#education', '#cooking'],
    longform: ['#tutorial', '#documentary', '#review', '#interview', '#podcast', '#course', '#webinar', '#deepdive']
  };

  const currentTags = sectionTags[activeTab as keyof typeof sectionTags] || [];

  // Live Discover feed — was hardcoded to [] so uploads never appeared.
  // Strict routing: only durable media (photo/video/moment/thought/live),
  // never stories. Photos never render as videos and vice-versa.
  const [discoverItems, setDiscoverItems] = React.useState<any[]>([]);
  const [isLoadingDiscover, setIsLoadingDiscover] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setIsLoadingDiscover(true);
        const [posts, moments] = await Promise.all([
          fetchPosts(undefined, 50).catch(() => []),
          fetchMoments(30).catch(() => []),
        ]);
        const thoughtsRes = await getThoughts(30, 0).catch(() => ({ data: [] as never[] }));
        const thoughts = ((thoughtsRes as { data: any[] }).data || []).map((t: any) => {
          const mediaArr = Array.isArray(t.media) ? t.media : [];
          const first = mediaArr[0] as { type?: string; url?: string; thumbnail?: string } | undefined;
          return {
            id: t.id,
            type: 'thought',
            title: String(t.content || '').slice(0, 80) || 'Thought',
            content: t.content || '',
            creator: t.user?.username || t.creator || 'Unknown',
            creatorId: t.user?.id || t.user?.username || 'unknown',
            image: first && first.type !== 'video' ? first.url || first.thumbnail || '' : (t.image_url || ''),
            thumbnail: first?.thumbnail || first?.url || t.image_url || '',
            videoUrl: first?.type === 'video' ? first.url || '' : '',
            mediaType: first?.type === 'video' ? 'video' : (first ? 'image' : 'text'),
            likes: t.likes_count ?? 0,
            comments: t.comments_count ?? 0,
            views: t.views ?? 0,
            category: (t.tags && t.tags[0]) || 'Thoughts',
            tags: t.tags || [],
            timestamp: t.created_at || t.createdAt || new Date().toISOString(),
            createdAt: t.created_at || t.createdAt,
          };
        });
        const mapped = [
          ...(posts as any[]).map((p: any) => {
            const vid = videoUrlOf(p);
            const img = imageUrlOf(p);
            const live = !!(p.isLive || p.live || String(p.type || '').toLowerCase() === 'live');
            return {
              id: p.id,
              type: p.type || (vid ? 'video' : 'photo'),
              contentType: live ? 'live' : vid ? 'video' : 'image',
              title: String(p.content || p.title || 'Post').slice(0, 80),
              content: p.content || '',
              creator: creatorOf(p),
              creatorId: p.userId || p.user || 'unknown',
              image: img,
              thumbnail: img,
              videoUrl: vid,
              mediaType: p.mediaType || (vid ? 'video' : 'image'),
              likes: p.likes ?? 0,
              comments: p.comments ?? 0,
              views: p.views ?? 0,
              category: (p.categories && p.categories[0]) || p.category || 'General',
              tags: p.tags || [],
              timestamp: p.createdAt || p.time || new Date().toISOString(),
              createdAt: p.createdAt,
              isLive: p.isLive,
              live: p.live,
              duration: p.duration,
            };
          }),
          ...(moments as any[]).map((m: any) => {
            const vid = videoUrlOf(m);
            const img = imageUrlOf(m);
            return {
              id: m.id,
              type: 'moment',
              contentType: vid ? 'video' : 'image',
              title: String(m.content || 'Moment').slice(0, 80),
              content: m.content || '',
              creator: creatorOf(m),
              creatorId: m.userId || m.user || 'unknown',
              image: img,
              thumbnail: img || m.thumbnail || '',
              videoUrl: vid,
              mediaType: vid ? 'video' : 'image',
              likes: m.likes ?? 0,
              comments: m.comments ?? 0,
              views: m.views ?? 0,
              category: m.category || 'Moments',
              tags: m.tags || [],
              timestamp: m.createdAt || m.time || new Date().toISOString(),
              createdAt: m.createdAt,
              duration: m.duration || '0:30',
            };
          }),
          ...thoughts.map((t: any) => ({
            ...t,
            contentType: t.videoUrl ? 'video' : t.image || t.thumbnail ? 'image' : 'text',
          })),
        ].filter((i) => allowedForSurface(String(i.type || 'post'), 'discover') && hasRenderableMedia(i));
        if (!cancelled) setDiscoverItems(mapped.sort((a, b) => timeOf(b) - timeOf(a)));
      } catch {
        if (!cancelled) setDiscoverItems([]);
      } finally {
        if (!cancelled) setIsLoadingDiscover(false);
      }
    };
    load();
    const refresh = () => load();
    window.addEventListener('userPostCreated', refresh);
    window.addEventListener('feedRefresh', refresh);
    window.addEventListener('momentCreated', refresh);
    window.addEventListener('thoughtCreated', refresh);
    window.addEventListener('profileUpdated', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('userPostCreated', refresh);
      window.removeEventListener('feedRefresh', refresh);
      window.removeEventListener('momentCreated', refresh);
      window.removeEventListener('thoughtCreated', refresh);
      window.removeEventListener('profileUpdated', refresh);
    };
  }, []);

  const toCardType = (item: any): 'image' | 'video' | 'live' => {
    const ct = String(item?.contentType || '').toLowerCase();
    if (ct === 'live' || item?.isLive || item?.live || item?.type === 'live') return 'live';
    if (ct === 'video' || item?.videoUrl || item?.mediaType === 'video' || item?.type === 'video' || (item?.type === 'moment' && item?.videoUrl)) return 'video';
    return 'image';
  };

  const applyFilters = React.useCallback(
    (items: any[]) => {
      let out = [...items];
      if (selectedCategory !== 'all') {
        out = out.filter((i) => String(i.category || '').toLowerCase() === selectedCategory.toLowerCase());
      }
      if (contentTypeFilter !== 'all') {
        out = out.filter((i) => toCardType(i) === contentTypeFilter);
      }
      if (timeFilter !== 'all') {
        const now = Date.now();
        const windowMs =
          timeFilter === 'today' ? 24 * 3600 * 1000 : timeFilter === 'week' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000;
        out = out.filter((i) => {
          const t = new Date(i.timestamp || i.createdAt || Date.now()).getTime();
          return Number.isFinite(t) && now - t <= windowMs;
        });
      }
      const num = (v: unknown) => (typeof v === 'number' ? v : parseInt(String(v || '0'), 10) || 0);
      if (sortBy === 'newest') out.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      else if (sortBy === 'popular' || sortBy === 'trending') out.sort((a, b) => num(b.likes) + num(b.comments) * 2 - (num(a.likes) + num(a.comments) * 2));
      return out;
    },
    [selectedCategory, contentTypeFilter, timeFilter, sortBy],
  );

  const gridData = React.useMemo(() => applyFilters(discoverItems), [discoverItems, applyFilters]);
  const trendingData = React.useMemo(() => {
    const num = (v: unknown) => (typeof v === 'number' ? v : parseInt(String(v || '0'), 10) || 0);
    return applyFilters([...discoverItems].sort((a, b) => num(b.likes) + num(b.views) - (num(a.likes) + num(a.views)))).slice(0, 12);
  }, [discoverItems, applyFilters]);
  const liveData = React.useMemo(
    () => applyFilters(discoverItems.filter((i) => i.isLive || i.live || i.type === 'live')),
    [discoverItems, applyFilters],
  );
  const longformData = React.useMemo(
    () => applyFilters(discoverItems.filter((i) => toCardType(i) === 'video')),
    [discoverItems, applyFilters],
  );

  // Seed like counts as items load (async fetch lands after mount, so this
  // must re-run when discoverItems changes — never overwriting live counts).
  React.useEffect(() => {
    if (discoverItems.length === 0) return;
    setPostLikes((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const item of discoverItems) {
        if (!next.has(item.id) && typeof item.likes === 'number') {
          next.set(item.id, item.likes);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [discoverItems]);

  const handleTagClick = (tag: string) => {
    // Open fullscreen browse instead of navigating to search
    setFullscreenBrowseOpen(true);
    showSuccess(`Opening fullscreen browse for ${tag}`);
  };

  const handleSortChange = (value: 'relevance' | 'trending' | 'newest' | 'popular') => {
    setSortBy(value);
    showSuccess(`Sorting by ${value}`);
  };

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category);
    showSuccess(`Filtered by ${categories.find(c => c.id === category)?.name || category}`);
  };

  const handleViewModeToggle = () => {
    const newMode = viewMode === 'grid' ? 'list' : 'grid';
    setViewMode(newMode);
    showSuccess(`Switched to ${newMode} view`);
  };

  const handleTimeFilterChange = (timeFilter: 'today' | 'week' | 'month' | 'all') => {
    setTimeFilter(timeFilter);
    const timeLabels = {
      today: 'Today',
      week: 'This Week',
      month: 'This Month',
      all: 'All Time'
    };
    showSuccess(`Filtered by ${timeLabels[timeFilter]}`);
  };

  const handleContentTypeFilter = (type: string) => {
    setContentTypeFilter(type);
    showSuccess(`Filtered by ${contentTypes.find(t => t.id === type)?.name || type}`);
  };

  // Filter and sort controls component
  const FilterControls = () => (
    <div className="flex flex-wrap items-center gap-3 mb-6 p-4 bg-muted/30 rounded-lg">
      {/* Sort By Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <SortDesc className="w-4 h-4" />
            {sortBy === 'relevance' && 'Relevance'}
            {sortBy === 'trending' && 'Trending'}
            {sortBy === 'newest' && 'Newest'}
            {sortBy === 'popular' && 'Most Popular'}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => handleSortChange('relevance')}>
            <TrendingUp className="w-4 h-4 mr-2" /> Relevance
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSortChange('trending')}>
            <Flame className="w-4 h-4 mr-2" /> Trending
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSortChange('newest')}>
            <Clock className="w-4 h-4 mr-2" /> Newest
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleSortChange('popular')}>
            <ThumbsUp className="w-4 h-4 mr-2" /> Most Popular
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Category Filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Filter className="w-4 h-4" />
            {categories.find(c => c.id === selectedCategory)?.name || 'All Categories'}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {categories.map((category) => {
            const IconComponent = category.icon;
            return (
              <DropdownMenuItem key={category.id} onClick={() => handleCategoryChange(category.id)}>
                <IconComponent className="w-4 h-4 mr-2" /> {category.name}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Content Type Filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Grid className="w-4 h-4" />
            {contentTypes.find(t => t.id === contentTypeFilter)?.name || 'All Content'}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {contentTypes.map((type) => (
            <DropdownMenuItem key={type.id} onClick={() => handleContentTypeFilter(type.id)}>
              {type.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Time Filter */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <Clock className="w-4 h-4" />
            {timeFilter === 'today' && 'Today'}
            {timeFilter === 'week' && 'This Week'}
            {timeFilter === 'month' && 'This Month'}
            {timeFilter === 'all' && 'All Time'}
            <ChevronDown className="w-3 h-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => handleTimeFilterChange('today')}>Today</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleTimeFilterChange('week')}>This Week</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleTimeFilterChange('month')}>This Month</DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleTimeFilterChange('all')}>All Time</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* View Mode Toggle */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleViewModeToggle}
        className="gap-2"
      >
        {viewMode === 'grid' ? <List className="w-4 h-4" /> : <Grid className="w-4 h-4" />}
        {viewMode === 'grid' ? 'List View' : 'Grid View'}
      </Button>

      {/* Clear Filters */}
      {(selectedCategory !== 'all' || contentTypeFilter !== 'all' || timeFilter !== 'all') && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSelectedCategory('all');
            setContentTypeFilter('all');
            setTimeFilter('all');
            setSortBy('relevance');
            showSuccess('Filters cleared');
          }}
          className="text-muted-foreground hover:text-foreground"
        >
          Clear Filters
        </Button>
      )}
    </div>
  );

  // Search Bar Section matching Navbar implementation
  const SearchBarSection = () => (
    <div className="mb-8">
      <div className="flex items-center gap-4 max-w-2xl mx-auto">
        <div className="flex-1">
          <SearchSuggest
            onSearch={handleSearch}
            placeholder="Search for content, users, tags... (Press '/' to focus)"
            className="w-full"
            showTrending={true}
            maxSuggestions={6}
          />
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={handleFullscreenBrowse}
          className="hidden md:flex items-center justify-center h-10 w-10 hover:bg-primary/10 hover:text-primary transition-all duration-200"
          title="Fullscreen Browse"
        >
          <Monitor className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );

  // Instagram Style Grid Content
  const GridContent = () => {
    if (isLoadingDiscover) {
      return (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
          <p className="ml-4 text-muted-foreground">Loading fresh uploads…</p>
        </div>
      );
    }
    if (viewMode === 'list') {
      // List view implementation
      return (
        <div className="space-y-4">
          {gridData.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No content found matching your filters</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => {
                setSelectedCategory('all');
                setContentTypeFilter('all');
                setTimeFilter('all');
                setSortBy('relevance');
                showSuccess('Filters cleared');
              }}>
                Clear Filters
              </Button>
            </div>
          ) : (
            gridData.map((item, i) => (
              <Card
                key={item.id}
                className="group cursor-pointer hover:shadow-lg transition-all duration-300"
                onClick={() => { const f = toFullscreen(item, postLikes.get(item.id)); handleOpenFullscreen(f.content, f.type); }}
              >
                <CardContent className="p-4">
                  <div className="flex gap-4">
                    <div className="w-24 h-24 flex-shrink-0 rounded-lg overflow-hidden bg-black">
                      <DiscoverImg
                        src={item.thumbnail || item.image}
                        className="w-full h-full object-contain"
                      />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <h3 className="font-semibold group-hover:text-primary transition-colors">
                          {item.title}
                        </h3>
                        <Badge variant="secondary" className="text-xs">
                          {item.category}
                        </Badge>
                        <Badge variant={item.contentType === 'live' ? 'destructive' : 'outline'} className="text-xs">
                          {item.contentType === 'live' ? (
                            <span className="flex items-center gap-1"><div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" /> LIVE</span>
                          ) : item.contentType === 'video' ? (
                            <span className="flex items-center gap-1"><Video className="w-3 h-3" /> Video</span>
                          ) : (
                            <span className="flex items-center gap-1"><Image className="w-3 h-3" /> Photo</span>
                          )}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">
                        {item.contentType === 'live' ? `🔴 Live streaming by ${item.creator} - join now!` :
                         item.contentType === 'video' ? `▶️ Video content from ${item.creator} - watch this amazing video` :
                         `📷 Photo by ${item.creator} - stunning visual content`}
                      </p>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <ThumbsUp className="w-4 h-4" /> {postLikes.get(item.id) ?? item.likes}
                        </span>
                        <span className="flex items-center gap-1">
                          <MessageCircle className="w-4 h-4" /> {item.comments}
                        </span>
                        <span>{Math.floor((new Date().getTime() - new Date(item.timestamp).getTime()) / (1000 * 60 * 60))} hours ago</span>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleLike(item.id);
                        }}
                        className={`p-2 rounded-full hover:bg-muted transition-all ${
                          likedPosts?.has(item.id) ? 'text-red-500' : 'text-muted-foreground'
                        }`}
                      >
                        <ThumbsUp className={`w-4 h-4 ${likedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleComment(item.id, item.creator);
                        }}
                        className={`p-2 rounded-full hover:bg-muted transition-all ${
                          commentedPosts?.has(item.id) ? 'text-blue-500' : 'text-muted-foreground'
                        }`}
                      >
                        <MessageCircle className={`w-4 h-4 ${commentedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          handleShare({
                            id: item.id,
                            title: item.title,
                            image: item.image
                          });
                        }}
                        className={`p-2 rounded-full hover:bg-muted transition-all ${
                          sharedPosts?.has(item.id) ? 'text-green-500' : 'text-muted-foreground'
                        }`}
                      >
                        <Share2 className={`w-4 h-4 ${sharedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                      </button>
                      <div onClick={(e) => e.stopPropagation()}>
                        <SaveButton postId={item.id} content={item} />
                      </div>
                      <div onClick={(e) => e.stopPropagation()}>
                        <StandardPostMenu
                          postId={item.id}
                          postUserId={item.creatorId}
                          contentType={toCardType(item) === 'video' ? 'video' : toCardType(item) === 'live' ? 'live' : 'post'}
                          onReport={handleReport}
                          onHide={handleHide}
                          onCopyLink={handleCopyLink}
                          onShare={() => handleShare({ id: item.id, title: item.title, image: item.image })}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      );
    }

    // Grid view — full-image previews (object-contain, never cropped)
    return (
      <div className="grid grid-cols-3 gap-1 md:gap-2">
        {gridData.length === 0 ? (
          <div className="col-span-3 text-center py-12 text-muted-foreground">
            <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>{discoverItems.length === 0 ? 'Nothing here yet — be the first to post!' : 'No content found matching your filters'}</p>
            {discoverItems.length === 0 ? (
              <Button variant="default" size="sm" className="mt-4" onClick={() => navigate('/app/create')}>
                Create the first post
              </Button>
            ) : (
              <Button variant="outline" size="sm" className="mt-4" onClick={() => {
                setSelectedCategory('all');
                setContentTypeFilter('all');
                setTimeFilter('all');
                setSortBy('relevance');
                showSuccess('Filters cleared');
              }}>
                Clear Filters
              </Button>
            )}
          </div>
        ) : (
          gridData.map((item, i) => (
            <div
              key={item.id}
              className={`relative aspect-square bg-muted group cursor-pointer overflow-hidden ${i % 3 === 0 && i % 2 === 0 ? 'row-span-2 col-span-2' : ''}`}
              onClick={() => { const f = toFullscreen(item, postLikes.get(item.id)); handleOpenFullscreen(f.content, f.type); }}
            >
              <DiscoverImg
                src={item.thumbnail || item.image}
                className="w-full h-full object-contain bg-black transition-transform duration-500 group-hover:scale-[1.02]"
              />
              {/* Top-left: category */}
              <div className="absolute top-2 left-2">
                <Badge className="text-xs bg-black/50 hover:bg-black/70">
                  {item.category}
                </Badge>
              </div>
              {/* Top-right: 3-dot menu — always visible so public uploads are actionable */}
              <div
                className="absolute top-1.5 right-1.5 rounded-full bg-black/50 backdrop-blur-sm"
                onClick={(e) => e.stopPropagation()}
              >
                <StandardPostMenu
                  postId={item.id}
                  postUserId={item.creatorId}
                  contentType={toCardType(item) === 'video' ? 'video' : toCardType(item) === 'live' ? 'live' : 'post'}
                  onReport={handleReport}
                  onHide={handleHide}
                  onCopyLink={handleCopyLink}
                  onShare={() => handleShare({ id: item.id, title: item.title, image: item.image })}
                  className="text-white hover:text-white"
                />
              </div>
              {/* Bottom action bar: like / comment / share / save — always
                  visible (mobile never had hover), overlay on desktop hover */}
              <div className="absolute inset-x-0 bottom-0 flex items-center justify-around gap-1 bg-gradient-to-t from-black/80 via-black/50 to-transparent px-2 pb-2 pt-8 text-white">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLike(item.id);
                  }}
                  aria-label="Like"
                  className={`flex items-center gap-1 rounded-full bg-black/50 p-2 transition-all hover:scale-110 hover:bg-black/70 ${
                    likedPosts?.has(item.id) ? 'text-red-500' : ''
                  }`}
                >
                  <ThumbsUp className={`w-4 h-4 ${likedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                  <span className="text-xs font-medium">{postLikes.get(item.id) ?? item.likes}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleComment(item.id, item.creator);
                  }}
                  aria-label="Comment"
                  className={`flex items-center gap-1 rounded-full bg-black/50 p-2 transition-all hover:scale-110 hover:bg-black/70 ${
                    commentedPosts?.has(item.id) ? 'text-blue-400' : ''
                  }`}
                >
                  <MessageCircle className={`w-4 h-4 ${commentedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                  <span className="text-xs font-medium">{item.comments}</span>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleShare({
                      id: item.id,
                      title: item.title,
                      image: item.image
                    });
                  }}
                  aria-label="Share"
                  className={`flex items-center gap-1 rounded-full bg-black/50 p-2 transition-all hover:scale-110 hover:bg-black/70 ${
                    sharedPosts?.has(item.id) ? 'text-green-400' : ''
                  }`}
                >
                  <Share2 className={`w-4 h-4 ${sharedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                </button>
                <div
                  className="flex items-center rounded-full bg-black/50 transition-all hover:bg-black/70"
                  onClick={(e) => e.stopPropagation()}
                >
                  <SaveButton postId={item.id} content={item} className="text-white hover:text-white" iconClassName="text-white" />
                </div>
              </div>
              {toCardType(item) === 'live' && (
                <div className="absolute top-2 right-12 flex items-center gap-1 bg-red-600 text-white text-xs px-2 py-0.5 rounded animate-pulse">
                  <div className="w-1.5 h-1.5 bg-white rounded-full" />
                  LIVE
                </div>
              )}
              {toCardType(item) === 'video' && (
                <div className="absolute top-10 right-2">
                  <Video className="w-5 h-5 text-white drop-shadow-md" />
                </div>
              )}
              {toCardType(item) === 'video' && item.duration && (
                <div className="absolute bottom-12 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                  {item.duration}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  };

  // Trending Section (List/Grid mix)
  const TrendingSection = () => (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-4">
        <Flame className="w-6 h-6 text-orange-500 fill-orange-500 animate-pulse" />
        <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-orange-400 to-red-600">Trending Now</h2>
      </div>
      {trendingData.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No trending content found matching your filters</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => {
            setSelectedCategory('all');
            setContentTypeFilter('all');
            setTimeFilter('all');
            setSortBy('relevance');
            showSuccess('Filters cleared');
          }}>
            Clear Filters
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {trendingData.map((item, i) => (
            <Card
              key={item.id}
              className="overflow-hidden hover:shadow-lg transition-all duration-300 border-border/50 group cursor-pointer"
              onClick={() => { const f = toFullscreen(item, postLikes.get(item.id)); handleOpenFullscreen(f.content, f.type); }}
            >
              <div className="relative aspect-video bg-black">
                <DiscoverImg src={item.thumbnail || item.image} alt="" className="w-full h-full object-contain" />
                <Badge className="absolute top-2 left-2 bg-orange-500/90 hover:bg-orange-600 border-none">#{i + 1} Trending</Badge>
                {toCardType(item) === 'video' && item.duration && (
                  <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                    {item.duration}
                  </div>
                )}
                <div className="absolute top-2 right-12">
                  <Badge className="text-xs bg-black/50 hover:bg-black/70">
                    {item.category}
                  </Badge>
                </div>
              </div>
              <CardContent className="p-3">
                <div className="flex gap-3 items-start justify-between">
                  <div className="flex gap-3">
                    <Avatar
                      className="w-8 h-8 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Navigate to user profile when avatar is clicked
                        navigateToProfile(navigate, item.creatorId, item.creator);
                      }}
                      title={`${item.creator}'s Profile`}
                    >
                      <AvatarImage src="" />
                      <AvatarFallback>U</AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="font-bold leading-tight group-hover:text-primary transition-colors">{item.title}</h3>
                      <p className="text-xs text-muted-foreground mt-1">{item.creator} • {item.views} views • {Math.floor((new Date().getTime() - new Date(item.timestamp).getTime()) / (1000 * 60 * 60))} hours ago</p>
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <StandardPostMenu
                      postId={item.id}
                      postUserId={item.creatorId}
                      contentType={toCardType(item) === 'video' ? 'video' : toCardType(item) === 'live' ? 'live' : 'post'}
                      onReport={handleReport}
                      onHide={handleHide}
                      onCopyLink={handleCopyLink}
                      onShare={() => handleShare({
                        id: item.id,
                        title: item.title,
                        image: item.thumbnail
                      })}
                    />
                  </div>
                </div>
                {/* Always-visible actions: like / comment / share / save */}
                <div className="mt-2 flex items-center gap-1 border-t border-border/50 pt-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleLike(item.id)}
                    aria-label="Like"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${likedPosts?.has(item.id) ? 'text-red-500' : 'text-muted-foreground'}`}
                  >
                    <ThumbsUp className={`w-4 h-4 ${likedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                    <span className="text-xs">{postLikes.get(item.id) ?? item.likes}</span>
                  </button>
                  <button
                    onClick={() => handleComment(item.id, item.creator)}
                    aria-label="Comment"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${commentedPosts?.has(item.id) ? 'text-blue-500' : 'text-muted-foreground'}`}
                  >
                    <MessageCircle className={`w-4 h-4 ${commentedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                    <span className="text-xs">{item.comments}</span>
                  </button>
                  <button
                    onClick={() => handleShare({ id: item.id, title: item.title, image: item.thumbnail || item.image })}
                    aria-label="Share"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${sharedPosts?.has(item.id) ? 'text-green-500' : 'text-muted-foreground'}`}
                  >
                    <Share2 className={`w-4 h-4 ${sharedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                  </button>
                  <SaveButton postId={item.id} content={item} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  // Live Section
  const LiveSection = () => (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-4">
        <Radio className="w-6 h-6 text-red-500 animate-pulse" />
        <h2 className="text-2xl font-bold">Live Channels</h2>
      </div>
      {liveData.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No live content found matching your filters</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => {
            setSelectedCategory('all');
            setContentTypeFilter('all');
            setTimeFilter('all');
            setSortBy('relevance');
            showSuccess('Filters cleared');
          }}>
            Clear Filters
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {liveData.map((item, i) => (
            <Card
              key={item.id}
              className="group cursor-pointer"
              onClick={() => { const f = toFullscreen(item, postLikes.get(item.id)); handleOpenFullscreen(f.content, f.type); }}
            >
              <div className="relative aspect-video bg-black">
                <DiscoverImg src={item.thumbnail || item.image} alt="" className="w-full h-full object-contain rounded-t-lg" />
                <div className="absolute top-3 left-3 bg-red-600 text-white px-2 py-0.5 rounded text-xs font-bold animate-pulse">LIVE</div>
                <div className="absolute bottom-3 left-3 bg-black/60 text-white px-2 py-0.5 rounded text-xs backdrop-blur-sm flex items-center gap-1">
                  <Users className="w-3 h-3" /> {item.views} watching
                </div>
                <div className="absolute top-3 right-3">
                  <Badge className="text-xs bg-black/50 hover:bg-black/70">
                    {item.category}
                  </Badge>
                </div>
              </div>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Avatar
                      className="w-8 h-8 ring-2 ring-red-500 ring-offset-2 cursor-pointer hover:ring-4 hover:ring-red-400 transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Navigate to user profile when avatar is clicked
                        navigateToProfile(navigate, item.creatorId, item.creator);
                      }}
                      title={`${item.creator}'s Profile`}
                    >
                      <AvatarImage src="" />
                      <AvatarFallback>STR</AvatarFallback>
                    </Avatar>
                    <div>
                      <span className="font-semibold text-sm">{item.creator}</span>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">{item.category}</Badge>
                      </div>
                    </div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <StandardPostMenu
                      postId={item.id}
                      postUserId={item.creatorId}
                      contentType="live"
                      onReport={handleReport}
                      onHide={handleHide}
                      onCopyLink={handleCopyLink}
                      onShare={() => handleShare({
                        id: item.id,
                        title: item.title,
                        image: item.thumbnail
                      })}
                    />
                  </div>
                </div>
                {/* Always-visible actions: like / comment / share / save */}
                <div className="mt-2 flex items-center gap-1 border-t border-border/50 pt-2" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleLike(item.id)}
                    aria-label="Like"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${likedPosts?.has(item.id) ? 'text-red-500' : 'text-muted-foreground'}`}
                  >
                    <ThumbsUp className={`w-4 h-4 ${likedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                    <span className="text-xs">{postLikes.get(item.id) ?? item.likes}</span>
                  </button>
                  <button
                    onClick={() => handleComment(item.id, item.creator)}
                    aria-label="Comment"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${commentedPosts?.has(item.id) ? 'text-blue-500' : 'text-muted-foreground'}`}
                  >
                    <MessageCircle className={`w-4 h-4 ${commentedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                    <span className="text-xs">{item.comments}</span>
                  </button>
                  <button
                    onClick={() => handleShare({ id: item.id, title: item.title, image: item.thumbnail || item.image })}
                    aria-label="Share"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${sharedPosts?.has(item.id) ? 'text-green-500' : 'text-muted-foreground'}`}
                  >
                    <Share2 className={`w-4 h-4 ${sharedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                  </button>
                  <SaveButton postId={item.id} content={item} />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );

  // Longform Video Section (YouTube style)
  const LongformSection = () => (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-4">
        <Video className="w-6 h-6 text-red-600" />
        <h2 className="text-2xl font-bold">Long Videos</h2>
      </div>
      {longformData.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Filter className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No long videos found matching your filters</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => {
            setSelectedCategory('all');
            setContentTypeFilter('all');
            setTimeFilter('all');
            setSortBy('relevance');
            showSuccess('Filters cleared');
          }}>
            Clear Filters
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {longformData.map((item, i) => (
            <div
              key={item.id}
              className="flex flex-col sm:flex-row gap-4 group cursor-pointer hover:bg-muted/30 p-2 rounded-xl transition-colors"
              onClick={() => { const f = toFullscreen(item, postLikes.get(item.id)); handleOpenFullscreen(f.content, f.type); }}
            >
              <div className="relative sm:w-64 md:w-80 flex-shrink-0 aspect-video rounded-xl overflow-hidden shadow-md bg-black">
                <DiscoverImg src={item.thumbnail || item.image} alt="" className="w-full h-full object-contain" />
                {item.duration && (
                  <div className="absolute bottom-2 right-2 bg-black/90 text-white text-xs px-1.5 py-0.5 rounded font-medium">
                    {item.duration}
                  </div>
                )}
                <div className="absolute top-2 left-2">
                  <Badge className="text-xs bg-black/50 hover:bg-black/70">
                    {item.category}
                  </Badge>
                </div>
              </div>
              <div className="flex-1 py-1">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-lg font-bold leading-tight line-clamp-2 group-hover:text-primary transition-colors mb-1">
                    {item.title}
                  </h3>
                  <div onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
                    <StandardPostMenu
                      postId={item.id}
                      postUserId={item.creatorId}
                      contentType="video"
                      onReport={handleReport}
                      onHide={handleHide}
                      onCopyLink={handleCopyLink}
                      onShare={() => handleShare({ id: item.id, title: item.title, image: item.thumbnail || item.image })}
                    />
                  </div>
                </div>
                <Avatar
                  className="w-8 h-8 ring-2 ring-red-500 ring-offset-2 cursor-pointer hover:ring-4 hover:ring-red-400 transition-all duration-200"
                  onClick={(e) => {
                    e.stopPropagation();
                    // Navigate to user profile when avatar is clicked
                    navigateToProfile(navigate, item.creatorId, item.creator);
                  }}
                  title={`${item.creator}'s Profile`}
                >
                  <AvatarImage src="" />
                  <AvatarFallback>STR</AvatarFallback>
                </Avatar>
                <div>
                  <span className="font-semibold text-sm">{item.creator}</span>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-xs">{item.category}</Badge>
                  </div>
                </div>
                <div className="hidden sm:block text-sm text-muted-foreground space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground/80">{item.creator}</span>
                    <Badge variant="secondary" className="h-4 px-1 text-[10px]">✓</Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <span>{item.views} views</span>
                    <span>•</span>
                    <span>{Math.floor((new Date().getTime() - new Date(item.timestamp).getTime()) / (1000 * 60 * 60))} hours ago</span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2 pt-2">
                    {item.content || item.title}
                  </p>
                </div>
                {/* Always-visible actions: like / comment / share / save */}
                <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => handleLike(item.id)}
                    aria-label="Like"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${likedPosts?.has(item.id) ? 'text-red-500' : 'text-muted-foreground'}`}
                  >
                    <ThumbsUp className={`w-4 h-4 ${likedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                    <span className="text-xs">{postLikes.get(item.id) ?? item.likes}</span>
                  </button>
                  <button
                    onClick={() => handleComment(item.id, item.creator)}
                    aria-label="Comment"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${commentedPosts?.has(item.id) ? 'text-blue-500' : 'text-muted-foreground'}`}
                  >
                    <MessageCircle className={`w-4 h-4 ${commentedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                    <span className="text-xs">{item.comments}</span>
                  </button>
                  <button
                    onClick={() => handleShare({ id: item.id, title: item.title, image: item.thumbnail || item.image })}
                    aria-label="Share"
                    className={`flex items-center gap-1 rounded-full p-2 text-sm transition-all hover:bg-muted ${sharedPosts?.has(item.id) ? 'text-green-500' : 'text-muted-foreground'}`}
                  >
                    <Share2 className={`w-4 h-4 ${sharedPosts?.has(item.id) ? 'fill-current' : ''}`} />
                  </button>
                  <SaveButton postId={item.id} content={item} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto pb-24 px-4 pt-6">
      <SearchBarSection />
      <FilterControls />

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full justify-start overflow-x-auto bg-transparent border-b border-border/40 p-0 h-auto mb-4 gap-2 no-scrollbar">
          <TabsTrigger value="grid" className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary rounded-full px-4 py-2 text-sm font-medium border border-transparent data-[state=active]:border-primary/20">
            <Grid className="w-4 h-4 mr-2" /> All Posts
          </TabsTrigger>
          <TabsTrigger value="trending" className="data-[state=active]:bg-orange-500/10 data-[state=active]:text-orange-500 rounded-full px-4 py-2 text-sm font-medium border border-transparent data-[state=active]:border-orange-500/20">
            <Flame className="w-4 h-4 mr-2" /> Trending
          </TabsTrigger>
          <TabsTrigger value="live" className="data-[state=active]:bg-red-500/10 data-[state=active]:text-red-500 rounded-full px-4 py-2 text-sm font-medium border border-transparent data-[state=active]:border-red-500/20">
            <Radio className="w-4 h-4 mr-2" /> Live
          </TabsTrigger>
          <TabsTrigger value="longform" className="data-[state=active]:bg-blue-500/10 data-[state=active]:text-blue-500 rounded-full px-4 py-2 text-sm font-medium border border-transparent data-[state=active]:border-blue-500/20">
            <Video className="w-4 h-4 mr-2" /> Long Videos
          </TabsTrigger>
        </TabsList>

        {/* Tag Bar */}
        <div className="mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <Hash className="w-4 h-4 text-muted-foreground" />
            {currentTags.map((tag, index) => (
              <Button
                key={index}
                variant="outline"
                size="sm"
                onClick={() => handleTagClick(tag)}
                className="h-7 px-3 text-xs rounded-full border-border/50 hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all duration-200 cursor-pointer"
              >
                {tag}
              </Button>
            ))}
          </div>
        </div>

        <TabsContent value="grid" className="mt-0 animate-in fade-in-50 duration-300">
          <GridContent />
        </TabsContent>
        <TabsContent value="trending" className="mt-0 animate-in fade-in-50 duration-300">
          <TrendingSection />
        </TabsContent>
        <TabsContent value="live" className="mt-0 animate-in fade-in-50 duration-300">
          <LiveSection />
        </TabsContent>
        <TabsContent value="longform" className="mt-0 animate-in fade-in-50 duration-300">
          <LongformSection />
        </TabsContent>
      </Tabs>

      {/* Sponsored — single calm native slot below discovery content.
          Never overlays video, never auto-plays. */}
      <div className="mt-8 max-w-2xl mx-auto">
        <InFeedAdGate placement="discover-bottom" />
      </div>
      
      {/* Fullscreen Viewer */}
      {fullscreenContent && (
        <FullscreenViewer
          content={fullscreenContent}
          type={fullscreenType}
          onClose={handleCloseFullscreen}
          onExpand={handleExpandFullscreen}
        />
      )}

      {/* Fullscreen Browse */}
      <FullscreenBrowse
        isOpen={fullscreenBrowseOpen}
        onClose={() => setFullscreenBrowseOpen(false)}
      />

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

export default DiscoverPage;
