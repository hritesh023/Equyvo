import { useState, useCallback, useMemo } from 'react';
import { searchContent, getAllContent } from './content-index';
import { brainSearchSuggest, brainLearn } from './brain';

// Types for search suggestions
export interface SearchSuggestion {
  id: string;
  label: string;
  category: string;
  description: string;
  type: 'trending' | 'personal' | 'ai-generated' | 'recent' | 'guess';
  confidence?: number;
  metadata?: Record<string, any>;
}

export interface SearchHistoryItem {
  query: string;
  timestamp: number;
  resultCount?: number;
  // When the search resolved to a real Equyvo account, remember it so the
  // recent-search row can render that account's avatar instead of a generic
  // icon (Google/YouTube-style recent suggestions).
  userId?: string;
  avatar?: string;
  username?: string;
}

// AI-powered search service
class AISearchService {
  private static instance: AISearchService;
  private searchHistory: SearchHistoryItem[] = [];
  private userPreferences: string[] = [];

  // â”€â”€ Predictive corpus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Built from REAL Equyvo data only (titles, tags, categories, creators and
  // the user's own search history). Feeds the "guess what you're typing"
  // autocomplete: prefix continuations, last-word completions and typo
  // corrections â€” never invented filler phrases.
  private corpusWords: string[] = [];          // lowercase distinct words
  private corpusWordRank: number[] = [];       // parallel: popularity rank
  private corpusWordMeta: string[] = [];       // parallel: display-ish source
  private corpusPhrases: { display: string; lower: string }[] = [];
  private corpusBuiltAt = 0;

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
  saveSearch(query: string, resultCount?: number, meta?: { userId?: string; avatar?: string; username?: string }): void {
    const historyItem: SearchHistoryItem = {
      query: query.trim(),
      timestamp: Date.now(),
      resultCount,
      userId: meta?.userId,
      avatar: meta?.avatar,
      username: meta?.username,
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
      // Google/YouTube-style: surface the user's recent searches first, then
      // trending defaults. Recent searches carry the resolved account avatar
      // when the query was a profile name.
      const recent = this.getRecentSearchSuggestions('');
      const defaults = this.getDefaultSuggestions();
      const seen = new Set<string>();
      const out: SearchSuggestion[] = [];
      for (const s of [...recent, ...defaults]) {
        const key = s.label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
      }
      return out.slice(0, 8);
    }

    const suggestions: SearchSuggestion[] = [];

    // 1. PREDICTIVE GUESS LAYER â€” "finish what you're typing" from real
    //    Equyvo content: full-phrase continuations ("music vi" â†’ "music
    //    videos"), last-word completions ("phot" â†’ "photography") and typo
    //    corrections ("photografy" â†’ "photography"). No data, no guesses.
    const phraseGuesses = await this.guessPhraseContinuations(queryLower);
    const wordGuesses = await this.guessWordCompletions(queryLower);
    const typoGuesses = await this.guessTypoCorrections(queryLower);
    suggestions.push(...phraseGuesses, ...wordGuesses, ...typoGuesses);

    // 2. Backend AI suggestions (learned interest-graph labels).
    const backendSuggestions = await this.fetchAISuggestions(queryLower);
    if (backendSuggestions.length > 0) {
      suggestions.push(...backendSuggestions);
    }

    // 3. Real content matches from the search index (titles of actual posts).
    const localSuggestions = this.generateContentMatches(queryLower);
    suggestions.push(...localSuggestions);

    // 4. Recent searches that match the typed prefix first.
    const recentSuggestions = this.getRecentSearchSuggestions(queryLower);
    suggestions.push(...recentSuggestions);

    // 5. Trending suggestions that match
    const trendingSuggestions = this.getTrendingSuggestions(queryLower);
    suggestions.push(...trendingSuggestions);

    // 6. Real tag/category completions from actual Equyvo content (never invented)
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

    // Guesses float above everything: they promise "keep this text, I know
    // where it goes". Higher (phrases) â†’ completions â†’ typos, then the rest
    // by confidence.
    return unique
      .sort((a, b) => {
        const at = a.type === 'guess' ? 100 + (a.confidence || 0) : (a.confidence || 0);
        const bt = b.type === 'guess' ? 100 + (b.confidence || 0) : (b.confidence || 0);
        return bt - at;
      })
      .slice(0, 8);
  }

