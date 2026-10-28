/**
 * Resilient media elements.
 *
 * Uploaded content (videos / photos / GIFs, small to multi-GB Vlogs) streams
 * from the same-origin Range-aware media proxy. Flaky mobile networks,
 * paused 百分 ranges and cold R2 workers can make ONE load attempt fail even
 * though the asset is perfectly fine. The old code silently hid the element
 * on error (`onError={hideBrokenImage}`), which looked exactly like "the
 * content is not rendering".
 *
 * These wrappers retry:
 *  1. again directly (some connectors race the first request),
 *  2. after a backoff pause,
 *  3. with a single cache-bust query param (in case a broken edge cache),
 *  4. then fall back to the poster/thumbnail for images,
 * and only when every attempt fails do they show a friendly placeholder.
 * `loading="lazy"` + `decoding="async"` keep feeds with hundreds of items
 * smooth, and `<video>` only mounts its media when it scrolls into view so
 * very large files never stall the feed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

type MediaReferrerPolicy = 'no-referrer' | 'no-referrer-when-downgrade' | 'origin' | 'origin-when-cross-origin' | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | 'unsafe-url';

export interface ResilientImageProps {
  src?: string;
  /** Lower-res fallback used when `src` fails all retries (e.g. video poster). */
  fallbackSrc?: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
  referrerPolicy?: MediaReferrerPolicy;
  retryLimit?: number;
  /** Shown after every attempt failed (default: neutral dashed frame). */
  fallbackRenderer?: React.ReactNode;
}

const RETRY_LIMIT_DEFAULT = 2;

export const ResilientImage: React.FC<ResilientImageProps> = ({
  src,
  fallbackSrc,
  alt = 'Content',
  className = '',
  style,
  onClick,
  loading = 'lazy',
  decoding = 'async',
  referrerPolicy = 'no-referrer',
  retryLimit = RETRY_LIMIT_DEFAULT,
  fallbackRenderer,
}) => {
  const raw = String(src || '').trim();
  const fallbackRaw = String(fallbackSrc || '').trim() || raw;

  // Current URL + retry counter. Reset when the item points at new media.
  const [current, setCurrent] = useState(raw || fallbackRaw);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'failed'>(raw ? 'loading' : 'failed');
  const [usedFallback, setUsedFallback] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    setUsedFallback(false);
    setAttempt(0);
    setPhase(raw || fallbackRaw ? 'loading' : 'failed');
    setCurrent(raw || fallbackRaw);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [raw, fallbackRaw]);

  const handleError = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    const srcForAttempt = usedFallback || !raw ? fallbackRaw : raw;
    const canRetrySources = raw && fallbackRaw && !usedFallback && raw !== fallbackRaw;
    const canRetry = attempt < retryLimit;

    if (canRetrySources && (phase === 'failed' || attempt >= Math.max(1, retryLimit - 1))) {
      // Direct + cache-bust attempts on the main URL failed too — try the
      // alternate source (thumbnail / optimized variant).
      setCurrent(`${fallbackRaw}${fallbackRaw.includes('?') ? '&' : '?'}retry=${attempt + 1}`);
      setUsedFallback(true);
      setAttempt(a => a + 1);
      return;
    }
    if (canRetry) {
      // Same URL again — instant first, then with a cache-bust + backoff.
      const bust = attempt > 0;
      const next = bust
        ? `${srcForAttempt}${srcForAttempt.includes('?') ? '&' : '?'}retry=${attempt + 1}`
        : srcForAttempt;
      const delay = attempt === 0 ? 250 : 800 * attempt;
      timerRef.current = window.setTimeout(() => {
        setAttempt(a => a + 1);
        setCurrent(next);
      }, attempt === 0 ? 0 : delay);
      if (attempt === 0) {
        // Zero-delay immediate re-mount of the element (same tick).
        setPhase('loading');
        return;
      }
      setPhase('loading');
      return;
    }
    setPhase('failed');
  }, [attempt, fallbackRaw, phase, raw, retryLimit, usedFallback]);

  if (!raw && !fallbackRaw) {
    return (
      <div className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {fallbackRenderer ?? (
          <span className="text-muted-foreground text-sm">No media attached</span>
        )}
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className={`${className} flex items-center justify-center`} style={style}>
        {fallbackRenderer ?? (
          <span className="text-muted-foreground text-xs text-center px-3" role="status">
            Couldn't load this media. Pull to refresh or tap again.
            <button
              type="button"
              className="block mx-auto mt-1 text-primary underline underline-offset-2"
              onClick={() => {
                setUsedFallback(false);
                setAttempt(0);
                setPhase('loading');
                setCurrent(`${raw || fallbackRaw}${(raw || fallbackRaw).includes('?') ? '&' : '?'}retry=manual`);
              }}
            >
              Retry
            </button>
          </span>
        )}
      </div>
    );
  }

  return (
    <img
      key={`${current}#${attempt}`}
      src={current}
      alt={alt}
      className={className}
      style={style}
      onClick={onClick}
      loading={loading}
      decoding={decoding}
      referrerPolicy={referrerPolicy}
      onError={handleError}
      onLoad={() => setPhase('ok')}
    />
  );
};

export default ResilientImage;
