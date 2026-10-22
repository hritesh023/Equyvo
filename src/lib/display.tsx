// ---------------------------------------------------------------------------
// Equyvo display engine: app-wide text scale + deliberate pinch zoom.
//
// • Text scale (0.8–1.6): sets the document root font-size so every rem-based
//   UI constant (bars, cards, inputs) scales together. Persisted instantly.
// • Pinch zoom (0.5–3): applied as CSS `zoom` from the --equyvo-app-zoom var
//   so the WHOLE app layout scales (not only text). The viewport meta has
//   user-scalable=no, so browser-native pinch is disabled — this engine IS
//   the pinch experience:
//     – requires TWO pointers (a single-finger scroll can never zoom);
//     – anti-mistouch ON → zoom only starts after a sustained, moving
//       two-finger contact (>=120ms dwell AND >=20px of clear pinch span),
//       so casual/accidental touches never scale the layout;
//     – anti-mistouch OFF → a light two-finger pinch responds immediately.
// • Desktop deliberate equivalents: Ctrl/Cmd + mouse wheel scales too.
// • Everything is applied synchronously at startup (module import), so the
//   chosen text size/zoom is already in place before the first frame.
// ---------------------------------------------------------------------------

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export const FONT_SCALE_KEY = 'equyvo_font_scale';
export const ZOOM_SCALE_KEY = 'equyvo_zoom_scale';
export const PINCH_ENABLED_KEY = 'equyvo_pinch_zoom';
export const ANTI_MISTOUCH_KEY = 'equyvo_pinch_antimistouch';

export const FONT_MIN = 0.8;
export const FONT_MAX = 1.6;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

function readNumKey(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch { /* ignore */ }
  return fallback;
}

function readFlagKey(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* ignore */ }
  return fallback;
}

/** Push the persisted display state into the document (before first paint). */
function applyFontScale(scale: number) {
  try {
    document.documentElement.style.fontSize = `${(16 * clamp(round2(scale), FONT_MIN, FONT_MAX)).toFixed(2)}px`;
  } catch { /* ignore */ }
}

function applyAppZoom(zoom: number) {
  try {
    const z = clamp(round2(zoom), ZOOM_MIN, ZOOM_MAX);
    document.documentElement.style.setProperty('--equyvo-app-zoom', String(z));
    // 1/z as a separate var so CSS can compensate native strips (the AdMob
    // banner reserve) with universally-supported calc multiplication.
    document.documentElement.style.setProperty('--equyvo-app-zoom-inverse', (1 / z).toFixed(4));
  } catch { /* ignore */ }
}

// Synchronous startup application — runs as soon as this module is imported.
const INITIAL_FONT = clamp(round2(readNumKey(FONT_SCALE_KEY, 1)), FONT_MIN, FONT_MAX);
const INITIAL_ZOOM = clamp(round2(readNumKey(ZOOM_SCALE_KEY, 1)), ZOOM_MIN, ZOOM_MAX);
try {
  applyFontScale(INITIAL_FONT);
  applyAppZoom(INITIAL_ZOOM);
} catch { /* ignore */ }

export interface DisplayContextValue {
  fontScale: number;
  setFontScale: (n: number) => void;
  zoom: number;
  setZoom: (n: number) => void;
  pinchOn: boolean;
  setPinchOn: (b: boolean) => void;
  antiMistouch: boolean;
  setAntiMistouch: (b: boolean) => void;
  resetDisplay: () => void;
}

const DisplayContext = createContext<DisplayContextValue>({
  fontScale: 1,
  setFontScale: () => { /* provider not mounted */ },
  zoom: 1,
  setZoom: () => { /* provider not mounted */ },
  pinchOn: true,
  setPinchOn: () => { /* provider not mounted */ },
  antiMistouch: true,
  setAntiMistouch: () => { /* provider not mounted */ },
  resetDisplay: () => { /* provider not mounted */ },
});

export const useDisplay = () => useContext(DisplayContext);

