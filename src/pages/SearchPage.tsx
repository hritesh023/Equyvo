import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Search, Grid, List, Sparkles, Eye, Monitor, MessageCircle, X, Users, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import SearchSuggest from '@/components/SearchSuggest';
import SEOHead from '@/components/SEOHead';
import SplitScreenView from '@/components/SplitScreenView';
import CommentSection from '@/components/CommentSection';
import StandardPostMenu from '@/components/StandardPostMenu';
import FullscreenViewer from '@/components/FullscreenViewer';
import FollowButton from '@/components/FollowButton';
import { cn } from '@/lib/utils';
import { showSuccess } from '@/utils/toast';
import { FullscreenContent } from '@/types';
import { searchContent, searchContentAsync, ContentIndexItem, SearchedUser, getAllContent } from '@/lib/content-index';

type SearchItem = ContentIndexItem;

const SearchPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<'grid' | 'list' | 'split'>('grid');
  const [sortBy, setSortBy] = useState('relevance');
  const [filterCategory, setFilterCategory] = useState('all');
  const [activeTab, setActiveTab] = useState<'all' | 'people' | 'content'>('all');
  const [results, setResults] = useState<SearchItem[]>(getAllContent().slice(0, 12));
  const [userResults, setUserResults] = useState<SearchedUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [isAiRecommended, setIsAiRecommended] = useState(false);
  const [showSplitScreen, setShowSplitScreen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SearchItem | null>(null);
  const [showCommentSection, setShowCommentSection] = useState(false);
  const [currentPostId, setCurrentPostId] = useState<string>('');
  const [currentPostUser, setCurrentPostUser] = useState<string>('');
  const [fullscreenContent, setFullscreenContent] = useState<FullscreenContent | null>(null);
  const [fullscreenType, setFullscreenType] = useState<'post' | 'live' | 'video' | 'moment' | 'image'>('image');
  const [showTagBar, setShowTagBar] = useState(false);
  const [currentTag, setCurrentTag] = useState<string>('');
  const requestIdRef = useRef(0);

  const query = searchParams.get('q') || '';
  const category = searchParams.get('category') || '';

  const handleComment = (postId: string, postUser: string) => {
    setCurrentPostId(postId);
    setCurrentPostUser(postUser);
    setShowCommentSection(true);
  };

  const handleShare = (item: SearchItem) => {
    showSuccess(`Sharing "${item.title}"...`);
    // Share functionality will be handled by ShareButton component
  };

  const getFullscreenType = (resultType: string): 'post' | 'live' | 'video' | 'moment' | 'image' => {
    if (resultType === 'moment') return 'moment';
    if (resultType === 'story') return 'story' as any;
    if (resultType === 'video') return 'video';
    if (resultType === 'photo') return 'image';
    return 'image';
  };

  const handleOpenFullscreen = (content: FullscreenContent, type: 'post' | 'live' | 'video' | 'moment' | 'image') => {
    setFullscreenContent(content);
    setFullscreenType(type);
  };

  const handleCloseFullscreen = () => {
    setFullscreenContent(null);
  };

  const handleExpandFullscreen = () => {
    // This will be called when the expand button is clicked in minimized mode
    // The FullscreenViewer will handle restoring the content
  };

  // Related tags data based on popular categories
  const relatedTagsData: Record<string, string[]> = {
    'photography': ['camera', 'landscape', 'portrait', 'sunset', 'nature', 'street', 'blackandwhite', 'macro'],
    'food': ['recipes', 'cooking', 'dinner', 'lunch', 'breakfast', 'dessert', 'healthy', 'vegan'],
    'yoga': ['fitness', 'meditation', 'wellness', 'exercise', 'health', 'stretching', 'mindfulness', 'breathing'],
    'fitness': ['workout', 'gym', 'training', 'cardio', 'strength', 'weights', 'running', 'cycling'],
    'travel': ['adventure', 'vacation', 'explore', 'wanderlust', 'journey', 'destination', 'tourism', 'backpacking'],
    'art': ['painting', 'drawing', 'creative', 'design', 'illustration', 'abstract', 'modern', 'digital'],
    'music': ['song', 'melody', 'rhythm', 'beat', 'concert', 'album', 'playlist', 'audio'],
    'technology': ['tech', 'coding', 'programming', 'software', 'gadgets', 'innovation', 'digital', 'startup'],
    'fashion': ['style', 'outfit', 'trend', 'clothing', 'accessories', 'runway', 'designer', 'vintage'],
    'gaming': ['videogames', 'esports', 'streaming', 'console', 'pc', 'mobile', 'multiplayer', 'indie']
  };

  const getRelatedTags = (tag: string): string[] => {
    const lowerTag = tag.toLowerCase();
    return relatedTagsData[lowerTag] || [
      'tutorial', 'guide', 'tips', 'howto', 'learn', 'basics', 'advanced', 'best'
    ];
  };

  const handleTagBarClick = (tag: string) => {
    setCurrentTag(tag);
    setSearchParams({ q: tag });
    setShowTagBar(true);
  };

  // Menu handlers
  const handleReport = (postId: string) => {
    showSuccess(`Report submitted for content ${postId}`);
  };

  const handleHide = (postId: string) => {
    showSuccess('Content hidden from search results');
  };

  const handleCopyLink = (postId: string) => {
    const shareUrl = `${window.location.origin}/search/${postId}`;
    navigator.clipboard.writeText(shareUrl);
    showSuccess('🔗 Link copied to clipboard!');
  };

  // Unified people + content search (real data only, honest empty, race-safe)
  const filterResults = useCallback(async (searchQuery: string, reqId: number) => {
    // 1. Instant sync content results from cache
    try {
      const sync = searchContent(searchQuery);
      if (reqId === requestIdRef.current && sync.results.length > 0) {
        setResults(sync.results);
      }
    } catch { /* ignore sync errors */ }

    // 2. Authoritative async search (people + content from server)
    try {
      const { results, users, isAiRecommended: aiRec } = await searchContentAsync(searchQuery);
      if (reqId !== requestIdRef.current) return;
      setResults(results);
      setUserResults(users || []);
      setIsAiRecommended(aiRec);
    } catch {
      if (reqId !== requestIdRef.current) return;
      setResults([]);
      setUserResults([]);
      setIsAiRecommended(false);
    }
  }, []);

  // Perform search when query changes (debounced, lag-free)
  useEffect(() => {
    if (query) {
      setIsLoading(true);
      const reqId = ++requestIdRef.current;
      const timer = setTimeout(async () => {
        await filterResults(query, reqId);
        if (reqId === requestIdRef.current) {
          setIsLoading(false);
          setIsInitialLoad(false);
        }
      }, 300);
      return () => clearTimeout(timer);
    } else {
      requestIdRef.current++;
      setResults(getAllContent().slice(0, 12));
      setUserResults([]);
      setIsAiRecommended(false);
      setIsLoading(false);
      setIsInitialLoad(false);
    }
  }, [query, filterResults]);

  // Show tag bar if URL contains a tag-like query
  useEffect(() => {
    if (query && !showTagBar) {
      // Check if query looks like a tag (single word, common tag categories)
      const isTagLike = query.trim().split(' ').length === 1 && 
                        Object.keys(relatedTagsData).some(tag => 
                          query.toLowerCase().includes(tag) || tag.includes(query.toLowerCase())
                        );
      
      if (isTagLike) {
        setCurrentTag(query);
        setShowTagBar(true);
      }
    }
  }, [query]);

  const handleSearch = (searchQuery: string) => {
    setSearchParams({ q: searchQuery });
  };

  const handleOpenProfile = (u: SearchedUser) => {
    if (!u?.id) return;
    navigate(`/profile/${encodeURIComponent(u.id)}`);
  };

  const handleSortChange = (value: string) => {
    setSortBy(value);
    const sortedResults = [...results].sort((a, b) => {
      switch (value) {
        case 'views':
          return (parseInt(String(b.views).replace(/[^0-9]/g, '')) || 0) - (parseInt(String(a.views).replace(/[^0-9]/g, '')) || 0);
        case 'newest':
          return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
        case 'oldest':
          return new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime();
        default:
          return 0;
      }
    });
    setResults(sortedResults);
  };

  // Category is a display filter over the current real search results —
  // it never replaces the query with unrelated content.
  const handleCategoryFilter = (value: string) => {
    setFilterCategory(value);
    if (!query && value === 'all') {
      setResults(getAllContent().slice(0, 20));
    }
  };

  const visibleResults = filterCategory === 'all'
    ? results
    : results.filter((r) => r.category === filterCategory);

  const handleSplitScreenToggle = () => {
    setShowSplitScreen(!showSplitScreen);
    if (!showSplitScreen && visibleResults.length > 0) {
      setSelectedItem(visibleResults[0]);
    }
  };

  const handleSelectItem = (item: SearchItem) => {
    setSelectedItem(item);
  };

  const handleCloseSplitScreen = () => {
    setShowSplitScreen(false);
    setSelectedItem(null);
  };

  const categories = ['all', ...Array.from(new Set(getAllContent().map(r => r.category)))];

  return (
    <>
      <SEOHead
        title={query ? `Search results for "${query}"` : undefined}
        searchQuery={query}
        category={category}
        resultsCount={results.length + userResults.length}
        canonicalUrl={typeof window !== 'undefined' ? window.location.href : undefined}
      />
      
      <div className="min-h-screen bg-background">
        {/* Search Header */}
        <div className="sticky top-0 bg-background/95 backdrop-blur-lg border-b border-border/50 z-40">
          <div className="container mx-auto px-4 py-4">
            <div className="flex flex-col md:flex-row gap-4 items-center">
              {/* Search Input */}
              <div className="w-full md:max-w-2xl">
                <SearchSuggest
                  onSearch={handleSearch}
                  placeholder="Search for content, users, tags..."
                  autoFocus={false}
                />
              </div>
              
              {/* Filters and View Mode */}
              <div className="flex items-center gap-4">
                <Select value={sortBy} onValueChange={handleSortChange}>
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="Sort by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="relevance">Relevance</SelectItem>
                    <SelectItem value="views">Most Viewed</SelectItem>
                    <SelectItem value="newest">Newest</SelectItem>
                    <SelectItem value="oldest">Oldest</SelectItem>
                  </SelectContent>
                </Select>
                
                <Select value={filterCategory} onValueChange={handleCategoryFilter}>
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map(cat => (
                      <SelectItem key={cat} value={cat}>
                        {cat === 'all' ? 'All Categories' : cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                
                <div className="flex items-center border rounded-md">
                  <Button
                    variant={viewMode === 'grid' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('grid')}
                    className="rounded-r-none"
                  >
                    <Grid className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={viewMode === 'list' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setViewMode('list')}
                    className="rounded-none border-l border-r"
                  >
                    <List className="h-4 w-4" />
                  </Button>
                  <Button
                    variant={viewMode === 'split' ? 'default' : 'ghost'}
                    size="sm"
                    onClick={handleSplitScreenToggle}
                    className="rounded-l-none"
                    title="Split Screen View"
                  >
                    <Monitor className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Search Results */}
        <div className="container mx-auto px-4 py-6">
          {/* Results Header */}
          <div className="mb-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h1 className="text-2xl font-bold mb-2">
                    {query ? `Search results for "${query}"` : 'Discover Content'}
                  </h1>
                  <p className="text-muted-foreground">
                    {isLoading
                      ? 'Searching people and content...'
                      : query
                        ? `Found ${userResults.length} ${userResults.length === 1 ? 'person' : 'people'} and ${results.length} ${results.length === 1 ? 'post' : 'posts'} for "${query}"`
                        : `Showing ${results.length} posts`}
                    {isAiRecommended && !isLoading && (results.length > 0 || userResults.length > 0) && (
                      <span className="ml-2 inline-flex items-center gap-1 text-xs bg-gradient-to-r from-purple-100 to-blue-100 dark:from-purple-900/30 dark:to-blue-900/30 text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-full font-medium">
                        <Sparkles className="h-3 w-3" />
                        Personalized
                      </span>
                    )}
                  </p>
                </div>
              </div>
              {/* People / Content tabs */}
              {query && (
                <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'all' | 'people' | 'content')}>
                  <TabsList className="w-fit">
                    <TabsTrigger value="all" className="flex items-center gap-1.5">
                      <Search className="h-3.5 w-3.5" /> All ({userResults.length + results.length})
                    </TabsTrigger>
                    <TabsTrigger value="people" className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" /> People ({userResults.length})
                    </TabsTrigger>
                    <TabsTrigger value="content" className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5" /> Content ({results.length})
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>
          </div>

          {/* People results */}
          {!isLoading && !isInitialLoad && query && (activeTab === 'all' || activeTab === 'people') && userResults.length > 0 && (
            <div className="mb-8">
              <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Users className="h-4 w-4" /> People
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {userResults.map((u) => (
                  <Card key={u.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="p-4 flex items-center gap-3">
                      <Avatar
                        className="h-12 w-12 cursor-pointer shrink-0"
                        onClick={() => handleOpenProfile(u)}
                      >
                        <AvatarImage src={u.avatar || undefined} alt={u.username || u.name || 'User'} />
                        <AvatarFallback>{(u.username || u.name || 'U').charAt(0).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div
                          className="font-semibold truncate cursor-pointer hover:text-primary"
                          onClick={() => handleOpenProfile(u)}
                        >
                          {u.username || u.name || 'User'}
                          {u.verified && <span className="ml-1 text-primary">✓</span>}
                        </div>
                        {u.name && u.username && u.name !== u.username && (
                          <div className="text-sm text-muted-foreground truncate">{u.name}</div>
                        )}
                        {u.bio && <div className="text-xs text-muted-foreground truncate mt-0.5">{u.bio}</div>}
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {(u.followers ?? 0)} followers{u.isPrivate ? ' • Private' : ''}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 shrink-0">
                        <FollowButton userId={u.id} userName={u.username || u.name || 'user'} size="sm" />
                        <Button variant="ghost" size="sm" onClick={() => handleOpenProfile(u)}>
                          View
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Tag Bar */}
          {showTagBar && currentTag && (
            <div className="mb-6 p-4 bg-muted/30 rounded-lg border border-border/50">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground">Browsing tag:</span>
                  <Badge variant="default" className="text-sm">
                    #{currentTag}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTagBar(false)}
                  className="h-6 w-6 p-0"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="text-xs text-muted-foreground self-center">Related tags:</span>
                {getRelatedTags(currentTag).map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-xs cursor-pointer hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-all duration-200"
                    onClick={() => handleTagBarClick(tag)}
                  >
                    #{tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Loading State with Skeletons */}
          {(isLoading || isInitialLoad) && (
            <div className="space-y-6">
              {/* Results Header Skeleton */}
              <div className="space-y-2">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-4 w-48" />
              </div>
              
              {/* Search Results Grid Skeleton */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {[...Array(6)].map((_, i) => (
                  <Card key={i} className="overflow-hidden">
                    <Skeleton className="h-48 w-full" />
                    <CardContent className="p-4 space-y-3">
                      <Skeleton className="h-5 w-full" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-3 w-12" />
                        </div>
                        <Skeleton className="h-3 w-20" />
                      </div>
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-6 w-16 rounded-full" />
                        <Skeleton className="h-6 w-20 rounded-full" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Split Screen View */}
          {showSplitScreen && (
            <SplitScreenView
              items={visibleResults}
              selectedItem={selectedItem}
              onSelectItem={handleSelectItem}
              onClose={handleCloseSplitScreen}
            />
          )}

          {/* AI Recommendation Banner — only when real matches exist */}
          {!isLoading && !isInitialLoad && isAiRecommended && query && (results.length > 0 || userResults.length > 0) && (
            <div className="mb-6 p-4 bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-950/30 dark:to-blue-950/30 border border-purple-200/50 dark:border-purple-800/30 rounded-lg">
              <div className="flex items-start gap-3">
                <Sparkles className="h-5 w-5 text-purple-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-purple-700 dark:text-purple-300">
                    Personalized results for "{query}"
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Ranked for you based on your interests. Only real Equyvo people and posts are shown.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Results Grid/List — respects People/Content tabs */}
          {!isLoading && !isInitialLoad && !showSplitScreen && visibleResults.length > 0 && (activeTab === 'all' || activeTab === 'content') && (
            <div className={cn(
              viewMode === 'grid' 
                ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6' 
                : 'space-y-4'
            )}>
              {visibleResults.map((result) => (
                <Card key={result.id} className="group hover:shadow-lg transition-all duration-300 cursor-pointer" onClick={() => handleOpenFullscreen(result, getFullscreenType(result.type))}>
                  {viewMode === 'grid' ? (
                    // Grid View
                    <>
                      <div className="relative bg-black">
                        <img
                          src={result.thumbnail}
                          alt={result.title}
                          loading="lazy"
                          className="w-full h-48 object-contain rounded-t-lg"
                        />
                        {result.type === 'video' && (
                          <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-1 rounded">
                            {result.duration}
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all duration-300 rounded-t-lg flex items-center justify-center">
                          <Button 
                            variant="secondary" 
                            size="sm" 
                            className="opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                            onClick={() => handleOpenFullscreen(result, getFullscreenType(result.type))}
                          >
                            {result.type === 'video' ? 'Play' : 'View'}
                          </Button>
                        </div>
                      </div>
                      <CardContent className="p-4">
                        <h3 className="font-semibold mb-2 line-clamp-2 group-hover:text-primary transition-colors">
                          {result.title}
                        </h3>
                        <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
                          {result.description}
                        </p>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span>{result.creator}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                            <Eye className="h-3 w-3" />
                            {result.views} views
                          </span>
                          </div>
                          <span>{result.publishedAt}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-3">
                          <Badge variant="secondary" className="text-xs">
                            {result.category}
                          </Badge>
                          {result.tags?.slice(0, 2).map(tag => (
                            <Badge 
                              key={tag} 
                              variant="outline" 
                              className="text-xs cursor-pointer hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-all duration-200"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Show tag bar and open content in fullscreen
                                handleTagBarClick(tag);
                                handleOpenFullscreen(result, getFullscreenType(result.type));
                              }}
                            >
                              #{tag}
                            </Badge>
                          ))}
                          <div className="ml-auto flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleComment(result.id, result.creator);
                              }}
                              title="Comment"
                            >
                              <MessageCircle className="h-3 w-3" />
                            </Button>
                            <StandardPostMenu
                              postId={result.id}
                              onReport={handleReport}
                              onHide={handleHide}
                              onCopyLink={handleCopyLink}
                              onShare={() => handleShare(result)}
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                            />
                          </div>
                        </div>
                      </CardContent>
                    </>
                  ) : (
                    // List View
                    <div className="flex gap-4 p-4">
                      <img
                        src={result.thumbnail}
                        alt={result.title}
                        loading="lazy"
                        className="w-32 h-20 object-contain bg-black rounded-md flex-shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold mb-1 line-clamp-1 group-hover:text-primary transition-colors">
                          {result.title}
                        </h3>
                        <p className="text-sm text-muted-foreground mb-2 line-clamp-2">
                          {result.description}
                        </p>
                        <div className="flex items-center gap-2 mb-2">
                          <Badge variant="secondary" className="text-xs">
                            {result.category}
                          </Badge>
                          {result.tags?.slice(0, 2).map(tag => (
                            <Badge 
                              key={tag} 
                              variant="outline" 
                              className="text-xs cursor-pointer hover:bg-primary/10 hover:border-primary/50 hover:text-primary transition-all duration-200"
                              onClick={(e) => {
                                e.stopPropagation();
                                // Show tag bar and open content in fullscreen
                                handleTagBarClick(tag);
                                handleOpenFullscreen(result, getFullscreenType(result.type));
                              }}
                            >
                              #{tag}
                            </Badge>
                          ))}
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <div className="flex items-center gap-2">
                            <span>{result.creator}</span>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                            <Eye className="h-3 w-3" />
                            {result.views} views
                          </span>
                            {result.type === 'video' && (
                              <>
                                <span>•</span>
                                <span>{result.duration}</span>
                              </>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleComment(result.id, result.creator);
                              }}
                              title="Comment"
                            >
                              <MessageCircle className="h-3 w-3" />
                            </Button>
                            <StandardPostMenu
                              postId={result.id}
                              onReport={handleReport}
                              onHide={handleHide}
                              onCopyLink={handleCopyLink}
                              onShare={() => handleShare(result)}
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
                            />
                          </div>
                          <span>{result.publishedAt}</span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <Badge variant="secondary" className="text-xs">
                          {result.category}
                        </Badge>
                        <div className="flex gap-2">
                          <Button 
                            variant="outline" 
                            size="sm"
                            onClick={() => handleOpenFullscreen(result, getFullscreenType(result.type))}
                          >
                            {result.type === 'video' ? 'Play' : 'View'}
                          </Button>
                          <StandardPostMenu
                            postId={result.id}
                            onReport={handleReport}
                            onHide={handleHide}
                            onCopyLink={handleCopyLink}
                            onShare={() => handleShare(result)}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}

          {/* No Results — honest empty state for people + content */}
          {!isLoading && !isInitialLoad && ((activeTab === 'all' && visibleResults.length === 0 && userResults.length === 0) || (activeTab === 'people' && userResults.length === 0) || (activeTab === 'content' && visibleResults.length === 0)) && (
            <div className="text-center py-12">
              <Search className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">No results found</h3>
              <p className="text-muted-foreground mb-4">
                {query ? `No people or content on Equyvo match "${query}"` : 'No content available yet — be the first to post!'}
              </p>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Try:</p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Using different keywords</li>
                  <li>• Browsing categories below</li>
                </ul>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {['Photography', 'Food', 'Fitness', 'Technology', 'Travel', 'Fashion', 'Art', 'Gaming', 'Music'].map(cat => (
                    <Badge
                      key={cat}
                      variant="outline"
                      className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-all"
                      onClick={() => handleCategoryFilter(cat)}
                    >
                      {cat}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Comment Section */}
      <CommentSection
        isOpen={showCommentSection}
        onClose={() => setShowCommentSection(false)}
        postId={currentPostId}
        postUser={currentPostUser}
      />

      {/* Fullscreen Viewer */}
      {fullscreenContent && (
        <FullscreenViewer
          content={fullscreenContent}
          type={fullscreenType}
          onClose={handleCloseFullscreen}
          onExpand={handleExpandFullscreen}
        />
      )}
    </>
  );
};

export default SearchPage;
