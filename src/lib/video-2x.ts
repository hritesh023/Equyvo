import { useEffect, useRef } from 'react';

// ── Equyvo hold-to-2× video gesture ────────────────────────────────────────
//
// Instagram-style continuous scrub for ANY video surface:
//   • long-press the RIGHT half  → play/scrub FORWARD at 2× the video speed
//     (playing videos speed up to 2×; paused videos scrub forward in place)
//   • long-press the LEFT half   → REWIND at 2× the video speed (scrub back
//     in place — HTML video can't play backwards, so this is a smooth fast
//     seek under the finger)
//   • release                    → the previous speed and play/pause state
//     resume exactly where the finger left off (a video that was sped to its
//     end stays ended instead of restarting)
//
// Design notes:
//  - A pressed tap (< holdMs, or moved >14px) behaves exactly as before —
//    tap toggles, double-tap seeks ±10s, scrolling is never blocked. Only a
//    STATIONARY hold longer than holdMs engages the gesture.
//  - The click that browsers synthesize right after the hold is swallowed,
//    so the release never ALSO fires play/pause / open-fullscreen / like.
//  - Native long-press menus (Android "save video…") are suppressed on the
//    video itself.
//  - Live streams: rewind is meaningless (nothing left of the live edge) so
//    skips; forward fast-watches the buffered window and catches up to live.
//  - Attaches to whatever <video> elements are currently mounted and
//    re-syncs every 250ms so shifted feeds/lists stay wired.

const HOLD_MS = 500;
const MOVE_CANCEL_PX = 14;
const DEFAULT_SPEED = 2;

type Side = 'fwd' | 'rew';

interface HoldState {
  video: HTMLVideoElement | null;
  pointerId: number;
  downX: number;
  downY: number;
  downOffsetX: number;
  timer: number;
  active: Side | null;
  wasPaused: boolean;
  savedRate: number;
  raf: number;
  last: number;
  overlay: HTMLDivElement | null;
  suppressUntil: number;
}

export interface UseVideo2xPressOptions {
  speed?: number;
  holdMs?: number;
  /**
   * 'element' (default) splits the video's own box — right half = forward.
   * 'viewport' splits the screen — right half = forward, left half = rewind.
   * Use 'viewport' for fullscreen players whose ancestors are rotated (the
   * video's getBoundingClientRect() is then an axis-aligned box that no longer
   * matches the user's left/right).
   */
  sideMode?: 'element' | 'viewport';
  /** Degrees to rotate the ▶▶/◀◀ pill so it matches a rotated UI. */
  overlayRotation?: number;
}

