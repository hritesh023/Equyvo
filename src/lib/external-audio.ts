/**
 * Equyvo external audio
 * ---------------------
 * Shared model + single-player controller for the "Use this audio" flow.
 *
 * A track always points at a playable media URL (the audio track of a Moment
 * video, or an uploaded audio file). Only ONE track can play at a time across
 * the whole app — the moment feed, the full-screen "Use this audio" page, the
 * Create composer and the camera recorder all go through this controller.
 */

export interface ExternalAudioTrack {
  id: string;
  /** Song / audio name shown in the UI (also stored as `song` on the post). */
  name: string;
  /** Original creator handle, e.g. "@alex". */
  creator: string;
  /** Playable URL. Same-origin /api/media URLs work with Web Audio recording. */
  url: string;
  /** Optional cover art (moment thumbnail). */
  cover?: string;
  /** Where the track was picked: moments feed or photo surface. */
  from?: 'moment' | 'photo';
}

const STORAGE_KEY = 'equyvo_external_audio';
const EVENT_NAME = 'equyvo:external-audio';

let player: HTMLAudioElement | null = null;
let activeId = '';
let isPlaying = false;
const listeners = new Set<() => void>();

function emit() {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, {
    detail: { id: activeId, playing: isPlaying },
  }));
  listeners.forEach((listener) => { try { listener(); } catch { /* ignore */ } });
}

export function subscribeExternalAudio(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getExternalAudioState(): { id: string; playing: boolean } {
  return { id: activeId, playing: isPlaying };
}

/** The active <audio> element, for UI that needs time/duration. */
export function getExternalAudioElement(): HTMLAudioElement | null {
  return player;
}

export function isExternalAudioPlaying(id?: string): boolean {
  return isPlaying && (!id || id === activeId);
}

function bindPlayerEvents(el: HTMLAudioElement) {
  el.addEventListener('play', () => { isPlaying = true; emit(); });
  el.addEventListener('pause', () => { isPlaying = false; emit(); });
  el.addEventListener('ended', () => { isPlaying = false; emit(); });
  el.addEventListener('error', () => { isPlaying = false; emit(); });
}

/** Stop anything currently playing, then play `track` (looping by default). */
export function playExternalAudio(track: ExternalAudioTrack, loop = true): void {
  stopExternalAudio();
  try {
    const el = new Audio();
    // Web Audio (camera recording) needs CORS permission for remote media.
    // Same-origin /api/media URLs are unaffected.
    try {
      const u = new URL(track.url, window.location.href);
      if (u.host !== window.location.host) el.crossOrigin = 'anonymous';
    } catch { /* ignore */ }
    el.src = track.url;
    el.loop = loop;
    el.preload = 'auto';
    el.volume = 1;
    bindPlayerEvents(el);
    player = el;
    activeId = track.id;
    void el.play().then(() => {
      isPlaying = true;
      emit();
    }).catch(() => {
      // Autoplay can still be refused (e.g. a background tab). The player
      // stays loaded so the user can tap play from the UI.
      isPlaying = false;
      emit();
    });
  } catch {
    player = null;
    activeId = '';
    isPlaying = false;
    emit();
  }
}

export function pauseExternalAudio(): void {
  try { player?.pause(); } catch { /* ignore */ }
  isPlaying = false;
  emit();
}

export function resumeExternalAudio(): void {
  try { void player?.play(); } catch { /* ignore */ }
}

export function stopExternalAudio(): void {
  if (player) {
    try {
      player.pause();
      player.removeAttribute('src');
      player.load();
    } catch { /* ignore */ }
  }
  player = null;
  activeId = '';
  isPlaying = false;
  emit();
}

export function toggleExternalAudio(track: ExternalAudioTrack): void {
  if (activeId === track.id && isPlaying) pauseExternalAudio();
  else if (activeId === track.id && player) resumeExternalAudio();
  else playExternalAudio(track);
}

// ── Persistence / deep links ──────────────────────────────────────────────

export function isValidExternalAudio(value: unknown): value is ExternalAudioTrack {
  if (!value || typeof value !== 'object') return false;
  const t = value as Partial<ExternalAudioTrack>;
  return typeof t.url === 'string' && t.url.length > 0 && typeof t.name === 'string';
}

function normalizeTrack(value: any): ExternalAudioTrack | null {
  if (!isValidExternalAudio(value)) return null;
  return {
    id: String(value.id || value.url || Date.now()),
    name: String(value.name || 'Original audio'),
    creator: String(value.creator || 'Equyvo creator'),
    url: String(value.url),
    cover: typeof value.cover === 'string' ? value.cover : undefined,
    from: value.from === 'photo' ? 'photo' : 'moment',
  };
}

export function encodeExternalAudio(track: ExternalAudioTrack): string {
  return encodeURIComponent(JSON.stringify(track));
}

export function decodeExternalAudio(raw: string | null | undefined): ExternalAudioTrack | null {
  if (!raw) return null;
  try {
    return normalizeTrack(JSON.parse(decodeURIComponent(raw)));
  } catch {
    return null;
  }
}

/** Read a track from a URL: `?audio=<encoded JSON>` or plain `?audioUrl=...`. */
export function readExternalAudioFromSearch(search: string): ExternalAudioTrack | null {
  const p = new URLSearchParams(search);
  const encoded = p.get('audio');
  const fromParam = p.get('from');
  const from = fromParam === 'photo' || fromParam === 'moments' ? 'photo'
    : fromParam === 'moment' || fromParam === 'moments-feed' ? 'moment' : undefined;
  if (encoded) {
    const track = decodeExternalAudio(encoded);
    if (track) return { ...track, from: from || track.from };
  }
  const url = p.get('audioUrl') || p.get('url');
  if (url) {
    return normalizeTrack({
      id: p.get('audioId') || url,
      name: p.get('audioName') || p.get('name') || 'Original audio',
      creator: p.get('audioCreator') || p.get('creator') || 'Equyvo creator',
      url,
      cover: p.get('audioCover') || p.get('cover') || undefined,
      from,
    });
  }
  return null;
}

export function externalAudioDestination(track: ExternalAudioTrack): string {
  const tab = track.from === 'photo' ? 'photo' : 'moment';
  return `/app/create?tab=${tab}&audio=${encodeExternalAudio(track)}`;
}

export function useAudioDestination(track: ExternalAudioTrack): string {
  const p = new URLSearchParams();
  p.set('audio', encodeExternalAudio(track));
  p.set('from', track.from === 'photo' ? 'photo' : 'moment');
  return `/app/use-audio?${p.toString()}`;
}

export function saveExternalAudio(track: ExternalAudioTrack): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(track));
  } catch { /* storage can be disabled — the URL still carries the track */ }
}

