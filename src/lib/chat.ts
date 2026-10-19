// ── Equyvo chat store: WhatsApp-style threads with ticks + seen ─────────────
// Two internal tabs: Followers (people who follow me — they can message me)
// and Following (people I follow — I can message them).
// Outgoing ticks: sending → sent (single tick, reached server) → delivered
// (double tick) → seen ("Seen" label under the bubble). Incoming messages
// never show ticks and render in a different bubble colour.

import { getStoredUser } from './auth';
import api from './api';

export type ChatStatus = 'sending' | 'sent' | 'delivered' | 'seen';
export type ChatRelation = 'follower' | 'following' | 'mutual';

export interface ChatMessage {
  id: string;
  threadId: string;
  text: string;
  fromMe: boolean;
  /** Only meaningful for outgoing messages. Incoming messages omit ticks. */
  status?: ChatStatus;
  timestamp: string;
  createdAt: number;
  type?: 'text' | 'image' | 'file' | 'audio';
  fileUrl?: string;
  fileName?: string;
  /** Voice notes: length in seconds (sender-computed, server echoed). */
  durationSec?: number;
  deletedForEveryone?: boolean;
  deletedFor?: string[];
  e2e?: boolean;
}

export interface ChatThread {
  id: string;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  relation: ChatRelation;
  online: boolean;
  lastMessage: string;
  timestamp: string;
  unread: number;
}

const THREADS_KEY = 'equyvo_chat_v2_threads';
const MESSAGES_KEY = 'equyvo_chat_v2_messages';

// --- Lightweight end-to-end encryption (client-side AES-GCM) ---
const E2E_PREFIX = 'e2e:';

const E2E_SALT = 'equyvo-e2e-v1::';

function materialToKey(material: string): Promise<CryptoKey> {
  const enc = new TextEncoder().encode(E2E_SALT + String(material));
  return crypto.subtle.digest('SHA-256', enc).then((digest) =>
    crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
  );
}

/**
 * The shared thread key BOTH participants derive the same way:
 * sorted (self id, peer id) pair. This is what makes incoming E2E payloads
 * decryptable on the recipient's device — unlike a key derived from only the
 * thread id (which is the peer id on each side and therefore disagrees).
 */
async function sharedPairKey(threadId: string): Promise<CryptoKey> {
  const me = getStoredUser();
  const self = String(me?.id || me?.email || '');
  const pair = [self, String(threadId)].sort().join('::');
  return materialToKey(pair);
}

// Legacy keys kept as decrypt fallbacks so messages sent before the pair-key
// fix can still be decoded when the other side ever used them.
async function legacyKeys(threadId: string): Promise<CryptoKey[]> {
  const me = getStoredUser();
  const self = String(me?.id || me?.email || '');
  const keys: Promise<CryptoKey>[] = [materialToKey(String(threadId))];
  if (self) keys.push(materialToKey(self));
  const out = await Promise.all(keys);
  return out;
}

export async function encryptText(threadId: string, plain: string): Promise<string> {
  if (!plain) return '';
  try {
    const key = await sharedPairKey(threadId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    const buf = new Uint8Array(iv.byteLength + ct.byteLength);
    buf.set(iv, 0);
    buf.set(new Uint8Array(ct), iv.byteLength);
    let bin = '';
    for (let i = 0; i < buf.byteLength; i++) bin += String.fromCharCode(buf[i]);
    return E2E_PREFIX + btoa(bin);
  } catch {
    return plain;
  }
}

export async function decryptText(threadId: string, value: string): Promise<string> {
  if (!value || !value.startsWith(E2E_PREFIX)) return value;
  let raw: string;
  try {
    raw = atob(value.slice(E2E_PREFIX.length));
  } catch {
    return '';
  }
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const tryKeys: CryptoKey[] = [];
  try { tryKeys.push(await sharedPairKey(threadId)); } catch { /* ignore */ }
  try { tryKeys.push(...await legacyKeys(threadId)); } catch { /* ignore */ }
  for (const key of tryKeys) {
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new TextDecoder().decode(pt);
    } catch { /* try next key */ }
  }
  // Unreadable E2E payload: never leak the ciphertext blob to the user.
  return '[Encrypted message]';
}

