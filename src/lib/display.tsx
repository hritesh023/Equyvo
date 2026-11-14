// ---------------------------------------------------------------------------
// Equyvo display engine: app-wide text scale + focused content pinch zoom.
//
// • Text scale (0.8–1.6): sets the document root font-size so every rem-based
//   UI constant (bars, cards, inputs) scales together. Persisted instantly.
// • Pinch zoom (0.75–2): applied as a transform to the content surface/card
//   under the fingers. The document, navbar, header and fixed controls never
//   scale. The viewport meta has user-scalable=no, so browser-native pinch is
//   disabled — this engine IS the focused pinch experience:
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
export const ZOOM_MIN = 0.75;
export const ZOOM_MAX = 2;

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
    // Keep the legacy variables at neutral values. Older builds applied this
    // value to <html>, which enlarged the navbar/header and caused the whole
    // layout to drift. Focused zoom is now applied directly to a content DOM
    // node by the provider below.
    document.documentElement.style.removeProperty('zoom');
    document.documentElement.style.setProperty('--equyvo-app-zoom', '1');
    document.documentElement.style.setProperty('--equyvo-app-zoom-inverse', '1');
    document.documentElement.style.setProperty('--equyvo-focused-zoom', String(z));
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

type FocusedZoomRecord = {
  transform: string;
  transformOrigin: string;
  willChange: string;
  transition: string;
  scale: number;
  originX: number;
  originY: number;
};

type Point = { x: number; y: number };

