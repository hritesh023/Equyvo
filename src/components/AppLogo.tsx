import React from 'react';
import { useTheme } from './theme-provider';

export const DARK_LOGO_SRC = '/Equyvo_logo.png';
export const LIGHT_LOGO_SRC = '/Equyvo_logo_light_v2.png';

/** Resolve light/dark logo from the app theme (handles "system"). */
export function useThemedLogoSrc(): string {
  const { theme } = useTheme();
  const [systemIsDark, setSystemIsDark] = React.useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true,
  );

  React.useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    setSystemIsDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const isDark = theme === 'dark' || (theme === 'system' && systemIsDark);
  return isDark ? DARK_LOGO_SRC : LIGHT_LOGO_SRC;
}

/** Non-hook version for places without ThemeProvider (media-session, etc). */
export function getThemedLogoSrc(): string {
  if (typeof window === 'undefined') return DARK_LOGO_SRC;
  const stored = localStorage.getItem('vite-ui-theme');
  if (stored === 'light') return LIGHT_LOGO_SRC;
  if (stored === 'dark') return DARK_LOGO_SRC;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? DARK_LOGO_SRC
    : LIGHT_LOGO_SRC;
}

interface AppLogoProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  alt?: string;
}

/**
 * Theme-aware Equyvo logo.
 * Shows Equyvo_logo_light_v2.png in light mode, Equyvo_logo.png in dark mode.
 */
const AppLogo: React.FC<AppLogoProps> = ({ alt = 'Equyvo Logo', ...rest }) => {
  const src = useThemedLogoSrc();
  return <img src={src} alt={alt} {...rest} />;
};

export default AppLogo;
