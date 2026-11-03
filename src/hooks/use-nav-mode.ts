import { useEffect } from 'react';

/**
 * Auto-detects the device's bottom navigation style and adjusts the safe-bottom
 * floor. MutationObserver is intentionally NOT used: observing `documentElement`
 * attributes (which many hooks update) re-triggered apply() in a loop and hung
 * the WebView on some devices.
 */
export function useNavMode() {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    const readInset = (): number => {
      try {
        const nativeRaw = getComputedStyle(root).getPropertyValue('--native-safe-bottom').trim();
        const nativeNum = parseFloat(nativeRaw);
        if (Number.isFinite(nativeNum) && nativeNum > 0) {
          root.classList.add('cap-native');
          return nativeNum;
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
      } catch {
        return 0;
      }
    };

    const apply = () => {
      try {
        const inset = readInset();
        const isButtons = inset >= 24;
        const newMode = isButtons ? 'buttons' : 'gesture';
        const newFloor = '28px';
        const newSafe = Math.max(28, inset) + 'px';

        const currentMode = root.getAttribute('data-nav-mode');
        const currentSafe = root.style.getPropertyValue('--equyvo-safe-bottom').trim();
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
      } catch {
        // ignore
      }
    };

    apply();

    const onAny = () => apply();
    window.addEventListener('resize', onAny);
    window.addEventListener('orientationchange', onAny);
    window.addEventListener('pageshow', onAny);
    document.addEventListener('visibilitychange', onAny);
    window.visualViewport?.addEventListener('resize', onAny);

    const timers = [50, 200, 600, 1200, 2500, 5000].map((ms) =>
      window.setTimeout(() => apply(), ms),
    );

    return () => {
      window.removeEventListener('resize', onAny);
      window.removeEventListener('orientationchange', onAny);
      window.removeEventListener('pageshow', onAny);
      document.removeEventListener('visibilitychange', onAny);
      window.visualViewport?.removeEventListener('resize', onAny);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
}