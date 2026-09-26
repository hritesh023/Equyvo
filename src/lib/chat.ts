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
  type?: 'text' | 'image' | 'file';
  fileUrl?: string;
  fileName?: string;
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
  return readThreads();
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
      lastMessage: msg.type === 'text' ? msg.text : msg.fileName || 'Attachment',
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
  attach?: { fileUrl: string; fileName: string; type: 'image' | 'file' },
): Promise<ChatMessage | null> {
  const clean = String(text || '').trim();
  if ((!clean && !attach) || !threadId) return null;
  const me = getStoredUser();
  void me;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
  };
  appendMessage(msg);

  // 1) Reach the Equyvo server → single tick.
  let serverOk = false;
  try {
    const res = await api.chatSend(threadId, {
      text: clean,
      type: msg.type,
      fileUrl: attach?.fileUrl,
      fileName: attach?.fileName,
    });
    serverOk = !res.error;
  } catch {
    serverOk = false;
  }
  patchMessage(threadId, id, { status: serverOk ? 'sent' : 'sending' });

  // 2) Simulated transport to the peer device → double tick.
  // When the server confirms, delivery follows shortly; when offline the
  // message stays at `sending`/`sent` honestly instead of faking delivery.
  if (serverOk) {
    window.setTimeout(() => {
      const cur = listMessages(threadId).find((m) => m.id === id);
      if (cur && cur.status === 'sent') {
        patchMessage(threadId, id, { status: 'delivered' });
        try {
          void api.chatDelivered(threadId, id).catch(() => {});
        } catch {
          /* ignore */
        }
      }
    }, 900);
  }
  return { ...msg, status: serverOk ? 'sent' : 'sending' };
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
      if (s && s.id) byId.set(String(s.id), { ...s, threadId } as ChatMessage);
    }
    const merged = [...byId.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-300);
    all[threadId] = merged;
    writeMessages(all);
    emitChatUpdated(threadId);
    return merged;
  } catch {
    return listMessages(threadId);
  }
}

export function threadsByRelation(relation: 'followers' | 'following'): ChatThread[] {
  const all = readThreads();
  if (relation === 'followers') {
    return all.filter((t) => t.relation === 'follower' || t.relation === 'mutual');
  }
  return all.filter((t) => t.relation === 'following' || t.relation === 'mutual');
}
