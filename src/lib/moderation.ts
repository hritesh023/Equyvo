// ---------------------------------------------------------------------------
// Equyvo content-safety gate (client side).
//
// Every file picked anywhere in the app is screened BEFORE it uploads. The
// Create page additionally shows a visible warning + blocks the pick. This
// module never decides policy by itself on ambiguous content — it ships a
// small visual sample to the Equyvo API (/api/content-screen) which runs the
// same server-side safety stack used at publish time (blocklist regexes +
// the shared Acronous safety brain). Fail-open on infrastructure errors so
// uploads never break because of a networking hiccup; the server still
// quarantines what slips through at publish time. Deliberate policy-based
// blocks (verdict !== 'allow') are hard blocks here.
// ---------------------------------------------------------------------------

import { inferMimeType, detectMimeFromBytes, isAllowedMime } from './mime';

function resolveApiBase(): string {
  try {
    const cap = (window as any)?.Capacitor;
    if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
      return 'https://equyvo.pages.dev/api';
    }
  } catch { /* ignore */ }
  return '/api';
}

export type ScreenVerdict = 'allow' | 'review' | 'block';

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** Human-facing, category-level hint for the warning UI. */
  category?: 'adult' | 'violent' | 'exploitative' | 'illegal' | 'spam' | 'unspecified';
  /** true when the server-eye (AI) actually ran; false = heuristics only. */
  checked?: boolean;
  message?: string;
}

/** Thrown by api.uploadFile when the safety gate rejects a file. */
export class ContentBlockedError extends Error {
  code = 'CONTENT_BLOCKED';
  category: ScreenResult['category'];
  constructor(message: string, category: ScreenResult['category'] = 'unspecified') {
    super(message);
    this.name = 'ContentBlockedError';
    this.category = category;
  }
}

// Obvious filename hits are rejected instantly, before any network call.
const NAME_BLOCK_PATTERNS: RegExp[] = [
  /(\b|_)(porn|xxx|nude|naked|nsfw|18\+|adult|sex(tape)?|erotic|hentai|onlyfans)\b/i,
  /(\b|_)csam(\b|_)/i,
  /\b(rape|bestiality|gore|behead|terror|terrorism|terrorist|suicide|self[- ]?harm|self[- ]?injury)\b/i,
  /(\.exe|\.apk|\.bat|\.msi|\.scr|\.js|\.html)$/i,
];

const MAX_SAMPLES = 8;
const SAMPLE_LONG_EDGE = 640;
const SAMPLE_QUALITY = 0.72;
const SAMPLE_TIMEOUT_MS = 9000;

let objectUrls: string[] = [];
function trackUrl(u: string) {
  objectUrls.push(u);
  if (objectUrls.length > 24) {
    const stale = objectUrls.shift();
    if (stale) void revoke(stale);
  }
}
async function revoke(u: string) {
  try { URL.revokeObjectURL(u); } catch { /* ignore */ }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const u of objectUrls) void revoke(u);
    objectUrls = [];
  });
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

function isSkinTone(r, g, b) {
  if (r > 95 && g > 40 && b > 20 && r > g && r > b) {
    if ((r - Math.min(g, b)) > 15 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15) return true;
  }
  return false;
}
function computeSkinRatio(ctx, w, h) {
  try {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let skin = 0;
    const total = w * h;
    for (let i = 0; i < d.length; i += 4) {
      if (isSkinTone(d[i], d[i + 1], d[i + 2])) skin++;
    }
    return total > 0 ? skin / total : 0;
  } catch {
    return 0;
  }
}

// Heuristic for violence/terrorism/explosions: red-dominant and fire-colored
// pixels. Terrorism footage often contains blood, fire, explosions and
// weapons; these show up as concentrated red/orange regions. Threshold is
// conservative to avoid flagging ordinary red objects.
function isViolentPixel(r, g, b) {
  // Blood / red-dominant
  if (r > 150 && r > g * 1.5 && r > b * 1.5 && (r - Math.max(g, b)) > 60) return true;
  // Fire / explosion
  if (r > 200 && g >= 80 && g <= 190 && b < 110 && r - b > 120) return true;
  return false;
}
function computeViolenceRatio(ctx, w, h) {
  try {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    let v = 0;
    const total = w * h;
    for (let i = 0; i < d.length; i += 4) {
      if (isViolentPixel(d[i], d[i + 1], d[i + 2])) v++;
    }
    return total > 0 ? v / total : 0;
  } catch {
    return 0;
  }
}

