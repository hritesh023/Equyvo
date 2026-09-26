import { useState, useCallback, useMemo } from 'react';
import { searchContent, getAllContent } from './content-index';
import { brainSearchSuggest, brainLearn } from './brain';

// Types for search suggestions
export interface SearchSuggestion {
  id: string;
  label: string;
  category: string;
  description: string;
  type: 'trending' | 'personal' | 'ai-generated' | 'recent';
  confidence?: number;
  metadata?: Record<string, any>;
}

export interface SearchHistoryItem {
  query: string;
  timestamp: number;
  resultCount?: number;
}

// AI-powered search service
class AISearchService {
  private static instance: AISearchService;
  private searchHistory: SearchHistoryItem[] = [];
  private userPreferences: string[] = [];
  
  static getInstance(): AISearchService {
    if (!AISearchService.instance) {
      AISearchService.instance = new AISearchService();
    }
    return AISearchService.instance;
  }

  // Load search history from localStorage
  loadSearchHistory(): SearchHistoryItem[] {
    try {
      const stored = localStorage.getItem('equyvo_search_history');
      if (stored) {
        this.searchHistory = JSON.parse(stored);
      }
    } catch {
      // If loading fails, just return empty history
    }
    return this.searchHistory;
  }

  // Save search to history
  saveSearch(query: string, resultCount?: number): void {
    const historyItem: SearchHistoryItem = {
      query: query.trim(),
      timestamp: Date.now(),
      resultCount
    };

    // Remove duplicates and keep only last 50 items
    this.searchHistory = [
      historyItem,
      ...this.searchHistory.filter(item => item.query !== query.trim())
    ].slice(0, 50);

    try {
      localStorage.setItem('equyvo_search_history', JSON.stringify(this.searchHistory));
    } catch {
    }
  }

  // Fetch smart suggestions from the app's suggestion service, which learns
  // from every search query it receives.
  private async fetchAISuggestions(query: string): Promise<SearchSuggestion[]> {
    try {
      const sessionId = `equyvo-search-${Date.now()}`;
      const labels = await brainSearchSuggest(query, sessionId);
      return labels.map((label, i) => ({
        id: `suggest-${Date.now()}-${i}`,
        label,
        category: 'Suggested',
        description: 'Suggested for you',
        type: 'ai-generated' as const,
        confidence: 0.9,
      }));
    } catch {
      return [];
    }
  }

