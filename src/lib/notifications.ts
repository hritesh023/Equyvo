// ── Equyvo notification center ──────────────────────────────────────────────
// In-app + system (Web Push / Notification API) notifications for:
//  - who requested to follow you (private accounts)
//  - who accepted your follow request
//  - who is live now
//  - new uploads from accounts you follow (only when Push is ON in Settings)
// Follow-request accept/decline actions live here so the bell dropdown is the
// one place to triage them.

import api from './api';

export type NotificationKind =
  | 'follow_request'
  | 'follow_accepted'
  | 'live'
  | 'upload'
  | 'chat'
  | 'report'
  | 'system';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  at: string;
  read: boolean;
  actorId?: string;
  actorName?: string;
  link?: string;
}

const KEY = 'equyvo_notifications_v1';

function readAll(): AppNotification[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeAll(list: AppNotification[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* ignore */
  }
}

export function emitNotificationsUpdated(): void {
  try {
    window.dispatchEvent(new CustomEvent('notificationsUpdated'));
  } catch {
    /* ignore */
  }
}

export function listNotifications(): AppNotification[] {
  return readAll().sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export function unreadCount(): number {
  return readAll().filter((n) => !n.read).length;
}

export function markAllRead(): void {
  const list = readAll().map((n) => ({ ...n, read: true }));
  writeAll(list);
  emitNotificationsUpdated();
}

export function markRead(id: string): void {
  const list = readAll().map((n) => (n.id === id ? { ...n, read: true } : n));
  writeAll(list);
  emitNotificationsUpdated();
}

export function clearNotifications(): void {
  writeAll([]);
  emitNotificationsUpdated();
}

function pushEnabled(): boolean {
  try {
    return localStorage.getItem('notifications') === 'true';
  } catch {
    return false;
  }
}

function uploadsEnabled(): boolean {
  try {
    return localStorage.getItem('pushUploads') !== 'false';
  } catch {
    return true;
  }
}

function liveEnabled(): boolean {
  try {
    return localStorage.getItem('liveAlerts') !== 'false';
  } catch {
    return true;
  }
}

/** Fire a real OS-level notification when permission was granted. */
export function sendSystemNotification(title: string, body: string): void {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return; // in-app banner covers it
    const n = new Notification(title, { body, tag: `equyvo-${Date.now()}` });
    n.onclick = () => {
      try {
        window.focus();
        n.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* ignore */
  }
}

export async function requestPushPermission(): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    const res = await Notification.requestPermission();
    return res === 'granted';
  } catch {
    return false;
  }
}

export function pushNotification(n: Omit<AppNotification, 'id' | 'at' | 'read'> & { id?: string }): AppNotification {
  const item: AppNotification = {
    id: n.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    read: false,
    ...n,
  } as AppNotification;
  const list = [item, ...readAll()].slice(0, 200);
  writeAll(list);
  emitNotificationsUpdated();
  // Mirror to the OS when it is a push-worthy kind and the user opted in.
  if (pushEnabled() || n.kind === 'follow_request' || n.kind === 'follow_accepted') {
    sendSystemNotification(item.title, item.body);
  }
  return item;
}

export function notifyFollowRequest(fromName: string, fromId?: string): AppNotification {
  return pushNotification({
    kind: 'follow_request',
    title: 'New follow request',
    body: `${fromName} requested to follow you. Approve or decline from notifications.`,
    actorId: fromId,
    actorName: fromName,
    link: '/app/profile',
  });
}

export function notifyFollowAccepted(byName: string, byId?: string): AppNotification {
  return pushNotification({
    kind: 'follow_accepted',
    title: 'Follow request accepted',
    body: `${byName} accepted your follow request. You can now see their posts and chat.`,
    actorId: byId,
    actorName: byName,
    link: '/app/profile',
  });
}

export function notifyLive(name: string, actorId?: string): AppNotification | null {
  if (!liveEnabled()) return null;
  return pushNotification({
    kind: 'live',
    title: `${name} is live now`,
    body: `Tap to watch ${name}'s live stream.`,
    actorId,
    actorName: name,
    link: '/app/moments',
  });
}

/** New-upload alerts only fire when Push is ON and upload alerts are enabled. */
export function notifyUpload(author: string, title: string, actorId?: string): void {
  if (!pushEnabled() || !uploadsEnabled()) return;
  pushNotification({
    kind: 'upload',
    title: `New from ${author}`,
    body: title || `${author} posted something new.`,
    actorId,
    actorName: author,
    link: '/app/home',
  });
}

/** Best-effort server merge: follow requests + live + reports for this device. */
export async function syncNotificationsFromServer(): Promise<AppNotification[]> {
  try {
    const res = await api.notifications();
    const items = (res as { data?: { items?: AppNotification[] } }).data?.items;
    if (!res.error && Array.isArray(items) && items.length) {
      const cur = readAll();
      const ids = new Set(cur.map((n) => n.id));
      const fresh = items.filter((n) => n && n.id && !ids.has(String(n.id)));
      if (fresh.length) {
        writeAll([...fresh.map((n) => ({ ...n, read: false }) as AppNotification), ...cur].slice(0, 200));
        emitNotificationsUpdated();
      }
    }
  } catch {
    /* offline — local notifications still work */
  }
  // Private-account owners: surface pending follow requests as notifications.
  try {
    const res = await api.followRequests();
    const reqs = (res as { data?: { requests?: string[] } }).data?.requests;
    if (!res.error && Array.isArray(reqs)) {
      const cur = readAll();
      for (const r of reqs.slice(0, 20)) {
        const id = `followreq-${r}`;
        if (!cur.some((n) => n.id === id)) {
          cur.unshift({
            id,
            kind: 'follow_request',
            title: 'New follow request',
            body: `${r} requested to follow you. Approve or decline from notifications.`,
            at: new Date().toISOString(),
            read: false,
            actorId: String(r),
            actorName: String(r),
          });
        }
      }
      writeAll(cur.slice(0, 200));
      emitNotificationsUpdated();
    }
  } catch {
    /* ignore */
  }
  return listNotifications();
}

/** Accept a follow request from the bell; notifies + refreshes feeds. */
export async function acceptFollowRequest(requester: string): Promise<boolean> {
  try {
    const { error } = await api.followAccept(String(requester));
    if (error) return false;
    markRead(`followreq-${requester}`);
    pushNotification({
      kind: 'system',
      title: 'Request approved',
      body: `You approved ${requester}. They can now see your posts.`,
      actorId: String(requester),
      actorName: String(requester),
    });
    try {
      window.dispatchEvent(new CustomEvent('feedRefresh'));
      window.dispatchEvent(new CustomEvent('followChanged'));
    } catch {
      /* ignore */
    }
    emitNotificationsUpdated();
    return true;
  } catch {
    return false;
  }
}

export async function declineFollowRequest(requester: string): Promise<boolean> {
  try {
    const { error } = await api.followDecline(String(requester));
    if (error) return false;
    markRead(`followreq-${requester}`);
    emitNotificationsUpdated();
    return true;
  } catch {
    return false;
  }
}
