import { useRef, useCallback, useEffect } from 'react';

interface UseVideoGesturesOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  seekTime?: number;
  onSingleTap?: () => void;
  enabled?: boolean;
  /** Invert left/right seek (e.g. rotated/expanded landscape). */
  invert?: boolean;
}

export function useVideoGestures({
  videoRef,
  seekTime = 10,
  onSingleTap,
  enabled = true,
  invert = false,
}: UseVideoGesturesOptions) {
  const lastTapRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!enabled) return;

    const now = Date.now();
    const timeSinceLastTap = now - lastTapRef.current;
    lastTapRef.current = now;

    if (timeSinceLastTap < 400) {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }

      const video = videoRef.current;
      if (!video) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const isRight = x > rect.width / 2;
      const goForward = invert ? !isRight : isRight;
      if (goForward) {
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + seekTime);
      } else {
        video.currentTime = Math.max(0, video.currentTime - seekTime);
      }
      return;
    }

    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      onSingleTap?.();
    }, 400);
  }, [enabled, videoRef, seekTime, onSingleTap, invert]);

  useEffect(() => {
    return () => {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
      }
    };
  }, []);

  return { handleClick };
}
