import React from 'react';
import { Button } from "@/components/ui/button";
import { Share2 } from 'lucide-react';
import { showError } from '@/utils/toast';
import { openShareSheet } from '@/utils/share';
import { Post } from '@/types';

interface ShareButtonProps {
  post: Post;
  size?: 'sm' | 'md' | 'lg';
  showCount?: boolean;
  sharesCount?: number;
  className?: string;
  onShare?: () => void;
}

const ShareButton: React.FC<ShareButtonProps> = ({
  post,
  size = 'md',
  showCount = false,
  sharesCount = 0,
  className = '',
  onShare
}) => {
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
    try {
      openShareSheet({
        title: `Post by ${post.user || 'creator'} on Equyvo`,
        text: post.content || 'Check out this post!',
        url: `${window.location.origin}/app/home?post=${encodeURIComponent(post.id)}`,
      });
      onShare?.();
    } catch {
      showError('Failed to share post');
    }
  };

  return (
    <Button
      variant="ghost"
      className={`${sizeClasses[size]} text-muted-foreground hover:text-foreground ${className}`}
      onClick={handleShare}
    >
      <Share2 className={iconSizes[size]} />
      {showCount && (
        <span className="ml-1">{Number(sharesCount) || 0}</span>
      )}
    </Button>
  );
};

export default ShareButton;
