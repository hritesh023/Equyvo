import { showSuccess, showError } from '@/utils/toast';

// Safe async wrapper with error handling
export const safeAsync = async <T>(
  asyncFn: () => Promise<T>,
  errorMessage?: string
): Promise<T | null> => {
  try {
    return await asyncFn();
  } catch {
    showError(errorMessage || 'An error occurred');
    return null;
  }
};

// Safe JSON parsing
export const safeJSONParse = <T>(str: string, fallback: T): T => {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
};

// Safe localStorage operations
export const safeLocalStorage = {
  get: <T>(key: string, fallback: T): T => {
    try {
      const item = localStorage.getItem(key);
      return item ? safeJSONParse(item, fallback) : fallback;
    } catch {
      return fallback;
    }
  },
  set: <T>(key: string, value: T): boolean => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove: (key: string): boolean => {
    try {
      localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  }
};

// Safe clipboard operations
export const safeClipboard = {
  copy: async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      showSuccess('Copied to clipboard!');
      return true;
    } catch {
      // Fallback for older browsers
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        showSuccess('Copied to clipboard!');
        return true;
      } catch {
        showError('Failed to copy to clipboard');
        return false;
      }
    }
  }
};

// Safe image loading
export const safeImageLoad = (src: string, fallback?: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(fallback || '/placeholder.svg');
    img.src = src;
  });
};

// Debounce utility
export const debounce = <T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

// Throttle utility
export const throttle = <T extends (...args: unknown[]) => unknown>(
  func: T,
  limit: number
): ((...args: Parameters<T>) => void) => {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
};
