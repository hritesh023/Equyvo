/**
 * Single source of truth for the Equyvo API base URL (web + native).
 *
 * - Web: same-origin `/api` (Cloudflare Pages serves dist/ and Functions
 *   together), so there is no hard-coded host and no CORS dependency.
 * - Native (Capacitor): the WebView origin is capacitor://localhost /
 *   https://localhost, which has no /api functions of its own, so it must
 *   call the canonical production domain explicitly.
 * - Build-time override: set VITE_API_BASE to point at another deployment
 *   without touching source (useful for staging / smoke tests).
 */
function resolveApiBase(): string {
  try {
    const env = import.meta.env as unknown as Record<string, string | undefined>;
    const override = String(env?.VITE_API_BASE || '').trim().replace(/\/+$/, '');
    if (override) return override.endsWith('/api') ? override : `${override}/api`;
  } catch { /* ignore */ }
  try {
    const cap = (window as any)?.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      return 'https://equyvo.acronous.com/api';
    }
  } catch { /* ignore */ }
  return '/api';
}

export const API_BASE = resolveApiBase();
export default API_BASE;
