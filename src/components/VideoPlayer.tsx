import React, { useState, useRef, useEffect } from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { 
  Play, Pause, Volume2, VolumeX, Maximize2, 
  Settings, ThumbsUp, MessageCircle, Share2, 
  Clock, Calendar, Tag, Users, ChevronDown,
  SkipBack, SkipForward, RotateCcw, PictureInPicture, Minimize, Monitor, Minimize2
} from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';
import SaveButton from './SaveButton';
import LongFormVideos from './LongFormVideos';
import { getAuthenticatedUser } from '@/lib/auth';

interface VideoPlayerProps {
  video?: any;
  secondVideo?: any;
  onClose?: () => void;
  followedCreators: Set<string>;
  onFollow: (creatorId: string) => void;
  onComment: (videoId: string, creator: string) => void;
  onShare: (video: any) => void;
  onVideoClick?: (video: any) => void;
  viewMode?: 'fullscreen' | 'windowed' | 'halfscreen' | 'splitscreen';
  onVideoChange?: (video: any) => void;
  onSecondVideoChange?: (video: any) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  video,
  secondVideo,
  onClose,
  followedCreators,
  onFollow,
  onComment,
  onShare,
  onVideoClick,
  viewMode = 'fullscreen',
  onVideoChange,
  onSecondVideoChange
}) => {
  // Guard clause to prevent rendering if video is undefined
  if (!video) {
    return (
      <div className="fixed inset-0 bg-black z-50 flex items-center justify-center">
        <div className="text-white text-center">
          <p className="text-lg mb-4">Video not available</p>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(video?.likes || 0);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [userLikes, setUserLikes] = useState<Set<string>>(new Set());
  const [currentViewMode, setCurrentViewMode] = useState<'fullscreen' | 'windowed' | 'halfscreen' | 'splitscreen'>(viewMode);
  const [currentVideo, setCurrentVideo] = useState(video);
  const [currentVideoUrl, setCurrentVideoUrl] = useState(video?.videoUrl || video?.media || '');
  const [currentSecondVideo, setCurrentSecondVideo] = useState(secondVideo);
  const [currentSecondVideoUrl, setCurrentSecondVideoUrl] = useState(secondVideo?.videoUrl || secondVideo?.media || '');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSecond, setIsLoadingSecond] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [retryCountSecond, setRetryCountSecond] = useState(0);
  
  // Check if current video is a moment (should be portrait)
  const isPortraitMoment = currentVideo?.type === 'moment' || currentVideo?.forcePortrait;
  const isPortraitSecondMoment = currentSecondVideo?.type === 'moment' || currentSecondVideo?.forcePortrait;
  
  // Force fullscreen mode for moments
  useEffect(() => {
    if (isPortraitMoment && currentViewMode !== 'fullscreen') {
      setCurrentViewMode('fullscreen');
    }
  }, [isPortraitMoment, currentViewMode]);
  
  // Second video states
  const [isPlayingSecond, setIsPlayingSecond] = useState(false);
  const [isMutedSecond, setIsMutedSecond] = useState(false);
  const [volumeSecond, setVolumeSecond] = useState(1);
  const [currentTimeSecond, setCurrentTimeSecond] = useState(0);
  const [durationSecond, setDurationSecond] = useState(0);
  const [showControlsSecond, setShowControlsSecond] = useState(true);
  const secondVideoRef = useRef<HTMLVideoElement>(null);

  // Update current video when prop changes
  useEffect(() => {
    if (video && video.id !== currentVideo?.id) {
      setCurrentVideo(video);
      setCurrentVideoUrl(video?.videoUrl || video?.media || '');
      setRetryCount(0);
      // Reset like state for new video
      setIsLiked(false);
      setLikeCount(video?.likes || 0);
    }
  }, [video]);
  
  // Update second video when prop changes
  useEffect(() => {
    if (secondVideo && secondVideo.id !== currentSecondVideo?.id) {
      setCurrentSecondVideo(secondVideo);
      setCurrentSecondVideoUrl(secondVideo?.videoUrl || secondVideo?.media || '');
      setRetryCountSecond(0);
    }
  }, [secondVideo]);

  // Handle video change from sidebar
  const handleVideoChange = (newVideo: any) => {
    console.log('VideoPlayer: handleVideoChange called with:', newVideo);
    setCurrentVideo(newVideo);
    setCurrentVideoUrl(newVideo?.videoUrl || newVideo?.media || '');
    setRetryCount(0);
    setIsLoading(false);
    
    // Notify parent component of the change
    if (onVideoChange) {
      onVideoChange(newVideo);
    }
    
    // Also call onVideoClick if provided (for compatibility)
    if (onVideoClick) {
      onVideoClick(newVideo);
    }
  };
  
  // Handle second video change
  const handleSecondVideoChange = (newVideo: any) => {
    console.log('VideoPlayer: handleSecondVideoChange called with:', newVideo);
    setCurrentSecondVideo(newVideo);
    setCurrentSecondVideoUrl(newVideo?.videoUrl || newVideo?.media || '');
    setRetryCountSecond(0);
    setIsLoadingSecond(false);
    
    // Notify parent component of the change
    if (onSecondVideoChange) {
      onSecondVideoChange(newVideo);
    }
  };

  useEffect(() => {
    setCurrentViewMode(viewMode);
  }, [viewMode]);

  // Get current user and check if they've liked the video
  useEffect(() => {
    const getCurrentUser = async () => {
      const user = await getAuthenticatedUser();
      setCurrentUser(user as any);
      
      if (user && currentVideo?.id) {
        // Mock like check
        const hasLiked = localStorage.getItem(`liked_${currentVideo.id}`) === 'true';
        setIsLiked(hasLiked);
        setLikeCount(prev => hasLiked ? prev + 1 : prev);
      }
    };
    
    getCurrentUser();
  }, [currentVideo?.id]);

  // Check if user has already liked this video (mock implementation)
  const checkIfUserLikedVideo = async (userId: string, videoId: string) => {
    try {
      // Mock check using localStorage
      const hasLiked = localStorage.getItem(`liked_${videoId}`) === 'true';
      setIsLiked(hasLiked);
    } catch (error) {
      console.error('Error checking like status:', error);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (currentViewMode === 'fullscreen' || currentViewMode === 'halfscreen' || currentViewMode === 'splitscreen')) {
        setCurrentViewMode('windowed');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentViewMode]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
  };
  
  const togglePlaySecond = () => {
    const video = secondVideoRef.current;
    if (!video) return;

    if (isPlayingSecond) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlayingSecond(!isPlayingSecond);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;

    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };
  
  const toggleMuteSecond = () => {
    const video = secondVideoRef.current;
    if (!video) return;

    video.muted = !isMutedSecond;
    setIsMutedSecond(!isMutedSecond);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const newTime = parseFloat(e.target.value);
    video.currentTime = newTime;
    setCurrentTime(newTime);
  };
  
  const handleSeekSecond = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = secondVideoRef.current;
    if (!video) return;

    const newTime = parseFloat(e.target.value);
    video.currentTime = newTime;
    setCurrentTimeSecond(newTime);
  };

  const handleLike = async () => {
    if (!currentUser) {
      showError('Please log in to like videos');
      return;
    }

    if (!currentVideo?.id) {
      showError('Video ID not found');
      return;
    }

    const videoId = currentVideo.id;
    const userId = currentUser.id;
    const newIsLiked = !isLiked;

    try {
      if (newIsLiked) {
        // Add like (mock implementation)
        localStorage.setItem(`liked_${videoId}`, 'true');
        setLikeCount(prev => prev + 1);
        showSuccess('Video liked!');
      } else {
        // Remove like (mock implementation)
        localStorage.setItem(`liked_${videoId}`, 'false');
        setLikeCount(prev => Math.max(0, prev - 1));
        showSuccess('Like removed');
      }
    } catch (error) {
      console.error('Error updating like:', error);
      showError('Failed to update like');
    }
  };

  const handleVideoError = async (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const videoElement = e.target as HTMLVideoElement;
    const videoSrc = currentVideo?.videoUrl || currentVideo?.media || '';
    
    console.error('Video error in VideoPlayer:', {
      error: e,
      videoError: videoElement.error,
      networkState: videoElement.networkState,
      readyState: videoElement.readyState,
      src: videoElement.src,
      currentSrc: videoElement.currentSrc,
      videoSrc: videoSrc,
      currentVideoUrl: currentVideoUrl,
      retryCount: retryCount,
      video: currentVideo
    });

    // Try fallback URLs if available
    if (currentVideo?.fallbackUrls && retryCount < currentVideo.fallbackUrls.length) {
      setIsLoading(true);
      const nextUrl = currentVideo.fallbackUrls[retryCount];
      console.log(`Retrying with fallback URL ${retryCount + 1}: ${nextUrl}`);
      
      setCurrentVideoUrl(nextUrl);
      setRetryCount(retryCount + 1);
      
      // Reset video element with new URL
      if (videoRef.current) {
        videoRef.current.src = nextUrl;
        videoRef.current.load();
      }
      
      setIsLoading(false);
    } else {
      showError('Video failed to load. Please try again later.');
    }
  };
  
  const handleSecondVideoError = async (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const videoElement = e.target as HTMLVideoElement;
    const videoSrc = currentSecondVideo?.videoUrl || currentSecondVideo?.media || '';
    
    console.error('Second video error in VideoPlayer:', {
      error: e,
      videoError: videoElement.error,
      networkState: videoElement.networkState,
      readyState: videoElement.readyState,
      src: videoElement.src,
      currentSrc: videoElement.currentSrc,
      videoSrc: videoSrc,
      currentVideoUrl: currentSecondVideoUrl,
      retryCount: retryCountSecond,
      video: currentSecondVideo
    });

    // Try fallback URLs if available
    if (currentSecondVideo?.fallbackUrls && retryCountSecond < currentSecondVideo.fallbackUrls.length) {
      setIsLoadingSecond(true);
      const nextUrl = currentSecondVideo.fallbackUrls[retryCountSecond];
      console.log(`Retrying second video with fallback URL ${retryCountSecond + 1}: ${nextUrl}`);
      
      setCurrentSecondVideoUrl(nextUrl);
      setRetryCountSecond(retryCountSecond + 1);
      
      // Reset video element with new URL
      if (secondVideoRef.current) {
        secondVideoRef.current.src = nextUrl;
        secondVideoRef.current.load();
      }
      
      setIsLoadingSecond(false);
    } else {
      showError('Second video failed to load. Please try again later.');
    }
  };

  const handlePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (error) {
      showError('Picture-in-Picture not supported');
    }
  };

  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const getViewModeClasses = () => {
    switch (currentViewMode) {
      case 'windowed':
        return 'fixed bottom-4 right-4 bg-black z-[999999] rounded-lg overflow-hidden shadow-2xl border border-gray-700';
      case 'halfscreen':
        return 'fixed inset-0 bg-black z-[999999] overflow-hidden m-0 p-0 box-border';
      case 'splitscreen':
        return 'fixed inset-0 bg-black z-[999999] overflow-hidden m-0 p-0 box-border';
      case 'fullscreen':
      default:
        return 'fixed inset-0 bg-black z-[999999] overflow-hidden m-0 p-0 box-border';
    }
  };

  const getContainerClasses = () => {
    switch (currentViewMode) {
      case 'windowed':
        return 'w-96 h-56';
      case 'halfscreen':
        return 'w-full h-full';
      case 'splitscreen':
        return 'w-full h-full';
      case 'fullscreen':
      default:
        return 'w-full h-full';
    }
  };

  const getLayoutClasses = () => {
    switch (currentViewMode) {
      case 'windowed':
        return 'w-full h-full flex flex-col';
      case 'halfscreen':
        return 'w-full h-full grid grid-cols-2 gap-0';
      case 'splitscreen':
        return 'w-full h-full grid grid-cols-2 gap-0';
      case 'fullscreen':
      default:
        return 'w-full h-full grid grid-cols-1 lg:grid-cols-3';
    }
  };

  // Reusable Video Player Component
  const VideoPlayerComponent = ({ 
    video, 
    videoUrl, 
    isPlaying, 
    isMuted, 
    currentTime, 
    duration, 
    showControls, 
    isLoading, 
    videoRef, 
    onTogglePlay, 
    onToggleMute, 
    onSeek, 
    onError, 
    onLoadStart, 
    onCanPlay, 
    onLoadedMetadata,
    onTimeUpdate,
    position = 'left'
  }: {
    video: any;
    videoUrl: string;
    isPlaying: boolean;
    isMuted: boolean;
    currentTime: number;
    duration: number;
    showControls: boolean;
    isLoading: boolean;
    videoRef: React.RefObject<HTMLVideoElement>;
    onTogglePlay: () => void;
    onToggleMute: () => void;
    onSeek: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onError: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
    onLoadStart: () => void;
    onCanPlay: () => void;
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
    onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
    position?: 'left' | 'right';
  }) => {
    const getVideoStyles = () => {
      if (currentViewMode === 'splitscreen') {
        return {
          width: '50vw',
          height: '100vh',
          objectFit: (position === 'left' && isPortraitMoment) || (position === 'right' && isPortraitSecondMoment) ? 'contain' : 'cover',
          margin: 0,
          padding: 0,
          position: 'fixed' as const,
          top: 0,
          left: position === 'left' ? 0 : '50vw',
          boxSizing: 'border-box' as const,
          ...(position === 'left' && isPortraitMoment && { aspectRatio: '9/16' }),
          ...(position === 'right' && isPortraitSecondMoment && { aspectRatio: '9/16' })
        };
      }
      return {};
    };

    const getContainerStyles = () => {
      if (currentViewMode === 'splitscreen') {
        return {
          width: '50vw',
          height: '100vh',
          margin: 0,
          padding: 0,
          position: 'fixed' as const,
          top: 0,
          left: position === 'left' ? 0 : '50vw',
          boxSizing: 'border-box' as const
        };
      }
      return {};
    };

    return (
      <div className="relative w-full h-full bg-black" style={getContainerStyles()}>
        <div 
          className={`relative bg-black overflow-hidden ${
            currentViewMode === 'splitscreen' ? 'w-full h-full' : 
            currentViewMode === 'fullscreen' ? 'w-screen h-screen' : 
            currentViewMode === 'halfscreen' ? 'w-full h-full' : 
            'w-full h-full'
          }`}
          style={getVideoStyles()}
          onMouseMove={() => showControls && currentViewMode === 'splitscreen' && setShowControls(true)}
          onMouseLeave={() => isPlaying && currentViewMode === 'splitscreen' && setShowControls(false)}
        >
          <video
            key={videoUrl} // Only recreate when URL changes, not when view mode changes
            ref={videoRef}
            src={videoUrl}
            className={`w-full h-full ${(position === 'left' && isPortraitMoment) || (position === 'right' && isPortraitSecondMoment) ? 'object-contain' : 'object-cover'}`}
            style={getVideoStyles()}
            onClick={onTogglePlay}
            onLoadedMetadata={onLoadedMetadata}
            onTimeUpdate={onTimeUpdate}
            onError={onError}
            onLoadStart={onLoadStart}
            onCanPlay={onCanPlay}
            preload="metadata" // Add preload to prevent reloading
          />
          
          {/* Loading Indicator */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <p className="text-white text-sm font-medium">Loading video...</p>
              </div>
            </div>
          )}
          
          {/* Video Controls Overlay */}
          <div className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'} pointer-events-none`}>
            {/* Top Controls */}
            <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-auto">
              <div className="flex items-center gap-2">
                <div className="bg-black/70 text-white px-3 py-1 rounded-full text-sm font-medium">
                  {position === 'left' ? 'Video 1' : 'Video 2'}
                </div>
              </div>
              {video && (
                <div className="bg-black/70 text-white px-3 py-1 rounded-full text-sm truncate max-w-xs">
                  {video.title}
                </div>
              )}
            </div>
            
            {/* Center Play/Pause */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Button 
                variant="ghost" 
                size="lg" 
                onClick={onTogglePlay}
                className="bg-white/20 hover:bg-white/30 text-white rounded-full p-4 pointer-events-auto"
              >
                {isPlaying ? <Pause className="h-8 w-8" /> : <Play className="h-8 w-8" />}
              </Button>
            </div>
            
            {/* Bottom Controls */}
            <div className="absolute bottom-0 left-0 right-0 p-2 pointer-events-auto">
              {/* Enhanced Progress Bar */}
              <div className="mb-2">
                <div className="relative w-full h-2 bg-white/30 rounded-full overflow-hidden cursor-pointer group">
                  {/* Progress Background */}
                  <div className="absolute inset-0 bg-white/30 rounded-full" />
                  {/* Progress Fill */}
                  <div 
                    className="absolute left-0 top-0 h-full bg-gradient-to-r from-red-500 to-red-600 rounded-full transition-all duration-100 ease-out"
                    style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                  />
                  {/* Buffered Progress */}
                  <div 
                    className="absolute left-0 top-0 h-full bg-white/50 rounded-full transition-all duration-300"
                    style={{ 
                      width: videoRef.current?.buffered?.length && videoRef.current.buffered.end(videoRef.current.buffered.length - 1) 
                        ? `${(videoRef.current.buffered.end(videoRef.current.buffered.length - 1) / duration) * 100}%` 
                        : '0%' 
                    }}
                  />
                  {/* Hover Effect */}
                  <div className="absolute inset-0 bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-full" />
                  {/* Seek Handle */}
                  <div 
                    className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 transform group-hover:scale-110"
                    style={{ left: `calc(${duration ? (currentTime / duration) * 100 : 0}% - 8px)` }}
                  />
                  {/* Clickable Overlay */}
                  <input
                    type="range"
                    min="0"
                    max={duration || 0}
                    value={currentTime}
                    onChange={onSeek}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    style={{ appearance: 'none', background: 'transparent' }}
                    onClick={(e) => e.stopPropagation()} // Prevent video click when seeking
                  />
                </div>
                <div className="flex justify-between text-xs text-white mt-1">
                  <span className="font-medium drop-shadow-sm">{formatTime(currentTime)}</span>
                  <span className="font-medium drop-shadow-sm">{formatTime(duration)}</span>
                </div>
              </div>
              
              {/* Control Buttons */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={onTogglePlay} className="text-white hover:bg-white/20 pointer-events-auto">
                    {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={onToggleMute} className="text-white hover:bg-white/20 pointer-events-auto">
                    {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={getViewModeClasses()}>
      <div className={getContainerClasses()}>
        <div className={getLayoutClasses()}>
          {currentViewMode === 'splitscreen' ? (
            // Split Screen Mode - Two Videos Side by Side
            <>
              {/* First Video */}
              <div className="col-span-1">
                <VideoPlayerComponent
                  video={currentVideo}
                  videoUrl={currentVideoUrl}
                  isPlaying={isPlaying}
                  isMuted={isMuted}
                  currentTime={currentTime}
                  duration={duration}
                  showControls={showControls}
                  isLoading={isLoading}
                  videoRef={videoRef}
                  onTogglePlay={togglePlay}
                  onToggleMute={toggleMute}
                  onSeek={handleSeek}
                  onError={handleVideoError}
                  onLoadStart={() => setIsLoading(true)}
                  onCanPlay={() => setIsLoading(false)}
                  onLoadedMetadata={(e) => {
                    const video = e.target as HTMLVideoElement;
                    setDuration(video.duration);
                    setIsLoading(false);
                  }}
                  onTimeUpdate={(e) => {
                    const video = e.target as HTMLVideoElement;
                    setCurrentTime(video.currentTime);
                  }}
                  position="left"
                />
              </div>
              
              {/* Second Video */}
              <div className="col-span-1">
                <VideoPlayerComponent
                  video={currentSecondVideo}
                  videoUrl={currentSecondVideoUrl}
                  isPlaying={isPlayingSecond}
                  isMuted={isMutedSecond}
                  currentTime={currentTimeSecond}
                  duration={durationSecond}
                  showControls={showControlsSecond}
                  isLoading={isLoadingSecond}
                  videoRef={secondVideoRef}
                  onTogglePlay={togglePlaySecond}
                  onToggleMute={toggleMuteSecond}
                  onSeek={handleSeekSecond}
                  onError={handleSecondVideoError}
                  onLoadStart={() => setIsLoadingSecond(true)}
                  onCanPlay={() => setIsLoadingSecond(false)}
                  onLoadedMetadata={(e) => {
                    const video = e.target as HTMLVideoElement;
                    setDurationSecond(video.duration);
                    setIsLoadingSecond(false);
                  }}
                  onTimeUpdate={(e) => {
                    const video = e.target as HTMLVideoElement;
                    setCurrentTimeSecond(video.currentTime);
                  }}
                  position="right"
                />
              </div>
            </>
          ) : (
            // Other Modes - Single Video
            <div className={
              currentViewMode === 'windowed' ? 'w-full h-full' : 
              currentViewMode === 'halfscreen' ? 'col-span-1' : 
              'lg:col-span-2'
            }>
            <div className="relative w-full h-full bg-black">
              {/* Video Element */}
              <div
                className={`relative bg-black overflow-hidden ${
                  currentViewMode === 'fullscreen' ? 'w-screen h-screen' :
                  currentViewMode === 'halfscreen' ? 'w-full h-full' :
                  'w-full h-full'
                }`}
                style={{
                  ...(currentViewMode === 'fullscreen' && {
                    width: '100vw',
                    height: '100vh',
                    margin: 0,
                    padding: 0,
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    boxSizing: 'border-box'
                  }),
                  ...(currentViewMode === 'halfscreen' && {
                    width: '50vw',
                    height: '100vh',
                    margin: 0,
                    padding: 0,
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    boxSizing: 'border-box'
                  }),
                  ...(currentViewMode === 'windowed' && {
                    width: '100%',
                    height: '100%',
                    position: 'relative',
                    boxSizing: 'border-box'
                  })
                }}
                onMouseMove={() => setShowControls(true)}
                onMouseLeave={() => isPlaying && setShowControls(false)}
              >
                <video
                  key={currentVideoUrl} // Only recreate when URL changes, not when view mode changes
                  ref={videoRef}
                  src={currentVideoUrl}
                  className={`w-full h-full ${isPortraitMoment ? 'object-contain' : 'object-cover'}`}
                  style={{
                    ...(currentViewMode === 'fullscreen' && {
                      width: '100vw',
                      height: '100vh',
                      objectFit: isPortraitMoment ? 'contain' : 'cover',
                      margin: 0,
                      padding: 0,
                      position: 'fixed',
                      top: 0,
                      left: 0,
                      boxSizing: 'border-box',
                      ...(isPortraitMoment && { aspectRatio: '9/16' })
                    }),
                    ...(currentViewMode === 'halfscreen' && {
                      width: '50vw',
                      height: '100vh',
                      objectFit: isPortraitMoment ? 'contain' : 'cover',
                      margin: 0,
                      padding: 0,
                      position: 'fixed',
                      top: 0,
                      left: 0,
                      boxSizing: 'border-box',
                      ...(isPortraitMoment && { aspectRatio: '9/16' })
                    }),
                    ...(currentViewMode === 'windowed' && {
                      width: '100%',
                      height: '100%',
                      objectFit: isPortraitMoment ? 'contain' : 'cover',
                      position: 'relative',
                      boxSizing: 'border-box',
                      ...(isPortraitMoment && { aspectRatio: '9/16' })
                    })
                  }}
                  onClick={togglePlay}
                  onLoadedMetadata={(e) => {
                    const video = e.target as HTMLVideoElement;
                    setDuration(video.duration);
                    setIsLoading(false);
                  }}
                  onTimeUpdate={(e) => {
                    const video = e.target as HTMLVideoElement;
                    setCurrentTime(video.currentTime);
                  }}
                  onError={handleVideoError}
                  onLoadStart={() => setIsLoading(true)}
                  onCanPlay={() => setIsLoading(false)}
                  preload="metadata" // Add preload to prevent reloading
                />
                {/* Loading Indicator */}
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-20">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      <p className="text-white text-sm font-medium">Loading video...</p>
                    </div>
                  </div>
                )}
                {/* Video Controls Overlay */}
                <div className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0'} pointer-events-none`}>
                  {/* Top Controls */}
                  <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-auto">
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={onClose} className="text-white hover:bg-white/20 bg-black/50 pointer-events-auto">
                        ×
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      {currentViewMode === 'windowed' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCurrentViewMode('fullscreen')}
                          className="text-white hover:bg-white/20 bg-black/50 pointer-events-auto"
                          title="Expand to full screen"
                        >
                          <Maximize2 className="h-4 w-4" />
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCurrentViewMode('splitscreen')}
                            className="text-white hover:bg-white/20 bg-black/50 pointer-events-auto"
                            title="Switch to split screen"
                          >
                            <Monitor className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCurrentViewMode('halfscreen')}
                            className="text-white hover:bg-white/20 bg-black/50 pointer-events-auto"
                            title="Switch to half screen"
                          >
                            <Minimize className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setCurrentViewMode('windowed')}
                            className="text-white hover:bg-white/20 bg-black/50 pointer-events-auto"
                            title="Minimize to small window"
                          >
                            <Minimize2 className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Center Play/Pause */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <Button
                      variant="ghost"
                      size="lg"
                      onClick={togglePlay}
                      className="bg-white/20 hover:bg-white/30 text-white rounded-full p-4 pointer-events-auto"
                    >
                      {isPlaying ? <Pause className="h-8 w-8" /> : <Play className="h-8 w-8" />}
                    </Button>
                  </div>

                  {/* Bottom Controls */}
                  <div className="absolute bottom-0 left-0 right-0 p-2 pointer-events-auto">
                    {/* Enhanced Progress Bar */}
                    <div className="mb-2">
                      <div className="relative w-full h-2 bg-white/30 rounded-full overflow-hidden cursor-pointer group">
                        {/* Progress Background */}
                        <div className="absolute inset-0 bg-white/30 rounded-full" />
                        {/* Progress Fill */}
                        <div
                          className="absolute left-0 top-0 h-full bg-gradient-to-r from-red-500 to-red-600 rounded-full transition-all duration-100 ease-out"
                          style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                        />
                        {/* Buffered Progress */}
                        <div
                          className="absolute left-0 top-0 h-full bg-white/50 rounded-full transition-all duration-300"
                          style={{
                            width: videoRef.current?.buffered?.length && videoRef.current.buffered.end(videoRef.current.buffered.length - 1)
                              ? `${(videoRef.current.buffered.end(videoRef.current.buffered.length - 1) / duration) * 100}%`
                              : '0%'
                          }}
                        />
                        {/* Hover Effect */}
                        <div className="absolute inset-0 bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-full" />
                        {/* Seek Handle */}
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 transform group-hover:scale-110"
                          style={{ left: `calc(${duration ? (currentTime / duration) * 100 : 0}% - 8px)` }}
                        />
                        {/* Clickable Overlay */}
                        <input
                          type="range"
                          min="0"
                          max={duration || 0}
                          value={currentTime}
                          onChange={handleSeek}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                          style={{ appearance: 'none', background: 'transparent' }}
                          onClick={(e) => e.stopPropagation()} // Prevent video click when seeking
                        />
                      </div>
                      <div className="flex justify-between text-xs text-white mt-1">
                        <span className="font-medium drop-shadow-sm">{formatTime(currentTime)}</span>
                        <span className="font-medium drop-shadow-sm">{formatTime(duration)}</span>
                      </div>
                    </div>

                    {/* Control Buttons */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={togglePlay} className="text-white hover:bg-white/20 pointer-events-auto">
                          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        </Button>
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={toggleMute} className="text-white hover:bg-white/20 pointer-events-auto">
                            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </div>
          )}
          
          {/* Sidebar for Halfscreen Mode - Long Form Videos */}
          {currentViewMode === 'halfscreen' && (
            <div className="col-span-1 bg-background border-l overflow-hidden" style={{
              width: '50vw',
              height: '100vh',
              position: 'fixed',
              top: 0,
              right: 0,
              boxSizing: 'border-box'
            }}>
              <div className="h-full overflow-y-auto">
                <LongFormVideos
                  onVideoClick={handleVideoChange}
                  onComment={onComment}
                  onShare={onShare}
                  followedCreators={followedCreators}
                  onFollow={onFollow}
                  hideTitle={true}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoPlayer;
