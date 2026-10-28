import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { X, Share2, ThumbsUp, MessageCircle, Bookmark, Play, Eye, Users, Compass } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { showSuccess } from '@/utils/toast';
import { avatarOf } from '@/utils/avatar';
import { useI18n } from '@/lib/i18n';
import FullscreenViewer from '@/components/FullscreenViewer';
import CommentSection from '@/components/CommentSection';
import { navItems } from '@/components/Navbar';
import { navigateToProfile, ownerIdOf } from '@/utils/profile-navigation';
import { openShareSheet } from '@/utils/share';
import api from '@/lib/api';
import { normalizeContentItem, resolveMediaFields } from '@/lib/media';
import { toCount } from '@/lib/count';

interface FullscreenBrowseProps {
  isOpen: boolean;
  onClose: () => void;
  /** Live discover feed — the desktop view shows real content, never dummies. */
  items?: any[];
  isLoading?: boolean;
}

const FullscreenBrowse: React.FC<FullscreenBrowseProps> = ({ isOpen, onClose, items, isLoading }) => {
  const [likedItems, setLikedItems] = useState<Set<string>>(new Set());
  const [savedItems, setSavedItems] = useState<Set<string>>(new Set());
  const [commentSectionOpen, setCommentSectionOpen] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedPostUser, setSelectedPostUser] = useState<string>('');
  const [fullscreenContent, setFullscreenContent] = useState<any>(null);
  const [fullscreenType, setFullscreenType] = useState<'post' | 'live' | 'video' | 'moment' | 'image'>('image');
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();

  if (!isOpen) return null;

  // Real feed content: featured first, the rest ranked by reach in Trending.
  // Normalise every card so raw media arrays/objects resolve to real posters.
  const feed = (Array.isArray(items) ? items : []).map((item) => normalizeContentItem(item));
  const featuredContent = feed.slice(0, 6);
  const trendingContent = [...feed.slice(6)]
    .sort((a, b) => (Number(b?.views) || 0) - (Number(a?.views) || 0));

  const handleLike = (itemId: string) => {
    const liking = !likedItems.has(itemId);
    setLikedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
        showSuccess('💔 Removed from liked');
      } else {
        newSet.add(itemId);
        showSuccess('❤️ Added to liked');
      }
      return newSet;
    });
    // Persist so the creator is notified and the count is shared.
    if (itemId && !itemId.startsWith('live-')) {
      void api.like(itemId, liking ? 'like' : 'unlike').catch(() => undefined);
    }
  };

  const handleShare = (content: any) => {
    const contentId = String(content?.id || content?.videoId || '').trim();
    const shareUrl = contentId
      ? `${window.location.origin}/app/home?post=${encodeURIComponent(contentId)}`
      : window.location.href;
    openShareSheet({
      title: content?.title || 'Check this out on Equyvo',
      text: `Check out this ${content?.type || 'post'} by ${content?.creator || 'creator'}!`,
      url: shareUrl,
    });
  };

  const handleComment = (content: any) => {
    setSelectedPostId(content.id);
    setSelectedPostUser(content.creator);
    setCommentSectionOpen(true);
  };

  const handleContentClick = (content: any) => {
    // Open content in fullscreen viewer (mirrors the page grid's toFullscreen:
    // live stays live, anything playable opens as a portrait moment).
    const fields = resolveMediaFields(content);
    const isLive = content.isLive || content.live || String(content.contentType || '').toLowerCase() === 'live';
    const hasVideo = Boolean(fields.videoUrl);
    const fullscreenData = {
      ...content,
      videoUrl: fields.videoUrl || undefined,
      image: fields.image,
      thumbnail: fields.thumbnail,
      media: fields.media,
      likes: content.likes || 0,
      comments: content.comments || 0,
      views: content.views || 0,
      verified: content.verified === true,
      published: content.published || 'Recently',
      description: content.description || `Amazing ${content.type} content by ${content.creator}`,
      forcePortrait: hasVideo && !isLive,
    };

    setFullscreenContent(fullscreenData);
    setFullscreenType(isLive ? 'live' : hasVideo ? 'moment' : 'image');
  };

  const handleCloseFullscreen = () => {
    setFullscreenContent(null);
  };

  const handleSave = (itemId: string) => {
    setSavedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
        showSuccess('📁 Removed from saved');
      } else {
        newSet.add(itemId);
        showSuccess('📁 Added to saved');
      }
      return newSet;
    });
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  // Navigate + collapse the overlay so the destination renders in the shell.
  const goNav = (path: string) => {
    onClose();
    if (location.pathname !== path) navigate(path);
  };

  return (
    <div className="bar-anchored-overlay bg-black z-50 flex flex-col">
      {/* Header — anchored between the shell's bars, so the app navigation
          (Home, Discover, Moments…) stays visible while browsing. The
          internal strip mirrors the same destinations. */}
      <div className="bg-black/90 backdrop-blur-md border-b border-white/10 pt-3 pb-0">
        <div className="flex items-center justify-between max-w-7xl mx-auto px-4 py-2">
          <span className="flex items-center gap-2 text-white/70">
            <Compass className="h-5 w-5" />
            <h1 className="text-white text-base font-semibold">Desktop Browse</h1>
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="text-white hover:bg-white/10"
              title="Exit Fullscreen"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
        {/* Nav strip: Home · Discover · Create · Moments · Thoughts · Profile · Settings.
            Wraps instead of scrolling sideways, so nothing needs a drag. */}
        <nav className="max-w-7xl mx-auto px-4">
          <div className="flex items-center flex-wrap gap-1 sm:gap-2 pb-2">
            <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-white/40 mr-2 shrink-0">
              <Compass className="h-3.5 w-3.5" /> Browse
            </span>
            {navItems.map((item) => {
              const active = location.pathname === item.path;
              return (
                <button
                  key={item.name}
                  onClick={() => goNav(item.path)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 sm:px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-all duration-200 border ${
                    active
                      ? 'bg-primary/20 text-white border-primary/40'
                      : 'bg-white/5 text-white/70 border-transparent hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  <span>{t(item.name)}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-7xl mx-auto p-4 sm:p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-24 text-white/70">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white/60"></div>
            </div>
          ) : feed.length === 0 ? (
            <div className="text-center py-24">
              <Compass className="h-12 w-12 mx-auto mb-4 text-white/30" />
              <h2 className="text-white text-xl font-semibold mb-2">Nothing to browse yet</h2>
              <p className="text-white/50 text-sm max-w-sm mx-auto">New uploads show up here. Open the normal Discover feed to post or explore categories.</p>
            </div>
          ) : (
            <>
              {/* Featured Section */}
              {featuredContent.length > 0 && (
                <div className="mb-8">
                  <h2 className="text-white text-2xl font-bold mb-4">Featured</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {featuredContent.map((content) => (
                      <Card key={content.id} className="bg-gray-900 border-gray-800 overflow-hidden group cursor-pointer hover:shadow-xl transition-all duration-300" style={{ pointerEvents: 'auto' }} onClick={() => {
                        handleContentClick(content);
                      }}>
                        <div className="relative aspect-video">
                          <img
                            src={content.thumbnail || content.image || ''}
                            alt={content.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            loading="lazy"
                            onError={(e) => {
                              // One lost thumbnail request must not leave a
                              // broken image forever — cache-bust once, then
                              // hide the broken icon.
                              const img = e.currentTarget;
                              const attempts = Number(img.dataset.thumbRetry || '0');
                              const base = content.thumbnail || content.image || '';
                              if (!base) { img.style.display = 'none'; return; }
                              if (attempts < 1) {
                                img.dataset.thumbRetry = '1';
                                img.src = `${base}${base.includes('?') ? '&' : '?'}retry=1`;
                              } else {
                                img.style.display = 'none';
                              }
                            }}
                          />
                          {content.mediaType === 'video' && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="bg-black/60 rounded-full p-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Play className="h-6 w-6 text-white" />
                              </div>
                            </div>
                          )}
                          {content.isLive && (
                            <div className="absolute top-2 left-2 bg-red-600 text-white px-2 py-1 rounded text-xs font-bold animate-pulse">
                              LIVE
                            </div>
                          )}
                          {content.duration && !content.isLive && (
                            <div className="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                              {content.duration}
                            </div>
                          )}
                        </div>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  navigateToProfile(navigate, ownerIdOf(content) || content.creatorId, content.creator);
                                }}
                                className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                aria-label={`Open ${content.creator || 'creator'}'s profile`}
                                title={`Open ${content.creator || 'creator'}'s profile`}
                              >
                                <Avatar className="h-8 w-8 cursor-pointer">
                                  {avatarOf(content) ? <AvatarImage src={avatarOf(content)} /> : null}
                                  <AvatarFallback className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                                    {(content.creator || 'U').substring(0, 2).toUpperCase()}
                                  </AvatarFallback>
                                </Avatar>
                              </button>
                              <div>
                                <h3 className="text-white font-semibold text-sm line-clamp-1">{content.title}</h3>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigateToProfile(navigate, ownerIdOf(content) || content.creatorId, content.creator);
                                    }}
                                    className="text-gray-400 text-xs hover:text-white hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                  >
                                    {content.creator}
                                  </button>
                                  {content.verified && (
                                    <Badge className="bg-blue-500 rounded-full p-0.5 h-3 w-3 p-0 flex items-center justify-center">
                                      <span className="sr-only">Verified</span>
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-4 text-gray-400 text-xs mb-3">
                            {content.views ? (
                              <span className="flex items-center gap-1">
                                <Eye className="h-3 w-3" /> {formatNumber(content.views)}
                              </span>
                            ) : null}
                            {content.viewers ? (
                              <span className="flex items-center gap-1">
                                <Users className="h-3 w-3" /> {formatNumber(content.viewers)} watching
                              </span>
                            ) : null}
                          </div>

                          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()} style={{ pointerEvents: 'auto' }}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleLike(content.id);
                              }}
                              className={`text-gray-400 hover:text-white ${likedItems.has(content.id) ? 'text-red-500' : ''}`}
                            >
                              <ThumbsUp className={`h-4 w-4 ${likedItems.has(content.id) ? 'fill-current' : ''}`} />
                              {toCount(content.likes) > 0 ? <span className="ml-1 text-xs">{formatNumber(toCount(content.likes))}</span> : null}
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleComment(content);
                              }}
                              className="text-gray-400 hover:text-white"
                            >
                              <MessageCircle className="h-4 w-4" />
                              {content.comments ? <span className="ml-1 text-xs">{formatNumber(content.comments)}</span> : null}
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleShare(content);
                              }}
                              className="text-gray-400 hover:text-white"
                            >
                              <Share2 className="h-4 w-4" />
                            </Button>

                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSave(content.id);
                              }}
                              className={`text-gray-400 hover:text-white ${savedItems.has(content.id) ? 'text-blue-500' : ''}`}
                            >
                              <Bookmark className={`h-4 w-4 ${savedItems.has(content.id) ? 'fill-current' : ''}`} />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* Trending Grid */}
              {trendingContent.length > 0 && (
                <div>
                  <h2 className="text-white text-2xl font-bold mb-4">Trending Now</h2>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                    {trendingContent.map((content) => (
                      <div key={content.id} className="relative group cursor-pointer" style={{ pointerEvents: 'auto' }} onClick={() => {
                        handleContentClick(content);
                      }}>
                        <div className="aspect-square rounded-lg overflow-hidden">
                          <img
                            src={content.thumbnail || content.image || ''}
                            alt={content.title}
                            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                            loading="lazy"
                            onError={(e) => {
                              const img = e.currentTarget;
                              const attempts = Number(img.dataset.thumbRetry || '0');
                              const base = content.thumbnail || content.image || '';
                              if (!base) { img.style.display = 'none'; return; }
                              if (attempts < 1) {
                                img.dataset.thumbRetry = '1';
                                img.src = `${base}${base.includes('?') ? '&' : '?'}retry=1`;
                              } else {
                                img.style.display = 'none';
                              }
                            }}
                          />
                          {content.mediaType === 'video' && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="bg-black/60 rounded-full p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Play className="h-4 w-4 text-white" />
                              </div>
                            </div>
                          )}
                          {content.duration && (
                            <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[10px] px-1 py-0.5 rounded">
                              {content.duration}
                            </div>
                          )}
                        </div>
                        <div className="mt-2">
                          <p className="text-white text-xs font-medium line-clamp-1">{content.title}</p>
                          <div className="flex items-center gap-1 text-gray-400 text-[10px]">
                            <span>{content.creator}</span>
                          </div>
                          <div className="flex items-center gap-2 text-gray-400 text-[10px] mt-1">
                            <span className="flex items-center gap-0.5">
                              <Eye className="h-2 w-2" /> {formatNumber(toCount(content.views))}
                            </span>
                            <span className="flex items-center gap-0.5">
                              <ThumbsUp className="h-2 w-2" /> {formatNumber(toCount(content.likes))}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Fullscreen Viewer */}
      {fullscreenContent && (
        <FullscreenViewer
          content={fullscreenContent}
          type={fullscreenType}
          onClose={handleCloseFullscreen}
        />
      )}

      {/* Comment Section */}
      <CommentSection
        isOpen={commentSectionOpen}
        onClose={() => setCommentSectionOpen(false)}
        postId={selectedPostId || ''}
        postUser={selectedPostUser}
      />
    </div>
  );
};

export default FullscreenBrowse;
