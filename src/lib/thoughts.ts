import { Thought, Vote, Like, CreateThoughtData, VoteData, LikeData, ThoughtMedia } from '@/types/thoughts';
import { getAuthenticatedUser } from './auth';
import api from './api';

// Client-side metadata validation. The server plan is the source of truth;
// `maxDurationSeconds=0` means no client cap is known yet, so large/long
// uploads are not rejected with the old hard-coded five-minute limit.
export const validateVideoDuration = (file: File, maxDurationSeconds = 0): Promise<{ valid: boolean; error?: string }> => {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    video.onloadedmetadata = () => {
      window.URL.revokeObjectURL(video.src);
      const duration = video.duration;
      const minDuration = 1;
      
      if (duration < minDuration) {
        resolve({ valid: false, error: 'Video must be at least 1 second long' });
      } else if (maxDurationSeconds > 0 && duration > maxDurationSeconds) {
        resolve({ valid: false, error: `Video must be less than ${Math.ceil(maxDurationSeconds / 60)} minutes long` });
      } else {
        resolve({ valid: true });
      }
    };
    
    video.onerror = () => {
      window.URL.revokeObjectURL(video.src);
      resolve({ valid: false, error: 'Invalid video file' });
    };
    
    video.src = URL.createObjectURL(file);
  });
};

// Thoughts API - now calls the backend
export const getThoughts = async (limit = 20, offset = 0) => {
  try {
    const { data, error } = await api.getThoughts(limit, offset);
    if (error) return { data: [], error };
    
    const user = await getAuthenticatedUser();
    const thoughtsWithVotes = data.map((thought: Thought) => ({
      ...thought,
      // Real counts only: never fabricate engagement numbers client-side.
      upvotes_count: (thought as any).upvotes_count || 0,
      downvotes_count: (thought as any).downvotes_count || 0,
      user_vote: user ? ((thought as any).user_vote || null) : null,
      user_liked: user ? ((thought as any).user_has_liked || false) : false
    }));
    
    return { data: thoughtsWithVotes, error: null };
  } catch (error) {
    return { data: [], error };
  }
};

export const createThought = async (thoughtData: CreateThoughtData) => {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('User not authenticated');

  if (thoughtData.media && thoughtData.media.length > 0) {
    const validTypes = ['image', 'video', 'gif'];
    const isValidMedia = thoughtData.media.every(media => 
      validTypes.includes(media.type) && media.url
    );
    if (!isValidMedia) throw new Error('Invalid media format');
  }

  const { data, error } = await api.createThought({
    user_id: user.id,
    content: thoughtData.content,
    platform: 'equyvo',
    tags: thoughtData.tags || [],
    comments_count: 0,
    shares_count: 0,
    retweets_count: 0,
    media: thoughtData.media || null,
    likes_count: 0,
  });

  if (error) throw new Error(error);
  return data;
};

export const deleteThought = async (_thoughtId: string) => {
  // For now, just a mock success
  await new Promise(resolve => setTimeout(resolve, 300));
  return true;
};

// Votes API — real server persistence (no random/fabricated counts).
export const voteOnThought = async (voteData: VoteData) => {
  try {
    const { data, error } = await api.vote(voteData.thought_id, voteData.vote_type);
    if (error || !data) {
      return { success: false, error: error || 'Vote failed', upvotes_count: 0, downvotes_count: 0, user_vote: null };
    }
    const vote = data as any;
    return {
      success: true,
      upvotes_count: vote.upvotes_count,
      downvotes_count: vote.downvotes_count,
      user_vote: vote.user_vote,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Vote failed',
      upvotes_count: 0,
      downvotes_count: 0,
      user_vote: null,
    };
  }
};

export const getThoughtVotes = async (thoughtId: string) => {
  try {
    const { data } = await api.getContentItem(thoughtId);
    const item = (data || {}) as Record<string, unknown>;
    return {
      upvotes_count: Number(item.upvotes_count ?? item.upvotes ?? 0) || 0,
      downvotes_count: Number(item.downvotes_count ?? item.downvotes ?? 0) || 0,
      user_vote: (item.user_vote as 'upvote' | 'downvote' | null) ?? null,
    };
  } catch {
    return { upvotes_count: 0, downvotes_count: 0, user_vote: null };
  }
};

// Likes API — real server persistence.
export const likeThought = async (likeData: LikeData) => {
  try {
    const { data, error } = await api.like(likeData.thought_id, 'toggle');
    if (error || !data) return { liked: false, likes_count: 0 };
    const item = data as unknown as Record<string, unknown>;
    return {
      liked: Boolean(item.hasLiked),
      likes_count: Number(item.likes ?? 0) || 0,
    };
  } catch {
    return { liked: false, likes_count: 0 };
  }
};

export const getThoughtLikes = async (thoughtId: string) => {
  try {
    const { data } = await api.getContentItem(thoughtId);
    const item = (data || {}) as Record<string, unknown>;
    return {
      likes_count: Number(item.likes ?? item.likes_count ?? 0) || 0,
      user_has_liked: item.user_has_liked === true,
    };
  } catch {
    return { likes_count: 0, user_has_liked: false };
  }
};
