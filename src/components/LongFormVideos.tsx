import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PlayCircle, Play, ThumbsUp, MessageCircle, Share2, Eye, Users, Clock, Calendar, Hash } from 'lucide-react';
import SaveButton from '@/components/SaveButton';
import { showSuccess } from '@/utils/toast';
import { useWatchHistory } from '@/hooks/useWatchHistory';

// Enhanced long-form videos data with more comprehensive information and fallback URLs
const longFormVideosData = [
  {
    id: 'lfv1',
    title: 'Building Modern Web Apps with Next.js 14 - Complete Course',
    creator: 'TechDev Studio',
    creatorId: 'techdev',
    thumbnail: 'https://picsum.photos/seed/nextjs-course/1280/720',
    views: 125000,
    likes: 8500,
    duration: '45:30',
    category: 'Technology',
    published: '1 day ago',
    description: 'Learn how to build modern web applications using Next.js 14 with the latest features and best practices. This comprehensive course covers everything from setup to deployment.',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    fallbackUrls: [
      'https://www.w3schools.com/html/mov_bbb.mp4'
    ],
    type: 'video',
    subscribers: 45000,
    verified: true,
    tags: ['nextjs', 'react', 'web development', 'javascript'],
    engagement: {
      comments: 234,
      shares: 89,
      watchTime: '85%'
    }
  },
  {
    id: 'lfv2',
    title: 'Street Photography Masterclass - Urban Documentary',
    creator: 'Photo Academy',
    creatorId: 'photoacademy',
    thumbnail: 'https://picsum.photos/seed/street-photo/1280/720',
    views: 89000,
    likes: 6200,
    duration: '32:15',
    category: 'Photography',
    published: '3 days ago',
    description: 'Master the art of street photography with professional techniques and composition tips. Learn to capture compelling stories in urban environments.',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
    fallbackUrls: [
      'https://test-videos.co.uk/vids/tears-of-steel/mp4/h264/720/Tears_Of_Steel_720_480_1MB.mp4',
      'https://www.w3schools.com/html/movie.mp4'
    ],
    type: 'video',
    subscribers: 32000,
    verified: true,
    tags: ['photography', 'street', 'composition', 'art'],
    engagement: {
      comments: 156,
      shares: 67,
      watchTime: '72%'
    }
  },
  {
    id: 'lfv3',
    title: 'Mindfulness & Meditation for Beginners - Complete Guide',
    creator: 'Wellness Guide',
    creatorId: 'wellness',
    thumbnail: 'https://picsum.photos/seed/meditation/1280/720',
    views: 156000,
    likes: 12400,
    duration: '28:45',
    category: 'Health',
    published: '1 week ago',
    description: "Start your mindfulness journey with this comprehensive beginner's guide to meditation. Reduce stress and improve your mental well-being.",
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    fallbackUrls: [
      'https://www.w3schools.com/html/mov_bbb.mp4'
    ],
    type: 'video',
    subscribers: 67000,
    verified: false,
    tags: ['meditation', 'mindfulness', 'health', 'wellness'],
    engagement: {
      comments: 445,
      shares: 178,
      watchTime: '91%'
    }
  },
  {
    id: 'lfv4',
    title: 'Advanced Cooking Techniques - Professional Chef Secrets',
    creator: 'Chef Masterclass',
    creatorId: 'chefmaster',
    thumbnail: 'https://picsum.photos/seed/cooking-tech/1280/720',
    views: 203000,
    likes: 18900,
    duration: '55:20',
    category: 'Food',
    published: '2 weeks ago',
    description: 'Elevate your cooking skills with advanced techniques from professional chefs. Learn knife skills, sauce making, and plating like a pro.',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    fallbackUrls: [
      'https://test-videos.co.uk/vids/tears-of-steel/mp4/h264/720/Tears_Of_Steel_720_480_1MB.mp4',
      'https://www.w3schools.com/html/movie.mp4'
    ],
    type: 'video',
    subscribers: 89000,
    verified: true,
    tags: ['cooking', 'techniques', 'culinary', 'food'],
    engagement: {
      comments: 567,
      shares: 234,
      watchTime: '78%'
    }
  },
  {
    id: 'lfv5',
    title: 'JavaScript Design Patterns - Clean Code Architecture',
    creator: 'Code Masters',
    creatorId: 'codemasters',
    thumbnail: 'https://picsum.photos/seed/js-patterns/1280/720',
    views: 67000,
    likes: 4500,
    duration: '38:10',
    category: 'Programming',
    published: '4 days ago',
    description: 'Learn essential JavaScript design patterns and write cleaner, more maintainable code. Perfect for intermediate developers.',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    fallbackUrls: [
      'https://test-videos.co.uk/vids/sintel/mp4/h264/720/Sintel_720_480_1MB.mp4',
      'https://www.w3schools.com/html/mov_bbb.mp4'
    ],
    type: 'video',
    subscribers: 23000,
    verified: true,
    tags: ['javascript', 'design patterns', 'clean code', 'architecture'],
    engagement: {
      comments: 123,
      shares: 45,
      watchTime: '83%'
    }
  },
  {
    id: 'lfv6',
    title: 'Yoga for Flexibility - Beginner to Advanced Poses',
    creator: 'Yoga Flow',
    creatorId: 'yogaflow',
    thumbnail: 'https://picsum.photos/seed/yoga-flex/1280/720',
    views: 98000,
    likes: 7800,
    duration: '42:00',
    category: 'Fitness',
    published: '5 days ago',
    description: 'Improve your flexibility with this comprehensive yoga routine. From basic stretches to advanced poses, suitable for all levels.',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    fallbackUrls: [
      'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      'https://www.w3schools.com/html/movie.mp4'
    ],
    type: 'video',
    subscribers: 34000,
    verified: false,
    tags: ['yoga', 'flexibility', 'fitness', 'wellness'],
    engagement: {
      comments: 289,
      shares: 112,
      watchTime: '87%'
    }
  }
];