export function useVideo2xPress(
  getVideos: () => Array<HTMLVideoElement | null | undefined>,
  opts: UseVideo2xPressOptions = {},
): void {
  const getRef = useRef(getVideos);
  getRef.current = getVideos;
  const speedRef = useRef(opts.speed ?? DEFAULT_SPEED);
  const holdRef = useRef(opts.holdMs ?? HOLD_MS);
  const sideModeRef = useRef(opts.sideMode ?? 'element');
  const rotationRef = useRef(opts.overlayRotation ?? 0);
  speedRef.current = opts.speed ?? DEFAULT_SPEED;
  holdRef.current = opts.holdMs ?? HOLD_MS;
  sideModeRef.current = opts.sideMode ?? 'element';
  rotationRef.current = opts.overlayRotation ?? 0;

  useEffect(() => {
    const attached = new Set<HTMLVideoElement>();
    const st: HoldState = {
      video: null, pointerId: -1, downX: 0, downY: 0, downOffsetX: 0, timer: 0,
      active: null, wasPaused: false, savedRate: 1, raf: 0, last: 0,
      overlay: null, suppressUntil: 0,
    };

    // ── overlay pill (▶▶ 2× / ◀◀ 2×) ──
    const showOverlay = (side: Side, rect: DOMRect): void => {
      hideOverlay();
      const el = document.createElement('div');
      el.textContent = side === 'fwd' ? '▶▶ 2×' : '◀◀ 2×';
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = [
        'position:fixed', 'z-index:2147483000', 'pointer-events:none',
        'padding:10px 18px', 'border-radius:999px',
        'background:rgba(0,0,0,.72)', 'color:#fff',
        'font-weight:800', 'font-size:15px', 'line-height:1',
        'letter-spacing:.04em', 'opacity:0', 'transition:opacity .15s',
        'writing-mode:horizontal-tb',
        // Match the viewer's rotation: in expanded landscape the whole UI is
        // turned 90°, so the pill must be turned with it to still read
        // horizontally from the landscape viewpoint.
        `transform:translate(-50%,-50%) rotate(${rotationRef.current}deg)`,
        'box-shadow:0 8px 30px rgba(0,0,0,.35)',
        'backdrop-filter:blur(4px)', '-webkit-backdrop-filter:blur(4px)',
        '-webkit-user-select:none', 'user-select:none',
        `left:${side === 'fwd'
          ? rect.right - rect.width * 0.25
          : rect.left + rect.width * 0.25}px`,
        `top:${rect.top + rect.height * 0.62}px`,
      ].join(';');
      document.body.appendChild(el);
      st.overlay = el;
      requestAnimationFrame(() => { el.style.opacity = '1'; });
    };
    const hideOverlay = (): void => {
      const el = st.overlay;
      if (!el) return;
      st.overlay = null;
      try {
        el.style.opacity = '0';
        window.setTimeout(() => { el.remove(); }, 180);
      } catch { /* ignore */ }
    };

    const seekableEnd = (v: HTMLVideoElement): number => {
      try {
        const s = v.seekable;
        return s.length ? Math.max(0, s.end(s.length - 1) - 0.25) : 0;
      } catch { return 0; }
    };

    // ── gesture engine ──
    const removeWindowListeners = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    const deactivate = (): void => {
      if (!st.active) return;
      st.active = null;
      cancelAnimationFrame(st.raf);
      hideOverlay();
      const v = st.video;
      st.video = null;
      st.suppressUntil = Date.now() + 350; // swallow the trailing click
      if (v) {
        try {
          v.playbackRate = st.savedRate;
          // Resume what was playing before the hold — but never auto-restart
          // a video that was sped all the way to its end.
          if (!st.wasPaused && !v.ended && v.paused) {
            const p = v.play();
            if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      }
    };

    const disarm = (): void => {
      if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
      removeWindowListeners();
      if (st.active) deactivate();
    };

    const activate = (): void => {
      const v = st.video;
      if (!v || st.active) return;
      const rect = v.getBoundingClientRect();
      if (rect.width < 40) { disarm(); return; }
      const finiteDur = isFinite(v.duration);
      const live = !finiteDur;
      // Decide the side from where the finger actually went down. In a
      // fullscreen player the video's rect can be transformed/offset (rotated
      // landscape), so comparing downOffsetX to that rect can classify BOTH
      // halves as 'fwd'. Viewport mode uses the real screen position: left
      // half = rewind, right half = forward — exactly what the user pressed.
      const side: Side = sideModeRef.current === 'viewport'
        ? (st.downX < window.innerWidth / 2 ? 'rew' : 'fwd')
        : (st.downOffsetX < (rect.width / 2) ? 'rew' : 'fwd');
      if (side === 'rew' && live) { disarm(); return; } // nothing left of live
      st.active = side;
      st.wasPaused = v.paused;
      st.savedRate = v.playbackRate || 1;
      st.last = performance.now();
      // Rewind scrubs under the finger → pause for exact control.
      if (side === 'rew' && !v.paused) {
        try { v.pause(); } catch { /* ignore */ }
      }
      // Forward while PLAYING → real 2× playback (smooth, sound preserved).
      // Forward while PAUSED → silent in-place fast-scrub (no autoplay).
      if (side === 'fwd' && !v.paused) {
        try { v.playbackRate = speedRef.current; } catch { /* ignore */ }
      }
      st.suppressUntil = Date.now() + 1400;
      showOverlay(side, rect);
      const step = (now: number): void => {
        if (!st.active) return;
        const dt = Math.min(0.2, (now - st.last) / 1000);
        st.last = now;
        const vv = st.video;
        if (vv) {
          try {
            if (st.active === 'rew') {
              vv.currentTime = Math.max(0, vv.currentTime - dt * speedRef.current);
            } else if (vv.paused) {
              let t = vv.currentTime + dt * speedRef.current;
              const maxT = isFinite(vv.duration)
                ? vv.duration - 0.05
                : (vv.seekable.length ? seekableEnd(vv) : Infinity);
              if (isFinite(maxT) && t >= maxT) { t = maxT; }
              vv.currentTime = t;
            }
            // playing+fwd: playbackRate already does the work per-frame
          } catch { /* ignore seek errors */ }
        }
        st.raf = requestAnimationFrame(step);
      };
      st.raf = requestAnimationFrame(step);
    };

    // ── pointer handlers ──
    // Listen in the CAPTURE phase at document level instead of only on each
    // <video>. In expanded landscape the whole viewer is rotated 90°, so the
    // control bars sit over what is visually the left/right half of the
    // screen. Those transparent overlays would otherwise swallow the press
    // before it ever reaches the video (right-side 2× never engaged). Here we
    // find the video geometrically under the pointer and ignore only real
    // controls, so a hold anywhere over the media works in every orientation.
    const onDown = (e: PointerEvent): void => {
      if (st.active || st.timer) return; // one gesture at a time
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('button,a,input,textarea,select,[role="slider"],[data-2x-ignore]')) return;
      let chosen: HTMLVideoElement | null = null;
      let chosenRect: DOMRect | null = null;
      for (const v of getRef.current?.() || []) {
        if (!v || !v.isConnected || v.readyState === 0) continue;
        const r = v.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
        if (!chosenRect || r.width * r.height < chosenRect.width * chosenRect.height) {
          chosen = v;
          chosenRect = r;
        }
      }
      if (!chosen || !chosenRect) return;
      st.video = chosen;
      st.pointerId = e.pointerId;
      st.downX = e.clientX;
      st.downY = e.clientY;
      // Side is measured against the video's on-screen box, so it stays
      // correct when that box is produced by a rotated/transformed ancestor.
      st.downOffsetX = e.clientX - chosenRect.left;
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', onUp, { passive: true });
      window.addEventListener('pointercancel', onUp, { passive: true });
      st.timer = window.setTimeout(activate, holdRef.current);
    };
    const onMove = (e: PointerEvent): void => {
      if (st.active) return; // tiny drift during an active hold is fine
      if (st.pointerId !== -1 && e.pointerId !== st.pointerId) return;
      if (Math.hypot(e.clientX - st.downX, e.clientY - st.downY) > MOVE_CANCEL_PX) {
        disarm();
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (st.active && st.pointerId !== -1 && e.pointerId !== st.pointerId) return;
      disarm();
    };
    const onClick = (e: MouseEvent): void => {
      if (Date.now() < st.suppressUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    // The click synthesised after a hold may land on an overlay (rotated
    // landscape) rather than on the video itself, so suppress it at document
    // level too — but never swallow clicks on real controls.
    const onDocClick = (e: MouseEvent): void => {
      if (Date.now() >= st.suppressUntil) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest('button,a,input,textarea,select,[role="slider"],[data-2x-ignore]')) return;
      e.stopPropagation();
      e.preventDefault();
    };
    const onContext = (e: Event): void => {
      if (st.active || st.timer) { e.preventDefault(); }
    };

    // ── attach / reconcile ──
    const attach = (v: HTMLVideoElement): void => {
      if (attached.has(v)) return;
      attached.add(v);
      v.addEventListener('click', onClick);
      v.addEventListener('contextmenu', onContext);
    };
    const detach = (v: HTMLVideoElement): void => {
      if (!attached.delete(v)) return;
      v.removeEventListener('click', onClick);
      v.removeEventListener('contextmenu', onContext);
      if (st.video === v) { st.video = null; }
    };
    const sync = (): void => {
      const list = (getRef.current?.() || [])
        .filter((x): x is HTMLVideoElement => !!x && !!x.addEventListener);
      for (const v of list) attach(v);
      for (const v of Array.from(attached)) {
        if (!list.includes(v) || !v.isConnected) detach(v);
      }
    };
    sync();
    const iv = window.setInterval(sync, 250);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onDocClick, true);

    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onDocClick, true);
      window.clearInterval(iv);
      disarm();
      for (const v of Array.from(attached)) detach(v);
      hideOverlay();
    };
  }, []);
}
