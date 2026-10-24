import * as React from "react";

const TABLET_BREAKPOINT = 1024;

export function useIsTablet() {
  const [isTablet, setIsTablet] = React.useState<boolean | undefined>(
    () => {
      if (typeof window === "undefined") return false;
      const native = !!(window as any)?.Capacitor?.isNativePlatform?.();
      if (native) return false;
      const width = window.innerWidth;
      return width >= 768 && width < TABLET_BREAKPOINT;
    },
  );

  React.useEffect(() => {
    const native = !!(window as any)?.Capacitor?.isNativePlatform?.();
    const mql = window.matchMedia(`(min-width: 768px) and (max-width: ${TABLET_BREAKPOINT - 1}px)`);
    const onChange = () => {
      if (native) { setIsTablet(false); return; }
      const width = window.innerWidth;
      setIsTablet(width >= 768 && width < TABLET_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    const width = window.innerWidth;
    setIsTablet(width >= 768 && width < TABLET_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isTablet;
}
