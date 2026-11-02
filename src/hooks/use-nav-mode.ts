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
      const isNative = root.classList.contains('cap-native');
      if (isNative) {
        const v = getComputedStyle(root).getPropertyValue('--native-safe-bottom').trim();
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : 0;
      }
      let probe: HTMLDivElement | null = document.createElement('div');
      probe.style.cssText =
        'position:fixed;bottom:0;left:0;visibility:hidden;pointer-events:none;' +
        'padding-bottom:env(safe-area-inset-bottom,0px);';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const n = parseFloat(cs.paddingBottom) || 0;
      document.body.removeChild(probe);
      probe = null;
      return n;
    };

    const apply = () => {
      const inset = readInset();
      const isButtons = inset >= 36;
      const newMode = isButtons ? 'buttons' : 'gesture';
      const newFloor = isButtons ? '64px' : '8px';

      const currentMode = root.getAttribute('data-nav-mode');
      const currentFloor = root.style.getPropertyValue('--equyvo-safe-bottom-floor').trim();
      if (currentMode === newMode && currentFloor === newFloor) return;

      root.style.setProperty('--equyvo-safe-bottom-floor', newFloor);
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
