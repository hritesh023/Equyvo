import React, { useEffect, useState } from 'react';
import NativeAdCard from './ads/NativeAdCard';

const SESSION_KEY = 'equyvo_appopen_ad_shown';

const AppOpenAd: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY) === '1') return;
      const t = window.setTimeout(() => setVisible(true), 400);
      return () => window.clearTimeout(t);
    } catch {
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    setVisible(false);
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
  };

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[99990] flex items-end sm:items-center justify-center p-4 pointer-events-none"
      role="dialog"
      aria-label="Sponsored"
    >
      <div className="w-full max-w-md pointer-events-auto bg-background/95 rounded-xl shadow-2xl p-2">
        <NativeAdCard placement="app-open" onDismiss={dismiss} />
        <button
          type="button"
          onClick={dismiss}
          className="mt-2 w-full text-center text-xs text-muted-foreground underline underline-offset-2"
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default AppOpenAd;