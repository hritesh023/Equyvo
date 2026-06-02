import { useState, useCallback } from 'react';

interface WatchHistoryItem {
  id: string;
  type: 'post' | 'video' | 'story';
  timestamp: number;
  duration?: number;
}

export const useWatchHistory = () => {
  const [history, setHistory] = useState<WatchHistoryItem[]>([]);

  const addToWatchHistory = useCallback((item: Omit<WatchHistoryItem, 'timestamp'>) => {
    const historyItem: WatchHistoryItem = {
      ...item,
      timestamp: Date.now()
    };

    setHistory(prev => {
      // Remove existing item with same ID if it exists
      const filtered = prev.filter(h => h.id !== item.id);
      // Add new item to the beginning
      return [historyItem, ...filtered].slice(0, 100); // Keep only last 100 items
    });

    // Store in localStorage for persistence
    try {
      const stored = localStorage.getItem('watchHistory');
      const parsed = stored ? JSON.parse(stored) : [];
      const filtered = parsed.filter((h: WatchHistoryItem) => h.id !== item.id);
      const updated = [historyItem, ...filtered].slice(0, 100);
      localStorage.setItem('watchHistory', JSON.stringify(updated));
    } catch {
    }
  }, []);

  const getHistory = useCallback(() => {
    return history;
  }, [history]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    localStorage.removeItem('watchHistory');
  }, []);

  return {
    addToWatchHistory,
    getHistory,
    clearHistory,
    history
  };
};