export function loadSavedExternalAudio(): ExternalAudioTrack | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeTrack(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function clearSavedExternalAudio(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ── Camera recording mix ──────────────────────────────────────────────────

export interface RecordingAudioMix {
  /** Feed this to MediaRecorder instead of the raw camera stream. */
  stream: MediaStream;
  /** Call when recording stops / camera is torn down. */
  dispose: () => void;
}

/**
 * Mix the external track (and the microphone, when available) into the
 * camera MediaStream so the music is actually audible in the recorded clip,
 * while also playing it to the speakers for the person recording.
 * Falls back to plain speaker playback when Web Audio is unavailable.
 */
export async function attachExternalAudioToRecording(
  track: ExternalAudioTrack,
  baseStream: MediaStream,
): Promise<RecordingAudioMix> {
  stopExternalAudio();
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) {
    playExternalAudio(track);
    return { stream: baseStream, dispose: stopExternalAudio };
  }

  let ctx: any = null;
  let el: HTMLAudioElement | null = null;
  let source: any = null;
  let micSource: any = null;
  let disposed = false;

  try {
    ctx = new AudioCtx();
    const dest = ctx.createMediaStreamDestination();
    el = new Audio();
    el.crossOrigin = 'anonymous';
    el.loop = true;
    el.preload = 'auto';
    el.src = track.url;
    source = ctx.createMediaElementSource(el);
    source.connect(ctx.destination); // monitor: user hears the track
    source.connect(dest); // record: track lands in the video file

    const micTracks = baseStream.getAudioTracks();
    if (micTracks.length) {
      try {
        micSource = ctx.createMediaStreamSource(new MediaStream(micTracks));
        micSource.connect(dest);
      } catch { /* music-only recording is still valid */ }
    }

    if (ctx.state === 'suspended') await ctx.resume();
    await el.play();
    activeId = track.id;
    isPlaying = true;
    emit();

    const mixed = new MediaStream([
      ...baseStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    return {
      stream: mixed,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        try { el?.pause(); } catch { /* ignore */ }
        try { source?.disconnect(); } catch { /* ignore */ }
        try { micSource?.disconnect(); } catch { /* ignore */ }
        try { void ctx?.close(); } catch { /* ignore */ }
        if (activeId === track.id) stopExternalAudio();
      },
    };
  } catch {
    try { el?.pause(); } catch { /* ignore */ }
    try { source?.disconnect(); } catch { /* ignore */ }
    try { void ctx?.close(); } catch { /* ignore */ }
    // Still give the user background music even if the mix failed.
    playExternalAudio(track);
    return { stream: baseStream, dispose: stopExternalAudio };
  }
}