interface LongFormVideosProps {
  onVideoClick: (video: any) => void;
  onComment: (videoId: string, creator: string) => void;
  onShare: (video: any) => void;
  followedCreators: Set<string>;
  onFollow: (creatorId: string) => void;
  hideTitle?: boolean;
}

const LongFormVideos: React.FC<LongFormVideosProps> = ({
  onVideoClick,
  onComment,
  onShare,
  followedCreators,
  onFollow,
  hideTitle = false
}) => {
  const { addToWatchHistory } = useWatchHistory();
  const [hoveredVideoId, setHoveredVideoId] = useState<string | null>(null);

  const handleVideoHover = (videoId: string, isHovering: boolean) => {
    setHoveredVideoId(isHovering ? videoId : null);
  };

  const handleVideoClick = (video: any) => {
    addToWatchHistory(video);
    onVideoClick(video);
    showSuccess(`🎬 Now playing: ${video.title}`);
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const getCategoryColor = (category: string) => {
    const colors: { [key: string]: string } = {
      'Technology': 'bg-blue-500',
      'Photography': 'bg-purple-500',
      'Health': 'bg-green-500',
      'Food': 'bg-orange-500',
      'Programming': 'bg-indigo-500',
      'Fitness': 'bg-red-500'
    };
    return colors[category] || 'bg-gray-500';
  };

  if (longFormVideosData.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlayCircle className="h-5 w-5 text-red-500" />
            Long-form Videos
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12">
            <PlayCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-muted-foreground text-lg mb-2">No long-form videos available</p>
            <p className="text-muted-foreground text-sm">Check back later for amazing content</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {!hideTitle && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlayCircle className="h-5 w-5 text-red-500" />
            Long-form Videos
            <Badge variant="secondary" className="ml-2">
              {longFormVideosData.length}
            </Badge>
          </CardTitle>
        </CardHeader>
      )}
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {longFormVideosData.map((video) => (
            <Card 
              key={video.id} 
              className="overflow-hidden hover:shadow-lg transition-all duration-300 group cursor-pointer"
              onClick={() => handleVideoClick(video)}
              onMouseEnter={() => handleVideoHover(video.id, true)}
              onMouseLeave={() => handleVideoHover(video.id, false)}
            >
              {/* Video Thumbnail Section */}
              <div className="relative">
                <div className="relative w-full h-48 overflow-hidden bg-black">
                  <img 
                    src={video.thumbnail} 
                    alt={video.title} 
                    className={`w-full h-full object-cover transition-transform duration-300 ${
                      hoveredVideoId === video.id ? 'scale-105' : 'scale-100'
                    }`} 
                  />
                  
                  {/* Play Button Overlay */}
                  <div className={`absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center ${
                    hoveredVideoId === video.id ? 'opacity-100' : 'opacity-0'
                  }`}>
                    <div className="bg-white/90 rounded-full p-3 shadow-lg transform group-hover:scale-110 transition-transform duration-300">
                      <Play className="h-6 w-6 text-red-500 fill-current ml-1" />
                    </div>
                  </div>
                  
                  {/* Duration Badge */}
                  <Badge variant="secondary" className="absolute bottom-2 right-2 text-xs bg-black/70 text-white">
                    {video.duration}
                  </Badge>
                  
                  {/* Category Badge */}
                  <div className="absolute top-2 left-2">
                    <Badge variant="outline" className={`text-xs bg-black/90 text-white border-white/20`}>
                      {video.category}
                    </Badge>
                  </div>

                  {/* Watch Time Indicator */}
                  {video.engagement?.watchTime && (
                    <div className="absolute bottom-2 left-2">
                      <div className="flex items-center gap-1 bg-black/70 rounded px-2 py-1">
                        <Clock className="h-3 w-3 text-white" />
                        <span className="text-xs text-white">{video.engagement.watchTime}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Video Information Section */}
              <CardContent className="p-4">
                {/* Creator Info */}
                <div className="flex items-start gap-3 mb-3">
                  <Avatar className="h-10 w-10 flex-shrink-0">
                    <AvatarImage src={`https://picsum.photos/seed/${video.creatorId}/100/100`} />
                    <AvatarFallback className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                      {video.creator.substring(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-sm mb-1 line-clamp-2 group-hover:text-primary transition-colors">
                      {video.title}
                    </h3>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium hover:text-foreground transition-colors cursor-pointer">
                        {video.creator}
                      </span>
                      {video.verified && (
                        <div className="bg-blue-500 rounded-full p-0.5">
                          <div className="w-2 h-2 bg-white rounded-full"></div>
                        </div>
                      )}
                      <span>•</span>
                      <span>{formatNumber(video.subscribers)} followers</span>
                    </div>
                  </div>
                </div>
                
                {/* Description */}
                <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                  {video.description}
                </p>
                
                {/* Video Stats */}
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <Eye className="h-3 w-3" /> {formatNumber(video.views)}
                    </span>
                    <span className="flex items-center gap-1">
                      <ThumbsUp className="h-3 w-3" /> {formatNumber(video.likes)}
                    </span>
                    {video.engagement?.comments && (
                      <span className="flex items-center gap-1">
                        <MessageCircle className="h-3 w-3" /> {formatNumber(video.engagement.comments)}
                      </span>
                    )}
                  </div>
                  <span>{video.published}</span>
                </div>
                
                {/* Tags */}
                <div className="flex flex-wrap gap-1 mb-3">
                  {video.tags.slice(0, 3).map((tag, index) => (
                    <Badge key={index} variant="outline" className="text-xs px-2 py-0.5">
                      #{tag}
                    </Badge>
                  ))}
                  {video.tags.length > 3 && (
                    <Badge variant="outline" className="text-xs px-2 py-0.5">
                      +{video.tags.length - 3}
                    </Badge>
                  )}
                </div>
                
                {/* Action Buttons */}
                <div className="flex items-center justify-between pt-3 border-t">
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="flex items-center gap-1 hover:bg-red-50 hover:text-red-600 transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        showSuccess('Liked!');
                      }}
                    >
                      <ThumbsUp className="h-4 w-4" />
                      <span className="text-xs">{formatNumber(video.likes)}</span>
                    </Button>
                    
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="flex items-center gap-1 hover:bg-blue-50 hover:text-blue-600 transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        onComment(video.id, video.creator);
                      }}
                    >
                      <MessageCircle className="h-4 w-4" />
                      <span className="text-xs">Comment</span>
                    </Button>
                    
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="flex items-center gap-1 hover:bg-green-50 hover:text-green-600 transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        onShare(video);
                      }}
                    >
                      <Share2 className="h-4 w-4" />
                      <span className="text-xs">Share</span>
                    </Button>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <div onClick={(e) => e.stopPropagation()}>
                      <SaveButton postId={video.id} content={video} />
                    </div>
                    <Button 
                      variant={followedCreators.has(video.creatorId) ? "default" : "outline"} 
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onFollow(video.creatorId);
                      }}
                    >
                      {followedCreators.has(video.creatorId) ? "Following" : "Follow"}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

export default LongFormVideos;