function nowTime(): string {
  try {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function readThreads(): ChatThread[] {
  try {
    const raw = localStorage.getItem(THREADS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeThreads(list: ChatThread[]): void {
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(list.slice(0, 300)));
  } catch {
    /* ignore */
  }
}

function readMessages(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function writeMessages(all: Record<string, ChatMessage[]>): void {
  try {
    const trimmed: Record<string, ChatMessage[]> = {};
    for (const [k, v] of Object.entries(all)) {
      trimmed[k] = Array.isArray(v) ? v.slice(-300) : [];
    }
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore */
  }
}

export function emitChatUpdated(threadId?: string): void {
  try {
    window.dispatchEvent(new CustomEvent('chatUpdated', { detail: { threadId } }));
  } catch {
    /* ignore */
  }
}

function upsertThread(t: ChatThread): ChatThread[] {
  const list = readThreads();
  const ix = list.findIndex((x) => x.id === t.id);
  const next = ix >= 0 ? list.map((x, i) => (i === ix ? { ...x, ...t } : x)) : [t, ...list];
  writeThreads(next);
  return next;
}

export function listThreads(): ChatThread[] {
  return readThreads().filter((t) => {
    const name = String(t.peerName || '').toLowerCase();
    const id = String(t.id || t.peerId || '').toLowerCase();
    return name && name !== 'user' && name !== 'users' && id && id !== 'user' && id !== 'users';
  });
}

export function listMessages(threadId: string): ChatMessage[] {
  const all = readMessages();
  return all[threadId] || [];
}

/** Ensure a thread exists for a social peer (idempotent). */
export function ensureThread(peer: { id: string; name: string; avatar?: string }, relation: ChatRelation): ChatThread {
  const id = String(peer.id || peer.name);
  const existing = readThreads().find((t) => t.id === id);
  if (existing) {
    const merged: ChatThread = {
      ...existing,
      peerName: peer.name || existing.peerName,
      peerAvatar: peer.avatar ?? existing.peerAvatar,
      relation,
    };
    upsertThread(merged);
    return merged;
  }
  const t: ChatThread = {
    id,
    peerId: String(peer.id || peer.name),
    peerName: peer.name || String(peer.id),
    peerAvatar: peer.avatar || '',
    relation,
    online: false,
    lastMessage: '',
    timestamp: nowTime(),
    unread: 0,
  };
  upsertThread(t);
  return t;
}

/** Seed threads from follower/following lists (merges, never wipes history). */
export function syncThreadsFromSocial(
  followers: { id: string; name: string; avatar?: string }[],
  following: { id: string; name: string; avatar?: string }[],
): ChatThread[] {
  const followerIds = new Set(followers.map((f) => String(f.id).toLowerCase()));
  const followingIds = new Set(following.map((f) => String(f.id).toLowerCase()));
  for (const f of followers) {
    const rel: ChatRelation = followingIds.has(String(f.id).toLowerCase()) ? 'mutual' : 'follower';
    ensureThread({ id: String(f.id), name: String(f.name || f.id), avatar: f.avatar }, rel);
  }
  for (const f of following) {
    if (followerIds.has(String(f.id).toLowerCase())) {
      ensureThread({ id: String(f.id), name: String(f.name || f.id), avatar: f.avatar }, 'mutual');
      continue;
    }
    ensureThread({ id: String(f.id), name: String(f.name || f.id), avatar: f.avatar }, 'following');
  }
  // Refresh mutual flags on existing threads.
  const list = readThreads().map((t) => {
    const k = t.peerId.toLowerCase();
    const isFollower = followerIds.has(k) || t.relation === 'follower' || t.relation === 'mutual';
    const isFollowing = followingIds.has(k) || t.relation === 'following' || t.relation === 'mutual';
    const relation: ChatRelation = isFollower && isFollowing ? 'mutual' : isFollower ? 'follower' : isFollowing ? 'following' : t.relation;
    return { ...t, relation };
  });
  writeThreads(list);
  emitChatUpdated();
  return list;
}

function appendMessage(msg: ChatMessage): void {
  const all = readMessages();
  const arr = all[msg.threadId] || [];
  arr.push(msg);
  all[msg.threadId] = arr.slice(-300);
  writeMessages(all);
  const threads = readThreads();
  const ix = threads.findIndex((t) => t.id === msg.threadId);
  if (ix >= 0) {
    threads[ix] = {
      ...threads[ix],
      lastMessage: msg.type === 'text' ? msg.text : msg.type === 'audio' ? 'Voice message' : msg.fileName || 'Attachment',
      timestamp: msg.timestamp,
      unread: msg.fromMe ? threads[ix].unread : threads[ix].unread + 1,
    };
    writeThreads(threads);
  }
  emitChatUpdated(msg.threadId);
}

function patchMessage(threadId: string, id: string, patch: Partial<ChatMessage>): void {
  const all = readMessages();
  const arr = all[threadId] || [];
  const ix = arr.findIndex((m) => m.id === id);
  if (ix < 0) return;
  arr[ix] = { ...arr[ix], ...patch };
  all[threadId] = arr;
  writeMessages(all);
  emitChatUpdated(threadId);
}

/**
 * Send a message. Tick lifecycle:
 *  - `sending` (clock) → `sent` (single tick: reached Equyvo server)
 *  - `sent` → `delivered` (double tick: reached the peer device)
 *  - `delivered` → `seen` (peer opened the chat; "Seen" label under bubble)
 * Server sync is best-effort; ticks still progress locally so the UI is honest
 * about what is confirmed vs pending.
 */
export async function sendChatMessage(
  threadId: string,
  text: string,
  attach?: { fileUrl: string; fileName: string; type: 'image' | 'file' | 'audio'; durationSec?: number },
): Promise<ChatMessage | null> {
  const clean = String(text || '').trim();
  if ((!clean && !attach) || !threadId) return null;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const wireText = clean ? await encryptText(threadId, clean) : '';
  const msg: ChatMessage = {
    id,
    threadId,
    text: clean,
    fromMe: true,
    status: 'sending',
    timestamp: nowTime(),
    createdAt: Date.now(),
    type: attach ? attach.type : 'text',
    fileUrl: attach?.fileUrl,
    fileName: attach?.fileName,
    durationSec: attach?.durationSec,
    e2e: !!clean,
  };
  appendMessage(msg);

  // 1) Reach the Equyvo server → single tick.
  let serverOk = false;
  let serverId = id;
  try {
    const res = await api.chatSend(threadId, {
      id,
      text: wireText,
      type: msg.type,
      fileUrl: attach?.fileUrl,
      fileName: attach?.fileName,
      durationSec: attach?.durationSec,
    });
    serverOk = !res.error;
    if (res?.data?.id) serverId = String(res.data.id);
  } catch {
    serverOk = false;
  }
  if (serverId !== id) {
    const all = readMessages();
    const arr = all[threadId] || [];
    const ix = arr.findIndex((m) => m.id === id);
    if (ix >= 0) {
      arr[ix] = { ...arr[ix], id: serverId };
      all[threadId] = arr;
      writeMessages(all);
    }
  }
  patchMessage(threadId, serverId, { status: serverOk ? 'sent' : 'sending' });

  // 2) The double tick is NOT simulated here — it is earned. 'delivered'
  //    only lands when the PEER's device actually pulls the message (their
  //    app is open and online) and the server flips the status; 'seen' lands
  //    when the peer opens the chat (/seen). Both reach this device through
  //    the next poll (see ChatSidebar's pull interval), never before the
  //    peer's device has truly received the message.
  return { ...msg, id: serverId, status: serverOk ? 'sent' : 'sending' };
}

/** Mark a thread as seen by me: clears unread + tells the server (best-effort). */
export function markThreadSeen(threadId: string): void {
  if (!threadId) return;
  const threads = readThreads();
  const ix = threads.findIndex((t) => t.id === threadId);
  if (ix >= 0 && threads[ix].unread !== 0) {
    threads[ix] = { ...threads[ix], unread: 0 };
    writeThreads(threads);
    emitChatUpdated(threadId);
  }
  try {
    void api.chatSeen(threadId).catch(() => {});
  } catch {
    /* ignore */
  }
  // Incoming messages have no ticks; outgoing ones from the peer stay as-is
  // locally until the peer's device reports seen via polling.
}

/** Called when the peer reports they saw my messages (polling / push). */
export function markMyMessagesSeen(threadId: string): void {
  const all = readMessages();
  const arr = all[threadId] || [];
  let changed = false;
  for (const m of arr) {
    if (m.fromMe && (m.status === 'sent' || m.status === 'delivered')) {
      m.status = 'seen';
      changed = true;
    }
  }
  if (changed) {
    all[threadId] = arr;
    writeMessages(all);
    emitChatUpdated(threadId);
  }
}

/** Pull server messages for a thread and merge (server wins on id clash). */
export async function pullThreadMessages(threadId: string): Promise<ChatMessage[]> {
  try {
    const res = await api.chatMessages(threadId);
    const items = (res as { data?: { messages?: ChatMessage[] } }).data?.messages;
    if (res.error || !Array.isArray(items)) return listMessages(threadId);
    const all = readMessages();
    const local = all[threadId] || [];
    const byId = new Map(local.map((m) => [m.id, m]));
    for (const s of items) {
      if (s && s.id) {
        const m = { ...s, threadId } as ChatMessage;
        // Decrypt end-to-end payload for display.
        if (m.text) {
          try { m.text = await decryptText(threadId, String(m.text)); } catch { /* keep */ }
        }
        // Mark e2e if it was encrypted on the wire.
        if (typeof s.text === 'string' && s.text.startsWith('e2e:')) m.e2e = true;
        byId.set(String(s.id), m);
      }
    }
    // Drop messages deleted for the current user.
    const me = getStoredUser();
    const myId = me ? String(me.id || me.email || '') : '';
    const filtered = [...byId.values()].filter((m) => !(Array.isArray(m.deletedFor) && myId && m.deletedFor.includes(myId)));
    const merged = filtered.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-300);
    all[threadId] = merged;
    writeMessages(all);
    emitChatUpdated(threadId);
    return merged;
  } catch {
    return listMessages(threadId);
  }
}

export async function deleteChatMessage(threadId: string, messageId: string, forEveryone?: boolean): Promise<void> {
  if (!threadId || !messageId) return;
  try {
    await api.chatDelete(threadId, messageId, !!forEveryone);
  } catch {
    /* best-effort */
  }
  const all = readMessages();
  const arr = all[threadId] || [];
  const ix = arr.findIndex((m) => m.id === messageId);
  if (ix >= 0) {
    if (forEveryone) {
      arr[ix] = { ...arr[ix], deletedForEveryone: true, text: '', fileUrl: undefined, fileName: undefined };
    } else {
      arr.splice(ix, 1);
    }
    all[threadId] = arr;
    writeMessages(all);
  }
  emitChatUpdated(threadId);
}

export function threadsByRelation(relation: 'followers' | 'following'): ChatThread[] {
  const all = readThreads();
  if (relation === 'followers') {
    return all.filter((t) => t.relation === 'follower' || t.relation === 'mutual');
  }
  return all.filter((t) => t.relation === 'following' || t.relation === 'mutual');
}
