// Infer a usable MIME type from a File/Blob when the browser leaves
// `type` empty (common on Android/WebView for camera-roll picks) or reports
// a generic octet-stream. Falls back to the raw type, then octet-stream.
const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus',
};

export function inferMimeType(file: Blob | File | null | undefined): string {
  try {
    const raw = (file as any)?.type;
    if (typeof raw === 'string' && raw.trim() && raw.trim().toLowerCase() !== 'application/octet-stream') {
      return raw.trim();
    }
    const name = String((file as any)?.name || '');
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
      const ext = name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
    }
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  } catch { /* ignore */ }
  return 'application/octet-stream';
}

export function isImageFile(file: Blob | File | null | undefined): boolean {
  return inferMimeType(file).startsWith('image/');
}

export function isVideoFile(file: Blob | File | null | undefined): boolean {
  return inferMimeType(file).startsWith('video/');
}

export function isAudioFile(file: Blob | File | null | undefined): boolean {
  return inferMimeType(file).startsWith('audio/');
}

export function isMediaFile(file: Blob | File | null | undefined): boolean {
  const t = inferMimeType(file);
  return t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/');
}

export function detectMimeFromBytes(bytes: ArrayBuffer | Uint8Array | null | undefined): string {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (b.length < 4) return '';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const brand = String.fromCharCode(b[8]||0, b[9]||0, b[10]||0, b[11]||0);
      if (/heic|heix|mif1|msf1|hevc|hevx/.test(brand)) return 'image/heic';
      if (brand === 'qt  ') return 'video/quicktime';
      if (/M4A |M4B |M4P /.test(brand)) return 'audio/mp4';
      if (/isom|iso2|mp41|mp42|avc1|mp4v/.test(brand)) return 'video/mp4';
    }
    if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'video/webm';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 && b[11] === 0x20) return 'video/x-msvideo';
    if (b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
    if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg';
    if (b[0] === 0xFF && (b[1] === 0xFB || b[1] === 0xF3 || b[1] === 0xF2)) return 'audio/mpeg';
    if (b[0] === 0xFF && (b[1] === 0xF1 || b[1] === 0xF9)) return 'audio/aac';
  } catch { /* ignore */ }
  return '';
}

const CLIENT_ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/'];
export function isAllowedMime(mime: string): boolean {
  const t = String(mime || '').trim().toLowerCase();
  return CLIENT_ALLOWED_MIME_PREFIXES.some((p) => t.startsWith(p));
}
