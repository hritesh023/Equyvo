import api from './api';

export interface ContentIndexItem {
  id: string;
  title: string;
  description: string;
  type: 'video' | 'photo' | 'post' | 'thought' | 'moment' | 'story';
  creator: string;
  creatorAvatar?: string;
  views: string;
  thumbnail: string;
  videoUrl?: string;
  imageUrl?: string;
  category: string;
  tags: string[];
  duration?: string;
  publishedAt: string;
  content?: string;
  likes?: number;
  comments?: number;
}

// In-memory cache for search index
let cachedIndex: ContentIndexItem[] | null = null;
let lastFetch = 0;
const CACHE_TTL = 60000; // 1 minute

// Invalidate cache when new content is created
if (typeof window !== 'undefined') {
  window.addEventListener('userPostCreated', () => {
    cachedIndex = null;
    lastFetch = 0;
  });
}

async function getIndex(): Promise<ContentIndexItem[]> {
  const now = Date.now();
  if (cachedIndex && now - lastFetch < CACHE_TTL) {
    return cachedIndex;
  }
  
  try {
    // Fetch from API with empty query to get all content
    const { data, error } = await api.search('');
    if (!error && data?.results) {
      cachedIndex = data.results;
      lastFetch = now;
      return data.results;
    }
  } catch {}
  
  // Fallback to empty
  return cachedIndex || [];
}

// Simple fuzzy scoring (kept from original)
function wordSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower === bLower) return 1;
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.9;
  const aWords = aLower.split(/\s+/);
  const bWords = bLower.split(/\s+/);
  let matchCount = 0;
  for (const w of aWords) {
    if (w.length < 2) continue;
    if (bWords.some(bw => bw.includes(w) || w.includes(bw))) matchCount++;
  }
  const maxLen = Math.max(aWords.length, bWords.length);
  if (maxLen === 0) return 0;
  return matchCount / maxLen;
}

function characterFuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let qIdx = 0;
  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      score++;
      qIdx++;
    }
  }
  if (qIdx === 0) return 0;
  const coverage = score / q.length;
  const density = score / Math.max(t.length, 1);
  return coverage * 0.7 + density * 0.3;
}

// Search content using API with client-side fallback
export async function searchContentAsync(query: string): Promise<{
  results: ContentIndexItem[];
  totalCount: number;
  isAiRecommended: boolean;
}> {
  const trimmed = query.trim();
  
  // Try API search first
  try {
    const { data, error } = await api.search(trimmed);
    if (!error && data) {
      return {
        results: data.results || [],
        totalCount: data.totalCount || 0,
        isAiRecommended: data.isAiRecommended || false,
      };
    }
  } catch {}
  
  // Fallback to client-side search on cached index
  const index = await getIndex();
  if (!trimmed) {
    return { results: index.slice(0, 12), totalCount: index.length, isAiRecommended: true };
  }
  
  const q = trimmed.toLowerCase();
  const scored = index.map(item => {
    let score = 0;
    const searchableText = [item.title, item.description, item.content, item.category, item.creator, ...item.tags]
      .filter(Boolean).join(' ').toLowerCase();
    
    if (searchableText.includes(q)) score += 100;
    if (item.title.toLowerCase().includes(q)) score += 50;
    if (item.category.toLowerCase().includes(q)) score += 40;
    if (item.creator.toLowerCase().includes(q)) score += 35;
    if (item.description.toLowerCase().includes(q)) score += 30;
    if (item.content?.toLowerCase().includes(q)) score += 25;
    
    const tagMatches = item.tags.filter(t => t.toLowerCase().includes(q)).length;
    score += tagMatches * 20;
    
    const words = q.split(/\s+/).filter(w => w.length > 1);
    for (const word of words) {
      if (searchableText.includes(word)) score += 5;
      const titleSim = wordSimilarity(item.title, word);
      if (titleSim > 0.5) score += titleSim * 15;
      const tagWordMatches = item.tags.filter(t => t.toLowerCase().includes(word) || word.includes(t.toLowerCase())).length;
      score += tagWordMatches * 8;
    }
    
    const fuzzyCharScore = characterFuzzyScore(q, searchableText);
    if (fuzzyCharScore > 0.3) score += fuzzyCharScore * 20;
    
    const views = parseInt(item.views.replace(/[K,M]/g, match => match === 'K' ? '000' : '000000'));
    score += Math.log2(views + 1) * 0.5;
    
    return { item, score };
  });
  
  const threshold = 2;
  const matching = scored.filter(s => s.score >= threshold);
  matching.sort((a, b) => b.score - a.score);
  
  if (matching.length === 0) {
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    return { results: sorted.slice(0, 12).map(s => s.item), totalCount: index.length, isAiRecommended: true };
  }
  
  return { results: matching.slice(0, 20).map(s => s.item), totalCount: matching.length, isAiRecommended: false };
}

