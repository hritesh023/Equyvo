import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Repeat, Maximize, Sparkles, Eye, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import FollowButton from './FollowButton';
import CommentSection from './CommentSection';
import SafeFullscreenViewer from './SafeFullscreenViewer';
import SaveButton from './SaveButton';
import LikeButton from './LikeButton';
import VotingButtons from './VotingButtons';
import ShareButton from './ShareButton';
import StandardPostMenu from './StandardPostMenu';
import ReportModal from './ReportModal';
import EditProfileContentModal from './EditProfileContentModal';
import { showSuccess, showError } from '@/utils/toast';
import { deleteContent } from '@/utils/delete';
import { Post } from '@/types';
import { navigateToProfile, ownerIdOf } from '@/utils/profile-navigation';
import { useMemo } from 'react';
import { withInFeedAds } from '@/lib/feed-ads';
import { shouldShowAds } from '@/lib/ads-config';
import { useAdPlan } from '@/hooks/use-ad-plan';
import InFeedAdGate from './ads/InFeedAdGate';
import { resolveMediaFields } from '@/lib/media';
import { toCount } from '@/lib/count';
import ResilientImage from '@/components/ResilientImage';
import ResilientVideo from '@/components/ResilientVideo';

interface ExtendedPost extends Post {
  type: 'post' | 'thought' | 'reacted';
  originalAuthor?: string;
  originalPostId?: string;
  engagement?: number;
  relevanceScore?: number;
  tags?: string[];
  categories?: string[];
  // Voting properties for thoughts
  upvotes_count?: number;
  downvotes_count?: number;
  user_vote?: 'upvote' | 'downvote' | null;
  // Additional properties for fullscreen compatibility
  videoUrl?: string;
  media?: string;
  thumbnail?: string;
  duration?: string;
}

interface ForYouFeedProps {
  posts: Post[];
  userInterests?: string[];
  userCategories?: string[];
  onLike: (postId: string) => void;
  onReact: (postId: string) => void;
  onComment: (postId: string, postUser: string) => void;
  onShare: (post: Post) => void;
  onFullscreen: (post: Post) => void;
  onReport: (postId: string) => void;
  onDelete: (postId: string) => void;
  onAddToHistory?: (post: Post) => void;
  onVote?: (postId: string, voteType: 'upvote' | 'downvote') => void;
  onCommentCountChange?: (postId: string, count: number) => void;
  likedPosts: Set<string>;
  reactedPosts: Set<string>;
  postLikes: { [key: string]: number };
  postReacts: { [key: string]: number };
  postCommentCounts?: { [key: string]: number };
  currentUserId?: string;
  isProfilePage?: boolean;
}

