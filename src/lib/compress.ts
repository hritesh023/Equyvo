// Client-side media compression helpers.
//
// Goal: shrink anything the user uploads BEFORE it hits the network / R2
// warehouse, so storage cost stays flat until truly massive usage. Images are
// re-encoded to WebP with a sane max dimension + quality. Videos are passed
// through untouched here (browser transcoding needs WebCodecs + heavy CPU);
// the server still enforces per-plan caps and dedupes by content hash.

export interface CompressOptions {
  maxDimension?: number;
  quality?: number; // 0..1
  mimeType?: string;
}

const DEFAULTS: Required<CompressOptions> = {
  // Keep visuals essentially original (high quality, large max dimension) while
  // still shrinking bytes for R2 storage. Lossless gzip on the server handles
  // the rest.
  maxDimension: 2560,
  quality: 0.92,
  mimeType: 'image/webp',
};

export async function compressImage(
  file: File | Blob,
  opts: CompressOptions = {},
): Promise<File | Blob> {
  const { maxDimension, quality, mimeType } = { ...DEFAULTS, ...opts };
  if (typeof createImageBitmap !== 'function') return file;
  if (!file.type || !file.type.startsWith('image/')) return file;
  // Skip tiny files — compression overhead isn't worth it.
  if (file.size < 64 * 1024) return file;
  // Skip animated GIFs (canvas flattens them).
  if (file.type === 'image/gif') return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), mimeType, quality);
    });
    if (!blob || blob.size >= file.size) return file; // never grow
    const name = (file as File).name ? (file as File).name.replace(/\.[^.]+$/, '') + '.webp' : 'upload.webp';
    return new File([blob], name, { type: mimeType, lastModified: Date.now() });
  } catch {
    return file;
  }
}

export async function compressMedia(file: File | Blob): Promise<File | Blob> {
  if (file.type && file.type.startsWith('image/')) {
    return compressImage(file);
  }
  // Videos: best-effort no-op client-side; server enforces caps.
  return file;
}

export function estimateSavings(original: number, compressed: number): number {
  if (original <= 0) return 0;
  return Math.max(0, 1 - compressed / original);
}