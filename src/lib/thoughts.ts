import { Thought, Vote, Like, CreateThoughtData, VoteData, LikeData, ThoughtMedia } from '@/types/thoughts';
import { getAuthenticatedUser } from './auth';
import api from './api';

// Mock video duration validation (no change - this is client-side)
export const validateVideoDuration = (file: File): Promise<{ valid: boolean; error?: string }> => {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    
    video.onloadedmetadata = () => {
      window.URL.revokeObjectURL(video.src);
      const duration = video.duration;
      const maxDuration = 300;
      const minDuration = 1;
      
      if (duration < minDuration) {
        resolve({ valid: false, error: 'Video must be at least 1 second long' });
      } else if (duration > maxDuration) {
        resolve({ valid: false, error: 'Video must be less than 5 minutes long' });
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
      upvotes_count: (thought as any).upvotes_count || Math.floor(Math.random() * 20),
      downvotes_count: (thought as any).downvotes_count || Math.floor(Math.random() * 5),
      user_vote: user ? ((thought as any).user_vote || null) : null,
      user_liked: user ? ((thought as any).user_has_liked || false) : false
    }));
    
    return { data: thoughtsWithVotes, error: null };
  } catch (error) {
    return { data: [], error };
  }
};

export const createThought = async (thoughtData: CreateThoughtData) => {
  try {
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
  } catch (error) {
    throw error;
  }
};

export const deleteThought = async (thoughtId: string) => {
  try {
    // For now, just a mock success
    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
  } catch (error) {
    throw error;
  }
};

// Votes API
export const voteOnThought = async (voteData: VoteData) => {
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    // TODO: Implement vote endpoint in worker
    return {
      success: true,
      upvotes_count: Math.floor(Math.random() * 20),
      downvotes_count: Math.floor(Math.random() * 5),
      user_vote: voteData.vote_type
    };
  } catch (error) {
    throw error;
  }
};

export const getThoughtVotes = async (thoughtId: string) => {
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    return {
      upvotes_count: Math.floor(Math.random() * 20),
      downvotes_count: Math.floor(Math.random() * 5),
      user_vote: null
    };
  } catch (error) {
    return { upvotes_count: 0, downvotes_count: 0, user_vote: null };
  }
};

// Likes API
export const likeThought = async (likeData: LikeData) => {
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const liked = Math.random() > 0.5;
    return {
      liked,
      likes_count: liked ? 1 : 0
    };
  } catch (error) {
    throw error;
  }
};

export const getThoughtLikes = async (thoughtId: string) => {
  try {
    return { likes_count: 0, user_has_liked: false };
  } catch (error) {
    return { likes_count: 0, user_has_liked: false };
  }
};
