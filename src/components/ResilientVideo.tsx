/**
 * Resilient, lazy video element for feeds.
 *
 * Videos (from short moments to very large recorded vlogs) stream through the
 * same-origin Range-aware proxy. Crashes of old code:
 *   • mounted EVERY `<video preload="auto">` at once → feed froze / never
 *     painted on slow mobile networks with large files,
 *   • one failed range request left a permanent black box.
 *
 * This element:
 *   • mounts/streams only when scrolled into view (IntersectionObserver),
 *   • keeps `preload="metadata"` so seek and duration work with almost no
 *     bytes wasted on huge files,
 *   • retries transient network errors (direct → cache-bust → backoff),
 *   • reports the failure to the caller but NEVER re-renders forever.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

export interface ResilientVideoProps {
  src?: string;
  poster?: string;
  className?: string;
  style?: React.CSSProperties;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  controls?: boolean;
  playsInline?: boolean;
  preload?: 'auto' | 'metadata' | 'none';
  retryLimit?: number;
  onEnded?: React.ReactEventHandler<HTMLVideoElement>;
  onLoadedMetadata?: React.ReactEventHandler<HTMLVideoElement>;
  onTimeUpdate?: React.ReactEventHandler<HTMLVideoElement>;
  onSeeked?: React.ReactEventHandler<HTMLVideoElement>;
  onError?: () => void;
  onClick?: React.MouseEventHandler<HTMLVideoElement>;
  refFactory?: (el: HTMLVideoElement | null) => void;
  /** Error slot when every retry failed (default: minimal white text). */
  fallbackRenderer?: React.ReactNode;
}

export const ResilientVideo: React.FC<ResilientVideoProps> = ({
  src,
  poster,
  className = '',
  style,
  autoPlay = false,
  muted = false,
  loop = false,
  controls = false,
  playsInline = true,
  preload = 'metadata',
  retryLimit = 2,
  onEnded,
  onLoadedMetadata,
  onTimeUpdate,
  onSeeked,
  onError,
  onClick,
  refFactory,
  fallbackRenderer,
}) => {
  const raw = String(src || '').trim();
  const uid = useId();
  const holderRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setNearViewport(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(holder);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, []);

  useEffect(() => {
    setFailed(0);
    setAttempt(0);
  }, [raw]);

  const handleError = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    onError?.();
    if (failed >= retryLimit + 1) return; // give up quietly
    const bust = failed > 0;
    const nextSrc = bust
      ? `${raw}${raw.includes('?') ? '&' : '?'}retry=${failed + 1}`
      : raw;
    const delay = failed === 0 ? 200 : 900 * failed;
    timerRef.current = window.setTimeout(() => {
      setFailed(f => f + 1);
      setAttempt(a => a + 1);
      // Re-mount by swapping the src through the element attribute.
      const holder = holderRef.current;
      const video = holder?.querySelector('video');
      if (video) video.src = nextSrc;
    }, delay);
  }, [failed, onError, raw, retryLimit]);

  if (!raw) {
    return (
      <div className={`${className} flex items-center justify-center bg-black/40`} style={style}>
        {fallbackRenderer ?? <span className="text-muted-foreground text-xs px-2 text-center">No video attached</span>}
      </div>
    );
  }

  return (
    <div ref={holderRef} className="contents" data-video-src-key={raw}>
      {failed > retryLimit ? (
        <div className={className} style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {fallbackRenderer ?? (
            <span className="text-muted-foreground text-xs px-3 text-center" role="status">
              Video could not stream. Tap to retry.
              <button
                type="button"
                className="block mx-auto mt-1 text-primary underline underline-offset-2"
                onClick={() => { setFailed(0); setAttempt(a => a + 1); }}
              >
                Retry
              </button>
            </span>
          )}
        </div>
      ) : (
        <video
          key={`${uid}#${attempt}`}
          ref={refFactory}
          src={nearViewport ? raw : undefined}
          poster={poster || undefined}
          autoPlay={nearViewport ? autoPlay : false}
          muted={muted}
          loop={loop}
          controls={controls}
          playsInline={playsInline}
          preload={preload}
          className={className}
          style={style}
          onEnded={onEnded}
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onSeeked={onSeeked}
          onError={handleError}
          onClick={onClick}
          aria-label={poster ? undefined : 'Video content'}
          data-attempt={attempt}
        />
      )}
    </div>
  );
};

export default ResilientVideo;
