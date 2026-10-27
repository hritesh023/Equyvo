import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  Mail,
  MessageCircle,
  MessageSquare,
  Send,
  Share2,
  Smartphone,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showError, showSuccess } from '@/utils/toast';
import {
  getSharePlatformUsage,
  recordSharePlatformUsage,
  SHARE_SHEET_EVENT,
  SharePayload,
} from '@/utils/share';

interface SharePlatformOption {
  id: string;
  name: string;
  badgeBg: string;
  badgeText: string;
  icon: React.ReactNode;
  buildUrl?: (payload: Required<SharePayload>) => string;
  action?: (payload: Required<SharePayload>) => Promise<void> | void;
}

const DEFAULT_ORDER = [
  'whatsapp',
  'instagram',
  'telegram',
  'x',
  'facebook',
  'sms',
  'snapchat',
  'reddit',
  'linkedin',
  'email',
  'system',
];

const PLATFORMS: SharePlatformOption[] = [
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    badgeBg: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
    badgeText: 'WA',
    icon: <MessageCircle className="h-5 w-5" />,
    buildUrl: ({ title, text, url }) => {
      const body = [title, text, url].filter(Boolean).join('\n');
      return `https://api.whatsapp.com/send?text=${encodeURIComponent(body)}`;
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    badgeBg: 'bg-pink-500/15 text-pink-500 border-pink-500/30',
    badgeText: 'IG',
    icon: <Sparkles className="h-5 w-5" />,
    action: async ({ title, text, url }) => {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title, text: text || title, url });
          return;
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return;
        }
      }
      window.open(
        `https://www.instagram.com/?url=${encodeURIComponent(url)}`,
        '_blank',
        'noopener,noreferrer',
      );
    },
  },
  {
    id: 'telegram',
    name: 'Telegram',
    badgeBg: 'bg-sky-500/15 text-sky-500 border-sky-500/30',
    badgeText: 'TG',
    icon: <Send className="h-5 w-5" />,
    buildUrl: ({ title, text, url }) => {
      const caption = [title, text].filter(Boolean).join(' — ');
      return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(caption)}`;
    },
  },
  {
    id: 'x',
    name: 'X (Twitter)',
    badgeBg: 'bg-zinc-500/15 text-foreground border-zinc-500/30',
    badgeText: 'X',
    icon: <span className="text-base font-bold leading-none">𝕏</span>,
    buildUrl: ({ title, text, url }) => {
      const tweet = [title, text].filter(Boolean).join(' — ').slice(0, 220);
      return `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(url)}`;
    },
  },
  {
    id: 'facebook',
    name: 'Facebook',
    badgeBg: 'bg-blue-600/15 text-blue-500 border-blue-500/30',
    badgeText: 'FB',
    icon: <span className="text-base font-bold leading-none">f</span>,
    buildUrl: ({ title, text, url }) => {
      const quote = [title, text].filter(Boolean).join(' — ');
      return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(quote)}`;
    },
  },
  {
    id: 'sms',
    name: 'Messages',
    badgeBg: 'bg-green-500/15 text-green-500 border-green-500/30',
    badgeText: 'SMS',
    icon: <MessageSquare className="h-5 w-5" />,
    buildUrl: ({ title, text, url }) => {
      const body = [title, text, url].filter(Boolean).join('\n');
      return `sms:?&body=${encodeURIComponent(body)}`;
    },
  },
  {
    id: 'snapchat',
    name: 'Snapchat',
    badgeBg: 'bg-yellow-500/15 text-yellow-500 border-yellow-500/30',
    badgeText: 'SC',
    icon: <Sparkles className="h-5 w-5" />,
    buildUrl: ({ url }) =>
      `https://www.snapchat.com/scan?attachmentUrl=${encodeURIComponent(url)}`,
  },
  {
    id: 'reddit',
    name: 'Reddit',
    badgeBg: 'bg-orange-500/15 text-orange-500 border-orange-500/30',
    badgeText: 'RD',
    icon: <ExternalLink className="h-5 w-5" />,
    buildUrl: ({ title, url }) =>
      `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`,
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    badgeBg: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    badgeText: 'in',
    icon: <span className="text-sm font-bold leading-none">in</span>,
    buildUrl: ({ url }) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    id: 'email',
    name: 'Email',
    badgeBg: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
    badgeText: 'Mail',
    icon: <Mail className="h-5 w-5" />,
    buildUrl: ({ title, text, url }) => {
      const body = [text, url].filter(Boolean).join('\n\n');
      return `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    },
  },
  {
    id: 'system',
    name: 'More apps',
    badgeBg: 'bg-primary/15 text-primary border-primary/30',
    badgeText: 'OS',
    icon: <Smartphone className="h-5 w-5" />,
    action: async ({ title, text, url }) => {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        try {
          await navigator.share({ title, text: text || title, url });
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') {
            showError('Device share menu is not available on this browser.');
          }
        }
      } else {
        showError('Device share menu is not supported by this browser — choose a platform above.');
      }
    },
  },
];

const ShareSheet: React.FC = () => {
  const [payload, setPayload] = useState<Required<SharePayload> | null>(null);
  const [copied, setCopied] = useState(false);
  const [usageTick, setUsageTick] = useState(0);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<Required<SharePayload>>).detail;
      if (!detail) return;
      setCopied(false);
      setUsageTick((n) => n + 1);
      setPayload({
        title: String(detail.title || 'Check this out on Equyvo').trim(),
        text: String(detail.text || '').trim(),
        url: String(detail.url || window.location.href).trim(),
      });
    };
    window.addEventListener(SHARE_SHEET_EVENT, onOpen as EventListener);
    return () => window.removeEventListener(SHARE_SHEET_EVENT, onOpen as EventListener);
  }, []);

  useEffect(() => {
    if (!payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPayload(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [payload]);

  const sortedPlatforms = useMemo(() => {
    const usage = getSharePlatformUsage();
    const canNativeShare =
      typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const list = PLATFORMS.filter((p) => (p.id === 'system' ? canNativeShare : true));
    return [...list].sort((a, b) => {
      const ua = usage[a.id];
      const ub = usage[b.id];
      const aLast = Number(ua?.lastUsedAt || 0);
      const bLast = Number(ub?.lastUsedAt || 0);
      if (aLast !== bLast) return bLast - aLast;
      const aCount = Number(ua?.count || 0);
      const bCount = Number(ub?.count || 0);
      if (aCount !== bCount) return bCount - aCount;
      return DEFAULT_ORDER.indexOf(a.id) - DEFAULT_ORDER.indexOf(b.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageTick, payload]);

  if (!payload) return null;

  const usage = getSharePlatformUsage();

  const handleSelectPlatform = async (platform: SharePlatformOption) => {
    recordSharePlatformUsage(platform.id);
    setUsageTick((n) => n + 1);
    const current = payload;
    if (platform.action) {
      await platform.action(current);
      setPayload(null);
      return;
    }
    if (platform.buildUrl) {
      const targetUrl = platform.buildUrl(current);
      if (targetUrl.startsWith('mailto:') || targetUrl.startsWith('sms:')) {
        window.location.href = targetUrl;
      } else {
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
      }
      setPayload(null);
    }
  };

  const handleCopyExplicit = async () => {
    recordSharePlatformUsage('copy');
    try {
      await navigator.clipboard.writeText(payload.url);
      setCopied(true);
      showSuccess('Link copied to clipboard!');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = payload.url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopied(true);
        showSuccess('Link copied to clipboard!');
      } catch {
        showError("Couldn't copy the link.");
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[140] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Share options"
      onClick={() => setPayload(null)}
    >
      <div
        className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border bg-card text-card-foreground shadow-2xl p-4 sm:p-5 animate-in slide-in-from-bottom-4 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary shrink-0" />
              <h3 className="text-base font-semibold">Share to platform</h3>
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {payload.title}
              {payload.text ? ` · ${payload.text}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPayload(null)}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label="Close share options"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-[11px] text-muted-foreground mb-2.5">
          Ordered by your recent platform usage
        </p>

        <div className="grid grid-cols-4 sm:grid-cols-5 gap-2.5 mb-4">
          {sortedPlatforms.map((platform, idx) => {
            const isRecent = Number(usage[platform.id]?.lastUsedAt || 0) > 0 && idx < 3;
            return (
              <button
                key={platform.id}
                type="button"
                onClick={() => void handleSelectPlatform(platform)}
                className="group relative flex flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-background/60 p-2.5 text-center transition hover:border-primary/50 hover:bg-secondary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {isRecent && (
                  <span className="absolute -top-1.5 right-1 rounded-full bg-primary px-1.5 py-0.2 text-[9px] font-semibold text-primary-foreground">
                    Recent
                  </span>
                )}
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-full border ${platform.badgeBg}`}
                >
                  {platform.icon}
                </div>
                <span className="text-[11px] font-medium leading-tight line-clamp-1">
                  {platform.name}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 rounded-xl border bg-muted/40 p-2">
          <div className="min-w-0 flex-1 px-2 text-xs text-muted-foreground truncate">
            {payload.url}
          </div>
          <Button
            type="button"
            size="sm"
            variant={copied ? 'secondary' : 'outline'}
            onClick={() => void handleCopyExplicit()}
            className="shrink-0 gap-1.5 text-xs"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy link
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ShareSheet;
