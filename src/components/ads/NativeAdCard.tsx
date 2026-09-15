import React, { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ExternalLink, Info, MoreHorizontal, Star, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  canCountImpression,
  housePromoAd,
  loadNativeAd,
  type NativeAdData,
} from '@/lib/admob-service';

interface NativeAdCardProps {
  placement: string;
  compact?: boolean;
  className?: string;
}

const DISMISS_KEY = 'equyvo_dismissed_ads';

/**
 * Native Advanced ad rendered as a quiet in-feed card.
 * - Looks like a normal post (no flashing, no autoplay, no sound).
 * - Always labelled "Sponsored" + AdChoices info.
 * - Dismissible; dismissal persists for the session.
 * - Zero impact on video playback: never overlays a <video>.
 */
const NativeAdCard: React.FC<NativeAdCardProps> = ({
  placement,
  compact = false,
  className = '',
}) => {
  const navigate = useNavigate();
  const [ad, setAd] = useState<NativeAdData | null>(null);
  const [isRealFill, setIsRealFill] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadNativeAd(placement)
      .then((fill) => {
        if (cancelled) return;
        if (fill) {
          setAd(fill);
          setIsRealFill(true);
        } else {
          // Web / no-fill fallback: house promo in the same calm layout.
          setAd(housePromoAd(placement));
          setIsRealFill(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAd(housePromoAd(placement));
          setIsRealFill(false);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [placement]);

  // Count the impression once, respecting the session cooldown.
  useEffect(() => {
    if (!loading && ad && !dismissed) {
      canCountImpression();
    }
  }, [loading, ad, dismissed]);

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      const raw = sessionStorage.getItem(DISMISS_KEY);
      const list: string[] = raw ? JSON.parse(raw) : [];
      list.push(`${placement}:${Date.now()}`);
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify(list.slice(-20)));
    } catch {
      /* ignore */
    }
  };

  const handleCta = () => {
    const url = ad?.clickUrl;
    if (!url) return;
    if (url.startsWith('/')) {
      navigate(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  if (loading || !ad) {
    return (
      <Card className={`overflow-hidden ${className}`} aria-label="Loading sponsored content">
        <CardContent className="p-4">
          <div className="flex items-center gap-3 animate-pulse">
            <div className="h-10 w-10 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
            </div>
          </div>
          <div className="mt-4 h-24 rounded-lg bg-muted animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={`overflow-hidden border-dashed ${className}`}
      aria-label={`Sponsored content from ${ad.advertiser ?? 'sponsor'}`}
    >
      <CardContent className="p-4">
        {/* Header: advertiser + Sponsored label + controls */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar className="h-10 w-10 shrink-0">
              <AvatarImage src={ad.iconUrl} alt="" />
              <AvatarFallback>
                {(ad.advertiser ?? 'Ad').substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {ad.advertiser ?? 'Sponsored'}
              </p>
              <div className="flex items-center gap-1.5">
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-semibold tracking-wide">
                  {isRealFill ? 'SPONSORED' : 'PROMOTED'}
                </Badge>
                <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                  <Info className="h-3 w-3" />
                  AdChoices
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Ad options">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  onClick={() =>
                    window.open(
                      'https://adssettings.google.com',
                      '_blank',
                      'noopener,noreferrer',
                    )
                  }
                >
                  Why am I seeing this ad?
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/settings')}>
                  Ad preferences
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => navigate('/pricing')}>
                  Go ad-free with Premium
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDismiss} className="text-destructive">
                  Hide this ad
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={handleDismiss}
              aria-label="Dismiss ad"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="mt-3">
          <p className="text-sm font-medium leading-snug">{ad.headline}</p>
          {ad.body && (
            <p className="mt-1 text-sm text-muted-foreground leading-relaxed">
              {ad.body}
            </p>
          )}
        </div>

        {/* Creative (static image only — never autoplay video) */}
        {ad.imageUrl && !compact && (
          <div className="mt-3 overflow-hidden rounded-lg bg-muted">
            <img
              src={ad.imageUrl}
              alt=""
              loading="lazy"
              className="max-h-64 w-full object-cover"
            />
          </div>
        )}

        {/* Footer: rating + CTA */}
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {typeof ad.starRating === 'number' && (
              <span className="flex items-center gap-1">
                <Star className="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
                {ad.starRating.toFixed(1)}
              </span>
            )}
            {ad.store && <span>{ad.store}</span>}
            {ad.price && <span>{ad.price}</span>}
          </div>
          <Button size="sm" onClick={handleCta} className="shrink-0">
            {ad.callToAction ?? 'Learn more'}
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default NativeAdCard;
