// ── Equyvo hardware/system back-button coordinator ─────────────────────────
//
// Previously the hardware back button (Android phones / Android tablets /
// gesture bars) simply DESTROYED the app — the #1 rated "obstruction".
// This module implements the respectful, standard behaviour:
//
//   back press #1  → closes the topmost overlay (video viewer, story rail,
//                    comment/details panels, notification centre, dialogs,
//                    bottom sheets, dropdown menus — Radix handled via a
//                    synthetic Escape, custom overlays via a close registry)
//   back press #2  → navigates to the PREVIOUS in-app page (history back),
//                    never exiting the app while in-app history remains
//   back press #3  → at the app root: "Press back again to exit" toast with
//                    a 2-second arm window — a deliberate double press
//                    MINIMIZES the app (standard Android behaviour; the OS
//                    keeps the process warm, faster resume than a kill)
//
// Extras:
//   - 300 ms debounce so ghost double-taps can't skip two screens at once
//   - busy guard: while an upload is running, leaving the Create page
//     requires a deliberate second press ("Upload in progress — press back
//     again to leave"), so progress is never lost by accident
//   - iOS/iPadOS: hardware back doesn't exist; the native swipe-back
//     gesture is enabled in the iOS AppDelegate (web history mirrors SPA
//     routes, so the gesture moves back inside the app)
import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { toast } from 'sonner';

// ── In-app navigation depth tracking (wired by <BackBridge /> in App.tsx) ──

let inAppDepth = 0;
let goBackImpl: (() => void) | null = null;

/** NavigationType comes from react-router's useNavigationType(). */
export function trackNavigation(type: 'PUSH' | 'POP' | 'REPLACE'): void {
  if (type === 'PUSH') inAppDepth += 1;
  else if (type === 'REPLACE') {
    // A replace keeps the same logical slot in the stack (auth → home, etc.).
  } else {
    inAppDepth = Math.max(0, inAppDepth - 1);
  }
}

export function getInAppDepth(): number {
  return inAppDepth;
}

export function setGoBack(fn: () => void): void {
  goBackImpl = fn;
}

// ── Overlay close registry (topmost wins) ──────────────────────────────────

interface OverlayEntry {
  id: number;
  /** Return true if this entry actually consumed the back press. */
  close: () => boolean;
}

const overlayStack: OverlayEntry[] = [];
let nextOverlayId = 1;

/**
 * Register an overlay closer while the overlay is open. The returned
 * function unregisters — use it as a React effect cleanup.
 * A close() that touches nothing should return false so the coordinator
 * falls through to the next layer.
 */
export function registerOverlayClose(close: () => boolean): () => void {
  const entry: OverlayEntry = { id: nextOverlayId++, close };
  overlayStack.push(entry);
  return () => {
    const i = overlayStack.indexOf(entry);
    if (i >= 0) overlayStack.splice(i, 1);
  };
}

/**
 * React hook: registers `close` with the back coordinator while `open` is
 * true. Example: useBackOverlay(open, () => { setOpen(false); return true; })
 */
export function useBackOverlay(open: boolean, close: () => boolean): void {
  useEffect(() => {
    if (!open) return;
    return registerOverlayClose(close);
    // close may change identity between renders — re-registering is cheap
    // and keeps the closure fresh over evolving sub-panel states.
  }, [open, close]);
}

// ── Radix dismissal (dialogs / sheets / drawers / dropdown menus) ──────────

function hasOpenRadixLayer(): boolean {
  try {
    return !!document.querySelector(
      '[data-state="open"][role="dialog"], ' +
      '[data-state="open"][role="alertdialog"], ' +
      '[data-state="open"][role="menu"]',
    );
  } catch {
    return false;
  }
}

/**
 * Radix DismissableLayer closes the TOP layer on Escape — dispatching a
 * synthetic Escape therefore closes exactly one dialog/sheet/drawer/menu
 * per back press, so nested overlays unwind one at a time.
 */
function dispatchEscape(): void {
  try {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
  } catch { /* ignore */ }
}

// ── Busy guard (uploads in progress) ───────────────────────────────────────

let appBusyDepth = 0;

/**
 * Declare the app busy (upload running, recording…). Overlapping busy
 * operations nest: the flag clears only when all of them are done.
 */
export function setAppBusy(busy: boolean): void {
  appBusyDepth = Math.max(0, appBusyDepth + (busy ? 1 : -1));
}

function isAppBusy(): boolean {
  return appBusyDepth > 0;
}

// ── Exit confirmation ──────────────────────────────────────────────────────

const EXIT_ARM_MS = 2000;
let exitArmedAt = 0;

// ── The coordinator ────────────────────────────────────────────────────────

const RETURN_PRESS_DEBOUNCE_MS = 300;
let lastHandledAt = 0;
let backHooked = false;

async function handleBack(): Promise<void> {
  const now = Date.now();
  if (now - lastHandledAt < RETURN_PRESS_DEBOUNCE_MS) return;
  lastHandledAt = now;

  // 1. Topmost registered overlay (video viewer, story rail, panels…).
  for (let i = overlayStack.length - 1; i >= 0; i--) {
    const entry = overlayStack[i];
    try {
      if (entry.close()) return;
    } catch {
      // A broken closer must never trap the user — drop it and continue.
      const idx = overlayStack.indexOf(entry);
      if (idx >= 0) overlayStack.splice(idx, 1);
    }
  }

  // 2. Radix-based overlay (dialog/sheet/drawer/menu) → close topmost only.
  if (hasOpenRadixLayer()) {
    dispatchEscape();
    return;
  }

  // 3. Busy guard: don't lose an in-flight upload on a stray press.
  if (isAppBusy()) {
    if (now - exitArmedAt < EXIT_ARM_MS) {
      exitArmedAt = 0;
      // Deliberate: leave anyway — the user knows what they are doing.
    } else {
      exitArmedAt = now;
      toast('Upload in progress — press back again to leave', { duration: EXIT_ARM_MS });
      return;
    }
  }

  // 4. Previous in-app page — never an app exit.
  if (inAppDepth > 0 && goBackImpl) {
    exitArmedAt = 0;
    goBackImpl();
    return;
  }

  // 5. Root of the app: double press to exit (minimize — the process stays
  // warm; instant resume instead of a cold relaunch).
  if (now - exitArmedAt < EXIT_ARM_MS) {
    exitArmedAt = 0;
    try { await CapApp.minimizeApp(); } catch { /* ignore */ }
    return;
  }
  exitArmedAt = now;
  toast('Press back again to exit', { duration: EXIT_ARM_MS });
}

/**
 * Arm native hardware/system back handling. No-op on web (where the browser
 * back button already behaves correctly) and idempotent everywhere.
 */
export function initBackNavigation(): void {
  if (backHooked) return;
  // Register on native shells only — on plain web there is no hardware back,
  // and the browser's own back/forward stack already does the right thing.
  if (!Capacitor.isNativePlatform?.()) return;
  backHooked = true;
  void CapApp.addListener('backButton', () => {
    void handleBack();
  });
}

// Convenience for tests/tools.
export function resetBackNavigationForTest(): void {
  overlayStack.length = 0;
  inAppDepth = 0;
  exitArmedAt = 0;
  lastHandledAt = 0;
  backHooked = false;
}