  // â”€â”€ Predictive corpus (rebuilt periodically from live content) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  private buildCorpus(): void {
    const now = Date.now();
    if (this.corpusBuiltAt && now - this.corpusBuiltAt < 30000 && this.corpusWords.length) return;
    this.corpusBuiltAt = now;
    this.corpusWords = [];
    this.corpusWordRank = [];
    this.corpusWordMeta = [];
    this.corpusPhrases = [];

    const counts = new Map<string, { count: number; meta: string }>();
    const bump = (word: string, meta: string) => {
      const w = word.trim().toLowerCase();
      if (w.length < 3) return;
      const cur = counts.get(w);
      if (cur) {
        cur.count += 1;
        if (meta === 'recent') cur.meta = meta; // user's own vocab wins
      } else {
        counts.set(w, { count: 1, meta });
      }
    };
    const pushPhrase = (display: string) => {
      const d = String(display || '').trim();
      if (d.length < 3 || d.length > 90) return;
      this.corpusPhrases.push({ display: d, lower: d.toLowerCase() });
    };

    // The user's own history first (their vocabulary wins duplicates).
    for (const h of this.loadSearchHistory()) {
      const q = String(h?.query || '').trim();
      if (!q) continue;
      q.split(/\s+/).forEach((w) => bump(w, 'recent'));
    }

