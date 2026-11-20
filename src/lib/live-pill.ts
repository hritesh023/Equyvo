// Android system-overlay LIVE pill. The native window is TYPE_APPLICATION_OVERLAY
// + FLAG_SECURE, so it stays visible on the device (and over other apps) but is
// excluded from the screen recording. On web/iOS these are safe no-ops.

interface LivePillBridge {
  canDraw?: () => boolean;
  requestPermission?: () => void;
  show?: () => void;
  hide?: () => void;
}

function bridge(): LivePillBridge | null {
  try {
    const b = (window as any)?.EquyvoLivePill;
    return b && typeof b === 'object' ? (b as LivePillBridge) : null;
  } catch {
    return null;
  }
}

export function isFloatingLivePillSupported(): boolean {
  return !!bridge()?.show;
}

/** True once the user has granted "display over other apps". */
export function canShowFloatingLivePill(): boolean {
  try { return !!bridge()?.canDraw?.(); } catch { return false; }
}

/** Opens Android's overlay-permission settings for this app. */
export function requestFloatingLivePillPermission(): void {
  try { bridge()?.requestPermission?.(); } catch { /* web/iOS */ }
}

/** Show the pill outside Equyvo (only when the permission is already granted). */
export function showFloatingLivePill(): void {
  try { bridge()?.show?.(); } catch { /* web/iOS */ }
}

export function hideFloatingLivePill(): void {
  try { bridge()?.hide?.(); } catch { /* web/iOS */ }
}