/** Downscale an image to a small JPEG data URL for the server-side eye. */
async function sampleImage(blob: Blob): Promise<{ dataUrl: string; skinRatio: number; violenceRatio: number } | null> {
  // Decode at the sample size when the browser supports it. The previous
  // implementation decoded the full original first, which could exhaust
  // memory on very large phone photos before the safety request even ran.
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await withTimeout((signal) => {
        const resize = { resizeWidth: SAMPLE_LONG_EDGE, resizeHeight: SAMPLE_LONG_EDGE, resizeQuality: 'high' } as ImageBitmapOptions;
        return createImageBitmap(blob, resize).then((value) => {
          if (signal.aborted) {
            value.close();
            throw new Error('timeout');
          }
          return value;
        });
      }, SAMPLE_TIMEOUT_MS);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, SAMPLE_LONG_EDGE / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) { bitmap.close(); return null; }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const sr = computeSkinRatio(ctx, canvas.width, canvas.height);
      const vr = computeViolenceRatio(ctx, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/jpeg', SAMPLE_QUALITY), skinRatio: sr, violenceRatio: vr };
    }
  } catch {
    // Fall through to the Safari-safe <img> decoder below.
  }
  try {
    const url = URL.createObjectURL(blob);
    trackUrl(url);
    const bmp = await withTimeout((signal) => {
      // Safari-safe path: <img> covers bitmaps that decodeImageBitmap misses.
      const img = new Image();
      img.src = url;
      const done = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode'));
        signal.addEventListener('abort', () => reject(new Error('timeout')));
      });
      return done.then(() => img);
    }, SAMPLE_TIMEOUT_MS);
    const w = (bmp as HTMLImageElement).naturalWidth || 0;
    const h = (bmp as HTMLImageElement).naturalHeight || 0;
    if (!w || !h) return null;
    const scale = Math.min(1, SAMPLE_LONG_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp as HTMLImageElement, 0, 0, canvas.width, canvas.height);
    const sr2 = computeSkinRatio(ctx, canvas.width, canvas.height);
    const vr2 = computeViolenceRatio(ctx, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', SAMPLE_QUALITY), skinRatio: sr2, violenceRatio: vr2 };
  } catch {
    return null;
  }
}

/** Grab frames near 12% / 45% / 75% of a video for the server-side eye. */
async function sampleVideo(blob: Blob): Promise<{ url: string; skinRatio: number; violenceRatio: number }[]> {
  const out: { url: string; skinRatio: number; violenceRatio: number }[] = [];
  try {
    const url = URL.createObjectURL(blob);
    trackUrl(url);
    const video = document.createElement('video');
    video.muted = true;
    (video as unknown as { playsInline?: boolean }).playsInline = true;
    // Metadata + seeks are enough for moderation and avoid asking the browser
    // to buffer a multi-gigabyte local recording.
    video.preload = 'metadata';
    video.src = url;
    video.load();
    const dur = await withTimeout((signal) => new Promise<number>((resolve, reject) => {
      video.onloadedmetadata = () => resolve(video.duration || 0);
      video.onerror = () => reject(new Error('meta'));
      signal.addEventListener('abort', () => reject(new Error('timeout')));
    }), SAMPLE_TIMEOUT_MS);
    if (!dur || !isFinite(dur)) return out;
    const fractions = [0.02, 0.12, 0.25, 0.4, 0.55, 0.7, 0.82, 0.92];
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return out;
    for (const f of fractions) {
      if (out.length >= MAX_SAMPLES) break;
      try {
        await withTimeout((signal) => new Promise<void>((resolve, reject) => {
          const onSeeked = () => { cleanup(); resolve(); };
          const onErr = () => { cleanup(); reject(new Error('seek')); };
          const cleanup = () => {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onErr);
            signal.removeEventListener('abort', onErr);
          };
          signal.addEventListener('abort', onErr);
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('error', onErr);
          video.currentTime = Math.min(dur * f, Math.max(0, dur - 0.05));
        }), SAMPLE_TIMEOUT_MS);
        const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
        if (!vw || !vh) continue;
        const scale = Math.min(1, SAMPLE_LONG_EDGE / Math.max(vw, vh));
        canvas.width = Math.max(1, Math.round(vw * scale));
        canvas.height = Math.max(1, Math.round(vh * scale));
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const jpeg = canvas.toDataURL('image/jpeg', SAMPLE_QUALITY);
        if (jpeg && jpeg.length > 200) {
           const sr = computeSkinRatio(ctx, canvas.width, canvas.height);
           const vr = computeViolenceRatio(ctx, canvas.width, canvas.height);
           out.push({ url: jpeg, skinRatio: sr, violenceRatio: vr });
         }
      } catch { /* frame skip */ }
    }
    try { video.pause(); } catch { /* ignore */ }
  } catch { /* best effort */ }
  return out.slice(0, MAX_SAMPLES);
}

