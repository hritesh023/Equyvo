import { Post, Moment, Story } from '@/types';

// Mock data for development when AWS is not configured
const mockPosts: Post[] = [
  {
    id: '1',
    user: 'john_doe',
    avatar: 'https://github.com/shadcn.png',
    time: '2 hours ago',
    content: 'Just launched my new app! Check it out and let me know what you think. #development #react',
    image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&h=400&fit=crop',
    likes: 42,
    reacts: 8,
    comments: 12,
    shares: 3,
    type: 'post',
    tags: ['development', 'react'],
    categories: ['tech'],
    userId: 'user1',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  },
  {
    id: '2',
    user: 'jane_smith',
    avatar: 'https://github.com/vercel.png',
    time: '5 hours ago',
    content: 'Beautiful sunset today! Sometimes you need to pause and appreciate the little things. 🌅',
    image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=600&fit=crop',
    likes: 128,
    reacts: 24,
    comments: 18,
    shares: 7,
    type: 'post',
    tags: ['nature', 'sunset'],
    categories: ['lifestyle'],
    userId: 'user2',
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
  }
];

const mockMoments: Moment[] = [
  {
    id: '1',
    user: 'mike_wilson',
    content: 'Quick coding session update',
    media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=300&fit=crop',
    mediaType: 'video',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    likes: 89,
    comments: 15,
    views: 342,
    time: '1 hour ago',
    userId: 'user3',
    createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
  }
];

const mockStories: Story[] = [
  {
    id: '1',
    user: 'alex_jones',
    avatar: 'https://github.com/tailwindlabs.png',
    image: 'https://images.unsplash.com/photo-1559526324-59b1a3440d8b?w=400&h=600&fit=crop',
    time: '30 minutes ago',
    userId: 'user4',
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  }
];

// Fetch posts (using mock data for now)
export const fetchPosts = async (userId?: string, limit = 50): Promise<Post[]> => {
  try {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('Fetching mock posts for user:', userId);
    return mockPosts.slice(0, limit);
  } catch (error) {
    console.error('Error in fetchPosts:', error);
    return [];
  }
};

// Fetch moments (using mock data for now)
export const fetchMoments = async (limit = 20): Promise<Moment[]> => {
  try {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 300));
    
    console.log('Fetching mock moments');
    return mockMoments.slice(0, limit);
  } catch (error) {
    console.error('Error in fetchMoments:', error);
    return [];
  }
};

// Fetch stories (using mock data for now)
export const fetchStories = async (limit = 20): Promise<Story[]> => {
  try {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 200));
    
    console.log('Fetching mock stories');
    return mockStories.slice(0, limit);
  } catch (error) {
    console.error('Error in fetchStories:', error);
    return [];
  }
};

// Create a new post (mock implementation)
export const createPost = async (postData: {
  content: string;
  image_url?: string;
  type?: 'post' | 'thought';
  tags?: string[];
  categories?: string[];
}): Promise<{ success: boolean; post?: Post; error?: string }> => {
  try {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const newPost: Post = {
      id: Date.now().toString(),
      user: 'current_user',
      avatar: 'https://github.com/shadcn.png',
      time: 'just now',
      content: postData.content,
      image: postData.image_url,
      likes: 0,
      reacts: 0,
      comments: 0,
      shares: 0,
      type: postData.type || 'post',
      tags: postData.tags || [],
      categories: postData.categories || [],
      userId: 'current_user_id',
      createdAt: new Date().toISOString()
    };

    // Add to mock posts (in real app, this would be saved to database)
    mockPosts.unshift(newPost);

    return { success: true, post: newPost };
  } catch (error) {
    console.error('Error in createPost:', error);
    return { success: false, error: 'Failed to create post' };
  }
};

// Get user profile data (mock implementation)
export const getUserProfile = async (userId: string) => {
  try {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Mock user profile
    const mockProfile = {
      id: userId,
      username: `user_${userId}`,
      full_name: 'Demo User',
      avatar_url: 'https://github.com/shadcn.png',
      bio: 'This is a demo user profile',
      created_at: new Date().toISOString()
    };

    return mockProfile;
  } catch (error) {
    console.error('Error in getUserProfile:', error);
    return null;
  }
};
