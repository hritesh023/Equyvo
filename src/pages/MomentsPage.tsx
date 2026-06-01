"use client";

import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Play, Pause, Volume2, VolumeX, ThumbsUp, MessageCircle, Share2, Bookmark, Music2, MoreVertical, Send } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from '@/lib/utils';
import { useIsMobile } from "@/hooks/use-mobile";
import StandardPostMenu from '@/components/StandardPostMenu';
import { showSuccess } from '@/utils/toast';
import SaveButton from '@/components/SaveButton';
import CommentSection from '@/components/CommentSection';
import { navigateToProfile } from '@/utils/profile-navigation';

const MomentsPage = () => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [activeVideoIndex, setActiveVideoIndex] = useState(0);
  const [isMuted, setIsMuted] = useState(true); // Start muted for auto-play compatibility
  const [hasEngaged, setHasEngaged] = useState(false); // Track user engagement
  const [autoUnmuted, setAutoUnmuted] = useState(false); // Track if auto-unmute has been applied
  const [likedMoments, setLikedMoments] = useState<Set<string>>(new Set());
  const [momentLikes, setMomentLikes] = useState<{[key: string]: string}>({});
  const [isScrolling, setIsScrolling] = useState(false);
  const [commentSectionOpen, setCommentSectionOpen] = useState(false);
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [selectedPostUser, setSelectedPostUser] = useState<string>('');
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  const scrollTimeoutRef = useRef<NodeJS.Timeout>();

  // Mock moments data with working video URLs
  const moments = [
    {
      id: 'm1',
      user: 'alex_adventures',
      avatar: 'https://github.com/shadcn.png',
      description: 'The view from the top is absolutely breathtaking! 🏔️ #hiking #nature #sunset',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      song: 'Original Sound - Alex Chen',
      likes: '15.4K',
      comments: '892',
      shares: '2.3K',
      isLiked: false,
      isSaved: false
    },
    {
      id: 'm2',
      user: 'culinary_wizard',
      avatar: 'https://github.com/shadcn.png',
      description: 'Secret pasta recipe revealed! 🍝 You have to try this. #cooking #foodie #recipe',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
      song: 'Italian Dinner Jazz - Foodie Beats',
      likes: '8.9K',
      comments: '567',
      shares: '123',
      isLiked: true,
      isSaved: false
    },
    {
      id: 'm3',
      user: 'fitness_pro',
      avatar: 'https://github.com/shadcn.png',
      description: 'No excuses. Get it done. 💪 #fitness #gym #motivation',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      song: 'High Energy Workout - Gym Tunes',
      likes: '22.1K',
      comments: '1.2K',
      shares: '456',
      isLiked: false,
      isSaved: true
    },
    {
      id: 'm4',
      user: 'urban_dancer',
      avatar: 'https://github.com/shadcn.png',
      description: 'Vibing in the city 🌃 #dance #street #vibes',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      song: 'City Lights - Dance Mix',
      likes: '45.6K',
      comments: '2.3K',
      shares: '7.8K',
      isLiked: true,
      isSaved: true
    }
  ];

  // Initialize likes state only (remove auto like/save initialization)
  useEffect(() => {
    const initialLikes: {[key: string]: string} = {};
    
    moments.forEach(moment => {
      initialLikes[moment.id] = moment.likes;
    });
    
    setMomentLikes(initialLikes);
  }, []);

  // Enhanced scroll handling with smooth transitions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let startY = 0;
    let startTime = 0;
    let isDragging = false;

    const handleTouchStart = (e: TouchEvent) => {
      startY = e.touches[0].clientY;
      startTime = Date.now();
      isDragging = true;
      setIsScrolling(true);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isDragging) return;
      const currentY = e.touches[0].clientY;
      const deltaY = currentY - startY;
      
      // Add momentum based on swipe velocity
      const velocity = Math.abs(deltaY) / (Date.now() - startTime);
      if (velocity > 0.5) {
        container.style.scrollBehavior = 'auto';
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      isDragging = false;
      container.style.scrollBehavior = 'smooth';
      
      // Clear existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      
      // Reset scrolling state after animation
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 500);
    };

    const handleWheel = (e: WheelEvent) => {
      setIsScrolling(true);
      
      // Clear existing timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      
      // Reset scrolling state after animation
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 150);
    };

    // Add event listeners
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    container.addEventListener('wheel', handleWheel, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('wheel', handleWheel);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Intersection observer for video playback management
  useEffect(() => {
    const options = {
      root: containerRef.current,
      rootMargin: '0px',
      threshold: 0.7 // Higher threshold for better detection
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const index = Number(entry.target.getAttribute('data-index'));
        const video = videoRefs.current[index];
        
        if (entry.isIntersecting && !isScrolling) {
          setActiveVideoIndex(index);

          // Play current video with enhanced logic
          if (video) {
            video.currentTime = 0;
            video.muted = true; // Start muted for reliable auto-play
            video.play().then(() => {
              // Auto-unmute immediately after successful play
              setTimeout(() => {
                video.muted = false;
                if (index === activeVideoIndex) {
                  setIsMuted(false);
                  setAutoUnmuted(true);
                  console.log(`Video ${index} auto-unmuted on view`);
                }
              }, 200); // Very short delay for reliable unmute
            }).catch(() => console.log('Autoplay prevented'));
          }
        } else if (!entry.isIntersecting) {
          // Pause video when not visible
          if (video) {
            video.pause();
          }
        }
      });
    }, options);

    const slides = containerRef.current?.querySelectorAll('.moment-slide');
    slides?.forEach(slide => observer.observe(slide));

    return () => {
      observer.disconnect();
      slides?.forEach(slide => observer.unobserve(slide));
    };
  }, [isScrolling, activeVideoIndex]);

  // Auto-play first video on mount with multiple attempts
  useEffect(() => {
    const playFirstVideo = () => {
      const firstVideo = videoRefs.current[0];
      if (firstVideo) {
        // Start muted for reliable auto-play
        firstVideo.muted = true;
        
        const attemptPlay = (attempts = 0) => {
          if (attempts >= 10) {
            console.log('Auto-play failed after 10 attempts');
            return;
          }
          
          firstVideo.play()
            .then(() => {
              console.log('First video auto-played successfully');
              // Immediately auto-unmute on visit
              setTimeout(() => {
                firstVideo.muted = false;
                setIsMuted(false);
                setAutoUnmuted(true);
                console.log('Video auto-unmuted on page visit');
              }, 200); // Very short delay for reliable unmute
            })
            .catch(error => {
              console.log(`Auto-play attempt ${attempts + 1} failed:`, error);
              setTimeout(() => attemptPlay(attempts + 1), 100 * (attempts + 1));
            });
        };
        
        // Start attempting to play after a short delay
        setTimeout(() => attemptPlay(), 100);
      }
    };

    playFirstVideo();
  }, []);

  // Keyboard navigation for desktop
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          // Scroll to next video
          const nextIndex = Math.min(activeVideoIndex + 1, moments.length - 1);
          const nextSlide = container.querySelector(`[data-index="${nextIndex}"]`) as HTMLElement;
          if (nextSlide) {
            nextSlide.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          break;
        case ' ':
          e.preventDefault();
          // Toggle play/pause
          togglePlay(activeVideoIndex);
          break;
        case 'ArrowUp':
          e.preventDefault();
          // Scroll to previous video
          const prevIndex = Math.max(activeVideoIndex - 1, 0);
          const prevSlide = container.querySelector(`[data-index="${prevIndex}"]`) as HTMLElement;
          if (prevSlide) {
            prevSlide.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          break;
        case 'm':
        case 'M':
          // Toggle mute
          toggleMute(e as any);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeVideoIndex, moments.length]);

  // Auto-unmute portrait videos after user engagement
  useEffect(() => {
    if (hasEngaged && !autoUnmuted) {
      const currentVideo = videoRefs.current[activeVideoIndex];
      if (currentVideo) {
        // Check if video metadata is loaded
        if (currentVideo.videoHeight > 0 && currentVideo.videoWidth > 0) {
          if (currentVideo.videoHeight > currentVideo.videoWidth) {
            // Check if video is portrait (height > width)
            currentVideo.muted = false;
            setIsMuted(false);
            setAutoUnmuted(true);
            console.log('Portrait video auto-unmuted after user engagement');
          }
        } else {
          // Wait for metadata to load
          const handleLoadedMetadata = () => {
            if (currentVideo.videoHeight > currentVideo.videoWidth) {
              currentVideo.muted = false;
              setIsMuted(false);
              setAutoUnmuted(true);
              console.log('Portrait video auto-unmuted after metadata loaded');
            }
            currentVideo.removeEventListener('loadedmetadata', handleLoadedMetadata);
          };
          currentVideo.addEventListener('loadedmetadata', handleLoadedMetadata);
        }
      }
    }
  }, [hasEngaged, activeVideoIndex, autoUnmuted]);

  // Update mute state for all videos (removed - now controlled individually)

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    setHasEngaged(true);
    setAutoUnmuted(true); // Prevent auto-unmute from triggering again
    const currentVideo = videoRefs.current[activeVideoIndex];
    if (currentVideo) {
      const newMutedState = !currentVideo.muted;
      currentVideo.muted = newMutedState;
      setIsMuted(newMutedState);
      console.log('Manual toggle - Video muted:', newMutedState);
    }
  };

  const togglePlay = (index: number) => {
    setHasEngaged(true);
    setAutoUnmuted(true); // Prevent auto-unmute from triggering again
    const video = videoRefs.current[index];
    if (video) {
      if (video.paused) {
        video.play();
      } else {
        video.pause();
      }
    }
  };

  const toggleLike = (momentId: string) => {
    setLikedMoments(prev => {
      const newLiked = new Set(prev);
      const currentLikes = momentLikes[momentId] || '0';
      const numericLikes = parseFloat(currentLikes.replace('K', '')) * (currentLikes.includes('K') ? 1000 : 1);
      
      if (newLiked.has(momentId)) {
        newLiked.delete(momentId);
        const newLikes = Math.max(0, numericLikes - 1);
        setMomentLikes(current => ({
          ...current, 
          [momentId]: newLikes >= 1000 ? `${(newLikes / 1000).toFixed(1)}K` : newLikes.toString()
        }));
      } else {
        newLiked.add(momentId);
        const newLikes = numericLikes + 1;
        setMomentLikes(current => ({
          ...current, 
          [momentId]: newLikes >= 1000 ? `${(newLikes / 1000).toFixed(1)}K` : newLikes.toString()
        }));
      }
      return newLiked;
    });
  };

  const handleComment = (momentId: string, user: string) => {
    setSelectedPostId(momentId);
    setSelectedPostUser(user);
    setCommentSectionOpen(true);
  };

  const handleShare = (momentId: string) => {
    const moment = moments.find(m => m.id === momentId);
    if (moment) {
      const shareUrl = `${window.location.origin}/moments/${momentId}`;
      if (navigator.share) {
        navigator.share({
          title: `Moment by ${moment.user}`,
          text: moment.description,
          url: shareUrl
        });
      } else {
        navigator.clipboard.writeText(shareUrl);
        showSuccess('🔗 Link copied to clipboard!');
      }
    }
  };

  // Menu handlers
  const handleReport = (momentId: string) => {
    showSuccess(`Report submitted for moment ${momentId}`);
  };

  const handleHide = (momentId: string) => {
    showSuccess('Moment hidden from feed');
  };

  const handleCopyLink = (momentId: string) => {
    const shareUrl = `${window.location.origin}/moments/${momentId}`;
    navigator.clipboard.writeText(shareUrl);
    showSuccess('🔗 Link copied to clipboard!');
  };

  return (
    <div
      ref={containerRef}
      className={`w-full bg-black snap-y snap-mandatory overflow-y-scroll overflow-x-hidden no-scrollbar ${
        isMobile ? 'h-[calc(100vh-3.5rem)]' : 'h-[calc(100vh-4rem)]'
      }`}
      style={{ 
        scrollBehavior: 'smooth',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none'
      }}
      onClick={() => setHasEngaged(true)}
    >
      {moments.map((moment, index) => (
        <div
          key={moment.id}
          data-index={index}
          className={`moment-slide relative w-full snap-start snap-always bg-black overflow-hidden ${
            isMobile ? 'h-[calc(100vh-3.5rem)]' : 'h-[calc(100vh-4rem)]'
          }`}
        >
          {/* Video Player - Full Page Portrait */}
          <div className="absolute inset-0 flex items-center justify-center bg-black">
            <video
              ref={el => videoRefs.current[index] = el}
              src={moment.videoUrl}
              className="h-full w-auto object-contain"
              style={{
                aspectRatio: '9/16',
                maxHeight: isMobile ? 'calc(100vh - 3.5rem)' : 'calc(100vh - 4rem)',
                maxWidth: '100vw',
                objectFit: 'contain',
                backgroundColor: 'black'
              }}
              loop
              playsInline
              muted={true}
              autoPlay
              onClick={() => togglePlay(index)}
              onLoadStart={() => console.log(`Video ${index} loading started: ${moment.videoUrl}`)}
              onCanPlay={() => console.log(`Video ${index} can play`)}
              onError={(e) => console.error(`Video ${index} error:`, e)}
              onLoadedMetadata={() => console.log(`Video ${index} metadata loaded: ${videoRefs.current[index]?.videoWidth}x${videoRefs.current[index]?.videoHeight}`)}
            />
          </div>

          {/* Overlay Content - Optimized for Portrait */}
          <div className="absolute inset-0 max-w-md mx-auto pointer-events-none">
            {/* Top Bar (Mute) */}
            <div className="absolute top-4 right-4 z-20 pointer-events-auto">
              <Button
                variant="ghost"
                size="icon"
                className="bg-black/20 hover:bg-black/40 text-white rounded-full backdrop-blur-sm"
                onClick={toggleMute}
              >
                {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </Button>
            </div>

            {/* Right Side Actions */}
            <div className="absolute bottom-20 right-2 flex flex-col items-center gap-6 z-20 pointer-events-auto">
              <div className="flex flex-col items-center gap-1">
                <Avatar 
                  className="h-12 w-12 border-2 border-white cursor-pointer hover:scale-110 hover:ring-2 hover:ring-white/50 transition-all duration-200"
                  onClick={() => {
                    // Navigate to user profile when avatar is clicked
                    navigateToProfile(navigate, undefined, moment.user);
                  }}
                  title={`${moment.user}'s Profile`}
                >
                  <AvatarImage src={moment.avatar} />
                  <AvatarFallback>{moment.user[0]}</AvatarFallback>
                </Avatar>
              </div>

              <div className="flex flex-col items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="p-0 hover:bg-transparent text-white hover:scale-110 transition-transform"
                  onClick={() => toggleLike(moment.id)}
                >
                  <ThumbsUp className={cn("h-8 w-8 drop-shadow-md", likedMoments.has(moment.id) ? "fill-current text-blue-500" : "")} />
                </Button>
                <span className="text-white text-xs font-medium drop-shadow-md">{momentLikes[moment.id] || moment.likes}</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="p-0 hover:bg-transparent text-white hover:scale-110 transition-transform"
                  onClick={() => handleComment(moment.id, moment.user)}
                >
                  <MessageCircle className="h-8 w-8 drop-shadow-md" />
                </Button>
                <span className="text-white text-xs font-medium drop-shadow-md">{moment.comments}</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <div onClick={(e) => e.stopPropagation()}>
                  <SaveButton 
                    postId={moment.id} 
                    content={{
                      ...moment,
                      type: 'moment',
                      videoUrl: moment.videoUrl,
                      media: moment.videoUrl,
                      mediaType: 'video'
                    }} 
                    className="p-0 hover:bg-transparent text-white hover:scale-110 transition-transform"
                    iconClassName="h-8 w-8 drop-shadow-md"
                  />
                </div>
                <span className="text-white text-xs font-medium drop-shadow-md">Save</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="p-0 hover:bg-transparent text-white hover:scale-110 transition-transform"
                  onClick={() => handleShare(moment.id)}
                >
                  <Share2 className="h-8 w-8 drop-shadow-md" />
                </Button>
                <span className="text-white text-xs font-medium drop-shadow-md">{moment.shares}</span>
              </div>

              <div className="flex flex-col items-center gap-1">
                <StandardPostMenu
                  postId={moment.id}
                  onReport={handleReport}
                  onHide={handleHide}
                  onCopyLink={handleCopyLink}
                  onShare={() => handleShare(moment.id)}
                  className="text-white hover:bg-transparent hover:scale-110 transition-transform"
                />
                <span className="text-white text-xs font-medium drop-shadow-md">More</span>
              </div>
            </div>

            {/* Bottom Info Area */}
            <div className="absolute bottom-4 left-4 right-16 z-20 text-white pointer-events-auto">
              <div className="mb-2">
                <h3 className="font-bold text-lg drop-shadow-md cursor-pointer hover:underline">@{moment.user}</h3>
              </div>
              <div className="mb-3">
                <p className="text-sm drop-shadow-md line-clamp-2 leading-snug">
                  {moment.description}
                </p>
              </div>
              <div className="flex items-center gap-2 bg-white/20 w-fit px-3 py-1 rounded-full backdrop-blur-sm animate-pulse cursor-pointer hover:bg-white/30 transition-colors">
                <Music2 className="h-3 w-3" />
                <p className="text-xs font-medium truncate max-w-[150px]">{moment.song}</p>
                {autoUnmuted && index === activeVideoIndex && !videoRefs.current[activeVideoIndex]?.muted && (
                  <span className="text-xs text-green-400 ml-2 animate-pulse">🔊 Auto-unmuted</span>
                )}
              </div>
            </div>
          </div>
        </div>
      ))}
      
      {/* Comment Section Modal */}
      {commentSectionOpen && selectedPostId && (
        <CommentSection
          isOpen={commentSectionOpen}
          onClose={() => {
            setCommentSectionOpen(false);
            setSelectedPostId(null);
            setSelectedPostUser('');
          }}
          postId={selectedPostId}
          postUser={selectedPostUser}
        />
      )}
    </div>
  );
};

export default MomentsPage;