/**
 * Screen one file. Returns 'allow' only when nothing trips the gate.
 * 'review' and 'block' are treated the same on the Create page: the file is
 * refused with a warning (per policy: such content is simply not allowed).
 */
export async function screenMedia(
  file: Blob,
  opts: { kind?: string; caption?: string } = {},
): Promise<ScreenResult> {
  const filename = (file as File).name || '';
  const lower = filename.toLowerCase();

  // Instant local rejections (zero network) for obvious cases.
  for (const re of NAME_BLOCK_PATTERNS) {
    if (re.test(lower)) {
      return {
        verdict: 'block',
        category: /csam|rape|bestiality/.test(lower) ? 'exploitative' : 'adult',
        message: 'This file looks like adult, violent or otherwise prohibited content. It cannot be posted on Equyvo.',
        checked: false,
      };
    }
  }
  // Executables / code files never belong in a media slot.
  if (/\.(exe|apk|bat|msi|scr|js|html|mjs|sh|jar)(\b|$)/i.test(lower)) {
    return {
      verdict: 'block',
      category: 'illegal',
      message: 'Program files are not allowed here. Only photos, videos, documents and audio can be posted.',
      checked: false,
    };
  }

  const inferred = inferMimeType(file as any);
  // Security: verify real bytes, not just name/type.
  try {
    const head = await (file as Blob).slice(0, 64).arrayBuffer();
    const detected = detectMimeFromBytes(head);
    if (detected && !isAllowedMime(detected)) {
      return {
        verdict: 'block',
        category: 'illegal',
        message: 'This file type is not allowed on Equyvo. Only photos, videos and audio can be posted.',
        checked: true,
      };
    }
  } catch { /* best-effort */ }

  // GIFs are animated images: screen them like any other image (first frame
  // + skin-tone guard + server-side vision). Previously GIFs were skipped,
  // leaving a hole for prohibited animated content.
  const isImage = inferred.startsWith('image/');
  const isVideo = inferred.startsWith('video/');
  const samples: string[] = [];
  const skinRatios: number[] = [];
  const violenceRatios: number[] = [];
  if (isImage) {
    const s = await sampleImage(file);
    if (s) { samples.push(s.dataUrl); skinRatios.push(s.skinRatio); violenceRatios.push(s.violenceRatio); }
  } else if (isVideo) {
    for (const s of await sampleVideo(file)) { samples.push(s.url); skinRatios.push(s.skinRatio); violenceRatios.push(s.violenceRatio); }
  }

  // Sampling is best-effort. If the browser cannot decode the media (unusual
  // codec/container, very large file, memory pressure) we do NOT hard-block:
  // filename + MIME + text checks above still apply, and the server re-runs
  // the full safety stack at publish time. Hard-blocking here caused legitimate
  // cooking/religious/educational uploads to be refused for decode hiccups.
  if ((isImage || isVideo) && samples.length === 0) {
    return { verdict: 'allow', checked: false };
  }
  // Heuristic nudity guard: a HIGH skin-tone ratio indicates likely 18+
  // content. Thresholds are deliberately conservative to avoid false
  // positives on ordinary footage (crowds, religious/cultural events,
  // outdoor scenes) while still catching overt nudity. Videos need a higher
  // bar because a single skin-heavy frame is common in legitimate footage.
  const maxSkin = skinRatios.length ? Math.max(...skinRatios) : 0;
  // Raised thresholds: nudity is usually >0.8 skin coverage; ordinary crowds,
  // religious/cultural events and outdoor scenes can hit 0.5-0.7. Only block
  // when skin dominates the frame.
  // Only treat as a hard block when skin coverage is extreme. Mid-range
  // values are passed to the server-side eye (with a hint) instead of
  // blocking outright, so legitimate skin-heavy footage (cooking, sports,
  // religious/cultural events) is not refused on a heuristic alone.
  const skinHardBlock = isVideo ? 0.75 : 0.7;
  if (maxSkin >= skinHardBlock) {
    return {
      verdict: 'block',
      category: 'adult',
      message: 'This content looks like adult (18+) material and is not allowed on Equyvo.',
      checked: true,
    };
  }
  // Violence/terrorism heuristic: concentrated red/fire regions indicate
  // blood, explosions or weapons. Block such content outright.
  const maxViolence = violenceRatios.length ? Math.max(...violenceRatios) : 0;
  // Raised threshold: ordinary cooking (fire, red meat/tomatoes) and sports
  // can trigger the red/fire heuristic at ~0.1-0.25. Only block when violence
  // colors dominate a large share of the frame.
  // Hard block only when violence colors dominate most of the frame. Mid-range
  // values are forwarded as a hint for the server-side eye.
  if (maxViolence >= 0.4) {
    return {
      verdict: 'block',
      category: 'violent',
      message: 'This content looks like violent or otherwise prohibited material and is not allowed on Equyvo.',
      checked: true,
    };
  }

  // Ask the shared safety gate. Network failures fail OPEN (allow) — the
  // server still runs its full check again at publish time and quarantines.
  try {
    // Attach auth headers so the server-side safety gate actually runs
    // (without them /api/content-screen returns 401 and screening is skipped).
    const authHeaders: Record<string, string> = {};
    try {
      const stored = localStorage.getItem('equyvo_cognito_user');
      if (stored) {
        const u = JSON.parse(stored);
        const id = u?.id || u?.email || '';
        if (id) authHeaders['X-User-Id'] = String(id);
      }
      const token = localStorage.getItem('equyvo_cognito_token');
      if (token) authHeaders['Authorization'] = 'Bearer ' + token;
    } catch { /* ignore */ }
    const res = await withTimeout((signal) => fetch(resolveApiBase() + '/content-screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        kind: String(opts.kind || '').slice(0, 40),
        filename: filename.slice(0, 120),
        caption: String(opts.caption || '').slice(0, 400),
        samples,
        clientHints: { maxSkin: maxSkin, maxViolence: maxViolence },
      }),
      signal,
    }), SAMPLE_TIMEOUT_MS + 4000);
    if (res.status === 401 || res.status === 403) {
       // Auth hiccup: fail open so uploads aren't blocked by a screening
       // round-trip that couldn't authenticate. The server still enforces
       // policy at publish time.
       return { verdict: 'allow', checked: false };
     }
     if (!res.ok) return { verdict: 'allow', checked: false };
    const data = await res.json().catch(() => null);
    const d = data && data.data ? data.data : data;
    if (!d) return { verdict: 'allow', checked: false };
    const verdict: ScreenVerdict = d.verdict === 'block' ? 'block' : d.verdict === 'review' ? 'review' : 'allow';
    if (verdict === 'allow') return { verdict: 'allow', checked: d.checked !== false };
    const raw = String(d.category || '');
    const category = (['adult', 'violent', 'exploitative', 'illegal', 'spam'].includes(raw) ? raw : 'unspecified') as ScreenResult['category'];
    return {
      verdict,
      category,
      checked: true,
      message: d.message || 'This content looks unsafe (adult, violent, exploitative or otherwise prohibited). Equyvo will not post it.',
    };
  } catch {
    return { verdict: 'allow', checked: false };
  }
}