    const all = getAllContent();
    for (const item of all) {
      pushPhrase(item.title || '');
      if (item.creator) {
        pushPhrase(item.creator);
        String(item.creator).split(/\s+/).forEach((w) => bump(w, 'creator'));
      }
      if (item.category) {
        pushPhrase(item.category);
        bump(item.category, 'category');
      }
      for (const tag of item.tags || []) {
        pushPhrase(tag);
        bump(tag, 'tag');
      }
      // Title words â€” real content vocabulary.
      String(item.title || '').toLowerCase().split(/[^a-z0-9]+/).forEach((w) => bump(w, 'title'));
    }
    // History queries as phrases too (recent completions are high-intent).
    for (const h of this.loadSearchHistory()) {
      const q = String(h?.query || '').trim();
      if (q) this.corpusPhrases.push({ display: q, lower: q.toLowerCase() });
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [word, v] of ranked) {
      this.corpusWords.push(word);
      this.corpusWordRank.push(v.count);
      this.corpusWordMeta.push(v.meta);
    }
    // Max ~10k entries â†’ trivial memory; keeps mustaches cheap too.
    this.corpusPhrases = this.corpusPhrases.slice(0, 2000);
  }

  /** Full-phrase continuations: the typed text is a prefix of a real title/tag. */
  private async guessPhraseContinuations(query: string): Promise<SearchSuggestion[]> {
    try {
      if (query.length < 2) return [];
      this.buildCorpus();
      const out: SearchSuggestion[] = [];
      const seen = new Set<string>();
      // Longer matches score higher ("music vi" â†’ "music videos ...").
      for (const { display, lower } of this.corpusPhrases) {
        if (!lower.startsWith(query) || lower === query) continue;
        if (seen.has(lower)) continue;
        seen.add(lower);
        const depthBoost = Math.min(lower.length - query.length, 12) / 40; // shorter leap = better guess
        out.push({
          id: `guess-ph-${lower.slice(0, 48)}`,
          label: display,
          category: 'Suggested',
          description: this.guessSourceHint(query, display),
          type: 'guess',
          confidence: 0.95 + depthBoost,
        });
        if (out.length >= 6) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  private guessSourceHint(query: string, display: string): string {
    const q = query.toLowerCase();
    const d = display.toLowerCase();
    if (this.searchHistory.some((h) => h.query.toLowerCase() === d)) return 'Your recent search';
    if (d === q) return '';
    return 'Finish typing â€” real Equyvo match';
  }

  /** Last-word completions: "music vi" â†’ "music videos", "phot" â†’ "photography". */
  private async guessWordCompletions(query: string): Promise<SearchSuggestion[]> {
    try {
      const tokens = query.split(/\s+/);
      if (tokens.length === 0 || query.length < 2) return [];
      this.buildCorpus();
      const lastTok = tokens[tokens.length - 1].toLowerCase();
      if (lastTok.length < 1 || lastTok.length > 30) return [];
      const prefix = tokens.slice(0, -1).join(' ');
      const out: SearchSuggestion[] = [];
      for (let i = 0; i < this.corpusWords.length && out.length < 6; i++) {
        const word = this.corpusWords[i];
        if (word === lastTok || !word.startsWith(lastTok)) continue;
        // Prefer the REAL casing of the completed phrase when one exists,
        // else the raw corpus word â€” never an invented display string.
        const fullLower = prefix ? `${prefix} ${word}` : word;
        const realPhrase = this.corpusPhrases.find(
          (p) => p.lower === fullLower || p.lower.startsWith(`${fullLower} `),
        );
        const label = realPhrase ? realPhrase.display : fullLower;
        out.push({
          id: `guess-wd-${word}-${prefix.length}`,
          label,
          category: 'Suggested',
          description: 'Continue with this search â€” real Equyvo word',
          type: 'guess',
          // Earlier prefix position + popularity = sharper guess.
          confidence: 0.88 + Math.min(this.corpusWordRank[i], 6) / 40,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Typo corrections â€” "did you mean". Bounded Levenshtein against real
   * corpus words only; distances â‰¤ 2 (â‰¤ 3 for long words). Shown when the
   * typed text has no prefix matches, exactly like classic search guessing.
   */
  private async guessTypoCorrections(query: string): Promise<SearchSuggestion[]> {
    try {
      const tokens = query.split(/\s+/);
      if (!tokens.length) return [];
      this.buildCorpus();
      const lastTok = tokens[tokens.length - 1].toLowerCase();
      // Only surface typo-guesses for meaningfully typed text.
      if (lastTok.length < 4) return [];
      // Prefix hits already cover the obvious case; typo mode is the fallback.
      const hasPrefixHit =
        this.corpusPhrases.some((p) => p.lower.startsWith(query)) ||
        this.corpusWords.some((w) => w.startsWith(lastTok));
      if (hasPrefixHit) return [];

      const maxDist = lastTok.length >= 7 ? 3 : 2;
      const prefix = tokens.slice(0, -1).join(' ');
      const out: { word: string; dist: number; rank: number }[] = [];
      for (let i = 0; i < this.corpusWords.length; i++) {
        const word = this.corpusWords[i];
        // Same first letter or one off: prune cheaply for speed.
        if (Math.abs(word.length - lastTok.length) > maxDist) continue;
        if (word[0] !== lastTok[0] && lastTok.length > 3 && word.length > 3) continue;
        const d = this.boundedLevenshtein(lastTok, word, maxDist);
        if (d >= 0 && d <= maxDist) out.push({ word, dist: d, rank: this.corpusWordRank[i] });
      }
      out.sort((a, b) => a.dist - b.dist || b.rank - a.rank);
      return out.slice(0, 4).map(({ word, dist }) => {
        const fixed = prefix ? `${prefix} ${word.charAt(0).toUpperCase() + word.slice(1)}` : word;
        return {
          id: `guess-ty-${word}-${dist}`,
          label: fixed,
          category: 'Suggested',
          description: 'Did you mean this?',
          type: 'guess' as const,
          confidence: 0.6 + (1 / (dist * 6 + 1)),
        };
      });
    } catch {
      return [];
    }
  }

  /** Levenshtein with early cutoff; returns dist (â‰¤ max) or -1 when over. */
  private boundedLevenshtein(a: string, b: string, max: number): number {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > max) return -1;
    let prev = new Array<number>(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        cur.push(v);
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return -1; // early exit â€” can't get back under max
      prev = cur;
    }
    return prev[lb] <= max ? prev[lb] : -1;
  }

  // Real content matches: titles of actual posts matching the typed text.
  private generateContentMatches(query: string): SearchSuggestion[] {
    try {
      const indexResults = searchContent(query);
      if (indexResults.results.length === 0) return [];
      return indexResults.results.slice(0, 3).map(item => ({
        id: `content-${item.id}`,
        label: item.title,
        category: item.category,
        description: item.description.slice(0, 80) + '...',
        type: 'ai-generated' as const,
        confidence: 0.75,
        metadata: { contentId: item.id }
      }));
    } catch {
      return [];
    }
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
      confidence: 0.8,
      metadata: { userId: item.userId, avatar: item.avatar, username: item.username },
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

  const saveSearch = useCallback((query: string, resultCount?: number, meta?: { userId?: string; avatar?: string; username?: string }) => {
    searchService.saveSearch(query, resultCount, meta);
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