const ForYouFeed: React.FC<ForYouFeedProps> = ({
  posts,
  userInterests = [],
  userCategories = [],
  onLike,
  onReact,
  onComment,
  onShare,
  onFullscreen,
  onReport,
  onDelete,
  onAddToHistory,
  onVote,
  onCommentCountChange,
  likedPosts,
  reactedPosts,
  postLikes,
  postReacts,
  postCommentCounts,
  currentUserId,
  isProfilePage = false
}) => {
  const navigate = useNavigate();
  const [recommendedPosts, setRecommendedPosts] = useState<Post[]>([]);
  const [showCommentSection, setShowCommentSection] = useState(false);
  const [currentPostId, setCurrentPostId] = useState<string>('');
  const [currentPostUser, setCurrentPostUser] = useState<string>('');
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportPostId, setReportPostId] = useState<string>('');
  const [editingPostId, setEditingPostId] = useState<string>('');
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingPost, setEditingPost] = useState<Post | null>(null);

  // ── UX-friendly native ads: in-feed slots only, never on video ──
  const adPlan = useAdPlan();
  const feedRows = useMemo(
    () =>
      shouldShowAds(adPlan)
        ? withInFeedAds(recommendedPosts, {
            placement: 'home-foryou',
            plan: adPlan,
            keyOf: (p) => (p as Post).id,
          })
        : recommendedPosts.map((value) => ({
            kind: 'content' as const,
            value,
            key: value.id,
          })),
    [recommendedPosts, adPlan],
  );

  // Content recommendation algorithm
  const calculateRelevanceScore = (post: Post): number => {
    let score = 0;
    
    // Base engagement score (counters may be missing on legacy rows — safe)
    const engagementScore = (toCount(post.likes) + toCount(post.reacts) * 2 + toCount(post.comments) * 3) / 10;
    score += engagementScore;
    
    // Time decay (newer content gets higher score)
    const timeAgo = parseInt(post.time) || 1;
    const timeScore = Math.max(0, 10 - timeAgo);
    score += timeScore;
    
    // Interest matching
    if (post.tags) {
      const matchingTags = post.tags.filter(tag => 
        userInterests.some(interest => 
          interest.toLowerCase().includes(tag.toLowerCase()) || 
          tag.toLowerCase().includes(interest.toLowerCase())
        )
      );
      score += matchingTags.length * 5;
    }
    
    // Category matching
    if (post.categories) {
      const matchingCategories = post.categories.filter(category => 
        userCategories.some(userCategory => 
          userCategory.toLowerCase() === category.toLowerCase()
        )
      );
      score += matchingCategories.length * 3;
    }
    
    // Content analysis (simple keyword matching)
    const contentLower = post.content.toLowerCase();
    userInterests.forEach(interest => {
      if (contentLower.includes(interest.toLowerCase())) {
        score += 2;
      }
    });
    
    // Diversity boost for unique accounts
    const uniqueAccountBonus = Math.random() * 2; // Add some randomness for diversity
    score += uniqueAccountBonus;
    
    return score;
  };

  // Apply recommendation algorithm and sort posts
  useEffect(() => {
    const postsWithScores = posts.map(post => ({
      ...post,
      relevanceScore: calculateRelevanceScore(post)
    }));
    
    // Sort by relevance score (descending)
    const sortedPosts = postsWithScores.sort((a, b) => 
      (b.relevanceScore || 0) - (a.relevanceScore || 0)
    );
    
    setRecommendedPosts(sortedPosts);
  }, [posts]); // Remove userInterests and userCategories from dependencies to prevent infinite loops

  const handleComment = (postId: string, postUser: string) => {
    setCurrentPostId(postId);
    setCurrentPostUser(postUser);
    setShowCommentSection(true);
  };

  const handleReport = (postId: string) => {
    setReportPostId(postId);
    setShowReportModal(true);
  };

  const handleDelete = async (postId: string) => {
    const post = recommendedPosts.find(p => p.id === postId);
    const contentType = post?.type === 'thought' ? 'thought' : post?.type === 'moment' ? 'moment' : post?.type === 'story' ? 'story' : 'post';
    try {
      await deleteContent({ postId, contentType, onDeleteComplete: onDelete });
    } catch {
    }
  };

  const handleEdit = (postId: string) => {
    const post = recommendedPosts.find(p => p.id === postId);
    if (post) {
      setEditingPost(post);
      setEditingPostId(postId);
      setShowEditModal(true);
    }
  };

  const handleSaveEdit = (updatedPost: any) => {
    setShowEditModal(false);
    setEditingPost(null);
    setEditingPostId('');
  };

  const handleContentClick = (post: Post) => {
    // Add to watch history
    if (onAddToHistory) {
      onAddToHistory(post);
    }
    
    // Enhanced content structure for fullscreen viewer
    const isMomentPost = post.type === 'moment';
    const resolved = resolveMediaFields(post);
    const vid = resolved.videoUrl;
    const img = resolved.image || resolved.thumbnail;
    const aud = resolved.audioUrl;
    const hasVideo = Boolean(vid);
    const fullscreenContent = {
      ...post,
      type: isMomentPost ? 'moment' : (hasVideo ? ('video' as any) : (aud ? ('audio' as any) : (img ? ('image' as any) : post.type))), // Keep original type when no media
      videoUrl: vid,
      audioUrl: aud,
      media: vid || aud || img,
      thumbnail: img,
      mediaType: hasVideo ? 'video' : (aud ? 'audio' : (img ? 'image' : 'text')),
      creator: post.user,
      content: post.content,
      likes: post.likes,
      comments: post.comments,
      views: post.views,
      time: post.time,
      published: post.time,
      duration: post.duration,
      description: post.content,
      creatorId: ownerIdOf(post) || post.user,
      // Only real values: never invent verified/subscriber counts.
      verified: (post as any).verified === true,
      fallbackImage: img,
      // Ensure proper aspect ratio for images
      aspectRatio: isMomentPost ? '9/16' : (img ? '16/9' : undefined),
      forcePortrait: isMomentPost
    };
    
    
    // Open content in fullscreen viewer
    onFullscreen(fullscreenContent as any);
  };

  return (
    <>
      <Card className="p-4">
        <CardTitle className="mb-4 text-lg flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-yellow-500" />
          For You
          <span className="text-sm text-muted-foreground font-normal">
            - Personalized content based on your interests
          </span>
        </CardTitle>
        
        {recommendedPosts.length === 0 ? (
          <div className="text-center py-8">
            <Sparkles className="w-12 h-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No personalized content yet</p>
            <p className="text-gray-400 text-sm mt-1">Start engaging with posts to get better recommendations</p>
          </div>
        ) : (
          <div className="space-y-4">
            {feedRows.map((row) => {
              if (row.kind === 'ad') {
                return <InFeedAdGate key={row.key} placement="home-foryou" />;
              }
              const post = row.value;
              return (
              <Card key={post.id} className="p-4 slide-up border-l-4 border-l-yellow-400">
                <CardHeader className="flex flex-row items-center justify-between p-0 mb-4">
                  <div className="flex items-center gap-3">
                    <Avatar 
                      className="h-10 w-10 cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all duration-200"
                      onClick={() => {
                        // Navigate to the CREATOR's profile: real owner id
                        // first, username route as fallback (never post.id,
                        // never the viewer's own profile).
                        navigateToProfile(navigate, ownerIdOf(post) || undefined, post.user);
                      }}
                      title={`${post.user}'s Profile`}
                    >
                      <AvatarImage src={post.avatar} />
                      <AvatarFallback>{post.user.substring(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <CardTitle className="text-base">
                        {post.user}
                      </CardTitle>
                      <p className="text-sm text-muted-foreground">{post.time}</p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <FollowButton userId={ownerIdOf(post)} userName={post.user} />
                    
                    <StandardPostMenu
                      postId={post.id}
                      postUserId={ownerIdOf(post) || post.user}
                      postOwnerId={ownerIdOf(post)}
                      currentUserId={currentUserId}
                      isProfilePage={isProfilePage}
                      onReport={handleReport}
                      onDelete={handleDelete}
                      onEdit={handleEdit}
                      onShare={(postId) => onShare(posts.find(p => p.id === postId))}
                      onHide={(postId) => {
                        // Handle hide functionality - remove from feed
                        const updatedPosts = posts.filter(p => p.id !== postId);
                        // You might want to update the parent component's posts state
                        showSuccess('Post hidden from feed');
                      }}
                      onCopyLink={(postId) => {
                        // Shared links open the exact post in the feed.
                        const shareUrl = `${window.location.origin}/app/home?post=${encodeURIComponent(postId)}`;
                        navigator.clipboard.writeText(shareUrl)
                          .then(() => showSuccess('🔗 Link copied to clipboard!'))
                          .catch(() => showError("Couldn't copy the link."));
                      }}
                    />
                  </div>
                </CardHeader>
                
                <CardContent className="p-0">
                  <p className="mb-4 cursor-pointer hover:text-primary transition-colors" onClick={() => handleContentClick(post)}>
                    {post.content}
                  </p>
                  
                  {(() => {
                    const resolved = resolveMediaFields(post);
                    const vid = resolved.videoUrl;
                    const img = resolved.image || resolved.thumbnail;
                    const aud = resolved.audioUrl;
                    const isVideo = Boolean(vid);
                    if (isVideo) {
                      return (
                        <ResilientVideo
                          src={vid}
                          poster={img || undefined}
                          controls
                          playsInline
                          preload="metadata"
                          className="w-full rounded-lg mb-4 aspect-video bg-black cursor-pointer object-contain"
                          style={{ width: '100%' }}
                          onClick={() => handleContentClick(post)}
                          fallbackRenderer={(
                            <div className="text-muted-foreground text-sm p-6 text-center" role="status">
                              Video could not load right now.
                              <button
                                type="button"
                                className="block mx-auto mt-1 text-primary underline underline-offset-2"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.reload();
                                }}
                              >
                                Retry
                              </button>
                            </div>
                          )}
                        />
                      );
                    }
                    if (aud) {
                      return (
                        <audio
                          src={aud}
                          controls
                          preload="metadata"
                          className="mb-4 w-full rounded-lg"
                          onClick={(e) => e.stopPropagation()}
                          aria-label="Audio content"
                        />
                      );
                    }
                    if (img) {
                      return (
                        <ResilientImage
                          src={img}
                          fallbackSrc={resolved.thumbnail || undefined}
                          alt="Post content"
                          loading="lazy"
                          className="w-full rounded-lg mb-4 object-contain bg-black max-h-96 cursor-pointer"
                          onClick={() => handleContentClick(post)}
                        />
                      );
                    }
                    return null;
                  })()}
                  
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                    {post.type === 'thought' ? (
                      <VotingButtons
                        thoughtId={post.id}
                        upvotesCount={toCount((post as any).upvotes_count)}
                        downvotesCount={toCount(post.downvotes_count)}
                        likesCount={toCount(post.likes)}
                        userVote={post.user_vote || null}
                        userHasLiked={likedPosts.has(post.id)}
                        onVote={(thoughtId, voteType) => onVote?.(thoughtId, voteType)}
                        onLike={() => onLike(post.id)}
                        size="sm"
                      />
                    ) : (
                      <>
                        <LikeButton
                          isLiked={likedPosts.has(post.id)}
                          likesCount={toCount(postLikes[post.id] ?? post.likes)}
                          onLike={() => onLike(post.id)}
                          size="sm"
                        />
                        
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className={`flex items-center gap-1 ${reactedPosts.has(post.id) ? 'text-green-500' : ''}`}
                          onClick={() => onReact(post.id)}
                          title="React to make this post yours"
                        >
                          <Repeat className={`h-4 w-4 ${reactedPosts.has(post.id) ? 'fill-current' : ''}`} /> 
                          {toCount(postReacts[post.id] ?? post.reacts)}
                        </Button>
                      </>
                    )}
                    
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="flex items-center gap-1"
                      onClick={() => handleComment(post.id, post.user)}
                    >
                      <MessageCircle className="h-4 w-4" /> {toCount(postCommentCounts?.[post.id] ?? post.comments)}
                    </Button>
                    
                    <ShareButton
                      post={post}
                      size="sm"
                      showCount={true}
                      sharesCount={post.shares}
                      onShare={() => onShare(post)}
                    />
                    
                    <SaveButton postId={post.id} content={post} />
                    
                    {post.views && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Eye className="h-3 w-3" />
                        {post.views}
                      </div>
                    )}
                    
                    {post.image && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="flex items-center gap-1"
                        onClick={() => onFullscreen(post)}
                        title="View in fullscreen"
                      >
                        <Maximize className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
              );
            })}
          </div>
        )}
      </Card>

      <CommentSection
        isOpen={showCommentSection}
        onClose={() => setShowCommentSection(false)}
        postId={currentPostId}
        postUser={currentPostUser}
        onCommentCountChange={onCommentCountChange}
      />
      
      <ReportModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        contentId={reportPostId}
        contentType="post"
      />
      
      {showEditModal && editingPost && (
        <EditProfileContentModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          currentContent={{
            id: editingPost.id,
            content: editingPost.content,
            type: editingPost.type as 'post' | 'thought' | 'moment',
            image: editingPost.image
          }}
          onSave={handleSaveEdit}
        />
      )}
    </>
  );
};

export default ForYouFeed;
