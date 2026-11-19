// Native screen capture for Equyvo live sessions.
//
// Uses the OS consent flow: Android MediaProjection's "start capturing" system
// dialog, or iOS ReplayKit's system recorder UI. Nothing is captured unless the
// user explicitly selects what to share. The web path uses getDisplayMedia.
import { Capacitor } from '@capacitor/core';
import { ScreenRecorder } from '@capgo/capacitor-screen-recorder';
import type { PluginListenerHandle } from '@capacitor/core';

export function isNativeScreenRecorderAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && (Capacitor.getPlatform() === 'android' || Capacitor.getPlatform() === 'ios');
  } catch {
    return false;
  }
}

interface NativeStopEvent {
  url: string;
  error?: string;
}

let listener: PluginListenerHandle | null = null;
let stopResolver: ((event: NativeStopEvent) => void) | null = null;
let lastStopEvent: NativeStopEvent | null = null;

/** Hide this window from MediaProjection while a screen live is running. */
function setLiveWindowSecure(secure: boolean): void {
  try {
    const bridge = (window as any)?.EquyvoLive;
    if (bridge && typeof bridge.setSecure === 'function') {
      if (secure) bridge.setSecure(true);
      else bridge.setSecure(false);
    }
  } catch { /* web or older native build — no-op */ }
}

async function ensureListener(): Promise<void> {
  if (listener) return;
  listener = await ScreenRecorder.addListener('onStopped', (event: NativeStopEvent) => {
    setLiveWindowSecure(false);
    const payload: NativeStopEvent = { url: String(event?.url || ''), error: event?.error ? String(event.error) : undefined };
    lastStopEvent = payload;
    if (stopResolver) {
      const resolve = stopResolver;
      stopResolver = null;
      resolve(payload);
    }
    // System UI stop ("Stop sharing" / ReplayKit done): let the composer end
    // the live session even though it did not call stop() itself.
    try {
      window.dispatchEvent(new CustomEvent('equyvo:nativeScreenStopped', { detail: payload }));
    } catch { /* ignore */ }
  });
}

/** Starts recording AFTER the user accepts the OS screen-capture consent UI. */
export async function startNativeScreenRecording(): Promise<void> {
  if (!isNativeScreenRecorderAvailable()) {
    throw new Error('Native screen capture is only available in the mobile app.');
  }
  await ensureListener();
  lastStopEvent = null;
  try {
    await ScreenRecorder.start({ recordAudio: true, format: 'mp4' });
    // From here on, Equyvo's own windows must never appear in the capture —
    // the user is free to browse the app while the stream keeps recording.
    setLiveWindowSecure(true);
  } catch (e) {
    setLiveWindowSecure(false);
    throw e;
  }
}

/** Stops recording and resolves with the saved local file URL. */
export async function stopNativeScreenRecording(timeoutMs = 30000): Promise<NativeStopEvent> {
  if (!isNativeScreenRecorderAvailable()) {
    return { url: '', error: 'Native screen capture is not available here.' };
  }
  if (lastStopEvent) {
    const cached = lastStopEvent;
    lastStopEvent = null;
    return cached;
  }
  const result = new Promise<NativeStopEvent>((resolve) => {
    stopResolver = resolve;
    setTimeout(() => {
      if (stopResolver === resolve) {
        stopResolver = null;
        resolve({ url: '', error: 'Timed out waiting for the device to save the recording.' });
      }
    }, timeoutMs);
  });
  // Patched plugin: stop() resolves with { url, error? } once the file is
  // finalized. The onStopped listener remains the fallback for system stops.
  try {
    const stopped = (await ScreenRecorder.stop()) as unknown as { url?: string; error?: string } | undefined;
    if (stopped && (stopped.url || stopped.error)) {
      if (stopResolver) {
        const resolve = stopResolver;
        stopResolver = null;
        resolve({ url: String(stopped.url || ''), error: stopped.error ? String(stopped.error) : undefined });
      }
    }
  } catch (e) {
    if (stopResolver) {
      const resolve = stopResolver;
      stopResolver = null;
      resolve({ url: '', error: e instanceof Error ? e.message : 'Could not stop the recording.' });
    }
  }
  setLiveWindowSecure(false);
  return result;
}

/** Turns the plugin's file:// URL into a Blob the upload API can consume. */
export async function nativeRecordingToBlob(url: string): Promise<Blob> {
  if (!url) throw new Error('The device did not return a saved recording.');
  const src = Capacitor.convertFileSrc(url);
  const res = await fetch(src);
  if (!res.ok) throw new Error('Could not read the screen recording from this device.');
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) throw new Error('The screen recording came out empty.');
  return new Blob([buffer], { type: 'video/mp4' });
}
