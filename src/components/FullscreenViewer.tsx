import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { X, ThumbsUp, MessageCircle, Share2, Users, Clock, Calendar, Minimize2, Play, Pause, Volume2, VolumeX, Maximize2, Columns, Eye, Image, RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import SaveButton from '@/components/SaveButton';
import CommentSection from '@/components/CommentSection';
import { showSuccess, showError } from '@/utils/toast';
import { FullscreenContent } from '@/types';
import { navigateToProfile, ownerIdOf, isPlaceholderId } from '@/utils/profile-navigation';
import { shareItem } from '@/utils/share';
import { avatarOf } from '@/utils/avatar';
import { useBackOverlay } from '@/lib/back-navigation';
import { useVideo2xPress } from '@/lib/video-2x';
import { useVideoKeyboardShortcuts } from '@/hooks/use-video-keyboard-shortcuts';
import { useMediaSession } from '@/hooks/use-media-session';
import { useVideoGestures } from '@/hooks/use-video-gestures';
import VideoSeekBar from '@/components/VideoSeekBar';
import api from '@/lib/api';
import { normalizeContentItem } from '@/lib/media';
import { toCount } from '@/lib/count';

interface FullscreenViewerProps {
  content: FullscreenContent;
  type: 'post' | 'live' | 'video' | 'moment' | 'image' | 'audio' | 'thought' | 'reacted' | 'story';
  onClose: () => void;
  onComment?: (videoId: string, creator: string) => void;
  onShare?: (video: FullscreenContent) => void | Promise<void>;
  followedCreators?: Set<string>;
  onFollow?: (creatorId: string) => void;
  onExpand?: () => void;
  onContentChange?: (content: FullscreenContent) => void;
}

const FullscreenViewer: React.FC<FullscreenViewerProps> = ({ 
  content, 
  type, 
  onClose, 
  onComment,
  onShare,
  followedCreators = new Set(),
  onFollow,
  onExpand,
  onContentChange
}) => {
  // Check for temp content from split view. The window slot is consumed ONCE
  // on the first render into a ref: clearing it mid-render on every pass
  // could lose the payload on a double render (StrictMode / parent state
  // update) and swap the viewer onto stale content.
  const rawContentRef = useRef<any>(null);
  if (rawContentRef.current === null) {
    const temp = (window as any).tempFullscreenContent;
    rawContentRef.current = temp || content;
    if (temp) (window as any).tempFullscreenContent = null;
  }
  const rawContent = rawContentRef.current;
  // Normalise once: callers can hand us raw media arrays/objects/legacy
  // fields, and every renderer below expects clean strings.
  const actualContent = useMemo(
    () => normalizeContentItem<FullscreenContent>(rawContent),
    [rawContent],
  );
  // Real author avatar only: the uploader's uploaded/updated profile icon
  // (overlaid fresh from the server profile on every read). When the author
  // has no photo, render initials — never a fake/bot placeholder image.
  const realAvatarSrc = avatarOf(actualContent);
  const hideBrokenImage = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const target = e.target as HTMLImageElement;
    target.style.display = 'none';
  };
  // Fullscreen image resilience: a flaky first fetch (mobile switch, cold
  // edge) must not black out the viewer. Remount the element with a fresh
  // fetch up to two times, then show the honest "not viewable" state.
  const [imageRenderKey, setImageRenderKey] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    setImageRenderKey(0);
    setImageFailed(false);
  }, [actualContent?.id]);
  const handleFullscreenImageError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (imageRenderKey < 2 && !imageFailed) {
      setImageRenderKey(k => k + 1);
      return;
    }
    setImageFailed(true);
    hideBrokenImage(e);
  };
  const actualType = rawContentRef.current !== content
    ? (rawContentRef.current?.type as string) || 'video'
    : type;
  const videoRef = useRef<HTMLVideoElement>(null);

  // Hold-to-2× scrub: long-press right = fast-forward at 2× the speed,
  // long-press left = rewind at 2× (long videos, moments & live streams).
  useVideo2xPress(() => [videoRef.current]);
  const [isPlaying, setIsPlaying] = useState(true);
  // Signal fullscreen takeover so the feed banner stays hidden while video
  // plays (no overlays, no interruptions).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fullscreenViewerOpened'));
    return () => {
      window.dispatchEvent(new CustomEvent('fullscreenViewerClosed'));
    };
  }, []);  const [isMuted, setIsMuted] = useState(false); // Start unmuted in fullscreen mode
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [isDesktop, setIsDesktop] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState<number>(0);
  const [showCommentSection, setShowCommentSection] = useState(false);
  const [isSplitView, setIsSplitView] = useState(false);
  const [showDetailsPanel, setShowDetailsPanel] = useState(false);
  const [showImageOverlay, setShowImageOverlay] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout>();
  const lastMouseMoveRef = useRef<number>(Date.now());
  const mouseActivityRef = useRef<boolean>(false);
  const detailsPanelTimeoutRef = useRef<NodeJS.Timeout>();
  const controlsShowCountRef = useRef<number>(0);
  const navigate = useNavigate();

  // ── Hardware/system back inside the viewer ─────────────────────────────
  // First press peels the top sub-panel off (fullscreen → details → image
  // info → comments), the final press CLOSES THE VIEWER (returns to the
  // feed underneath) — the app itself is never exited from here.
  const handleBackInViewer = useCallback((): boolean => {
    try {
      if (document.fullscreenElement) { void document.exitFullscreen(); return true; }
    } catch { /* ignore */ }
    if (showDetailsPanel) { setShowDetailsPanel(false); return true; }
    if (showImageOverlay) { setShowImageOverlay(false); return true; }
    if (showCommentSection) { setShowCommentSection(false); return true; }
    onClose();
    return true;
  }, [showDetailsPanel, showImageOverlay, showCommentSection, onClose]);
  useBackOverlay(true, handleBackInViewer);

  // Detect mobile device and orientation
  const isMobileDevice = window.innerWidth < 768;
  const isPortraitOrientation = window.innerHeight > window.innerWidth;

  // Resolve the effective type from multiple sources of truth
  const resolvedType = actualType ||
                        actualContent?.type ||
                        actualContent?.contentType ||
                        'image';
  const resolvedContentType = actualContent?.contentType || resolvedType;
  
  // Enhanced video type detection using all available type indicators
  const videoTypeValues = new Set(['video', 'moment', 'live', 'story']);
  const isVideoType = videoTypeValues.has(resolvedType) ||
                       videoTypeValues.has(actualContent?.type || '') ||
                       videoTypeValues.has(actualContent?.contentType || '') ||
                        actualContent?.mediaType === 'video' ||
                        Boolean(actualContent?.videoUrl);
  const isAudioType = resolvedType === 'audio' ||
                      actualContent?.type === 'audio' ||
                      actualContent?.mediaType === 'audio' ||
                      Boolean((actualContent as any)?.audioUrl);
  const isPortraitMoment = resolvedType === 'moment' ||
                            actualContent?.type === 'moment' ||
                            actualContent?.contentType === 'moment' ||
                            actualContent?.forcePortrait;
  const isStory = resolvedType === 'story' ||
                   actualContent?.type === 'story' ||
                   actualContent?.contentType === 'story';
  const isLiveStream = resolvedType === 'live' ||
                        actualContent?.type === 'live' ||
                        actualContent?.contentType === 'live' ||
                        actualContent?.isLive === true ||
                        actualContent?.live === true;

  // Force landscape mode for mobile videos (except moments and stories)
  const shouldForceLandscape = isMobileDevice && isVideoType && !isPortraitMoment && !isStory;
  
  // Single unified video source detection. Never substitutes demo media:
  // when no playable URL exists the viewer renders an honest error state.
  const videoSrc = actualContent?.videoUrl ||
                   actualContent?.mediaUrl ||
                   actualContent?.media ||
                   actualContent?.src ||
                   actualContent?.url ||
                   undefined;
  
  // For live streams, use the same detection as other video content with live indicators
  const fallbackVideoSrc = isVideoType ? videoSrc : null;
  const audioSrc = isAudioType
    ? String((actualContent as any)?.audioUrl || (actualContent as any)?.mediaUrl || (actualContent as any)?.media || (actualContent as any)?.src || (actualContent as any)?.url || '')
    : '';

  // A live stream that ENDS must immediately fall back to NORMAL video
  // seek-bar behaviour (real duration + time cursor) — never a permanent red
  // "LIVE" rail frozen at the end of the recording. Playback events below
  // flip this: element 'ended', or a finite duration on board with the
  // playhead at the very end.
  const [liveEnded, setLiveEnded] = useState(false);
  // Cache-bust retry key for the fullscreen stream (cover flaky range reads).
  const [videoRetryKey, setVideoRetryKey] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  useEffect(() => {
    setVideoRetryKey(0);
    setVideoFailed(false);
  }, [fallbackVideoSrc]);
  // NOTE: this effect must stay BELOW the `fallbackVideoSrc` declaration —
  // reading it in the deps array while it was still in its temporal dead
  // zone threw a ReferenceError on every render, so the ErrorBoundary
  // replaced the whole fullscreen viewer with "This section couldn't load".
  useEffect(() => { setLiveEnded(false); }, [fallbackVideoSrc]);
  const effectiveLive = isLiveStream && !liveEnded;
  const contentTags = Array.isArray((actualContent as any)?.tags)
    ? ((actualContent as any).tags as unknown[]).map((tag) => String(tag)).filter(Boolean)
    : String((actualContent as any)?.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const imageSrc = String(
    (actualContent as any)?.image ||
    (actualContent as any)?.mediaUrl ||
    (actualContent as any)?.media ||
    (actualContent as any)?.src ||
    (actualContent as any)?.thumbnail ||
    '',
  );
  const commentCount = toCount((actualContent as any)?.comments ?? (actualContent as any)?.engagement?.comments);
  const viewerContentId = String((actualContent as any)?.id || (actualContent as any)?.videoId || (actualContent as any)?.imageId || 'unknown');
    
  // Determine container style based on content type and device
  const getContainerStyle = () => {
    
    if (isSplitView) {
      return {
        position: 'fixed' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        display: 'flex',
        backgroundColor: 'black',
        overflow: 'hidden',
        margin: 0,
        padding: 0
      };
    }
    
    // Mobile moments and stories use portrait mode
    if (isMobileDevice && (isPortraitMoment || isStory)) {
      return {
        position: 'fixed' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'black',
        overflow: 'hidden',
        margin: 0,
        padding: 0
      };
    }
    
    // Mobile videos (non-moments, non-stories) use 16:9 fullscreen
    if (isMobileDevice && isVideoType && !isPortraitMoment && !isStory) {
      return {
        position: 'fixed' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'black',
        overflow: 'hidden',
        margin: 0,
        padding: 0
      };
    }
    
    // Desktop moments and stories keep portrait mode
    if (isPortraitMoment || isStory) {
      return {
        position: 'fixed' as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'black',
        overflow: 'hidden',
        margin: 0,
        padding: 0
      };
    }
    
    // Default desktop fullscreen
    return {
      position: 'fixed' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: '100vw',
      height: '100vh',
      backgroundColor: 'black',
      overflow: 'hidden',
      margin: 0,
      padding: 0
    };
  };
  
  // Get video container style for portrait moments, stories, and mobile 16:9
  const getVideoContainerStyle = (): React.CSSProperties => {
    
    // Mobile moments and stories should always be portrait (9:16)
    if (isMobileDevice && (isPortraitMoment || isStory)) {
      return {
        width: '100vw',
        height: '177.78vw', // 9:16 ratio (16/9 = 1.7778)
        maxHeight: '100vh',
        maxWidth: '56.25vh', // 9/16 = 0.5625
        objectFit: 'cover',
        position: 'relative',
        backgroundColor: 'black'
      };
    }
    
    // Mobile videos (non-moments, non-stories) use 16:9 ratio - force landscape
    if (isMobileDevice && isVideoType && !isPortraitMoment && !isStory) {
      return {
        width: '100vw',
        height: '56.25vw', // 16:9 ratio (9/16 = 0.5625) - forces landscape orientation
        maxHeight: '100vh',
        maxWidth: '177.78vh', // 16/9 = 1.7778
        objectFit: 'contain',
        position: 'relative',
        backgroundColor: 'black',
        transform: 'rotate(0deg)', // Ensure no rotation
        transformOrigin: 'center'
      };
    }
    
    // Desktop moments and stories keep portrait mode (9:16)
    if (isPortraitMoment || isStory) {
      return {
        height: '100vh',
        maxWidth: '100vw',
        aspectRatio: '9/16',
        objectFit: 'cover',
        backgroundColor: 'black'
      };
    }
    
    // Desktop videos use cover
    return {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover' as const,
      zIndex: 0
    };
  };

  useEffect(() => {
    const rawLikes = actualContent?.likes;
    const parsedLikes = typeof rawLikes === 'number' ? rawLikes : Number.parseInt(String(rawLikes ?? 0), 10);
    setIsLiked(false);
    setLikeCount(Number.isFinite(parsedLikes) ? parsedLikes : 0);
  }, [actualContent?.id]);

  useEffect(() => {
    // Add shimmer animation to document head
    const style = document.createElement('style');
    style.textContent = `
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `;
    document.head.appendChild(style);
    
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      // Only prevent clicks that would exit fullscreen in split view
      if (isSplitView) {
        const target = e.target as HTMLElement;
        
        // Allow clicks on buttons and actionable elements
        if (target.closest('button') || target.closest('input') || target.closest('[role="button"]')) {
          return;
        }
        
        // Allow clicks on the top bar controls
        if (target.closest('.fixed.top-0.left-0.right-0')) {
          return;
        }
        
        // Allow clicks on the split view panel (right side) for video selection
        if (target.closest('.split-view-panel')) {
          return;
        }
        
        // Allow clicks on the main video container (left side) - let it handle play/pause
        if (target.closest('.main-video-container')) {
          return;
        }
        
        // Only prevent clicks on the main fullscreen container that would exit fullscreen
        if (target.closest('.fixed.inset-0.bg-black.z-50') && !target.closest('.main-video-container') && !target.closest('.split-view-panel') && !target.closest('.fixed.top-0')) {
          e.stopPropagation();
          e.preventDefault();
        }
      }
    };

    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cleanup();
        onClose();
      }
    };

    // Use bubble phase instead of capture to avoid conflicts with button click handlers
    document.addEventListener('click', handleGlobalClick, false);
    document.addEventListener('keydown', handleEsc);
    
    return () => {
      document.removeEventListener('click', handleGlobalClick, false);
      document.removeEventListener('keydown', handleEsc);
      cleanup();
    };
  }, [isSplitView, onClose]);

  useEffect(() => {
    // Detect if desktop or mobile
    const checkDevice = () => {
      setIsDesktop(window.innerWidth >= 768);
    };
    
    // Check fullscreen state
    const checkFullscreen = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    
    checkDevice();
    checkFullscreen();
    window.addEventListener('resize', checkDevice);
    document.addEventListener('fullscreenchange', checkFullscreen);
    
    return () => {
      window.removeEventListener('resize', checkDevice);
      document.removeEventListener('fullscreenchange', checkFullscreen);
    };
  }, []);

  // Poll currentTime every 200ms to keep progress bar in sync
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const poll = setInterval(() => {
      setCurrentTime(video.currentTime);
    }, 200);

    return () => clearInterval(poll);
  }, []);

  // Sync isPlaying state with native video events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
    };
  }, []);

  // Update duration when metadata loads
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateDuration = () => setDuration(video.duration);
    video.addEventListener('loadedmetadata', updateDuration);

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      updateDuration();
    }

    return () => video.removeEventListener('loadedmetadata', updateDuration);
  }, []);

  // Restore video state if coming from minimized viewer
  useEffect(() => {
    if (!actualContent?.isFromMinimized) return;
    const video = videoRef.current;
    if (!video) return;

    const restoreTime = actualContent?.restoreTime || 0;
    const restorePaused = actualContent?.restorePaused !== false;

    setTimeout(() => {
      if (video.duration) {
        video.currentTime = restoreTime;
        if (!restorePaused) {
          video.play().catch(() => {});
        }
      }
    }, 100);
  }, [actualContent?.isFromMinimized, actualContent?.restoreTime, actualContent?.restorePaused]);

  // Ensure videos start unmuted in fullscreen mode
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isVideoType) return;

    // When video loads, ensure it's unmuted for fullscreen experience
    const ensureUnmuted = () => {
      if (video.readyState >= 2) { // HAVE_CURRENT_DATA
        video.muted = false;
        setIsMuted(false);
      }
    };

    // Try immediately if video is ready
    ensureUnmuted();
    
    // Also try when video loads
    video.addEventListener('loadeddata', ensureUnmuted);
    video.addEventListener('canplay', ensureUnmuted);
    
    return () => {
      video.removeEventListener('loadeddata', ensureUnmuted);
      video.removeEventListener('canplay', ensureUnmuted);
    };
  }, [actualContent?.id, isVideoType]);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.fullscreenEnabled && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else {
        showError('Fullscreen is not supported on this device.');
      }
    } catch {
      showError('Fullscreen could not be opened. Try again from the media controls.');
    }
  }, []);

  useVideoKeyboardShortcuts({
    videoRef,
    isPlaying,
    setIsPlaying,
    isMuted,
    setIsMuted,
    volume,
    setVolume,
    onToggleFullscreen: toggleFullscreen,
  });

  useMediaSession({
    videoRef,
    isPlaying,
    setIsPlaying,
    title: actualContent?.title || actualContent?.description || actualContent?.content || 'Video',
    artist: actualContent?.user || actualContent?.creator || (actualContent as any)?.username || 'Equyvo',
  });

  const { handleClick: handleVideoTap } = useVideoGestures({
    videoRef,
    seekTime: 10,
    onSingleTap: () => {
      togglePlay();
    },
    enabled: isVideoType,
  });

  const HIDE_DELAY = 5000;

  // Show controls on any keyboard activity, auto-hide after 5s
  useEffect(() => {
    const onKeyActivity = () => {
      scheduleHide();
    };
    window.addEventListener('keydown', onKeyActivity);
    return () => window.removeEventListener('keydown', onKeyActivity);
  }, []);

  const scheduleHide = () => {
    setShowControls(true);
    if (isVideoType) setShowDetailsPanel(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    if (detailsPanelTimeoutRef.current) clearTimeout(detailsPanelTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), HIDE_DELAY);
    if (isVideoType) {
      detailsPanelTimeoutRef.current = setTimeout(() => setShowDetailsPanel(false), HIDE_DELAY);
    }
  };

  const handleMouseMove = () => {
    lastMouseMoveRef.current = Date.now();
    scheduleHide();
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    
    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(() => {});
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    
    video.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const parsed = parseFloat(e.target.value);
    if (!Number.isFinite(parsed)) return;
    const newVolume = Math.min(1, Math.max(0, parsed));
    try {
      video.volume = newVolume;
    } catch {
      return;
    }
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
  };

  const seekTo = (newTime: number) => {
    if (!Number.isFinite(newTime)) return;
    setCurrentTime(newTime);
    const video = videoRef.current;
    if (video) {
      try {
        video.currentTime = newTime;
      } catch {
        /* ignore */
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement> | number) => {
    const newTime = typeof e === 'number' ? e : parseFloat(e.target.value);
    seekTo(newTime);
  };

  // Add mouse leave handler for desktop fade away
  const handleMouseLeave = () => {
    if (isDesktop) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      if (detailsPanelTimeoutRef.current) {
        clearTimeout(detailsPanelTimeoutRef.current);
      }
      // Hide controls immediately when mouse leaves
      setShowControls(false);
      // Hide details panel immediately for video content
      if (isVideoType) {
        setShowDetailsPanel(false);
      }
    }
  };

  // Cleanup function
  const cleanup = () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    if (detailsPanelTimeoutRef.current) {
      clearTimeout(detailsPanelTimeoutRef.current);
    }
    
    // Pause video if exists
    if (videoRef.current) {
      videoRef.current.pause();
    }
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    } catch { /* fullscreen may already be closing */ }
    
    // Dispatch event to notify Moments component to stop all videos
    window.dispatchEvent(new CustomEvent('fullscreenViewerClosed'));
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (!actualContent) return null;

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const handleLike = () => {
    const next = !isLiked;
    setIsLiked(next);
    setLikeCount(current => Math.max(0, current + (next ? 1 : -1)));
    // Persist the like so the creator is notified and counts agree everywhere.
    const itemId = String(actualContent?.id || actualContent?.videoId || actualContent?.imageId || '').trim();
    if (!itemId || itemId.startsWith('live-')) return;
     api.like(itemId, next ? 'like' : 'unlike').then(({ data }) => {
       const likes = (data as any)?.likes;
       if (typeof likes === 'number') setLikeCount(likes);
    }).catch(() => undefined);
  };

  const handleComment = () => {
    if (onComment) {
      onComment(actualContent.id, actualContent.creator);
    } else {
      // Show comment section directly if no external handler
      setShowCommentSection(true);
    }
  };

  // Every share surface (header, video, image, split) points at the exact
  // item, never at whichever route the viewer happens to be on.
  const shareContentId = String(actualContent?.id || actualContent?.videoId || actualContent?.imageId || '').trim();
  const shareContentUrl = shareContentId
    ? `${window.location.origin}/app/home?post=${encodeURIComponent(shareContentId)}`
    : window.location.href;

  const handleShare = async () => {
    if (onShare) {
      // The page that owns the feed updates the authoritative count. Do not
      // open a second sheet or record a second event here.
      await onShare(actualContent);
    } else {
      const result = await shareItem(shareContentId, {
        title: actualContent?.title || actualContent?.content || 'Check out this content on Equyvo',
        text: actualContent?.content || actualContent?.description || `Check out this ${actualType} by ${actualContent?.creator || 'creator'}`,
        url: shareContentUrl,
      });
      if (!result.success && !result.cancelled) {
        showError(result.error || 'Could not share this content');
        return;
      }
      if (result.success && result.recorded === false) {
        showError(result.error || 'The share count could not be saved');
      }
    }
  };

  const handleMinimize = () => {
    const video = videoRef.current;
    
    // Create a minimized picture-in-picture style window
    const minimizedViewer = document.createElement('div');
    minimizedViewer.id = 'minimized-video-viewer';
    minimizedViewer.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 320px;
      height: 180px;
      background: black;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 1000;
      overflow: hidden;
      cursor: move;
      user-select: none;
    `;
    
    // Add drag functionality
    let isDragging = false;
    let initialX;
    let initialY;

    const dragStart = (e: MouseEvent) => {
      if (e.target === closeBtn || e.target === expandBtn) return;
      
      const rect = minimizedViewer.getBoundingClientRect();
      initialX = e.clientX - rect.left;
      initialY = e.clientY - rect.top;

      if (e.target === minimizedViewer || 
          e.target === dragHandle ||
          minimizedViewer.contains(e.target as Node)) {
        isDragging = true;
        minimizedViewer.style.cursor = 'grabbing';
      }
    };

    const dragEnd = () => {
      isDragging = false;
      minimizedViewer.style.cursor = 'move';
    };

    const drag = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        
        const newX = e.clientX - initialX;
        const newY = e.clientY - initialY;

        // Keep the window within viewport bounds
        const maxX = window.innerWidth - minimizedViewer.offsetWidth;
        const maxY = window.innerHeight - minimizedViewer.offsetHeight;
        
        const boundedX = Math.max(0, Math.min(newX, maxX));
        const boundedY = Math.max(0, Math.min(newY, maxY));

        minimizedViewer.style.bottom = 'auto';
        minimizedViewer.style.right = 'auto';
        minimizedViewer.style.left = `${boundedX}px`;
        minimizedViewer.style.top = `${boundedY}px`;
      }
    };

    // Add event listeners for dragging
    document.addEventListener('mousedown', dragStart);
    document.addEventListener('mouseup', dragEnd);
    document.addEventListener('mousemove', drag);
    
    if (video && fallbackVideoSrc) {
      // Get current video state
      const currentTime = video.currentTime;
      const isPaused = video.paused;
      
      const minimizedVideo = document.createElement('video');
      minimizedVideo.src = fallbackVideoSrc;
      minimizedVideo.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: cover;
      `;
      minimizedVideo.controls = true;
      minimizedVideo.currentTime = currentTime; // Preserve current time
      if (!isPaused) {
        minimizedVideo.play().catch(() => {});
      }
      
      minimizedViewer.appendChild(minimizedVideo);
    } else if (!isVideoType && (actualContent?.thumbnail || actualContent?.image || actualContent?.mediaUrl || actualContent?.media)) {
      // For images, show the image
      const minimizedImage = document.createElement('img');
      minimizedImage.src = actualContent?.thumbnail || actualContent?.image || actualContent?.mediaUrl || actualContent?.media;
      minimizedImage.style.cssText = `
        width: 100%;
        height: 100%;
        object-fit: cover;
      `;
      minimizedViewer.appendChild(minimizedImage);
    }
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '×';
    closeBtn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      background: rgba(0,0,0,0.7);
      color: white;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 16px;
      z-index: 1001;
    `;
    
    closeBtn.onclick = () => {
      const videoElement = minimizedViewer.querySelector('video');
      if (videoElement) {
        videoElement.pause();
      }
      // Remove drag event listeners
      document.removeEventListener('mousedown', dragStart);
      document.removeEventListener('mouseup', dragEnd);
      document.removeEventListener('mousemove', drag);
      document.body.removeChild(minimizedViewer);
    };
    
    // Add expand button
    const expandBtn = document.createElement('button');
    expandBtn.innerHTML = '⛶';
    expandBtn.style.cssText = `
      position: absolute;
      top: 8px;
      right: 40px;
      width: 24px;
      height: 24px;
      background: rgba(0,0,0,0.7);
      color: white;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      z-index: 1001;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    
    expandBtn.onclick = () => {
      // Get current video state
      const videoElement = minimizedViewer.querySelector('video');
      const currentTime = videoElement ? videoElement.currentTime : 0;
      const isPaused = videoElement ? videoElement.paused : true;
      
      // Remove drag event listeners
      document.removeEventListener('mousedown', dragStart);
      document.removeEventListener('mouseup', dragEnd);
      document.removeEventListener('mousemove', drag);
      
      // Remove minimized viewer
      document.body.removeChild(minimizedViewer);
      
      // Store current state to restore after re-render
      (window as any).restoreVideoState = { currentTime, isPaused };
      
      // Ensure video source is preserved in temp content
      const restoredContent = {
        ...actualContent,
        restoreTime: currentTime,
        restorePaused: isPaused,
        isFromMinimized: true, // Flag to indicate this is from minimized state
        // Explicitly preserve video sources
        videoUrl: actualContent?.videoUrl || actualContent?.mediaUrl || actualContent?.media || actualContent?.src || fallbackVideoSrc,
        mediaUrl: actualContent?.mediaUrl || actualContent?.videoUrl || fallbackVideoSrc,
        media: actualContent?.media || actualContent?.videoUrl || fallbackVideoSrc,
        src: actualContent?.src || actualContent?.videoUrl || fallbackVideoSrc
      };
      
      // Set temp content for restoration with proper flags
      (window as any).tempFullscreenContent = restoredContent;
      
      // Trigger a custom event to notify parent to reopen fullscreen
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('reopenFullscreen', { 
          detail: { 
            content: restoredContent,
            currentTime, 
            isPaused,
            isFromMinimized: true 
          } 
        }));
      }, 100);
    };
    
    minimizedViewer.appendChild(expandBtn);
    minimizedViewer.appendChild(closeBtn);
    
    // Add drag handle indicator
    const dragHandle = document.createElement('div');
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.style.cssText = `
      position: absolute;
      top: 8px;
      left: 8px;
      color: rgba(255,255,255,0.5);
      font-size: 12px;
      cursor: move;
      z-index: 1001;
      padding: 4px;
      border-radius: 4px;
      transition: color 0.2s;
    `;
    dragHandle.onmouseenter = () => {
      dragHandle.style.color = 'rgba(255,255,255,0.8)';
    };
    dragHandle.onmouseleave = () => {
      dragHandle.style.color = 'rgba(255,255,255,0.5)';
    };
    minimizedViewer.appendChild(dragHandle);
    
    document.body.appendChild(minimizedViewer);
    
    onClose();
  };


  const handleSplitView = () => {
    const video = videoRef.current;
    const wasPlaying = video && !video.paused;
    
    setIsSplitView(!isSplitView);
    
    // Restore video state after state update
    setTimeout(() => {
      if (video && wasPlaying && video.paused) {
        video.play().catch(() => {});
      }
    }, 100);
  };

  const handleFollow = () => {
    // Real owner id only — never invent a fake id from the display name
    // (that navigation landed on unrelated profiles).
    const ownerId = ownerIdOf(actualContent) || actualContent?.creatorId;
    if (onFollow && ownerId && !isPlaceholderId(ownerId)) {
      onFollow(ownerId);
      showSuccess(followedCreators.has(ownerId) ? 'Unfollowed creator' : 'Following creator!');
    } else {
      showSuccess('No creator to follow');
    }
  };

  return (
    <div
      className={`fixed inset-0 bg-black z-[150] ${isSplitView ? 'flex' : ''}`}
      style={getContainerStyle()}
    >
      {/* Top bar with minimal controls */}
      <div
        className={`fixed top-0 left-0 right-0 z-50 bg-gradient-to-b from-black/90 via-black/70 to-transparent p-4 ${isSplitView ? 'w-1/2' : ''} top-controls-bar transition-all duration-500 eq-safe-top eq-fullscreen-top-safe ${isVideoType ? (showDetailsPanel ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-full') : 'opacity-100 translate-y-0'}`}
        style={{
          pointerEvents: isVideoType && !showDetailsPanel ? 'none' : 'auto'
        }}
        onMouseEnter={() => {
          if (isVideoType) {
            setShowDetailsPanel(true);
          }
        }}
        onMouseMove={() => {
          if (isVideoType) {
            setShowDetailsPanel(true);
          }
        }}
      >
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleMinimize}
            className="text-white hover:bg-white/20 bg-white/10 backdrop-blur-sm rounded-full p-2 shadow-lg"
            title="Minimize"
          >
            <Minimize2 className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              handleSplitView();
            }}
            className="text-white hover:bg-white/20 bg-white/10 backdrop-blur-sm rounded-full p-2 shadow-lg"
            title="Split View"
          >
            <Columns className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setIsSplitView(false);
              setTimeout(() => {
                onClose();
              }, 100);
            }}
            className="text-white hover:bg-white/20 bg-white/10 backdrop-blur-sm rounded-full p-2 shadow-lg"
            title="Escape"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Video Container - Full height or split view */}
      {isVideoType && (
        <div 
          className={`main-video-container ${isSplitView ? 'w-1/2 h-full relative flex' : 'fixed inset-0 w-full h-full'}`}
          style={{
            position: isSplitView ? 'relative' : 'fixed',
            top: isSplitView ? 'auto' : 0,
            left: isSplitView ? 'auto' : 0,
            right: isSplitView ? 'auto' : 0,
            bottom: isSplitView ? 'auto' : 0,
            width: isSplitView ? '50%' : '100vw',
            height: isSplitView ? '100%' : '100vh',
            margin: 0,
            padding: 0,
            backgroundColor: 'black',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden'
          }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onMouseEnter={() => {
            if (isVideoType) {
              setShowDetailsPanel(true);
            }
          }}
          onClick={(e) => {
            const target = e.target as HTMLElement | null;
            
            if (target?.closest('.top-controls-bar')) return;
            
            if (isSplitView) {
              if (target?.closest('video')) {
                e.stopPropagation();
                e.preventDefault();
                togglePlay();
                return;
              }
              return;
            }
            
            scheduleHide();
            handleVideoTap(e);
          }}
        >
          {fallbackVideoSrc && !videoFailed ? (
            <video
              ref={videoRef}
              key={videoRetryKey}
              src={videoRetryKey === 0 ? String(fallbackVideoSrc) : `${String(fallbackVideoSrc)}${String(fallbackVideoSrc).includes('?') ? '&' : '?'}streamretry=${videoRetryKey}`}
              className={`${isPortraitMoment || isStory ? 'max-w-full max-h-screen object-cover mx-auto' : 'absolute inset-0 w-full h-full'}`}
              style={getVideoContainerStyle()}
              autoPlay
              playsInline
              controls={false}
              muted={false}
              loop={isPortraitMoment || isStory}
              preload="metadata"
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onError={() => {
                // One failed streaming attempt (dropped range, cold edge,
                // flaky mobile link) must not end the fullscreen show —
                // remount with a cache-busting URL up to 3 times.
                if (videoRetryKey < 3) setVideoRetryKey(k => Math.min(3, k + 1));
                else setVideoFailed(true);
              }}
              onTimeUpdate={(e) => {
                setCurrentTime(e.currentTarget.currentTime);
                // Live → normal transition: the recording acquired a real
                // duration and the playhead reached its end (or the element
                // reports ended) — the seek bar becomes a regular one.
                if (effectiveLive) {
                  const v = e.currentTarget;
                  const d = v.duration;
                  if (v.ended || (isFinite(d) && d > 0 && v.currentTime >= d - 0.4)) {
                    setLiveEnded(true);
                  }
                }
              }}
              onEnded={() => { if (effectiveLive) setLiveEnded(true); }}
              onSeeked={(e) => { setCurrentTime(e.currentTarget.currentTime); }}
              onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); }}
            />
          ) : (
            <div className="absolute inset-0 w-full h-full flex items-center justify-center" style={{ zIndex: 1, pointerEvents: 'none' }}>
              <div className="text-white text-center">
                <p className="text-xl mb-2">{videoFailed ? 'Video could not be loaded' : 'Video not available'}</p>
                <p className="text-sm text-gray-400">{videoFailed ? 'Check your connection and try again.' : 'No video URL provided'}</p>
                {videoFailed && (
                  <button
                    type="button"
                    className="pointer-events-auto mt-3 rounded-full bg-white px-4 py-2 text-sm text-black"
                    onClick={() => {
                      setVideoFailed(false);
                      setVideoRetryKey(0);
                    }}
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}
          
          {/* Combined bottom overlay with video info and controls */}
          <div className="absolute bottom-0 left-0 right-0 flex flex-col justify-end pointer-events-none eq-safe-bottom">
            {/* Details Section - above controls */}
            {!isSplitView && (
              <div className={`bg-gradient-to-t from-black/90 via-black/70 to-transparent p-4 pt-12 transition-all duration-500 ${isVideoType ? (showDetailsPanel ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-full') : 'opacity-100 translate-y-0'}`}
                style={{
                  pointerEvents: isVideoType && !showDetailsPanel ? 'none' : 'auto'
                }}
                onMouseEnter={() => {
                  if (isVideoType) {
                    setShowDetailsPanel(true);
                  }
                }}
                onMouseMove={() => {
                  if (isVideoType) {
                    setShowDetailsPanel(true);
                  }
                }}
              >
                {/* Video Information */}
                <div className="mb-3">
                  <h2 className="text-white text-lg md:text-xl font-semibold mb-1 line-clamp-2">
                    {actualContent.title || 'Untitled Video'}
                  </h2>
                  <div className="flex items-center gap-3 text-white/80 text-sm">
                    <div className="flex items-center gap-2">
                      <Avatar 
                        className="h-8 w-8 cursor-pointer hover:ring-2 hover:ring-white/50 transition-all duration-200"
                        onClick={() => {
                          navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator);
                        }}
                        title={`${actualContent.creator}'s Profile`}
                      >
                                          {realAvatarSrc ? <AvatarImage src={realAvatarSrc} /> : null}
                        <AvatarFallback className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                          {(actualContent.creator || 'Unknown').substring(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span 
                        className="font-medium hover:text-white transition-colors cursor-pointer"
                        onClick={() => navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator)}
                      >
                        {actualContent.creator || 'Unknown Creator'}
                      </span>
                      {actualContent.verified === true && (
                        <div className="bg-blue-500 rounded-full p-0.5">
                          <div className="w-2 h-2 bg-white rounded-full"></div>
                        </div>
                      )}
                    </div>
                    {/* Equyvo has followers only — no subscribers. Follower counts
                        are shown only when the server provides a real number. */}
                    {Number.isFinite(Number((actualContent as any)?.followersCount ?? (actualContent as any)?.followerCount)) &&
                      Number((actualContent as any)?.followersCount ?? (actualContent as any)?.followerCount) > 0 && (
                      <span className="text-white/60">{formatNumber(Number((actualContent as any)?.followersCount ?? (actualContent as any)?.followerCount))} followers</span>
                    )}
                    {actualContent.views && (
                      <span className="flex items-center gap-1">
                        <Users className="h-4 w-4" /> {formatNumber(actualContent.views)} views
                      </span>
                    )}
                    {actualContent.published && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-4 w-4" /> {actualContent.published}
                      </span>
                    )}
                    {actualContent.duration && (
                      <span className="flex items-center gap-1">
                        <Clock className="h-4 w-4" /> {actualContent.duration}
                      </span>
                    )}
                  </div>
                  {actualContent.description && (
                    <p className="text-white/70 text-sm mt-2 line-clamp-2">
                      {actualContent.description}
                    </p>
                  )}
                </div>

                {/* Tags */}
                 {contentTags.length > 0 && (
                   <div className="flex flex-wrap gap-1 mb-3">
                     {contentTags.slice(0, 6).map((tag: string, index: number) => (
                      <Badge key={index} variant="outline" className="text-xs bg-white/10 text-white/80 border-white/20">
                        #{tag}
                      </Badge>
                    ))}
                     {contentTags.length > 6 && (
                       <Badge variant="outline" className="text-xs bg-white/10 text-white/80 border-white/20">
                         +{contentTags.length - 6}
                      </Badge>
                    )}
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`text-white hover:bg-white/20 hover:text-white transition-all duration-200 ${isLiked ? 'text-red-500' : ''}`}
                    onClick={handleLike}
                    title="Like video"
                  >
                    <ThumbsUp className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
                    <span className="ml-1 text-xs">{formatNumber(likeCount)}</span>
                  </Button>
                  
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
                    onClick={handleComment}
                    title="Comment"
                  >
                    <MessageCircle className="h-4 w-4" />
                    {commentCount > 0 && (
                      <span className="ml-1 text-xs">{formatNumber(commentCount)}</span>
                    )}
                  </Button>
                  
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
                    onClick={handleShare}
                    title="Share video"
                  >
                    <Share2 className="h-4 w-4" />
                  </Button>
                  
                  <div className="flex items-center">
                     <SaveButton postId={viewerContentId} content={actualContent} />
                  </div>
                  
                  {actualContent.creatorId && (
                    <Button
                      variant={followedCreators.has(actualContent.creatorId) ? "default" : "outline"}
                      size="sm"
                      className="text-white border-white/30 hover:bg-white/20 hover:text-white"
                      onClick={handleFollow}
                    >
                      {followedCreators.has(actualContent.creatorId) ? "Following" : "Follow"}
                    </Button>
                  )}
                </div>
              </div>
            )}
            
            {/* Custom Video Controls — the inline padding now reserves real
                gesture-bar / curved-edge space on Android edge-to-edge builds
                (env() reads 0 in the Capacitor WebView, so the
                --native-safe-bottom var is always included), keeping the
                play/pause, seek and every control above the system navbar
                and clickable. */}
            <div 
              className="bg-gradient-to-t from-black/90 via-black/60 to-transparent p-4 transition-opacity duration-500 pointer-events-none"
              style={{ 
                paddingBottom: isPortraitMoment
                  ? 'calc(max(1rem, var(--native-safe-bottom, 0px), env(safe-area-inset-bottom, 0px)) + 120px)'
                  : (isMobileDevice && !isPortraitMoment && !isStory)
                    ? 'calc(max(1rem, var(--native-safe-bottom, 0px), env(safe-area-inset-bottom, 0px)) + 80px)'
                    : 'calc(max(1rem, var(--native-safe-bottom, 0px), env(safe-area-inset-bottom, 0px)) + 140px)',
                display: showControls ? 'block' : 'none'
              }}
            >
              {/* Progress Bar — hover/drag shows a small preview window above the bar */}
              <div className="relative mb-3">
                {effectiveLive ? (
                  <div className="relative">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-red-500 text-xs font-medium flex items-center gap-1">
                        <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                        LIVE
                      </span>
                      <span className="text-white text-xs font-medium">
                        {formatTime(currentTime)}
                      </span>
                    </div>
                    <div className="w-full h-2 bg-red-500/30 rounded-lg overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-red-500 via-red-600 to-red-500 rounded-full animate-pulse"
                        style={{
                          width: '100%',
                          backgroundSize: '200% 100%',
                          animation: 'shimmer 2s ease-in-out infinite'
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="pointer-events-auto">
                    <VideoSeekBar
                      videoRef={videoRef}
                      currentTime={currentTime}
                      duration={duration || 0}
                      onSeek={seekTo}
                    />
                  </div>
                )}
              </div>
              
              {/* Controls Row */}
              <div className="flex items-center justify-between pointer-events-auto">
                <div className="flex items-center gap-4">
                  <button
                    onClick={togglePlay}
                    className="text-white hover:text-blue-400 transition-colors p-2 hover:bg-white/10 rounded-full"
                  >
                    {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                  </button>
                  
                  <button
                    onClick={() => {
                      const v = videoRef.current;
                      if (v) v.currentTime = Math.max(0, v.currentTime - 5);
                    }}
                    className="text-white hover:text-blue-400 transition-colors p-2 hover:bg-white/10 rounded-full max-md:hidden"
                  >
                    <RotateCcw className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => {
                      const v = videoRef.current;
                      if (v) v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
                    }}
                    className="text-white hover:text-blue-400 transition-colors p-2 hover:bg-white/10 rounded-full max-md:hidden"
                  >
                    <RotateCcw className="h-5 w-5 scale-x-[-1]" />
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={toggleMute}
                      className="text-white hover:text-blue-400 transition-colors p-2 hover:bg-white/10 rounded-full"
                    >
                      {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                    </button>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      className="w-24 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>
                  
                  <span className="text-white text-sm font-medium">
                    {effectiveLive ? `LIVE ${formatTime(currentTime)}` : `${formatTime(currentTime)} / ${formatTime(duration || 100)}`}
                  </span>
                </div>
                
                <div className="flex items-center gap-3">
                  <button 
                    onClick={() => {
                       void toggleFullscreen();
                    }}
                    className="text-white hover:text-blue-400 transition-colors p-2 hover:bg-white/10 rounded-full"
                    title={isFullscreen ? "Exit Fullscreen" : "Enter Fullscreen"}
                  >
                    {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Split View Bottom Bar - appears inside video container */}
      {isSplitView && isVideoType && videoSrc && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-4 eq-safe-bottom"
          style={{
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)'
          }}
        >
          {/* Video Information */}
          <div className="mb-3">
            <h2 className="text-white text-lg md:text-xl font-semibold mb-1 line-clamp-2">
              {actualContent.title || 'Untitled Video'}
            </h2>
            <div className="flex items-center gap-3 text-white/80 text-sm">
              <div className="flex items-center gap-2">
                <Avatar 
                  className="h-8 w-8 cursor-pointer hover:ring-2 hover:ring-white/50 transition-all duration-200"
                  onClick={() => {
                    // Navigate to creator's profile when avatar is clicked
                    navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator);
                  }}
                  title={`${actualContent.creator}'s Profile`}
                >
                                    {realAvatarSrc ? <AvatarImage src={realAvatarSrc} /> : null}
                  <AvatarFallback className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                    {(actualContent.creator || 'Unknown').substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span 
                  className="font-medium hover:text-white transition-colors cursor-pointer"
                  onClick={() => navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator)}
                  title={`${actualContent.creator}'s Profile`}
                >
                  {actualContent.creator || 'Unknown Creator'}
                </span>
                {actualContent.verified === true && (
                  <div className="bg-blue-500 rounded-full p-0.5">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                  </div>
                )}
              </div>
              {Number.isFinite(Number((actualContent as any)?.followersCount ?? (actualContent as any)?.followerCount)) &&
                Number((actualContent as any)?.followersCount ?? (actualContent as any)?.followerCount) > 0 && (
                <span className="text-white/60">{formatNumber(Number((actualContent as any)?.followersCount ?? (actualContent as any)?.followerCount))} followers</span>
              )}
              {actualContent.views && (
                <span className="flex items-center gap-1">
                  <Users className="h-4 w-4" /> {formatNumber(actualContent.views)} views
                </span>
              )}
              {actualContent.published && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" /> {actualContent.published}
                </span>
              )}
              {actualContent.duration && (
                <span className="flex items-center gap-1">
                  <Clock className="h-4 w-4" /> {actualContent.duration}
                </span>
              )}
            </div>
            {actualContent.description && (
              <p className="text-white/70 text-sm mt-2 line-clamp-2">
                {actualContent.description}
              </p>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              className={`text-white hover:bg-white/20 hover:text-white transition-all duration-200 ${isLiked ? 'text-red-500' : ''}`}
              onClick={handleLike}
              title="Like video"
            >
              <ThumbsUp className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
              <span className="ml-1 text-xs">{formatNumber(likeCount)}</span>
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
              onClick={() => {
                if (onComment) {
                  onComment(actualContent.id, actualContent.creator);
                } else {
                  setShowCommentSection(true);
                }
              }}
              title="Comment"
            >
              <MessageCircle className="h-4 w-4" />
               {commentCount > 0 && (
                 <span className="ml-1 text-xs">{formatNumber(commentCount)}</span>
              )}
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
              onClick={() => {
                handleShare();
              }}
              title="Share video"
            >
              <Share2 className="h-4 w-4" />
            </Button>
            
            <div className="flex items-center">
               <SaveButton postId={viewerContentId} content={actualContent} />
            </div>
            
            {actualContent.creatorId && onFollow && (
              <Button
                variant={followedCreators.has(actualContent.creatorId) ? "default" : "outline"}
                size="sm"
                className="text-white border-white/30 hover:bg-white/20 hover:text-white"
                onClick={() => onFollow(actualContent.creatorId)}
              >
                {followedCreators.has(actualContent.creatorId) ? "Following" : "Follow"}
              </Button>
            )}
          </div>
        </div>
      )}
      
      {/* Split View Bottom Bar - appears inside image container */}
      {isSplitView && !isVideoType && actualType === 'image' && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-4 eq-safe-bottom"
          style={{
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)'
          }}
        >
          {/* Image Information */}
          <div className="mb-3">
            <h2 className="text-white text-lg md:text-xl font-semibold mb-1 line-clamp-2">
              {actualContent.title || 'Untitled Image'}
            </h2>
            <div className="flex items-center gap-3 text-white/80 text-sm">
              <div className="flex items-center gap-2">
                <Avatar 
                  className="h-8 w-8 cursor-pointer hover:ring-2 hover:ring-white/50 transition-all duration-200"
                  onClick={() => {
                    // Navigate to creator's profile when avatar is clicked
                    navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator);
                  }}
                  title={`${actualContent.creator}'s Profile`}
                >
                                    {realAvatarSrc ? <AvatarImage src={realAvatarSrc} /> : null}
                  <AvatarFallback className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                    {(actualContent.creator || 'Unknown').substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span 
                  className="font-medium hover:text-white transition-colors cursor-pointer"
                  onClick={() => navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator)}
                  title={`${actualContent.creator}'s Profile`}
                >
                {actualContent.creator || 'Unknown Creator'}
                </span>
                {actualContent.verified === true && (
                  <div className="bg-blue-500 rounded-full p-0.5">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                  </div>
                )}
              </div>
              {actualContent.views && (
                <span className="flex items-center gap-1">
                  <Eye className="h-4 w-4" /> {formatNumber(actualContent.views)} views
                </span>
              )}
              {actualContent.likes && (
                <span className="flex items-center gap-1">
                  <ThumbsUp className="h-4 w-4" /> {formatNumber(Number(actualContent.likes) || likeCount || 0)} likes
                </span>
              )}
            </div>
            {actualContent.description && (
              <p className="text-white/70 text-sm mt-2 line-clamp-2">
                {actualContent.description}
              </p>
           )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              className={`text-white hover:bg-white/20 hover:text-white transition-all duration-200 ${isLiked ? 'text-red-500' : ''}`}
              onClick={handleLike}
              title="Like image"
            >
              <ThumbsUp className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
              <span className="ml-1 text-xs">{formatNumber(likeCount)}</span>
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
              onClick={() => {
                if (onComment) {
                  onComment(actualContent.id, actualContent.creator);
                } else {
                  setShowCommentSection(true);
                }
              }}
              title="Comment"
            >
              <MessageCircle className="h-4 w-4" />
               {commentCount > 0 && (
                 <span className="ml-1 text-xs">{formatNumber(commentCount)}</span>
              )}
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
              onClick={() => {
                handleShare();
              }}
              title="Share image"
            >
              <Share2 className="h-4 w-4" />
            </Button>
            
            <div className="flex items-center">
               <SaveButton postId={viewerContentId} content={actualContent} />
            </div>
            
            {actualContent.creatorId && onFollow && (
              <Button
                variant={followedCreators.has(actualContent.creatorId) ? "default" : "outline"}
                size="sm"
                className="text-white border-white/30 hover:bg-white/20 hover:text-white"
                onClick={() => onFollow(actualContent.creatorId)}
              >
                {followedCreators.has(actualContent.creatorId) ? "Following" : "Follow"}
              </Button>
            )}
          </div>
        </div>
      )}
      
      {/* Split View Panel - Browse other videos */}
      {isSplitView && (
        <div
          className="split-view-panel w-1/2 h-full bg-gray-900 overflow-hidden flex flex-col"
          style={{ pointerEvents: 'auto' }}
        >
          {/* eq-fullscreen-top-safe keeps the panel clear of the persistent
              Android/tablet notification bar (edge-to-edge): the status bar
              overlays this fixed overlay, and without the inset the first
              lines of the panel were unreadable. eq-safe-bottom does the same
              for the gesture-nav strip above the scroll list. */}
          <div className="p-4 border-b border-gray-800 eq-safe-top eq-fullscreen-top-safe">
            <p className="text-gray-400 text-sm">Browse more {resolvedType === 'moment' ? 'moments' : resolvedType === 'live' ? 'live streams' : resolvedType === 'video' ? 'videos' : resolvedType === 'post' ? 'posts' : resolvedType === 'thought' ? 'thoughts' : resolvedType === 'story' ? 'stories' : 'content'} while watching</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4 eq-safe-bottom">
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">No related content available yet</p>
          </div>
          </div>
        </div>
      )}

      {/* Audio uploads use a native, range-friendly player instead of being
          sent through the image renderer. This covers voice/audio posts and
          prevents an audio URL from producing a blank fullscreen image. */}
      {isAudioType && (
        <div className="fixed inset-0 z-[2] flex items-center justify-center bg-gradient-to-br from-slate-950 via-black to-purple-950 px-6">
          <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-black/50 p-6 text-white shadow-2xl backdrop-blur-md">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-full bg-white/10 p-3">
                <Volume2 className="h-7 w-7" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold">{String(actualContent.title || actualContent.content || 'Audio')}</h2>
                <p className="truncate text-sm text-white/60">{String(actualContent.creator || actualContent.user || 'Equyvo')}</p>
              </div>
            </div>
            {audioSrc ? (
              <audio
                className="w-full"
                src={audioSrc}
                controls
                preload="metadata"
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onError={() => showError('This audio could not be played right now.')}
                aria-label={String(actualContent.title || 'Audio content')}
              />
            ) : (
              <p className="text-center text-sm text-white/60">No playable audio was attached.</p>
            )}
            {actualContent.description && (
              <p className="mt-4 line-clamp-3 text-sm text-white/70">{String(actualContent.description)}</p>
            )}
          </div>
        </div>
      )}

      {/* Content for images */}
      {!isVideoType && !isAudioType && (actualType === 'image' || actualType === 'post') && (
        <div 
          className={`${isSplitView ? 'w-1/2 h-full relative' : 'fixed inset-0'} h-full flex items-center justify-center cursor-zoom-in`}
          style={{ 
            zIndex: 1,
            width: isSplitView ? '50%' : '100vw',
            height: isSplitView ? '100%' : '100vh'
          }}
          onClick={() => {
            setShowImageOverlay(prev => !prev);
          }}
        >
          {imageSrc && !imageFailed ? (
          <img
            key={`fs-image-${imageRenderKey}`}
            src={imageRenderKey ? `${imageSrc}${imageSrc.includes('?') ? '&' : '?'}fsretry=${imageRenderKey}` : imageSrc}
            alt={actualContent?.title || 'Fullscreen Image'}
            className="max-w-full max-h-full object-contain transition-all duration-300"
            style={{
              width: 'auto',
              height: 'auto',
              maxWidth: isSplitView ? '100%' : '100vw',
              maxHeight: isSplitView ? '100%' : '100vh',
              objectFit: 'contain',
              objectPosition: 'center',
              display: 'block',
              imageRendering: 'crisp-edges',
              imageResolution: 'from-image 1dppx'
            }}
            onError={handleFullscreenImageError}
            onLoad={(e) => {
              const target = e.target as HTMLImageElement;
              target.style.imageRendering = 'auto';
            }}
          />
          ) : (
            <div className="text-white text-center px-6">
              <p className="text-xl mb-2">Image not available</p>
              <p className="text-sm text-gray-400">The uploader did not attach viewable media</p>
            </div>
          )}
        </div>
      )}

      {/* Image overlay with actions (non-split-view) */}
      {!isVideoType && (actualType === 'image' || actualType === 'post') && !isSplitView && showImageOverlay && (
        <div
          className="fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-black/90 via-black/70 to-transparent p-4 eq-safe-bottom animate-in slide-in-from-bottom duration-300"
          style={{
            paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)'
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-3">
            <h2 className="text-white text-lg md:text-xl font-semibold mb-1 line-clamp-2">
              {actualContent.title || 'Untitled Image'}
            </h2>
            <div className="flex items-center gap-3 text-white/80 text-sm">
              <div className="flex items-center gap-2">
                <Avatar 
                  className="h-8 w-8 cursor-pointer hover:ring-2 hover:ring-white/50 transition-all duration-200"
                  onClick={() => navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator)}
                >
                                    {realAvatarSrc ? <AvatarImage src={realAvatarSrc} /> : null}
                  <AvatarFallback className="bg-gradient-to-r from-purple-500 to-pink-500 text-white text-xs">
                    {(actualContent.creator || 'Unknown').substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span 
                  className="font-medium hover:text-white transition-colors cursor-pointer"
                  onClick={() => navigateToProfile(navigate, ownerIdOf(actualContent) || undefined, actualContent.creator)}
                >
                  {actualContent.creator || 'Unknown Creator'}
                </span>
                {actualContent.verified === true && (
                  <div className="bg-blue-500 rounded-full p-0.5">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                  </div>
                )}
              </div>
              {actualContent.views && (
                <span className="flex items-center gap-1">
                  <Eye className="h-4 w-4" /> {formatNumber(actualContent.views)} views
                </span>
              )}
            </div>
            {actualContent.description && (
              <p className="text-white/70 text-sm mt-2 line-clamp-2">
                {actualContent.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              size="sm"
              className={`text-white hover:bg-white/20 hover:text-white transition-all duration-200 ${isLiked ? 'text-red-500' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleLike();
              }}
              title="Like image"
            >
              <ThumbsUp className={`h-4 w-4 ${isLiked ? 'fill-current' : ''}`} />
              <span className="ml-1 text-xs">{formatNumber(likeCount)}</span>
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
              onClick={(e) => {
                e.stopPropagation();
                if (onComment) {
                  onComment(actualContent.id, actualContent.creator);
                } else {
                  setShowCommentSection(true);
                }
              }}
              title="Comment"
            >
              <MessageCircle className="h-4 w-4" />
               {commentCount > 0 && (
                 <span className="ml-1 text-xs">{formatNumber(commentCount)}</span>
              )}
            </Button>
            
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/20 hover:text-white transition-all duration-200"
              onClick={(e) => {
                e.stopPropagation();
                handleShare();
              }}
              title="Share image"
            >
              <Share2 className="h-4 w-4" />
            </Button>
            
            <div className="flex items-center">
               <SaveButton postId={viewerContentId} content={actualContent} />
            </div>
          </div>
        </div>
      )}

      {/* Content for other non-video types - try to show as image if possible */}
      {!isVideoType && !isAudioType && actualType !== 'image' && actualType !== 'post' && (
        <div 
          className={`${isSplitView ? 'w-1/2 h-full relative' : 'fixed inset-0'} h-full flex items-center justify-center cursor-zoom-in`}
          style={{ 
            zIndex: 1,
            width: isSplitView ? '50%' : '100vw',
            height: isSplitView ? '100%' : '100vh'
          }}
          onClick={() => {
            void toggleFullscreen();
          }}
        >
          {imageSrc && !imageFailed ? (
          <img
            key={`fs-content-image-${imageRenderKey}`}
            src={imageRenderKey ? `${imageSrc}${imageSrc.includes('?') ? '&' : '?'}fsretry=${imageRenderKey}` : imageSrc}
            alt={actualContent?.title || 'Fullscreen Content'}
            className="max-w-full max-h-full object-contain transition-all duration-300"
            style={{
              width: 'auto',
              height: 'auto',
              maxWidth: isSplitView ? '100%' : '100vw',
              maxHeight: isSplitView ? '100%' : '100vh',
              objectFit: 'contain',
              objectPosition: 'center',
              display: 'block',
              imageRendering: 'crisp-edges',
              imageResolution: 'from-image 1dppx'
            }}
            onError={handleFullscreenImageError}
            onLoad={(e) => {
              const target = e.target as HTMLImageElement;
              // Enhance image quality for HD displays
              target.style.imageRendering = 'auto';
            }}
          />
          ) : (
            <div className="text-white text-center px-6">
              <p className="text-xl mb-2">Content not available</p>
              <p className="text-sm text-gray-400">The uploader did not attach viewable media</p>
            </div>
          )}

        </div>
      )}





      {/* Comment Section */}
      <CommentSection
        isOpen={showCommentSection}
        onClose={() => setShowCommentSection(false)}
        postId={actualContent?.id || 'unknown'}
        postUser={actualContent?.creator || actualContent?.user || 'Unknown'}
      />
    </div>
  );
};

export default FullscreenViewer;