// Sync search function - returns cached data immediately, refreshes async
export function searchContent(query: string): {
  results: ContentIndexItem[];
  totalCount: number;
  isAiRecommended: boolean;
} {
  const trimmed = query.trim();

  // Try cached index first
  if (cachedIndex && cachedIndex.length > 0) {
    if (!trimmed) {
      return { results: cachedIndex.slice(0, 12), totalCount: cachedIndex.length, isAiRecommended: false };
    }

    const q = trimmed.toLowerCase();
    const scored = cachedIndex.map(item => {
      let score = 0;
      const searchableText = [item.title, item.description, item.content, item.category, item.creator, ...item.tags]
        .filter(Boolean).join(' ').toLowerCase();

      if (searchableText.includes(q)) score += 100;
      if (item.title.toLowerCase().includes(q)) score += 50;
      if (item.category.toLowerCase().includes(q)) score += 40;
      if (item.creator.toLowerCase().includes(q)) score += 35;
      if (item.description.toLowerCase().includes(q)) score += 30;
      if (item.content?.toLowerCase().includes(q)) score += 25;

      const tagMatches = item.tags.filter(t => t.toLowerCase().includes(q)).length;
      score += tagMatches * 20;

      return { item, score };
    });

    const threshold = 2;
    const matching = scored.filter(s => s.score >= threshold);
    matching.sort((a, b) => b.score - a.score);

    if (matching.length === 0) {
      scored.sort((a, b) => b.score - a.score);
      return { results: scored.slice(0, 12).map(s => s.item), totalCount: scored.length, isAiRecommended: true };
    }

    return { results: matching.slice(0, 20).map(s => s.item), totalCount: matching.length, isAiRecommended: false };
  }

  // No cache yet - kick off async fetch
  if (trimmed) {
    searchContentAsync(trimmed).catch(() => {});
  }
  return { results: [], totalCount: 0, isAiRecommended: true };
}

export function getContentByCategory(category: string): ContentIndexItem[] {
  if (!cachedIndex || cachedIndex.length === 0) {
    getIndex().catch(() => {});
    return [];
  }
  return cachedIndex.filter(item => item.category.toLowerCase() === category.toLowerCase());
}

export function getTrendingContent(): ContentIndexItem[] {
  if (!cachedIndex || cachedIndex.length === 0) {
    getIndex().catch(() => {});
    return [];
  }
  // Sort by views (descending) as a proxy for trending
  return [...cachedIndex].sort((a, b) => {
    const viewsA = parseInt(a.views.replace(/[K,M]/g, m => m === 'K' ? '000' : '000000')) || 0;
    const viewsB = parseInt(b.views.replace(/[K,M]/g, m => m === 'K' ? '000' : '000000')) || 0;
    return viewsB - viewsA;
  }).slice(0, 10);
}

export function getContentById(id: string): ContentIndexItem | undefined {
  if (cachedIndex) return cachedIndex.find(item => item.id === id);
  return undefined;
}

// Populate cache immediately on import
if (typeof window !== 'undefined') {
  getIndex().catch(() => {});
}

export function getAllContent(): ContentIndexItem[] {
  if (cachedIndex && cachedIndex.length > 0) return cachedIndex;
  // Kick off async fetch
  getIndex().catch(() => {});
  return cachedIndex || [];
}

export async function getAiRecommendations(query: string): Promise<ContentIndexItem[]> {
  const { results } = await searchContentAsync(query);
  return results.slice(0, 8);
}
