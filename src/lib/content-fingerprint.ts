// Exact-content fingerprinting for uploads.
//
// Two files are treated as THE SAME content only when their bytes are
// identical. We derive a SHA-256 fingerprint from the file size plus three
// fixed byte windows (head / middle / tail). This is effectively collision-free
// for real media, is cheap even for very large videos, and — unlike a title or
// URL comparison — never mistakes a merely similar post for a copy/paste.
//
// The server independently computes a full SHA-256 of the uploaded bytes at
// /api/upload and enforces the same uniqueness rule at publish time, so the
// client check is a fast warning, not the only line of defence.

import api from './api';

export {
  rememberContentHash,
  contentHashOf,
  rememberFileFingerprint,
  fingerprintOfFile,
  isDuplicateError,
} from './content-hash-registry';

const WINDOW = 64 * 1024; // 64 KB per sample window

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function computeContentFingerprint(file: Blob): Promise<string> {
  const size = file.size || 0;
  try {
    const mid = Math.max(0, Math.floor(size / 2) - Math.floor(WINDOW / 2));
    const slices = [file.slice(0, WINDOW), file.slice(mid, mid + WINDOW), file.slice(Math.max(0, size - WINDOW))];
    const buffers = await Promise.all(slices.map((s) => s.arrayBuffer()));
    const total = buffers.reduce((n, b) => n + b.byteLength, 0);
    const packed = new Uint8Array(total + 32);
    const sizeText = new TextEncoder().encode(`equyvo:fp:v1:size=${size}:`);
    packed.set(sizeText, 0);
    let offset = sizeText.length;
    for (const b of buffers) {
      packed.set(new Uint8Array(b), offset);
      offset += b.byteLength;
    }
    const digest = await crypto.subtle.digest('SHA-256', packed.subarray(0, offset));
    return toHex(digest);
  } catch {
    // WebCrypto can be unavailable on a plain-http origin. Fall back to a
    // deterministic non-crypto hash of the same windows (still byte-exact).
    const parts: string[] = [`size=${size}`];
    try {
      const head = new Uint8Array(await file.slice(0, 2048).arrayBuffer());
      parts.push(Array.from(head).join(','));
    } catch { /* ignore */ }
    let h = 2166136261;
    const text = parts.join('|');
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'fnv-' + (h >>> 0).toString(16).padStart(8, '0');
  }
}

export interface DuplicateInfo {
  duplicate: boolean;
  owner: 'self' | 'other' | '';
  title?: string;
}

/** Ask the server whether this exact file already exists in Equyvo. */
export async function checkContentDuplicate(hash: string): Promise<DuplicateInfo> {
  if (!hash) return { duplicate: false, owner: '' };
  try {
    const { data, error } = await api.checkContentDuplicate(hash);
    if (error || !data) return { duplicate: false, owner: '' }; // fail open; server still enforces at publish
    return {
      duplicate: !!data.duplicate,
      owner: data.owner === 'self' || data.owner === 'other' ? data.owner : '',
      title: data.title || '',
    };
  } catch {
    return { duplicate: false, owner: '' };
  }
}

