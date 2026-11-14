import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
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

  // Rendered in normal document flow (NOT a fixed full-screen overlay) so the
  // ad behaves like part of the app: it never blocks interaction with the rest
  // of the UI and the user can scroll past it. It still appears only once per
  // session and disappears permanently once dismissed.
  return (
    <div
      className="w-full max-w-3xl mx-auto px-3 py-2 select-none"
      role="complementary"
      aria-label="Sponsored content"
      style={{ touchAction: 'manipulation' }}
    >
      <div className="rounded-xl border border-dashed bg-background/95 shadow-sm p-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Sponsored
          </span>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Close ad"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <NativeAdCard placement="app-open" onDismiss={dismiss} />
      </div>
    </div>
  );
};

export default AppOpenAd;