export const DisplayProvider = ({ children }: { children: React.ReactNode }) => {
  const [fontScale, setFontScaleState] = useState(INITIAL_FONT);
  const [zoom, setZoomState] = useState(INITIAL_ZOOM);
  const [pinchOn, setPinchOnState] = useState(readFlagKey(PINCH_ENABLED_KEY, true));
  const [antiMistouch, setAntiMistouchState] = useState(readFlagKey(ANTI_MISTOUCH_KEY, true));

  // Live refs so the touch listeners never need re-binding.
  const fontRef = useRef(fontScale);
  fontRef.current = fontScale;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pinchOnRef = useRef(pinchOn);
  pinchOnRef.current = pinchOn;
  const antiRef = useRef(antiMistouch);
  antiRef.current = antiMistouch;

  const setFontScale = useCallback((n: number) => {
    const next = clamp(round2(n), FONT_MIN, FONT_MAX);
    setFontScaleState(next);
    applyFontScale(next);
    try { localStorage.setItem(FONT_SCALE_KEY, String(next)); } catch { /* ignore */ }
  }, []);

  // Zoom changes are batched during a live gesture — write DOM immediately,
  // commit React state + storage debounced.
  const zoomSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitZoom = useCallback((next: number, immediate: boolean) => {
    const v = clamp(round2(next), ZOOM_MIN, ZOOM_MAX);
    zoomRef.current = v;
    applyAppZoom(v);
    if (immediate) {
      setZoomState(v);
      try { localStorage.setItem(ZOOM_SCALE_KEY, String(v)); } catch { /* ignore */ }
      return;
    }
    if (zoomSaveTimer.current) clearTimeout(zoomSaveTimer.current);
    zoomSaveTimer.current = setTimeout(() => {
      setZoomState(zoomRef.current);
      try { localStorage.setItem(ZOOM_SCALE_KEY, String(zoomRef.current)); } catch { /* ignore */ }
    }, 250);
  }, []);

  const setZoom = useCallback((n: number) => commitZoom(n, true), [commitZoom]);

  const setPinchOn = useCallback((b: boolean) => {
    setPinchOnState(b);
    try { localStorage.setItem(PINCH_ENABLED_KEY, b ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  const setAntiMistouch = useCallback((b: boolean) => {
    setAntiMistouchState(b);
    try { localStorage.setItem(ANTI_MISTOUCH_KEY, b ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  const resetDisplay = useCallback(() => {
    setFontScale(1);
    commitZoom(1, true);
  }, [setFontScale, commitZoom]);

  // ── The pinch engine ───────────────────────────────────────────────────────
  // Bound once; every decision reads the live refs above.
  useEffect(() => {
    if (typeof window === 'undefined' || !('addEventListener' in window)) return;
    let touching = false;
    let magnify = false;
    let startDist = 0;
    let anchorDist = 0;
    let anchorZoom = 1;
    let startAt = 0;
    let maxDelta = 0;

    const spanOf = (t0: Touch, t1: Touch): number => {
      const dx = t1.clientX - t0.clientX;
      const dy = t1.clientY - t0.clientY;
      return Math.hypot(dx, dy);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2 && pinchOnRef.current) {
        touching = true;
        magnify = false;
        startAt = Date.now();
        maxDelta = 0;
        startDist = spanOf(e.touches[0], e.touches[1]);
        anchorDist = startDist;
        anchorZoom = zoomRef.current;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touching || e.touches.length < 2) return;
      const d = spanOf(e.touches[0], e.touches[1]);
      maxDelta = Math.max(maxDelta, Math.abs(d - startDist));
      const dwellMs = Date.now() - startAt;
      if (!magnify) {
        // Deliberate-pinch gate: sustained contact + clear span before zoom.
        const needDwell = antiRef.current ? 120 : 0;
        const needSpan = antiRef.current ? 20 : 6;
        if (d < 24) {
          // Fingers landing on/over the same spot — treated as a tap cluster.
          startAt = Date.now();
          return;
        }
        if (dwellMs >= needDwell && maxDelta >= needSpan) {
          magnify = true;
          anchorDist = d;
          anchorZoom = zoomRef.current;
        }
        if (!magnify) return;
      }
      // Magnifying: hold page scrolling for the whole gesture.
      if (e.cancelable) e.preventDefault();
      if (anchorDist > 12) {
        commitZoom(anchorZoom * (d / anchorDist), false);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        // Suppress the synthetic tap that would land where the pinch just was.
        if (magnify && e.cancelable) e.preventDefault();
        touching = false;
        magnify = false;
        commitZoom(zoomRef.current, false); // flush debounced persist/state
      }
    };

    // Deliberate desktop equivalent: Ctrl/Cmd + wheel.
    const onWheel = (e: WheelEvent) => {
      if (!pinchOnRef.current) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.cancelable) e.preventDefault();
        const factor = Math.exp(-e.deltaY / 300);
        commitZoom(zoomRef.current * factor, false);
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('touchcancel', onTouchEnd, { passive: false });
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('wheel', onWheel);
    };
  }, [commitZoom]);

  // Cross-tab sync: another tab's Settings change applies here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === FONT_SCALE_KEY && e.newValue) setFontScaleState(clamp(parseFloat(e.newValue) || 1, FONT_MIN, FONT_MAX));
      if (e.key === ZOOM_SCALE_KEY && e.newValue) {
        const v = clamp(parseFloat(e.newValue) || 1, ZOOM_MIN, ZOOM_MAX);
        zoomRef.current = v;
        applyAppZoom(v);
        setZoomState(v);
      }
      if (e.key === PINCH_ENABLED_KEY) setPinchOnState(e.newValue === '1');
      if (e.key === ANTI_MISTOUCH_KEY) setAntiMistouchState(e.newValue === '1');
    };
    try { window.addEventListener('storage', onStorage); } catch { /* ignore */ }
    return () => { try { window.removeEventListener('storage', onStorage); } catch { /* ignore */ } };
  }, []);

  const value = useMemo<DisplayContextValue>(() => ({
    fontScale, setFontScale, zoom, setZoom, pinchOn, setPinchOn, antiMistouch, setAntiMistouch, resetDisplay,
  }), [
    fontScale, setFontScale, zoom, setZoom, pinchOn, setPinchOn, antiMistouch, setAntiMistouch, resetDisplay,
  ]);

  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
};

export default DisplayProvider;
