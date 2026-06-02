import { useRef, useCallback } from 'react';

interface UseVideoGesturesOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  seekTime?: number;
  onSingleTap?: () => void;
  enabled?: boolean;
}

export function useVideoGestures({
  videoRef,
  seekTime = 10,
  onSingleTap,
  enabled = true,
}: UseVideoGesturesOptions) {
  const dblClickFlag = useRef(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!enabled) return;
    if (dblClickFlag.current) {
      dblClickFlag.current = false;
      return;
    }
    onSingleTap?.();
  }, [enabled, onSingleTap]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!enabled) return;
    dblClickFlag.current = true;

    const video = videoRef.current;
    if (!video) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x > rect.width / 2) {
      video.currentTime = Math.min(video.duration || Infinity, video.currentTime + seekTime);
    } else {
      video.currentTime = Math.max(0, video.currentTime - seekTime);
    }
  }, [enabled, videoRef, seekTime]);

  return { handleClick, handleDoubleClick };
}
