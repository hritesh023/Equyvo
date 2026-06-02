"use client";

import React, { useState, useEffect, useRef } from 'react';
import { X, MoreVertical, MessageCircle, Send, Volume2, VolumeX, Play, Pause, Bookmark, Heart, Share2 } from 'lucide-react';
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
import { showSuccess, showError } from '@/utils/toast';
import { useAudio } from '../contexts/AudioContext';

interface Moment {
  id: string;
  title: string;
  image: string;
  views: string;
  userId?: string;
  user?: string;
  avatar?: string;
  time?: string;
  isLiked?: boolean;
  likes?: number;
  comments?: number;
  videoUrl?: string;
  mediaType?: 'video' | 'image';
  media?: string;
}

interface MomentViewerProps {
  moment: Moment;
  onClose: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  onLike?: (momentId: string) => void;
  onComment?: (momentId: string, comment: string) => void;
  onShare?: (momentId: string) => void;
}

const MomentViewer: React.FC<MomentViewerProps> = ({
  moment,
  onClose,
  onNext,
  onPrevious,
  onLike,
  onComment,
  onShare,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { isGloballyMuted, setGlobalMute } = useAudio();
  const [comment, setComment] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLiked, setIsLiked] = useState(moment.isLiked || false);
  const [likesCount, setLikesCount] = useState(moment.likes || 0);
  const [showControls, setShowControls] = useState(true);
  const isVideo = !!(moment.videoUrl || moment.media || moment.mediaType === 'video');

  // Auto-hide controls after 3 seconds
  useEffect(() => {
    const timer = setTimeout(() => {
      setShowControls(false);
    }, 3000);

    return () => clearTimeout(timer);
  }, [isPlaying]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          onPrevious?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          onNext?.();
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onNext, onPrevious, onClose]);

  const togglePlayVideo = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleLike = () => {
    const newLikedState = !isLiked;
    setIsLiked(newLikedState);
    setLikesCount(prev => newLikedState ? prev + 1 : prev - 1);
    
    if (onLike) {
      onLike(moment.id);
    }
    
    showSuccess(newLikedState ? '❤️ Moment liked!' : '💔 Moment unliked');
  };

  const handleComment = () => {
    if (comment.trim()) {
      if (onComment) {
        onComment(moment.id, comment);
      }
      showSuccess('💬 Comment posted successfully!');
      setComment('');
    } else {
      showError('Please enter a comment');
    }
  };

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: moment.title,
        text: `Check out this moment: ${moment.title}`,
        url: window.location.href
      }).catch(() => {
        navigator.clipboard.writeText(window.location.href);
        showSuccess('🔗 Moment link copied to clipboard!');
      });
    } else {
      navigator.clipboard.writeText(window.location.href);
      showSuccess('🔗 Moment link copied to clipboard!');
    }
    
    if (onShare) {
      onShare(moment.id);
    }
  };

  const toggleMute = () => {
    setGlobalMute(!isGloballyMuted);
  };

  return (
    <div 
      className="moment-viewer fixed inset-0 z-50 bg-black flex items-center justify-center"
      onMouseMove={() => setShowControls(true)}
      onClick={() => setShowControls(true)}
    >
      {/* Close Button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="absolute top-4 right-4 z-20 text-white hover:bg-white/20"
      >
        <X className="h-6 w-6" />
      </Button>

      {/* Main Content - Portrait Mode */}
      <div className="relative w-full h-full max-w-md mx-auto flex flex-col">
        {/* Moment Image/Video */}
        <div className="relative flex-1 bg-black flex items-center justify-center">
          {isVideo ? (
            <video
              ref={videoRef}
              src={moment.videoUrl || moment.media}
              className="w-full h-full object-contain"
              loop
              playsInline
              muted={isGloballyMuted}
              onClick={togglePlayVideo}
            />
          ) : (
            <img
              src={moment.image}
              alt={moment.title}
              className="w-full h-full object-contain"
            />
          )}
          
          {/* Play/Pause Overlay - only show for videos */}
          {isVideo && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div 
                className="bg-black/50 backdrop-blur-sm rounded-full p-4 cursor-pointer pointer-events-auto"
                onClick={togglePlayVideo}
              >
                {isPlaying ? (
                  <Pause className="h-8 w-8 text-white" />
                ) : (
                  <Play className="h-8 w-8 text-white ml-1" />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Section with Info and Actions */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent p-4">
          {/* Title and Views */}
          <div className="mb-3">
            <h3 className="text-white font-bold text-lg">{moment.title}</h3>
            <p className="text-white/70 text-sm">{moment.views} views</p>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              {/* Like Button */}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleLike}
                className={`text-white hover:bg-white/20 ${isLiked ? 'text-red-500' : ''}`}
              >
                <Heart className={`h-6 w-6 ${isLiked ? 'fill-current' : ''}`} />
              </Button>

              {/* Comment Button */}
              <Button
                variant="ghost"
                size="icon"
                className="text-white hover:bg-white/20"
              >
                <MessageCircle className="h-6 w-6" />
              </Button>

              {/* Share Button */}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleShare}
                className="text-white hover:bg-white/20"
              >
                <Share2 className="h-6 w-6" />
              </Button>
            </div>

            {/* More Options */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="text-white hover:bg-white/20 z-30"
                >
                  <MoreVertical className="h-6 w-6" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[100000] bg-black/90 backdrop-blur-sm border border-white/20">
                <DropdownMenuItem 
                  onClick={handleShare}
                  className="text-white hover:bg-white/20 cursor-pointer"
                >
                  Share Moment
                </DropdownMenuItem>
                <ReportButton
                  contentId={moment.id}
                  contentType="video"
                  variant="dropdown"
                />
                <DropdownMenuItem 
                  onClick={toggleMute}
                  className="text-white hover:bg-white/20 cursor-pointer"
                >
                  {isGloballyMuted ? 'Unmute' : 'Mute'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Comment Input */}
          <div className="flex items-center gap-2">
            <Input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment..."
              className="flex-1 bg-white/10 border-white/20 text-white placeholder-white/50 focus:bg-white/15 focus:border-white/30"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleComment();
                }
              }}
            />
            <Button 
              onClick={handleComment}
              className="bg-blue-500 hover:bg-blue-600 text-white"
              size="icon"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Navigation Buttons */}
      {onPrevious && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onPrevious}
          className="absolute left-4 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white backdrop-blur-md rounded-full p-3"
        >
          <span className="text-xl font-bold">&lt;</span>
        </Button>
      )}
      
      {onNext && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onNext}
          className="absolute right-4 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white backdrop-blur-md rounded-full p-3"
        >
          <span className="text-xl font-bold">&gt;</span>
        </Button>
      )}
    </div>
  );
};

export default MomentViewer;
