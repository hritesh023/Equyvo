// Single source of truth for locally-remembered deleted / hidden content.
// Kept dependency-free so every layer (api, feeds, pages, delete helper) can
// import it without creating a circular module graph. Once the owner confirms
// a delete, that id is marked here and EVERY surface must drop the item — a
// stale server row, a cached profile or a search index entry can never bring
// it back on a different page.

export const DELETED_KEY = 'equyvo_deleted_ids';
export const BLOCKED_KEY = 'equyvo_blocked_posts';

// Hardcoded titles/phrases of posts that must never render (e.g. stale
// server-side rows the owner cannot delete from the client).
export const BLOCKED_POST_PHRASES = ['parakram game'];

function readSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
}

function writeSet(key: string, set: Set<string>, cap = 500): void {
  try {
    localStorage.setItem(key, JSON.stringify([...set].slice(-cap)));
  } catch { /* storage unavailable — best effort */ }
}

/** True when an id was removed by the user (persisted locally). */
export function isDeletedContent(id: unknown): boolean {
  if (id === undefined || id === null || id === '') return false;
  try {
    return readSet(DELETED_KEY).has(String(id));
  } catch {
    return false;
  }
}

/**
 * Persist a deleted id and broadcast it. Call this from ANY delete path so
 * every mounted feed/page removes the item immediately and forever.
 */
export function markDeletedLocally(id: unknown, contentType = 'post'): void {
  const sid = String(id ?? '');
  if (!sid) return;
  try {
    const set = readSet(DELETED_KEY);
    set.add(sid);
    writeSet(DELETED_KEY, set);
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent('userPostDeleted', { detail: { postId: sid, contentType } }));
  } catch { /* ignore */ }
}

/** Remove a previously-recorded deletion (used only by a server rollback). */
export function unmarkDeletedLocally(id: unknown): void {
  const sid = String(id ?? '');
  if (!sid) return;
  try {
    const set = readSet(DELETED_KEY);
    set.delete(sid);
    writeSet(DELETED_KEY, set);
  } catch { /* ignore */ }
}

/** True for content that must be hidden everywhere (deleted or blocked). */
export function isBlockedContent(item: any): boolean {
  try {
    if (!item) return false;
    const id = String(item.id ?? item._id ?? '');
    if (isDeletedContent(id)) return true;
    // Persisted blocked ids/titles (hide-from-my-view style tombstones).
    const blocked = readSet(BLOCKED_KEY);
    const title = String(item.title || item.content || '').toLowerCase();
    for (const b of blocked) {
      const lb = b.toLowerCase();
      if (lb === id || lb === title) return true;
    }
    if (BLOCKED_POST_PHRASES.some((p) => title.includes(p.toLowerCase()))) return true;
    return false;
  } catch {
    return false;
  }
}

/** Drop deleted/blocked items from any list, at every API boundary. */
export function withoutDeleted<T extends { id?: string }>(items: T[]): T[] {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => !isBlockedContent(i));
}
