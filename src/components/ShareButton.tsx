import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Share2 } from 'lucide-react';
import { showError } from '@/utils/toast';
import { sharePost } from '@/utils/share';
import { Post } from '@/types';

interface ShareButtonProps {
  post: Post;
  size?: 'sm' | 'md' | 'lg';
  showCount?: boolean;
  sharesCount?: number;
  className?: string;
  /** The callback owns the complete share flow (including persistence). */
  onShare?: () => void | Promise<void>;
}

const ShareButton: React.FC<ShareButtonProps> = ({
  post,
  size = 'md',
  showCount = false,
  sharesCount = 0,
  className = '',
  onShare
}) => {
  const [isSharing, setIsSharing] = useState(false);
  const sizeClasses = {
    sm: 'h-6 px-2 text-xs',
    md: 'h-8 px-3 text-sm',
    lg: 'h-10 px-4 text-base'
  };

  const iconSizes = {
    sm: 'h-3 w-3',
    md: 'h-4 w-4',
    lg: 'h-5 w-5'
  };

  const handleShare = async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      if (onShare) {
        // Feed pages pass this callback so they can adopt the authoritative
        // server count. Do not also open a second share sheet here.
        await onShare();
      } else {
        const result = await sharePost({
          id: post.id,
          user: post.user || 'creator',
          content: post.content || 'Check out this post!',
          image: post.media || post.image,
        });
        if (!result.success && !result.cancelled) {
          showError(result.error || 'Failed to share post');
        } else if (result.success && result.recorded === false) {
          showError(result.error || 'The share count could not be saved');
        }
      }
    } catch {
      showError('Failed to share post');
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <Button
      variant="ghost"
      className={`${sizeClasses[size]} text-muted-foreground hover:text-foreground ${className}`}
      onClick={handleShare}
      disabled={isSharing}
      aria-label="Share post"
    >
      <Share2 className={iconSizes[size]} />
      {showCount && (
        <span className="ml-1">{Number(sharesCount) || 0}</span>
      )}
    </Button>
  );
};

export default ShareButton;
