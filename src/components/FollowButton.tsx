"use client";

import React, { useEffect, useState } from 'react';
import { Button } from "@/components/ui/button";
import { UserPlus, UserCheck } from 'lucide-react';
import { showSuccess } from '@/utils/toast';
import { isFollowing as isFollowingUser, setFollowing } from '@/lib/feed-store';
import api from '@/lib/api';
import { getStoredUser } from '@/lib/auth';

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
  // Server ids are the follow-graph truth; fall back to the display name key.
  const serverTarget = userId || '';
  const [isFollowing, setIsFollowingState] = useState(() => {
    try { return isFollowingUser(key); } catch { return false; }
  });
  const [isPending, setIsPending] = useState(false);
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

  // Reconcile with the server graph (source of truth across devices).
  useEffect(() => {
    let cancelled = false;
    const me = getStoredUser();
    if (!me || !serverTarget || serverTarget === me.id) return;
    api.followStatus(serverTarget).then(({ data, error }) => {
      if (cancelled || error || !data) return;
      setIsFollowingState(!!data.isFollowing);
      setIsPending(!!data.pending);
      try { setFollowing(key, !!data.isFollowing); } catch { /* ignore */ }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [serverTarget, key]);

  const handleFollow = async () => {
    if (!key) return;
    setIsLoading(true);
    try {
      const me = getStoredUser();
      const target = serverTarget || key;
      // Own profile: nothing to do.
      if (me && target && (target === me.id || target.toLowerCase() === (me.username || '').toLowerCase())) {
        showSuccess('This is your own profile');
        return;
      }
      if (isFollowing) {
        const { error } = await api.unfollow(target);
        if (error) throw new Error(error);
        setFollowing(key, false);
        if (serverTarget && serverTarget !== key) setFollowing(serverTarget, false);
        setIsFollowingState(false);
        setIsPending(false);
        showSuccess(`Unfollowed ${userName}`);
      } else {
        const { data, error } = await api.follow(target);
        if (error) throw new Error(error);
        if (data?.pending) {
          // Private account: request sent, awaits owner approval.
          setIsPending(true);
          showSuccess(`Follow request sent to ${userName}. You'll see their posts once they approve.`);
        } else {
          setFollowing(key, true);
          if (serverTarget && serverTarget !== key) setFollowing(serverTarget, true);
          setIsFollowingState(true);
          showSuccess(`Now following ${userName}! Their uploads will appear in Following.`);
        }
      }
    } catch {
      // Server unreachable: keep the instant local mirror so the UI still
      // responds; it reconciles on the next load.
      try {
        const next = !isFollowing;
        setFollowing(key, next);
        setIsFollowingState(next);
        showSuccess(next ? `Now following ${userName}!` : `Unfollowed ${userName}`);
      } catch { /* ignore */ }
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
      ) : !isFollowing && isPending ? (
        <>
          <UserCheck className="h-4 w-4 mr-1" />
          Requested
        </>
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
