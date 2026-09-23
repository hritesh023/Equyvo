"use client";

import React, { useEffect, useState } from 'react';
import { Button } from "@/components/ui/button";
import { UserPlus, UserCheck } from 'lucide-react';
import { showSuccess } from '@/utils/toast';
import { isFollowing as isFollowingUser, setFollowing } from '@/lib/feed-store';

interface FollowButtonProps {
  userId?: string;
  userName?: string;
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'outline' | 'secondary';
  className?: string;
}

const FollowButton: React.FC<FollowButtonProps> = ({
  userId,
  userName = 'user',
  size = 'sm',
  variant = 'outline',
  className = '',
}) => {
  const key = userName || userId || 'user';
  const [isFollowing, setIsFollowingState] = useState(() => {
    try { return isFollowingUser(key); } catch { return false; }
  });
  const [isLoading, setIsLoading] = useState(false);

  // Stay in sync when follow changes elsewhere (feed, profile, suggestions).
  useEffect(() => {
    const sync = () => {
      try { setIsFollowingState(isFollowingUser(key)); } catch { /* ignore */ }
    };
    sync();
    window.addEventListener('followChanged', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('followChanged', sync);
      window.removeEventListener('storage', sync);
    };
  }, [key]);

  const handleFollow = async () => {
    if (!key) return;
    setIsLoading(true);
    try {
      const next = !isFollowing;
      // Persisted + broadcast: Following tab updates instantly, cross-tab.
      setFollowing(key, next);
      if (userId && userId !== key) setFollowing(userId, next);
      setIsFollowingState(next);
      if (next) {
        showSuccess(`Now following ${userName}! Their uploads will appear in Following.`);
      } else {
        showSuccess(`Unfollowed ${userName}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Button
      variant={isFollowing ? 'secondary' : variant}
      size={size}
      onClick={handleFollow}
      disabled={isLoading}
      className={`${className} transition-all duration-200 ${
        isFollowing ? 'bg-green-100 text-green-700 hover:bg-green-200' : ''
      }`}
    >
      {isLoading ? (
        <div className="animate-spin h-4 w-4 border-2 border-current border-t-transparent rounded-full" />
      ) : isFollowing ? (
        <>
          <UserCheck className="h-4 w-4 mr-1" />
          Following
        </>
      ) : (
        <>
          <UserPlus className="h-4 w-4 mr-1" />
          Follow
        </>
      )}
    </Button>
  );
};

export default FollowButton;