function midpointOf(touches: TouchList): Point {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function distanceOf(t0: Touch, t1: Touch): number {
  return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
}

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

  // Each focused card/surface keeps its own transform. This means a pinch
  // never changes the document geometry or the fixed app chrome.
  const focusedTargetsRef = useRef(new Map<HTMLElement, FocusedZoomRecord>());
  const activeTargetRef = useRef<HTMLElement | null>(null);

  const restoreTarget = useCallback((target: HTMLElement, record: FocusedZoomRecord) => {
    target.style.transform = record.transform;
    target.style.transformOrigin = record.transformOrigin;
    target.style.willChange = record.willChange;
    target.style.transition = record.transition;
  }, []);

  const clearFocusedZoom = useCallback(() => {
    focusedTargetsRef.current.forEach((record, target) => restoreTarget(target, record));
    focusedTargetsRef.current.clear();
    activeTargetRef.current = null;
    zoomRef.current = 1;
    applyAppZoom(1);
  }, [restoreTarget]);

  const targetScale = useCallback((target: HTMLElement) => {
    return focusedTargetsRef.current.get(target)?.scale ?? 1;
  }, []);

  const applyFocusedZoom = useCallback((target: HTMLElement, scale: number, origin?: Point) => {
    const bounded = clamp(round2(scale), ZOOM_MIN, ZOOM_MAX);
    let record = focusedTargetsRef.current.get(target);
    if (!record) {
      const rect = target.getBoundingClientRect();
      const x = clamp(origin?.x ?? rect.width / 2, 0, Math.max(rect.width, 1));
      const y = clamp(origin?.y ?? rect.height / 2, 0, Math.max(rect.height, 1));
      record = {
        transform: target.style.transform,
        transformOrigin: target.style.transformOrigin,
        willChange: target.style.willChange,
        transition: target.style.transition,
        scale: 1,
        originX: x,
        originY: y,
      };
      focusedTargetsRef.current.set(target, record);
    } else if (origin) {
      record.originX = origin.x;
      record.originY = origin.y;
    }

    record.scale = bounded;
    target.style.transformOrigin = `${record.originX}px ${record.originY}px`;
    target.style.transform = bounded === 1 ? record.transform : `scale(${bounded})`;
    target.style.willChange = bounded === 1 ? record.willChange : 'transform';
    target.style.transition = bounded === 1 ? record.transition : 'none';
    activeTargetRef.current = target;

    if (bounded === 1) {
      restoreTarget(target, record);
      focusedTargetsRef.current.delete(target);
    }
  }, [restoreTarget]);

  const findZoomTarget = useCallback((x: number, y: number): HTMLElement | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit) return null;
    if (hit.closest('[data-equyvo-no-zoom], nav, header, [role="navigation"]')) return null;
    const main = hit.closest('main');
    if (!main) return null;
    const candidate = hit.closest(
      '[data-equyvo-zoom-target], article, [role="article"], .equyvo-zoom-surface',
    ) as HTMLElement | null;
    if (candidate && main.contains(candidate)) return candidate;
    return main.querySelector('[data-equyvo-zoom-surface]') as HTMLElement | null;
  }, []);

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
    const active = activeTargetRef.current;
    if (active && active.isConnected) {
      applyFocusedZoom(active, v);
      if (v === 1) activeTargetRef.current = null;
    }
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
  }, [applyFocusedZoom]);

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
    clearFocusedZoom();
    commitZoom(1, true);
  }, [setFontScale, clearFocusedZoom, commitZoom]);

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
    let gestureTarget: HTMLElement | null = null;
    let gestureOrigin: Point | undefined;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2 && pinchOnRef.current) {
        const midpoint = midpointOf(e.touches);
        gestureTarget = findZoomTarget(midpoint.x, midpoint.y);
        if (!gestureTarget) return;
        touching = true;
        magnify = false;
        startAt = Date.now();
        maxDelta = 0;
        startDist = distanceOf(e.touches[0], e.touches[1]);
        anchorDist = startDist;
        anchorZoom = targetScale(gestureTarget) || zoomRef.current;
        if (targetScale(gestureTarget) === 1) {
          const rect = gestureTarget.getBoundingClientRect();
          gestureOrigin = {
            x: clamp(midpoint.x - rect.left, 0, Math.max(rect.width, 1)),
            y: clamp(midpoint.y - rect.top, 0, Math.max(rect.height, 1)),
          };
        } else {
          gestureOrigin = undefined;
        }
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touching || !gestureTarget || e.touches.length < 2) return;
      const d = distanceOf(e.touches[0], e.touches[1]);
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
          anchorDist = Math.max(startDist, 12);
          applyFocusedZoom(gestureTarget, anchorZoom, gestureOrigin);
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
        gestureTarget = null;
        gestureOrigin = undefined;
        commitZoom(zoomRef.current, false); // flush debounced persist/state
      }
    };

    // Deliberate desktop equivalent: Ctrl/Cmd + wheel.
    const onWheel = (e: WheelEvent) => {
      if (!pinchOnRef.current) return;
      if (e.ctrlKey || e.metaKey) {
        const target = findZoomTarget(e.clientX, e.clientY);
        if (target) activeTargetRef.current = target;
        if (!activeTargetRef.current) return;
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
  }, [applyFocusedZoom, commitZoom, findZoomTarget, targetScale]);

  // Cross-tab sync: another tab's Settings change applies here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === FONT_SCALE_KEY && e.newValue) setFontScaleState(clamp(parseFloat(e.newValue) || 1, FONT_MIN, FONT_MAX));
      if (e.key === ZOOM_SCALE_KEY && e.newValue) {
        const v = clamp(parseFloat(e.newValue) || 1, ZOOM_MIN, ZOOM_MAX);
        zoomRef.current = v;
        applyAppZoom(v);
        const active = activeTargetRef.current;
        if (active && active.isConnected) applyFocusedZoom(active, v);
        setZoomState(v);
      }
      if (e.key === PINCH_ENABLED_KEY) setPinchOnState(e.newValue === '1');
      if (e.key === ANTI_MISTOUCH_KEY) setAntiMistouchState(e.newValue === '1');
    };
    try { window.addEventListener('storage', onStorage); } catch { /* ignore */ }
    return () => { try { window.removeEventListener('storage', onStorage); } catch { /* ignore */ } };
  }, [applyFocusedZoom]);

  const value = useMemo<DisplayContextValue>(() => ({
    fontScale, setFontScale, zoom, setZoom, pinchOn, setPinchOn, antiMistouch, setAntiMistouch, resetDisplay,
  }), [
    fontScale, setFontScale, zoom, setZoom, pinchOn, setPinchOn, antiMistouch, setAntiMistouch, resetDisplay,
  ]);

  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
};

export default DisplayProvider;
