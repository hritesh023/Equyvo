import React, { useCallback, useEffect, useRef, useState } from 'react';

interface VideoSeekBarProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
  className?: string;
  compact?: boolean;
}

function formatTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) return '0:00';
  const m = Math.floor(time / 60);
  const s = Math.floor(time % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * YouTube-style seek bar: hovering / dragging over the bar shows a small
 * floating preview window above the pointer with the timestamp and a live
 * frame thumbnail of that moment.
 */
const VideoSeekBar: React.FC<VideoSeekBarProps> = ({
  videoRef,
  currentTime,
  duration,
  onSeek,
  className = '',
  compact = false,
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0);
  const [previewUrl, setPreviewUrl] = useState('');
  const [scrubbing, setScrubbing] = useState(false);
  const [barWidth, setBarWidth] = useState(0);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const progress = safeDuration > 0 ? Math.min(100, Math.max(0, (currentTime / safeDuration) * 100)) : 0;

  // Keep an offscreen video element in sync with the main source for thumbnails.
  useEffect(() => {
    const src = videoRef.current?.currentSrc || videoRef.current?.src || '';
    if (!src) return;
    try {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.src = src;
      previewVideoRef.current = v;
      if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
      return () => {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch {
          /* ignore */
        }
        if (previewVideoRef.current === v) previewVideoRef.current = null;
      };
    } catch {
      return;
    }
  }, [videoRef.current?.currentSrc, videoRef.current?.src]);

  useEffect(() => {
    const measure = () => {
      if (barRef.current) setBarWidth(barRef.current.getBoundingClientRect().width);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  const captureFrame = useCallback((time: number) => {
    const pv = previewVideoRef.current;
    const canvas = canvasRef.current;
    if (!pv || !canvas) return;
    try {
      const doCapture = () => {
        try {
          const w = 160;
          const vw = pv.videoWidth || 160;
          const vh = pv.videoHeight || 90;
          const h = Math.round((w * vh) / Math.max(1, vw));
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(pv, 0, 0, w, h);
          setPreviewUrl(canvas.toDataURL('image/jpeg', 0.6));
        } catch {
          /* frame not readable (protected) — time bubble still shows */
        }
      };
      const onSeeked = () => {
        doCapture();
        pv.removeEventListener('seeked', onSeeked);
      };
      pv.addEventListener('seeked', onSeeked);
      try {
        pv.currentTime = Math.min(Math.max(0, time), Math.max(0, (pv.duration || safeDuration) - 0.1));
      } catch {
        pv.removeEventListener('seeked', onSeeked);
      }
      if (seekTimer.current) clearTimeout(seekTimer.current);
      seekTimer.current = setTimeout(() => {
        try {
          pv.removeEventListener('seeked', onSeeked);
        } catch {
          /* ignore */
        }
      }, 1500);
    } catch {
      /* ignore */
    }
  }, [safeDuration]);

  const timeFromClientX = useCallback(
    (clientX: number): { time: number; x: number } => {
      const el = barRef.current;
      if (!el || !safeDuration) return { time: 0, x: 0 };
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
      const ratio = rect.width > 0 ? x / rect.width : 0;
      return { time: ratio * safeDuration, x };
    },
    [safeDuration],
  );

  const handleMove = useCallback(
    (clientX: number) => {
      if (!safeDuration) return;
      const { time, x } = timeFromClientX(clientX);
      setHoverTime(time);
      setHoverX(x);
      captureFrame(time);
      if (scrubbing) onSeek(time);
    },
    [captureFrame, onSeek, safeDuration, scrubbing, timeFromClientX],
  );

  const commitSeek = useCallback(
    (clientX: number) => {
      if (!safeDuration) return;
      const { time } = timeFromClientX(clientX);
      onSeek(time);
    },
    [onSeek, safeDuration, timeFromClientX],
  );

  useEffect(() => {
    if (!scrubbing) return;
    const up = () => setScrubbing(false);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [scrubbing]);

  useEffect(() => {
    return () => {
      if (seekTimer.current) clearTimeout(seekTimer.current);
    };
  }, []);

  const previewLeft = Math.min(Math.max(hoverX, 68), Math.max(68, barWidth - 68));
  const hoverProgress = hoverTime != null && safeDuration > 0 ? (hoverTime / safeDuration) * 100 : 0;

  return (
    <div className={`select-none ${className}`}>
      {/* Floating preview window */}
      {hoverTime != null && safeDuration > 0 && (
        <div
          className="pointer-events-none absolute z-40 -translate-x-1/2"
          style={{ left: previewLeft, bottom: compact ? 26 : 34 }}
        >
          <div className="overflow-hidden rounded-lg border border-white/20 bg-black/90 shadow-xl backdrop-blur-sm">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={`Preview at ${formatTime(hoverTime)}`}
                className="h-[63px] w-[112px] object-cover"
                draggable={false}
              />
            ) : (
              <div className="flex h-[63px] w-[112px] items-center justify-center bg-gradient-to-br from-zinc-700 to-zinc-900">
                <span className="text-xs font-medium text-white/80">{formatTime(hoverTime)}</span>
              </div>
            )}
            <div className="bg-black/80 px-2 py-1 text-center text-[11px] font-semibold tabular-nums text-white">
              {formatTime(hoverTime)}
            </div>
          </div>
          <div className="mx-auto h-2 w-px bg-white/70" />
        </div>
      )}

      <div className="flex items-center gap-2">
        {!compact && (
          <span className="min-w-[38px] text-right text-[11px] font-medium tabular-nums text-white/85">
            {formatTime(currentTime)}
          </span>
        )}
        <div
          ref={barRef}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(safeDuration)}
          aria-valuenow={Math.round(currentTime)}
          tabIndex={0}
          className="group relative flex h-5 flex-1 cursor-pointer touch-none items-center"
          onPointerDown={(e) => {
            try {
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            } catch {
              /* ignore */
            }
            setScrubbing(true);
            handleMove(e.clientX);
            commitSeek(e.clientX);
          }}
          onPointerMove={(e) => {
            handleMove(e.clientX);
          }}
          onPointerLeave={() => {
            if (!scrubbing) {
              setHoverTime(null);
              setPreviewUrl('');
            }
          }}
          onPointerUp={(e) => {
            commitSeek(e.clientX);
            setScrubbing(false);
          }}
          onKeyDown={(e) => {
            if (!safeDuration) return;
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              onSeek(Math.max(0, currentTime - 5));
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              onSeek(Math.min(safeDuration, currentTime + 5));
            } else if (e.key === 'Home') {
              e.preventDefault();
              onSeek(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              onSeek(safeDuration);
            }
          }}
        >
          <div className="relative h-1 w-full overflow-visible rounded-full bg-white/25 transition-all group-hover:h-1.5">
            {/* Hover ghost */}
            {hoverTime != null && (
              <div
                className="absolute left-0 top-0 h-full rounded-full bg-white/40"
                style={{ width: `${hoverProgress}%` }}
              />
            )}
            {/* Played */}
            <div
              className="absolute left-0 top-0 h-full rounded-full bg-white"
              style={{ width: `${progress}%` }}
            />
            {/* Knob */}
            <div
              className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md transition-opacity ${
                scrubbing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              }`}
              style={{ left: `${progress}%` }}
            />
            {/* Hover dot */}
            {hoverTime != null && !scrubbing && (
              <div
                className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80"
                style={{ left: `${hoverProgress}%` }}
              />
            )}
          </div>
        </div>
        {!compact && (
          <span className="min-w-[38px] text-[11px] font-medium tabular-nums text-white/70">
            {formatTime(safeDuration)}
          </span>
        )}
      </div>
    </div>
  );
};

export default VideoSeekBar;
