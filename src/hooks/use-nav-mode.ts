import { useEffect } from 'react';

/**
 * Auto-detects the device's bottom navigation style (3-button "default
 * navbar" vs gesture navigation) and adjusts the safe-bottom floor so the
 * floating bottom nav sits at the right height on every device:
 *
 *   - button nav (large bottom inset, >= 36px)  -> raised (64px floor)
 *   - gesture nav (small/no bottom inset)        -> low (8px floor)
 */
export function useNavMode() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    const readInset = (): number => {
      const isNative = root.classList.contains('cap-native') ||
        !!(window as any)?.Capacitor?.isNativePlatform?.();

      // Prefer a real native inset whenever MainActivity has published one,
      // even before the cap-native class is applied.
      const nativeRaw = getComputedStyle(root).getPropertyValue('--native-safe-bottom').trim();
      const nativeNum = parseFloat(nativeRaw);

      // Native bridge (MainActivity) — direct query, bypasses CSS var timing.
      let bridgeNum = 0;
      if (isNative) {
        try {
          const nav = (window as any)?.AndroidNav;
          if (nav && typeof nav.getBottomInset === 'function') {
            const v = nav.getBottomInset();
            if (Number.isFinite(v) && v > 0) bridgeNum = v;
          }
        } catch {
          bridgeNum = 0;
        }
      }

      // Web / no native insets: probe env(safe-area-inset-bottom).
      let probe: HTMLDivElement | null = document.createElement('div');
      probe.style.cssText =
        'position:fixed;bottom:0;left:0;visibility:hidden;pointer-events:none;' +
        'padding-bottom:env(safe-area-inset-bottom,0px);';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const envNum = parseFloat(cs.paddingBottom) || 0;
      document.body.removeChild(probe);
      probe = null;

      // Native fallback heuristic: when the OS inset is not published (or is 0)
      // but the WebView viewport is clearly shorter than the screen, treat the
      // difference as a button/gesture nav bar. This mirrors the website's
      // env()-based detection for native shells.
      let heuristic = 0;
      if (isNative) {
        try {
          heuristic = Math.max(0, (window.screen?.height || 0) - (window.innerHeight || 0));
        } catch {
          heuristic = 0;
        }
      }

      const inset = Math.max(
        Number.isFinite(nativeNum) && nativeNum > 0 ? nativeNum : 0,
        bridgeNum,
        envNum,
        heuristic,
      );
      if (isNative && inset > 0) root.classList.add('cap-native');
      return inset;
    };

    const apply = () => {
      const inset = readInset();
      // Buttons report >= ~24px (usually 42-48); gesture reports < ~24px.
      // Mirror the website: always keep a 56px floor so the bottom nav can never
      // overlap the system navigation bar (3-button or gesture) on any device.
      const isButtons = inset >= 24;
      const newMode = isButtons ? 'buttons' : 'gesture';
      const newFloor = '56px';

      const currentMode = root.getAttribute('data-nav-mode');
      const currentSafe = root.style.getPropertyValue('--equyvo-safe-bottom').trim();
      const newSafe = Math.max(parseInt(newFloor, 10), inset) + 'px';
      if (currentMode === newMode && currentSafe === newSafe) return;

      root.style.setProperty('--equyvo-safe-bottom-floor', newFloor);
      root.style.setProperty('--equyvo-safe-bottom', newSafe);
      root.classList.remove('nav-mode-buttons', 'nav-mode-gesture');
      root.classList.add(isButtons ? 'nav-mode-buttons' : 'nav-mode-gesture');
      root.setAttribute('data-nav-mode', newMode);

      try {
        window.dispatchEvent(new CustomEvent('equyvo:navmode', { detail: { mode: newMode, inset } }));
      } catch {
        // ignore
      }
    };

    apply();

    const observer = new MutationObserver(() => apply());
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-native-insets', 'data-nav-mode'],
    });

    const onAny = () => apply();
    window.addEventListener('resize', onAny);
    window.addEventListener('orientationchange', onAny);
    window.addEventListener('pageshow', onAny);
    document.addEventListener('visibilitychange', onAny);
    window.visualViewport?.addEventListener('resize', onAny);

    const timers = [50, 200, 600, 1200, 2500, 5000].map((ms) =>
      window.setTimeout(apply, ms),
    );

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onAny);
      window.removeEventListener('orientationchange', onAny);
      window.removeEventListener('pageshow', onAny);
      document.removeEventListener('visibilitychange', onAny);
      window.visualViewport?.removeEventListener('resize', onAny);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
}
