import { Env } from './env';
import { KEYS, ContentIndexItem, Post, Thought, Story, Moment } from './kv';

// Seed data matching the existing mock data
const seedPosts: Post[] = [
  {
    id: 'seed-1',
    user: 'john_doe',
    avatar: '',
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
    isSeed: true,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'seed-2',
    user: 'jane_smith',
    avatar: '',
    time: '5 hours ago',
    content: 'Beautiful sunset today! Sometimes you need to pause and appreciate the little things.',
    image: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&h=600&fit=crop',
    likes: 128,
    reacts: 24,
    comments: 18,
    shares: 7,
    type: 'post',
    tags: ['nature', 'sunset'],
    categories: ['lifestyle'],
    userId: 'user2',
    isSeed: true,
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
  }
];

const seedThoughts: Thought[] = [
  {
    id: 'seed-t1',
    user_id: 'user1',
    content: 'Welcome to Equyvo Thoughts! Share your ideas with the community.',
    platform: 'equyvo',
    tags: [],
    comments_count: 0,
    shares_count: 0,
    retweets_count: 0,
    media: [{
      type: 'video',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=300&fit=crop',
      duration: 60,
    }],
    isSeed: true,
    likes_count: 15,
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    user_vote: null,
    user_has_liked: false,
  },
  {
    id: 'seed-t2',
    user_id: 'user2',
    content: 'Just implemented a new feature using React hooks. The composition API is game-changing!',
    platform: 'equyvo',
    tags: ['react', 'hooks', 'development'],
    comments_count: 0,
    shares_count: 0,
    retweets_count: 0,
    media: [{
      type: 'video',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      thumbnail: 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=400&h=300&fit=crop',
      duration: 45,
    }],
    isSeed: true,
    likes_count: 42,
    created_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    user_vote: null,
    user_has_liked: false,
  }
];

const seedStories: Story[] = [
  {
    id: 'seed-s1',
    user: 'alex_jones',
    avatar: 'https://picsum.photos/seed/alex/200/200',
    image: 'https://images.unsplash.com/photo-1559526324-59b1a3440d8b?w=400&h=600&fit=crop',
    time: '30 minutes ago',
    type: 'image',
    userId: 'user4',
    isSeed: true,
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  },
  {
    id: 'seed-s2',
    user: 'sarah_creative',
    avatar: 'https://picsum.photos/seed/sarah/200/200',
    image: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=400&h=600&fit=crop',
    video: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    time: '1 hour ago',
    type: 'video',
    userId: 'user5',
    isSeed: true,
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  },
  {
    id: 'seed-s3',
    user: 'mike_adventures',
    avatar: 'https://picsum.photos/seed/mike/200/200',
    image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400&h=600&fit=crop',
    time: '2 hours ago',
    type: 'image',
    userId: 'user6',
    isSeed: true,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  }
];

const seedMoments: Moment[] = [
  {
    id: 'seed-m1',
    user: 'mike_wilson',
    content: 'Quick coding session update',
    media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=400&h=700&fit=crop&auto=format&dpr=2',
    mediaType: 'video',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    likes: 89,
    comments: 15,
    views: 342,
    time: '1 hour ago',
    userId: 'user3',
    isSeed: true,
    createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'seed-m2',
    user: 'sarah_creative',
    content: 'Morning inspiration!',
    media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1490730141103-6cac27aaab94?w=400&h=700&fit=crop&auto=format&dpr=2',
    mediaType: 'video',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
    likes: 234,
    comments: 42,
    views: 1024,
    time: '3 hours ago',
    userId: 'user4',
    isSeed: true,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'seed-m3',
    user: 'alex_adventures',
    content: 'City vibes!',
    media: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    thumbnail: 'https://images.unsplash.com/photo-1516373363238-71c1eee6e0c5?w=400&h=700&fit=crop&auto=format&dpr=2',
    mediaType: 'video',
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
    likes: 567,
    comments: 89,
    views: 2341,
    time: '5 hours ago',
    userId: 'user5',
    isSeed: true,
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()
  }
];

const seedProfiles = [
  {
    id: 'user1',
    name: 'John Doe',
    username: '@john_doe',
    avatar: '',
    bio: 'Developer & creator. Building cool stuff.',
    followers: 1200,
    following: 340,
    _userEmail: 'john@example.com',
  },
  {
    id: 'user2',
    name: 'Jane Smith',
    username: '@jane_smith',
    avatar: '',
    bio: 'Photography enthusiast. Nature lover.',
    followers: 3400,
    following: 520,
    _userEmail: 'jane@example.com',
  },
];

