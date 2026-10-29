// Persistent store for scheduled posts and drafts.
//
// Scheduled posts and drafts must survive app restarts / page reloads and
// device kills, so we keep the FULL record (including File/Blob media) in
// IndexedDB — localStorage cannot hold Blobs and would silently drop them.
// A lightweight mirror is NOT kept in localStorage; CreatePage loads/saves
// through these helpers and re-renders from the returned records.
const DB_NAME = 'equyvo_scheduled_v1';
const DB_VERSION = 1;
const STORE_SCHEDULED = 'scheduled';
const STORE_DRAFTS = 'drafts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SCHEDULED)) {
        db.createObjectStore(STORE_SCHEDULED, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function readAll(storeName: string): Promise<any[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
    req.onerror = () => reject(req.error || new Error('read failed'));
    tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } };
  });
}

async function replaceAll(storeName: string, items: any[]): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.clear();
    for (const item of items || []) {
      try { store.put(item); } catch { /* skip unserialisable */ }
    }
    tx.oncomplete = () => { try { db.close(); } catch { /* ignore */ } resolve(); };
    tx.onerror = () => { try { db.close(); } catch { /* ignore */ } reject(tx.error || new Error('write failed')); };
    tx.onabort = () => { try { db.close(); } catch { /* ignore */ } reject(tx.error || new Error('write aborted')); };
  });
}

export async function loadScheduled(): Promise<any[]> {
  try { return await readAll(STORE_SCHEDULED); } catch { return []; }
}

export async function saveScheduled(items: any[]): Promise<void> {
  try { await replaceAll(STORE_SCHEDULED, items); } catch { /* best-effort */ }
}

export async function loadDrafts(): Promise<any[]> {
  try { return await readAll(STORE_DRAFTS); } catch { return []; }
}

export async function saveDrafts(items: any[]): Promise<void> {
  try { await replaceAll(STORE_DRAFTS, items); } catch { /* best-effort */ }
}
