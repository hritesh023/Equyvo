import { useEffect } from 'react';

/**
 * Auto-detects the device's bottom navigation style (3-button "default
 * navbar" vs gesture navigation) and adjusts the safe-bottom floor so the
 * floating bottom nav sits at the right height on every device:
 *
 *   - button nav (large bottom inset, >= 40px)  -> raised (56px floor)
 *   - gesture nav (small/no bottom inset)        -> max bottom (12px floor)
 *
 * Works on both native (Android MainActivity forwards --native-safe-bottom)
 * and web (measures env(safe-area-inset-bottom)).
 */
export function useNavMode() {
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const apply = () => {
      const root = document.documentElement;
      const isNative = root.classList.contains('cap-native');
      let inset = 0;
      if (isNative) {
        const v = getComputedStyle(root).getPropertyValue('--native-safe-bottom').trim();
        inset = parseFloat(v) || 0;
      } else {
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:fixed;bottom:0;left:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px);';
        document.body.appendChild(probe);
        inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
        document.body.removeChild(probe);
      }
      const isButtons = inset >= 40;
      const newMode = isButtons ? 'buttons' : 'gesture';
      if (root.getAttribute('data-nav-mode') === newMode) return;
      root.style.setProperty('--equyvo-safe-bottom-floor', isButtons ? '56px' : '4px');
      root.classList.remove('nav-mode-buttons', 'nav-mode-gesture');
      root.classList.add(isButtons ? 'nav-mode-buttons' : 'nav-mode-gesture');
      root.setAttribute('data-nav-mode', newMode);
    };

    apply();

    // Re-run when native insets arrive / change (MainActivity sets the attr).
    const observer = new MutationObserver(() => apply());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-native-insets'],
    });

    const onResize = () => apply();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    // Re-check a few times in case insets arrive late on native.
    const timers = [200, 800, 2000].map((ms) => window.setTimeout(apply, ms));

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
}