// Categories and their content for search index
const seedContentIndex: ContentIndexItem[] = [
  { id: 'c1', title: 'Amazing Sunset Photography Tips', description: 'Learn how to capture stunning sunset photos.', type: 'video', creator: 'PhotoPro', creatorAvatar: '', views: '125K', thumbnail: 'https://picsum.photos/seed/sunset1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', category: 'Photography', tags: ['photography', 'sunset', 'tips', 'camera', 'golden hour', 'landscape', 'nature'], duration: '10:24', publishedAt: '2 days ago', content: 'Learn how to capture stunning sunset photos.', likes: 12500, comments: 890 },
  { id: 'c2', title: 'Street Photography Guide for Beginners', description: 'Explore the art of street photography.', type: 'photo', creator: 'UrbanShooter', creatorAvatar: '', views: '67K', thumbnail: 'https://picsum.photos/seed/street1/300/200', imageUrl: 'https://picsum.photos/seed/street1/800/600', category: 'Photography', tags: ['photography', 'street', 'urban', 'beginner', 'guide'], publishedAt: '5 days ago', content: 'Explore the art of street photography.', likes: 8900, comments: 450 },
  { id: 'c3', title: 'Quick & Easy Dinner Recipes', description: 'Delicious recipes in under 30 minutes.', type: 'photo', creator: 'FoodieLife', creatorAvatar: '', views: '89K', thumbnail: 'https://picsum.photos/seed/food1/300/200', imageUrl: 'https://picsum.photos/seed/food1/800/600', category: 'Food', tags: ['food', 'recipes', 'dinner', 'cooking', 'quick', 'easy'], publishedAt: '1 day ago', content: 'Delicious recipes you can make in under 30 minutes.', likes: 8900, comments: 670 },
  { id: 'c4', title: 'How to Bake a Perfect Cake', description: 'Step-by-step tutorial on baking a moist cake.', type: 'video', creator: 'BakingMaster', creatorAvatar: '', views: '234K', thumbnail: 'https://picsum.photos/seed/cake1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', category: 'Food', tags: ['food', 'baking', 'cake', 'recipe', 'dessert', 'cooking', 'tutorial'], duration: '15:30', publishedAt: '3 days ago', content: 'Step-by-step tutorial on baking a moist and delicious cake.', likes: 34000, comments: 2100 },
  { id: 'c5', title: 'Morning Yoga Flow for Beginners', description: 'Gentle yoga sequence for beginners.', type: 'video', creator: 'YogaGuru', creatorAvatar: '', views: '234K', thumbnail: 'https://picsum.photos/seed/yoga1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', category: 'Fitness', tags: ['yoga', 'fitness', 'morning', 'wellness', 'meditation', 'stretching', 'beginner'], duration: '15:30', publishedAt: '3 days ago', content: 'Start your day with this gentle yoga sequence.', likes: 34000, comments: 2100 },
  { id: 'c6', title: 'No Excuses Full Body Workout', description: 'Intense full body workout, no equipment needed.', type: 'video', creator: 'fitness_pro', creatorAvatar: '', views: '78K', thumbnail: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400&h=700&fit=crop', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4', category: 'Fitness', tags: ['fitness', 'workout', 'gym', 'exercise', 'health', 'strength', 'cardio'], duration: '20:00', publishedAt: '6 hours ago', content: 'No excuses. Full body workout that builds strength.', likes: 22100, comments: 1200 },
  { id: 'c7', title: 'Latest AI Trends and Developments', description: 'Newest breakthroughs in AI.', type: 'thought', creator: 'Tech Enthusiast', creatorAvatar: '', views: '245K', thumbnail: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=300&h=200&fit=crop', imageUrl: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&fit=crop', category: 'Technology', tags: ['AI', 'technology', 'machine learning', 'future', 'innovation', 'artificial intelligence', 'tech'], publishedAt: '1 hour ago', content: 'The future of AI is here! What are your thoughts?', likes: 245, comments: 67 },
  { id: 'c8', title: 'Web Development with React Hooks', description: 'Learn modern React development.', type: 'thought', creator: 'DevMaster', creatorAvatar: '', views: '42K', thumbnail: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=300&h=200&fit=crop', imageUrl: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=800&fit=crop', category: 'Technology', tags: ['react', 'hooks', 'development', 'coding', 'programming', 'web', 'javascript'], publishedAt: '4 hours ago', content: 'Just implemented a new feature using React hooks.', likes: 42, comments: 12 },
  { id: 'c9', title: 'Budget Travel Tips 2024', description: 'Explore the world without breaking the bank.', type: 'post', creator: 'Wanderlust', creatorAvatar: '', views: '78K', thumbnail: 'https://picsum.photos/seed/travel1/300/200', imageUrl: 'https://picsum.photos/seed/travel1/800/600', category: 'Travel', tags: ['travel', 'budget', 'tips', 'vacation', 'explore', 'adventure', 'hacks'], publishedAt: '4 days ago', content: 'Explore the world without breaking the bank.', likes: 19000, comments: 1400 },
  { id: 'c10', title: 'Hidden Gems Around the World', description: 'Beautiful hidden travel spots.', type: 'video', creator: 'alex_adventures', creatorAvatar: '', views: '230K', thumbnail: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=400&h=700&fit=crop', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', category: 'Travel', tags: ['travel', 'hidden gems', 'adventure', 'explore', 'nature', 'destination'], duration: '12:15', publishedAt: '2 hours ago', content: 'The view from the top is absolutely breathtaking!', likes: 15400, comments: 892 },
  { id: 'c11', title: 'Latest Fashion Trends This Season', description: 'Hottest fashion trends and styling tips.', type: 'photo', creator: 'StyleIcon', creatorAvatar: '', views: '92K', thumbnail: 'https://picsum.photos/seed/fashion1/300/200', imageUrl: 'https://picsum.photos/seed/fashion1/800/600', category: 'Fashion', tags: ['fashion', 'style', 'trends', 'outfit', 'clothing', 'designer', 'seasonal'], publishedAt: '1 day ago', content: 'Stay ahead of the curve with the hottest fashion trends.', likes: 12000, comments: 850 },
  { id: 'c12', title: 'Digital Art Tutorial for Beginners', description: 'Start creating digital art.', type: 'video', creator: 'ArtStudio', creatorAvatar: '', views: '167K', thumbnail: 'https://picsum.photos/seed/art1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', category: 'Art', tags: ['art', 'digital art', 'drawing', 'painting', 'creative', 'design', 'tutorial', 'procreate'], duration: '18:45', publishedAt: '2 days ago', content: 'Start creating digital art with these easy-to-follow tutorials.', likes: 32000, comments: 2100 },
  { id: 'c13', title: 'Top Gaming Moments Compilation', description: 'Best gaming highlights and epic wins.', type: 'video', creator: 'GameZone', creatorAvatar: '', views: '890K', thumbnail: 'https://picsum.photos/seed/gaming1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4', category: 'Gaming', tags: ['gaming', 'games', 'esports', 'highlights', 'funny', 'moments', 'play'], duration: '22:10', publishedAt: '5 hours ago', content: 'The best gaming highlights and epic wins.', likes: 67000, comments: 4500 },
  { id: 'c14', title: 'Music Production Tips for Beginners', description: 'Learn music production from scratch.', type: 'video', creator: 'BeatMaker', creatorAvatar: '', views: '198K', thumbnail: 'https://picsum.photos/seed/music1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4', category: 'Music', tags: ['music', 'production', 'beat', 'audio', 'mixing', 'tutorial', 'sound'], duration: '14:20', publishedAt: '2 hours ago', content: 'Learn music production from scratch.', likes: 23000, comments: 1500 },
  { id: 'c15', title: 'Trending Songs and Music Videos', description: 'Latest trending songs and viral audio.', type: 'video', creator: 'MusicVibes', creatorAvatar: '', views: '567K', thumbnail: 'https://picsum.photos/seed/music2/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4', category: 'Music', tags: ['music', 'songs', 'trending', 'viral', 'audio', 'playlist', 'vibes'], duration: '3:45', publishedAt: '1 hour ago', content: 'Check out the latest trending songs and music videos.', likes: 89000, comments: 6700 },
  { id: 'c16', title: 'Vibing in the City Nightlife', description: 'Urban dance and city vibes.', type: 'video', creator: 'urban_dancer', creatorAvatar: '', views: '78K', thumbnail: 'https://images.unsplash.com/photo-1516373363238-71c1eee6e0c5?w=400&h=700&fit=crop', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4', category: 'Lifestyle', tags: ['lifestyle', 'dance', 'city', 'nightlife', 'vibes', 'street', 'urban'], duration: '1:30', publishedAt: '8 hours ago', content: 'Vibing in the city nightlife scene.', likes: 45600, comments: 2300 },
  { id: 'c17', title: 'Welcome to Equyvo Community', description: 'Join our growing community.', type: 'post', creator: 'Equyvo Official', creatorAvatar: '', views: '120K', thumbnail: 'https://picsum.photos/seed/welcome1/300/200', imageUrl: 'https://picsum.photos/seed/welcome1/800/600', category: 'Lifestyle', tags: ['community', 'welcome', 'social', 'equyvo', 'connect', 'share'], publishedAt: '2 hours ago', content: 'Welcome to Equyvo! Share your first thought and connect with others.', likes: 120, comments: 15 },
  { id: 'c18', title: 'Tech Reviews: Latest Gadgets 2024', description: 'In-depth reviews of newest tech gadgets.', type: 'video', creator: 'TechReviewer', creatorAvatar: '', views: '456K', thumbnail: 'https://picsum.photos/seed/tech1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4', category: 'Technology', tags: ['tech', 'reviews', 'gadgets', 'smartphone', 'innovation', 'devices', 'unboxing'], duration: '12:30', publishedAt: '2 days ago', content: 'In-depth reviews of the newest tech gadgets.', likes: 34000, comments: 2800 },
  { id: 'c19', title: 'Meditation and Mindfulness for Beginners', description: 'Learn basics of meditation.', type: 'video', creator: 'WellnessPro', creatorAvatar: '', views: '89K', thumbnail: 'https://picsum.photos/seed/meditate1/300/200', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4', category: 'Fitness', tags: ['meditation', 'mindfulness', 'wellness', 'health', 'stress', 'relaxation', 'mental health'], duration: '10:00', publishedAt: '4 days ago', content: 'Learn the basics of meditation and mindfulness.', likes: 29000, comments: 1800 },
  { id: 'c20', title: 'Secret Pasta Recipe Revealed', description: 'Incredible homemade pasta recipe.', type: 'video', creator: 'culinary_wizard', creatorAvatar: '', views: '45K', thumbnail: 'https://images.unsplash.com/photo-1563379091339-03246963d278?w=400&h=700&fit=crop', videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4', category: 'Food', tags: ['food', 'pasta', 'recipe', 'cooking', 'italian', 'homemade'], duration: '8:45', publishedAt: '4 hours ago', content: 'Secret pasta recipe revealed! Simple ingredients, amazing flavor.', likes: 8900, comments: 567 },
];

export async function seedKV(env: Env): Promise<void> {
  // Check if already seeded
  const existing = await env.EQUYVO_KV.get(KEYS.POSTS);
  if (existing) return; // Already seeded
  
  // Seed posts
  const postIds: string[] = [];
  for (const post of seedPosts) {
    await env.EQUYVO_KV.put(KEYS.POST(post.id), JSON.stringify(post));
    postIds.push(post.id);
  }
  await env.EQUYVO_KV.put(KEYS.POSTS, JSON.stringify(postIds));
  
  // Seed thoughts
  const thoughtIds: string[] = [];
  for (const thought of seedThoughts) {
    await env.EQUYVO_KV.put(KEYS.THOUGHT(thought.id), JSON.stringify(thought));
    thoughtIds.push(thought.id);
  }
  await env.EQUYVO_KV.put(KEYS.THOUGHTS, JSON.stringify(thoughtIds));
  
  // Seed stories
  const storyIds: string[] = [];
  for (const story of seedStories) {
    await env.EQUYVO_KV.put(KEYS.STORY(story.id), JSON.stringify(story));
    storyIds.push(story.id);
  }
  await env.EQUYVO_KV.put(KEYS.STORIES, JSON.stringify(storyIds));
  
  // Seed moments
  const momentIds: string[] = [];
  for (const moment of seedMoments) {
    await env.EQUYVO_KV.put(KEYS.MOMENT(moment.id), JSON.stringify(moment));
    momentIds.push(moment.id);
  }
  await env.EQUYVO_KV.put(KEYS.MOMENTS, JSON.stringify(momentIds));
  
  // Seed profiles
  for (const profile of seedProfiles) {
    await env.EQUYVO_KV.put(KEYS.PROFILE(profile.id), JSON.stringify(profile));
  }
  
  // Seed content index (search)
  await env.EQUYVO_KV.put(KEYS.CONTENT_INDEX, JSON.stringify(seedContentIndex));
  
  // Initialize counter
  await env.EQUYVO_KV.put(KEYS.NEXT_ID, '100');
  
  console.log('KV seeded successfully with mock data');
}
