import { Post, Moment, Story } from '@/types';
import api from './api';
import { currentAuthor, pickDisplayName } from './identity';

// The server filters out placeholder content once real users exist.
 
export function markHasRealContent() {
  // Server-side flag is set automatically when content is created via API
}

// Fetch posts from the API
export const fetchPosts = async (userId?: string, limit = 50): Promise<Post[]> => {
  try {
    const { data, error } = await api.getPosts(limit);
    if (error) {
      console.warn('Failed to fetch posts:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Error fetching posts:', err);
    return [];
  }
};

// Fetch moments from the API
export const fetchMoments = async (limit = 20): Promise<Moment[]> => {
  try {
    const { data, error } = await api.getMoments(limit);
    if (error) {
      console.warn('Failed to fetch moments:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Error fetching moments:', err);
    return [];
  }
};

// Fetch stories from the API
export const fetchStories = async (limit = 20): Promise<Story[]> => {
  try {
    const { data, error } = await api.getStories(limit);
    if (error) {
      console.warn('Failed to fetch stories:', error);
      return [];
    }
    return data || [];
  } catch (err) {
    console.error('Error fetching stories:', err);
    return [];
  }
};

// Create a new post via the API
export const createPost = async (postData: {
  content: string;
  image_url?: string;
  type?: 'post' | 'thought';
  tags?: string[];
  categories?: string[];
}): Promise<{ success: boolean; post?: Post; error?: string }> => {
  try {
    // Never send a placeholder author: the server stamps the authenticated
    // account, and empty fields let its profile lookup take over.
    const author = currentAuthor();
    const authorName = pickDisplayName(author.username, author.name);

    const { data, error } = await api.createPost({
      userId: author.id || undefined,
      user: authorName,
      avatar: author.avatar,
      content: postData.content,
      image: postData.image_url || '',
      likes: 0,
      reacts: 0,
      comments: 0,
      shares: 0,
      type: postData.type || 'post',
      tags: postData.tags || [],
      categories: postData.categories || [],
    });

    if (error) return { success: false, error };
    return { success: true, post: data };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to create post' };
  }
};

// Get user profile data from the API
export const getUserProfile = async (userId: string) => {
  try {
    const { data, error } = await api.getProfile(userId);
    if (error) return null;
    return data;
  } catch {
    return null;
  }
};
