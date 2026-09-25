import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

export interface ChatTheme {
  type: 'default' | 'image' | 'color';
  value?: string; // For image URL (data URL) or color hex
  opacity?: number; // For background opacity, 0..1
}

interface ChatThemeContextType {
  chatTheme: ChatTheme;
  setChatTheme: (theme: ChatTheme) => boolean;
  resetChatTheme: () => void;
}

const defaultChatTheme: ChatTheme = {
  type: 'default',
  opacity: 1,
};

const STORAGE_KEY = 'chat-theme';
export const CHAT_THEME_DEFAULT = defaultChatTheme;

function clampOpacity(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0.05, n));
}

function isValidHex(v: unknown): boolean {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

function sanitizeTheme(raw: unknown): ChatTheme {
  if (!raw || typeof raw !== 'object') return { ...defaultChatTheme };
  const t = raw as Partial<ChatTheme>;
  const opacity = clampOpacity(t.opacity ?? 1);
  if (t.type === 'color' && isValidHex(t.value)) {
    return { type: 'color', value: (t.value as string).toLowerCase(), opacity };
  }
  if (t.type === 'image' && typeof t.value === 'string' && t.value.startsWith('data:image/')) {
    // Guard against absurdly large values that would thrash storage.
    // ~7MB data-URL cap; larger values are dropped to default.
    if (t.value.length > 7_000_000) return { ...defaultChatTheme };
    return { type: 'image', value: t.value, opacity };
  }
  return { ...defaultChatTheme, opacity };
}

const ChatThemeContext = createContext<ChatThemeContextType | undefined>(undefined);

export function ChatThemeProvider({ children }: { children: React.ReactNode }) {
  const [chatTheme, setChatThemeState] = useState<ChatTheme>(() => {
    // Lazy init avoids the flash-of-default on first paint.
    try {
      if (typeof window === 'undefined') return { ...defaultChatTheme };
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (!saved) return { ...defaultChatTheme };
      return sanitizeTheme(JSON.parse(saved));
    } catch {
      // Corrupt value: clear it so it doesn't fail on every reload.
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return { ...defaultChatTheme };
    }
  });

  // Cross-tab sync: changing theme in one tab updates all open tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      try {
        setChatThemeState(e.newValue ? sanitizeTheme(JSON.parse(e.newValue)) : { ...defaultChatTheme });
      } catch {
        /* ignore malformed cross-tab value */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setChatTheme = useCallback((theme: ChatTheme): boolean => {
    const clean = sanitizeTheme(theme);
    // Reject caller's invalid payload loudly in dev, but always store a safe value.
    setChatThemeState(clean);
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
      }
      return true;
    } catch {
      // QuotaExceededError (large image) or private-mode denial.
      return false;
    }
  }, []);

  const resetChatTheme = useCallback(() => {
    setChatThemeState({ ...defaultChatTheme });
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultChatTheme));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(
    () => ({ chatTheme, setChatTheme, resetChatTheme }),
    [chatTheme, setChatTheme, resetChatTheme],
  );

  return <ChatThemeContext.Provider value={value}>{children}</ChatThemeContext.Provider>;
}

export const useChatTheme = () => {
  const context = useContext(ChatThemeContext);
  if (context === undefined) {
    throw new Error('useChatTheme must be used within a ChatThemeProvider');
  }
  return context;
};
