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
