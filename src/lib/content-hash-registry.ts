// Dependency-free registry linking delivery URLs to the byte fingerprint
// returned by /api/upload, plus duplicate-error helpers. Kept separate from
// the upload/network layer so both api.ts and the composer can use it without
// creating a circular import.

const HASH_BY_URL = new Map<string, string>();
const FP_BY_FILE = new WeakMap<object, string>();

/** Remember the fingerprint computed when the user picked this exact file. */
export function rememberFileFingerprint(file: object, fp: string): void {
  if (file && fp) FP_BY_FILE.set(file, fp);
}

export function fingerprintOfFile(file: unknown): string {
  if (!file || (typeof file !== 'object' && typeof file !== 'function')) return '';
  return FP_BY_FILE.get(file as object) || '';
}

export function rememberContentHash(urls: Array<string | null | undefined>, hash?: string): void {
  if (!hash) return;
  for (const raw of urls) {
    if (!raw) continue;
    const url = String(raw);
    HASH_BY_URL.set(url, hash);
    try {
      const marker = '/api/media/';
      const i = url.indexOf(marker);
      if (i >= 0) HASH_BY_URL.set(url.slice(i + marker.length).split('?')[0], hash);
    } catch { /* ignore */ }
  }
}

export function contentHashOf(content: Record<string, unknown>): string {
  const direct = String((content as any).contentHash || (content as any).sha256 || '');
  if (direct) return direct;
  const candidates: unknown[] = [
    (content as any).videoUrl,
    (content as any).media,
    (content as any).image,
    (content as any).thumbnail,
  ];
  const media = (content as any).media;
  if (Array.isArray(media)) candidates.push(...media.map((m: any) => m?.url || m?.secureUrl || m));
  else if (media && typeof media === 'object') candidates.push((media as any).url, (media as any).secureUrl);
  for (const c of candidates) {
    if (!c) continue;
    const hit = HASH_BY_URL.get(String(c));
    if (hit) return hit;
  }
  return ''
}

export function isDuplicateError(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | string | null | undefined;
  const code = typeof e === 'string' ? e : String(e?.code || '');
  const msg = typeof e === 'string' ? e : String(e?.message || '');
  return code.includes('DUPLICATE') || /already uploaded|already posted|exact (copy|duplicate)/i.test(msg);
}
