import * as React from "react";

const MOBILE_BREAKPOINT = 768;

/**
 * Resolve the breakpoint SYNCHRONOUSLY on the first render. The old version
 * started as `undefined` (=> false = "desktop") and only corrected itself in
 * an effect, so phones painted the desktop top navigation for a frame — a
 * visible second header every app launch. Now the very first paint already
 * matches the device.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    () => {
      if (typeof window === "undefined") return false;
      // Native shells (Android/iOS) are always phone-class layouts: the
      // WebView can briefly report a desktop-ish width during the first
      // paint, which rendered the desktop top nav as a "bad header" overlay
      // above the mobile header. Treat native platforms as mobile outright.
      const native = !!(window as any)?.Capacitor?.isNativePlatform?.();
      return native || window.innerWidth < MOBILE_BREAKPOINT;
    },
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    // Re-read once after mount: rotation / split-screen may already differ.
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
