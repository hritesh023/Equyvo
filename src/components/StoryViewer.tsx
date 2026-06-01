"use client";

import React, { useState, useEffect, useRef } from 'react';
import { X, MoreVertical, MessageCircle, Send, Volume2, VolumeX, Play, Pause, Bookmark, Flag, Trash2, Share2 } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import ReportButton from '@/components/ReportButton';
import SaveButton from '@/components/SaveButton';
import ShareButton from '@/components/ShareButton';
import { showSuccess, showError } from '@/utils/toast';
import { useAudio } from '../contexts/AudioContext';

interface Story {
  id: string;
  user: string;
  avatar: string;
  image: string;
  time: string;
  video?: string;
  audio?: string;
  type?: 'image' | 'video';
  userId?: string; // Future: User ID for backend filtering
  profileId?: string; // Future: Profile ID to match with story
  isBotContent?: boolean; // Current: Mark as bot content
  content?: string; // Optional story content/text
  isFollowing?: boolean;
  isOwn?: boolean;
}

interface StoryViewerProps {
  stories: Story[];
  currentIndex: number;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onDeleteStory?: (storyId: string) => void;
}

const StoryViewer: React.FC<StoryViewerProps> = ({
  stories,
  currentIndex,
  onClose,
  onNext,
  onPrevious,
  onDeleteStory,
}) => {
  const { isGloballyMuted, setGlobalMute } = useAudio();
  const [progress, setProgress] = useState(0);
  const [comment, setComment] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [isLoading, setIsLoading] = useState(false);
  const [isNextLoading, setIsNextLoading] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [videoError, setVideoError] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentStory = stories[currentIndex];

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          if (currentIndex > 0) {
            onPrevious();
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (currentIndex < stories.length - 1) {
            onNext();
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [currentIndex, stories.length, onNext, onPrevious, onClose]);

  // Auto-hide controls after 3 seconds, but keep header always visible
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowControls(false);
    }, 3000);

    return () => clearTimeout(timer);
  }, [currentIndex, showControls]);

  // Handle video/audio playback and photo progress
  useEffect(() => {
    const story = stories[currentIndex];
    if (!story) return;

    // Reset states
    setProgress(0);
    setVideoError(false);
    setVideoLoaded(false);
    setIsPlaying(false);
    
    // Clear any existing intervals
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
    }

    // For videos, wait for video to load before starting progress
    if (story.type === 'video' && videoRef.current) {
      const video = videoRef.current;
      
      const handleVideoLoad = () => {
        setVideoLoaded(true);
        startProgress();
      };
      
      const handleVideoError = () => {
        setVideoError(true);
        console.error('Video failed to load');
        // Still start progress so user can navigate
        startProgress();
      };
      
      video.addEventListener('loadeddata', handleVideoLoad);
      video.addEventListener('error', handleVideoError);
      
      // Load video if not already loaded
      if (video.readyState < 2) {
        video.load();
      } else {
        setVideoLoaded(true);
        startProgress();
      }
      
      return () => {
        video.removeEventListener('loadeddata', handleVideoLoad);
        video.removeEventListener('error', handleVideoError);
        if (progressIntervalRef.current) {
          clearInterval(progressIntervalRef.current);
        }
      };
    } else {
      // For images or if no video ref, start progress immediately
      startProgress();
    }
    
    function startProgress() {
      const duration = story.type === 'video' ? 6000 : 3000;
      const interval = 50;
      const increment = (interval / duration) * 100;
      
      progressIntervalRef.current = setInterval(() => {
        setProgress(prev => {
          const newProgress = prev + increment;
          
          if (newProgress >= 100) {
            clearInterval(progressIntervalRef.current!);
            
            // Auto-advance
            if (currentIndex < stories.length - 1) {
              onNext();
            } else {
              onClose();
            }
            
            return 100;
          }
          return newProgress;
        });
      }, interval);
    }
  }, [currentIndex]);

  const handleDelete = () => {
    if (onDeleteStory) {
      onDeleteStory(currentStory.id);
      showSuccess('🗑️ Story deleted successfully.');
      onClose(); // Close the story viewer after deletion
    } else {
      showSuccess('🗑️ Story deleted successfully.');
      console.log("Delete story:", currentStory.id);
      onClose(); // Close the story viewer after deletion
    }
  };

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: `Story by ${currentStory.user}`,
        text: 'Check out this amazing story!',
        url: window.location.href
      }).catch(() => {
        // Fallback to clipboard
        navigator.clipboard.writeText(window.location.href);
        showSuccess('🔗 Story link copied to clipboard!');
      });
    } else {
      navigator.clipboard.writeText(window.location.href);
      showSuccess('🔗 Story link copied to clipboard!');
    }
  };

  const handleShareAction = () => {
    handleShare();
    // You can add additional share tracking here if needed
  };

  
  const togglePlayPause = () => {
    const video = videoRef.current;
    const audio = audioRef.current;
    
    if (!video && !audio) return;
    
    const newPlayingState = !isPlaying;
    setIsPlaying(newPlayingState);
    
    if (video) {
      if (newPlayingState) {
        // When user clicks to play, try to unmute if not explicitly muted
        if (!isGloballyMuted) {
          video.muted = false;
        }
        
        video.play().then(() => {
          if (audio) {
            audio.currentTime = video.currentTime;
            audio.muted = isGloballyMuted;
            audio.play().catch(e => console.log('Audio play prevented:', e));
          }
          showSuccess('▶️ Playing video' + (video.muted ? ' (muted)' : ' with audio'));
        }).catch(e => {
          console.error('Video play failed:', e);
          // Fallback: try playing muted if unmuted fails
          if (!video.muted) {
            video.muted = true;
            video.play().then(() => {
              if (audio) {
                audio.play().catch(e => console.log('Audio play prevented:', e));
              }
              showSuccess('▶️ Playing video (auto-muted for browser compatibility)');
            }).catch(e => {
              console.error('Muted play also failed:', e);
              showError('Failed to play video. Please try again.');
              setIsPlaying(false);
            });
          } else {
            showError('Failed to play video. Please try again.');
            setIsPlaying(false);
          }
        });
      } else {
        video.pause();
        if (audio) {
          audio.pause();
        }
        showSuccess('⏸️ Video paused');
      }
    } else if (audio) {
      if (newPlayingState) {
        audio.play().then(() => {
          showSuccess('▶️ Playing audio');
        }).catch(e => {
          console.error('Audio play failed:', e);
          showError('Failed to play audio. Please try again.');
          setIsPlaying(false);
        });
      } else {
        audio.pause();
        showSuccess('⏸️ Audio paused');
      }
    }
  };

  const toggleMute = () => {
    const newMutedState = !isGloballyMuted;
    setGlobalMute(newMutedState);
    
    if (videoRef.current) {
      videoRef.current.muted = newMutedState;
    }
    if (audioRef.current) {
      audioRef.current.muted = newMutedState;
    }
  };

  const handleVolumeChange = (newVolume: number) => {
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
    }
    if (audioRef.current) {
      audioRef.current.volume = newVolume;
    }
  };

  const handleSendComment = () => {
    if (comment.trim()) {
      // Simulate posting comment to backend
      console.log('Posting comment:', comment);
      showSuccess('Comment posted successfully!');
      setComment('');
      
      // In a real app, you would:
      // 1. Send comment to backend
      // 2. Update comments list
      // 3. Show success/error feedback
    } else {
      showError('Please enter a comment');
    }
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSendComment();
    }
  };

  if (!currentStory) return null;

  return (
    <div 
      className="story-viewer fade-in"
      onMouseMove={() => setShowControls(true)}
      onClick={() => setShowControls(true)}
    >
      <div className="story-content">
        {/* Instagram-style Progress Bar */}
        <div className="story-progress">
          <div className="flex gap-1 px-4 py-2">
            {stories.map((_, index) => (
              <div
                key={index}
                className="flex-1 bg-white/30 rounded-full overflow-hidden h-1 relative"
              >
                <div
                  className={`story-progress-bar h-full rounded-full ${
                    index === currentIndex && isLoading ? 'instagram-loading' : 
                    index === currentIndex + 1 && isNextLoading ? 'instagram-loading' : 
                    'bg-white'
                  }`}
                  style={{
                    width: index === currentIndex ? (isLoading ? '0%' : `${progress}%`) : 
                           index === currentIndex + 1 && isNextLoading ? '0%' :
                           index < currentIndex ? '100%' : '0%',
                    transition: index === currentIndex && !isLoading ? 'width 0.05s linear' : 'none',
                  }}
                />
              </div>
            ))}
          </div>
        </div>

        
        {/* Header */}
        <div className="story-header">
          <div className="story-user-info">
            <Avatar 
              className="w-10 h-10 border-2 border-white cursor-pointer hover:ring-2 hover:ring-white/50 transition-all duration-200"
              onClick={() => {
                // Navigate to user profile when avatar is clicked
                console.log(`Navigate to ${currentStory.user}'s profile`);
              }}
              title={`${currentStory.user}'s Profile`}
            >
              <AvatarImage src={currentStory.avatar} />
              <AvatarFallback>{currentStory.user.substring(0, 2)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="text-white font-semibold">{currentStory.user}</p>
              <p className="text-white/70 text-sm">{currentStory.time}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* 3-dot menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="text-white hover:bg-white/20"
                >
                  <MoreVertical className="h-5 w-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[150px] z-[1000000]" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleShareAction();
                  }}
                  className="cursor-pointer"
                >
                  <Share2 className="h-4 w-4 mr-2" />
                  Share Story
                </DropdownMenuItem>
                <ReportButton
                    contentId={currentStory.id}
                    contentType="moment"
                    variant="button"
                    size="sm"
                    showLabel={true}
                    className="w-full justify-start text-red-600 hover:text-red-700 hover:bg-red-50"
                  />
                <DropdownMenuItem 
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete();
                  }}
                  className="cursor-pointer text-red-600"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Story
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            
            {/* Save button */}
            <div onClick={(e) => e.stopPropagation()}>
              <SaveButton 
                postId={currentStory.id} 
                content={{
                  ...currentStory,
                  type: 'story',
                  media: currentStory.image || currentStory.video,
                  mediaType: currentStory.type || 'image',
                  content: currentStory.content || `Story by ${currentStory.user}`
                }} 
                className="text-white hover:bg-white/20" 
                iconClassName="h-5 w-5"
              />
            </div>
            
            {/* Close button */}
            <Button variant="ghost" size="icon" onClick={onClose} className="text-white hover:bg-white/20">
              <X className="h-6 w-6" />
            </Button>
          </div>
        </div>

        {/* Story Media */}
        <div className="relative w-full h-full">
          {currentStory.type === 'video' ? (
            <>
              {videoError ? (
                <div className="story-image flex items-center justify-center bg-black/80">
                  <div className="text-center text-white">
                    <p className="text-lg mb-2">⚠️ Video failed to load</p>
                    <p className="text-sm opacity-70">Please check your connection</p>
                  </div>
                </div>
              ) : (
                <>
                  {!videoLoaded && (
                    <div className="story-image flex items-center justify-center bg-black/60">
                      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
                    </div>
                  )}
                  <video
                    ref={videoRef}
                    src={currentStory.video}
                    className={`story-image ${videoLoaded ? 'block' : 'hidden'}`}
                    muted={isGloballyMuted}
                    loop
                    preload="metadata"
                    playsInline
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePlayPause();
                    }}
                    onLoadedData={() => setVideoLoaded(true)}
                    onError={() => setVideoError(true)}
                  />
                </>
              )}
            </>
          ) : (
            <img
              src={currentStory.image}
              alt={currentStory.user}
              className="story-image"
              onError={(e) => {
                e.currentTarget.src = '/placeholder.svg';
              }}
            />
          )}
          
          {/* Audio element for background music */}
          {currentStory.audio && (
            <audio
              ref={audioRef}
              src={currentStory.audio}
              loop
              muted={isGloballyMuted}
            />
          )}

          {/* Media Controls Overlay */}
          {currentStory.type === 'video' && showControls && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div 
                className="bg-black/50 backdrop-blur-sm rounded-full p-4 pointer-events-auto cursor-pointer" 
                onClick={(e) => {
                  e.stopPropagation();
                  togglePlayPause();
                }}
                role="button"
                tabIndex={0}
                aria-label={isPlaying ? "Pause video" : "Play video"}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    togglePlayPause();
                  }
                }}
              >
                {isPlaying ? <Pause className="h-8 w-8 text-white" /> : <Play className="h-8 w-8 text-white" />}
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons only - no tap areas */}
        
        {/* Instagram-style navigation buttons */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onPrevious}
          disabled={currentIndex === 0}
          aria-label="Previous story"
          className="absolute left-4 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white backdrop-blur-md transition-all duration-300 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed z-20 rounded-full p-3 shadow-lg"
        >
          <span className="text-xl font-bold">&lt;</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNext}
          disabled={currentIndex === stories.length - 1}
          aria-label="Next story"
          className="absolute right-4 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white backdrop-blur-md transition-all duration-300 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed z-20 rounded-full p-3 shadow-lg"
        >
          <span className="text-xl font-bold">&gt;</span>
        </Button>


        {/* Comment Input at Bottom - Always visible */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-black/70 backdrop-blur-lg p-4 border-t border-white/10" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                handleShareAction();
              }}
              className="text-white hover:bg-white/20 flex-shrink-0"
              title="Share story"
            >
              <Share2 className="h-5 w-5" />
            </Button>
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment..."
              className="flex-1 bg-white/10 border-white/20 text-white placeholder-white/50 focus:bg-white/15 focus:border-white/30 transition-all duration-200"
              onKeyDown={handleCommentKeyDown}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.stopPropagation()}
            />
            <Button 
              onClick={(e) => {
                e.stopPropagation();
                handleSendComment();
              }}
              className="bg-blue-500 hover:bg-blue-600 text-white shadow-lg hover:shadow-blue-500/25 transition-all duration-200 hover:scale-105"
              size="icon"
              disabled={!comment.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StoryViewer;