  // Generate AI-powered suggestions based on input
  async generateSuggestions(query: string): Promise<SearchSuggestion[]> {
    const queryLower = query.toLowerCase().trim();
    
    if (!queryLower) {
      return this.getDefaultSuggestions();
    }

    const suggestions: SearchSuggestion[] = [];

    // 1. Try backend AI suggestions first (highest quality)
    const backendSuggestions = await this.fetchAISuggestions(queryLower);
    if (backendSuggestions.length > 0) {
      suggestions.push(...backendSuggestions);
    }

    // 2. Local contextual suggestions grounded in real content (supplement)
    const localSuggestions = this.generateContextualSuggestions(queryLower);
    suggestions.push(...localSuggestions);

    // 3. Recent searches that match
    const recentSuggestions = this.getRecentSearchSuggestions(queryLower);
    suggestions.push(...recentSuggestions);

    // 4. Trending suggestions that match
    const trendingSuggestions = this.getTrendingSuggestions(queryLower);
    suggestions.push(...trendingSuggestions);

    // 5. Real tag/category completions from actual Equyvo content (never invented)
    const realSuggestions = this.generateRealCompletions(queryLower);
    suggestions.push(...realSuggestions);

    // Deduplicate by label
    const seen = new Set<string>();
    const unique = suggestions.filter(s => {
      const key = s.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by relevance and limit results
    return unique
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 8);
  }

  // Generate contextual AI suggestions
  private generateContextualSuggestions(query: string): SearchSuggestion[] {
    const contextualPatterns = [
      // Content type patterns
      {
        keywords: ['photo', 'picture', 'image', 'camera', 'photography'],
        suggestions: [
          { label: 'portrait photography tips', category: 'Photography', description: 'Professional portrait photography techniques' },
          { label: 'landscape photography', category: 'Photography', description: 'Beautiful landscape photography ideas' },
          { label: 'street photography', category: 'Photography', description: 'Urban street photography captures' },
          { label: 'photo editing tutorials', category: 'Photography', description: 'Learn photo editing techniques' }
        ]
      },
      {
        keywords: ['video', 'movie', 'film', 'cinema'],
        suggestions: [
          { label: 'video editing tips', category: 'Video', description: 'Professional video editing tutorials' },
          { label: 'cinematic techniques', category: 'Video', description: 'Cinematic video techniques' },
          { label: 'vlogging ideas', category: 'Video', description: 'Creative vlogging content ideas' },
          { label: 'animation tutorials', category: 'Video', description: 'Animation and motion graphics' }
        ]
      },
      {
        keywords: ['music', 'song', 'audio', 'sound', 'beat'],
        suggestions: [
          { label: 'music production', category: 'Music', description: 'Music production tutorials' },
          { label: 'songwriting tips', category: 'Music', description: 'Creative songwriting techniques' },
          { label: 'audio mixing', category: 'Music', description: 'Professional audio mixing guides' },
          { label: 'music covers', category: 'Music', description: 'Amazing music covers' }
        ]
      },
      {
        keywords: ['food', 'cooking', 'recipe', 'kitchen', 'chef', 'bake', 'cake'],
        suggestions: [
          { label: 'quick recipes', category: 'Food', description: 'Fast and easy recipes' },
          { label: 'baking tutorials', category: 'Food', description: 'Learn baking techniques' },
          { label: 'food photography', category: 'Food', description: 'Beautiful food photography' },
          { label: 'cooking tips', category: 'Food', description: 'Professional cooking advice' }
        ]
      },
      {
        keywords: ['fitness', 'workout', 'gym', 'exercise', 'health', 'yoga'],
        suggestions: [
          { label: 'home workouts', category: 'Fitness', description: 'Effective home workout routines' },
          { label: 'yoga flows', category: 'Fitness', description: 'Relaxing yoga sequences' },
          { label: 'strength training', category: 'Fitness', description: 'Build strength exercises' },
          { label: 'nutrition tips', category: 'Fitness', description: 'Healthy nutrition advice' }
        ]
      },
      {
        keywords: ['travel', 'trip', 'vacation', 'explore', 'adventure'],
        suggestions: [
          { label: 'travel vlogs', category: 'Travel', description: 'Amazing travel experiences' },
          { label: 'budget travel tips', category: 'Travel', description: 'Travel on a budget guides' },
          { label: 'hidden gems', category: 'Travel', description: 'Undiscovered travel spots' },
          { label: 'travel photography', category: 'Travel', description: 'Capture travel memories' }
        ]
      },
      {
        keywords: ['tech', 'technology', 'coding', 'programming', 'software', 'ai', 'artificial intelligence'],
        suggestions: [
          { label: 'tech reviews', category: 'Technology', description: 'Latest tech product reviews' },
          { label: 'coding tutorials', category: 'Technology', description: 'Learn programming languages' },
          { label: 'gadget unboxing', category: 'Technology', description: 'New gadget reviews' },
          { label: 'AI tools', category: 'Technology', description: 'Artificial intelligence tools' }
        ]
      },
      {
        keywords: ['fashion', 'style', 'outfit', 'clothing', 'trend', 'tie'],
        suggestions: [
          { label: 'fashion trends', category: 'Fashion', description: 'Latest fashion trends' },
          { label: 'outfit ideas', category: 'Fashion', description: 'Daily outfit inspiration' },
          { label: 'styling tips', category: 'Fashion', description: 'Fashion styling advice' },
          { label: 'sustainable fashion', category: 'Fashion', description: 'Eco-friendly fashion choices' }
        ]
      },
      {
        keywords: ['art', 'drawing', 'painting', 'creative', 'design'],
        suggestions: [
          { label: 'art tutorials', category: 'Art', description: 'Learn art techniques' },
          { label: 'digital art', category: 'Art', description: 'Digital art creation' },
          { label: 'creative projects', category: 'Art', description: 'Inspiring creative ideas' },
          { label: 'art challenges', category: 'Art', description: 'Fun art challenges' }
        ]
      },
      {
        keywords: ['gaming', 'games', 'play', 'esports', 'stream'],
        suggestions: [
          { label: 'gaming streams', category: 'Gaming', description: 'Popular gaming content' },
          { label: 'game reviews', category: 'Gaming', description: 'Honest game reviews' },
          { label: 'esports highlights', category: 'Gaming', description: 'Best esports moments' },
          { label: 'gaming tutorials', category: 'Gaming', description: 'Improve gaming skills' }
        ]
      }
    ];

    // Find matching patterns
    const matchedSuggestions: SearchSuggestion[] = [];
    
    for (const pattern of contextualPatterns) {
      if (pattern.keywords.some(keyword => query.includes(keyword))) {
        const suggestions = pattern.suggestions.map(suggestion => ({
          id: `ai-${Math.random().toString(36).substr(2, 9)}`,
          ...suggestion,
          type: 'ai-generated' as const,
          confidence: this.calculateConfidence(query, suggestion.label + ' ' + suggestion.description)
        }));
        matchedSuggestions.push(...suggestions);
      }
    }

    // If no keyword pattern matched, try content-index-based suggestions
    // (real Equyvo content only). Honest empty when nothing matches — the
    // search page will show "No results found" instead of invented filler.
    if (matchedSuggestions.length === 0) {
      const indexResults = searchContent(query);
      if (indexResults.results.length > 0 && !indexResults.isAiRecommended) {
        const contentSuggestions = indexResults.results.slice(0, 4).map(item => ({
          id: `content-${item.id}`,
          label: item.title,
          category: item.category,
          description: item.description.slice(0, 80) + '...',
          type: 'ai-generated' as const,
          confidence: 0.75,
          metadata: { contentId: item.id }
        }));
        matchedSuggestions.push(...contentSuggestions);
      }
    }

    return matchedSuggestions;
  }

  // Real completions from actual Equyvo content (tags/categories/titles).
  // Never invents `${query} tutorials`-style filler.
  private generateRealCompletions(query: string): SearchSuggestion[] {
    try {
      const all = getAllContent();
      if (!all.length || !query) return [];
      const q = query.toLowerCase();
      const seen = new Set<string>();
      const out: SearchSuggestion[] = [];
      for (const item of all) {
        const candidates = [
          ...(item.tags || []),
          item.category || '',
        ].filter(Boolean);
        for (const cand of candidates) {
          const c = String(cand).trim();
          const cl = c.toLowerCase();
          if (c && cl.includes(q) && !seen.has(cl) && out.length < 4) {
            seen.add(cl);
            out.push({
              id: `real-${cl}`,
              label: c,
              category: item.category || 'Tag',
              description: `Real Equyvo ${item.category || 'content'}`,
              type: 'trending',
              confidence: 0.65,
            });
          }
        }
        if (out.length >= 4) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  // Legacy invented-suggestion generator removed: returning fake
  // `${query} tutorials`-style rows for random strings is bot-like data.
  // Kept as an empty stub so older callers don't break.
  private generateGeneralSuggestions(_query: string): SearchSuggestion[] {
    return [];
  }

  // Get recent search suggestions
  private getRecentSearchSuggestions(query: string): SearchSuggestion[] {
    const recent = this.searchHistory
      .filter(item => item.query.toLowerCase().includes(query))
      .slice(0, 3);

    return recent.map(item => ({
      id: `recent-${item.timestamp}`,
      label: item.query,
      category: 'Recent',
      description: `Searched ${this.getRelativeTime(item.timestamp)}`,
      type: 'recent' as const,
      confidence: 0.8
    }));
  }

  // Get trending suggestions
  private getTrendingSuggestions(query: string): SearchSuggestion[] {
    const trendingTopics = [
      { label: 'viral challenges', category: 'Trending', description: 'Latest viral challenges' },
      { label: 'trending music', category: 'Music', description: 'Popular trending songs' },
      { label: 'meme templates', category: 'Entertainment', description: 'Trending meme formats' },
      { label: 'shorts trends', category: 'Video', description: 'Trending short video content' },
      { label: 'ai art', category: 'Art', description: 'AI-generated artwork' },
      { label: 'sustainable living', category: 'Lifestyle', description: 'Eco-friendly lifestyle tips' }
    ];

    return trendingTopics
      .filter(topic => 
        topic.label.toLowerCase().includes(query) || 
        topic.category.toLowerCase().includes(query)
      )
      .slice(0, 3)
      .map(topic => ({
        id: `trending-${Math.random().toString(36).substr(2, 9)}`,
        ...topic,
        type: 'trending' as const,
        confidence: 0.7
      }));
  }

  // Get default suggestions when query is empty
  private getDefaultSuggestions(): SearchSuggestion[] {
    return [
      {
        id: 'default-1',
        label: 'trending photography',
        category: 'Photography',
        description: 'Popular photography trends and techniques',
        type: 'trending',
        confidence: 0.9
      },
      {
        id: 'default-2',
        label: 'viral dance challenges',
        category: 'Entertainment',
        description: 'Latest dance challenges going viral',
        type: 'trending',
        confidence: 0.9
      },
      {
        id: 'default-3',
        label: 'food recipes',
        category: 'Food',
        description: 'Delicious recipes and cooking tips',
        type: 'trending',
        confidence: 0.8
      },
      {
        id: 'default-4',
        label: 'fitness workouts',
        category: 'Health',
        description: 'Effective workout routines and exercises',
        type: 'trending',
        confidence: 0.8
      }
    ];
  }

  // Calculate confidence score for suggestions
  private calculateConfidence(query: string, text: string): number {
    const queryWords = query.toLowerCase().split(' ').filter(w => w.length > 1);
    const textLower = text.toLowerCase();
    
    let score = 0;
    for (const word of queryWords) {
      if (textLower.includes(word)) {
        score += 1;
        // Exact match gets higher score
        if (textLower.includes(query.toLowerCase())) {
          score += 0.5;
        }
      }
    }
    
    return Math.min(score / queryWords.length, 1);
  }

  // Removed: invented SEO autocomplete (`${query} tutorial`, `${query} near me`,
  // etc.) is fake data for random strings. Suggestions now come only from real
  // Equyvo content, backend suggestions, recent searches, and trending topics.
  private generateSEOSuggestions(_query: string): SearchSuggestion[] {
    return [];
  }

  // Get relative time for display
  private getRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }
}

// Hook for using AI search service
export function useAISearch() {
  const [isLoading, setIsLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  
  const searchService = useMemo(() => AISearchService.getInstance(), []);

  const generateSuggestions = useCallback(async (query: string) => {
    setIsLoading(true);
    try {
      const results = await searchService.generateSuggestions(query);
      setSuggestions(results);
    } catch {
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  }, [searchService]);

  const saveSearch = useCallback((query: string, resultCount?: number) => {
    searchService.saveSearch(query, resultCount);
    if (query && query.trim()) {
      const sessionId = `equyvo-search-${Date.now()}`;
      brainLearn({
        query: query.trim(),
        response: undefined,
        feedback: resultCount && resultCount > 0 ? 0.8 : 0.4,
        sessionId,
        source: 'equivo-search',
        routeType: 'web_search',
      });
    }
  }, [searchService]);

  const getSearchHistory = useCallback(() => {
    return searchService.loadSearchHistory();
  }, [searchService]);

  return {
    suggestions,
    isLoading,
    generateSuggestions,
    saveSearch,
    getSearchHistory
  };
}

export default AISearchService;
