"use client";

import React, { useState } from 'react';
import { X, ThumbsUp, MessageCircle, Share2, Eye, Bookmark, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { sharePost } from '@/utils/share';
import { showSuccess, showError } from '@/utils/toast';
import CommentSection from '@/components/CommentSection';
import SaveButton from '@/components/SaveButton';

interface ImageViewerProps {
  content: any;
  onClose: () => void;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ content, onClose }) => {
  const [isLiked, setIsLiked] = useState(false);
  const [showCommentSection, setShowCommentSection] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleLike = () => {
    setIsLiked(!isLiked);
    showSuccess(isLiked ? 'Image removed from likes' : 'Image liked!');
  };

  const handleComment = () => {
    setShowCommentSection(true);
    showSuccess('Comment section opened!');
  };

  const handleShare = async () => {
    const shareData = {
      id: content.id || 'image-post',
      user: content.creator || 'Unknown',
      content: content.title || 'Amazing image',
      image: content.thumbnail || content.mediaUrl
    };
    
    try {
      const result = await sharePost(shareData);
      if (result.success) {
        showSuccess('Image shared successfully!');
      } else {
        showError('Share failed');
      }
    } catch (error) {
      showError('Share failed');
    }
  };

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  return (
    <div className="fullscreen-viewer">
      {/* Close Button */}
      <div className="absolute top-0 right-0 z-50 p-2" style={{ zIndex: 99999 }}>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="text-white hover:bg-white/20 bg-black/60 backdrop-blur-sm rounded-full p-3 shadow-lg"
          title="Press ESC to exit"
        >
          <X className="h-6 w-6" />
        </Button>
      </div>

      {/* Main Content */}
      <div className="fullscreen-content">
        <div className="relative w-full h-full flex items-center justify-center">
          {/* Image */}
          <img
            src={content.image || content.media || content.thumbnail || content.mediaUrl}
            alt={content.caption || content.title || 'Image'}
            className="fullscreen-media"
            style={{
              objectFit: 'contain',
              objectPosition: 'center',
              width: '100vw',
              height: '100vh',
              maxWidth: '100vw',
              maxHeight: '100vh'
            }}
            onError={() => {
              showError('Failed to load image. Please try again later.');
            }}
          />

          {/* Fullscreen Toggle */}
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              toggleFullscreen();
            }}
            className="absolute top-4 left-4 text-white hover:bg-white/20 bg-black/60 backdrop-blur-sm rounded-full p-2 shadow-lg"
            title="Toggle fullscreen"
          >
            {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Image Info Overlay */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-6 pb-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            {/* User Info */}
            <div className="flex items-center gap-3 mb-4">
              <Avatar className="h-10 w-10 border-2 border-white">
                <AvatarImage src={`https://picsum.photos/seed/${content.creator}/100/100`} />
                <AvatarFallback>{(content.creator || 'Unknown').charAt(0).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-white font-semibold text-lg drop-shadow-md">{content.creator || 'Unknown'}</p>
                <p className="text-white/80 text-sm drop-shadow-sm flex items-center gap-2">
                  <span>{content.category}</span>
                  <span>•</span>
                  <span className="text-blue-400 font-semibold">PHOTO</span>
                </p>
              </div>
            </div>

            {/* Title */}
            <p className="text-white text-base leading-relaxed mb-4 drop-shadow-md">{content.title || 'Image'}</p>

            {/* Stats */}
            <div className="flex items-center gap-6 text-white/90 text-base font-medium">
              <span className="flex items-center gap-1">
                <Eye className="h-4 w-4" /> {content.views || '0'} views
              </span>
              <span>{content.likes || '0'} likes</span>
              <span>{content.comments || '0'} comments</span>
              <span>{content.shares || '0'} shares</span>
            </div>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="absolute bottom-6 right-6 flex flex-col gap-3" style={{ zIndex: 50 }}>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleLike();
          }}
          className={`text-white hover:bg-white/20 transition-all duration-200 hover:scale-110 ${isLiked ? 'text-blue-500' : ''}`}
          title="Like image"
        >
          <ThumbsUp className={`h-6 w-6 ${isLiked ? 'fill-current' : ''}`} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleComment();
          }}
          className="text-white hover:bg-white/20 transition-all duration-200 hover:scale-110"
          title="Comment on image"
        >
          <MessageCircle className="h-6 w-6" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleShare();
          }}
          className="text-white hover:bg-white/20 transition-all duration-200 hover:scale-110"
          title="Share image"
        >
          <Share2 className="h-6 w-6" />
        </Button>
        <div 
          className="transition-all duration-200 hover:scale-110"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          title="Save image"
        >
          <SaveButton postId={content.id || 'image-post'} className="text-white hover:text-blue-400" content={content} />
        </div>
      </div>

      {/* Comment Section */}
      {showCommentSection && (
        <CommentSection
          isOpen={showCommentSection}
          onClose={() => setShowCommentSection(false)}
          postId={content.id || 'image-post'}
          postUser={content.creator || 'Unknown'}
        />
      )}
    </div>
  );
};

export default ImageViewer;
