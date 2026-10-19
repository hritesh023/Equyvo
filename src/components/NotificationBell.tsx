import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, X, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  listNotifications,
  unreadCount,
  markAllRead,
  markRead,
  clearNotifications,
  syncNotificationsFromServer,
  acceptFollowRequest,
  declineFollowRequest,
  type AppNotification,
} from '@/lib/notifications';

const kindLabel: Record<AppNotification['kind'], string> = {
  follow_request: 'Follow request',
  follow_accepted: 'Accepted',
  live: 'Live',
  upload: 'New upload',
  chat: 'Chat',
  report: 'Safety',
  system: 'System',
};

/**
 * Notification center rendered through a body-level portal so it always
 * appears correctly on top of ANY page:
 *  - Mobile  : true full-screen panel (100dvh, safe-area aware, scroll-locked)
 *  - Desktop : anchored card near the bell (never overlaps off-screen).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>(() => listNotifications());
  const [count, setCount] = useState(() => unreadCount());
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => {
    setItems(listNotifications());
    setCount(unreadCount());
  };

  useEffect(() => {
    refresh();
    syncNotificationsFromServer().then(refresh).catch(() => {});
    const t = window.setInterval(() => syncNotificationsFromServer().then(refresh).catch(() => {}), 30000);
    const onU = () => refresh();
    window.addEventListener('notificationsUpdated', onU);
    window.addEventListener('chatIncoming', onU);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('notificationsUpdated', onU);
      window.removeEventListener('chatIncoming', onU);
    };
  }, []);

  // Escape closes + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleAccept = async (n: AppNotification) => {
    if (!n.actorId) return;
    setBusy(n.id);
    try {
      await acceptFollowRequest(n.actorId);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const handleDecline = async (n: AppNotification) => {
    if (!n.actorId) return;
    setBusy(n.id);
    try {
      await declineFollowRequest(n.actorId);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  return (
    <>
      <Button variant="ghost" size="icon" className="relative" aria-label="Notifications" title="Notifications" onClick={() => setOpen((v) => !v)}>
        <Bell className="h-[1.2rem] w-[1.2rem]" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </Button>

      {open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[9999] sm:flex sm:items-start sm:justify-end">
          {/* Backdrop (mobile: dimmed full screen; desktop: transparent) */}
          <button
            type="button"
            aria-label="Close notifications"
            className="fixed inset-0 bg-black/45 sm:bg-black/10"
            onClick={() => setOpen(false)}
          />
          {/* Panel: TRUE fullscreen on mobile, anchored card on desktop */}
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Notifications"
            className="
              relative ml-auto flex h-[100dvh] w-full flex-col bg-background text-foreground
              sm:mt-14 sm:mr-4 sm:h-auto sm:max-h-[80vh] sm:w-[380px] sm:rounded-xl sm:border sm:border-border sm:shadow-2xl
            "
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
              <p className="text-sm font-semibold">
                Notifications {count > 0 && <span className="text-muted-foreground">({count} new)</span>}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { markAllRead(); refresh(); }}>
                  Mark all read
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { clearNotifications(); refresh(); }} aria-label="Clear all">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setOpen(false)} aria-label="Close notifications">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)]">
              {items.length === 0 && (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  <Bell className="mx-auto mb-2 h-8 w-8 opacity-40" />
                  You are all caught up.
                  <p className="mt-1 text-xs opacity-80">Follow requests, accepts, live alerts and new uploads land here.</p>
                </div>
              )}
              {items.map((n) => (
                <div
                  key={n.id}
                  className={`border-b border-border/40 px-3 py-2.5 last:border-0 ${n.read ? 'opacity-75' : 'bg-primary/5'}`}
                  onClick={() => { if (!n.read) { markRead(n.id); refresh(); } }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wide">{kindLabel[n.kind]}</span>
                        <span className="truncate">{n.title}</span>
                      </p>
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">{n.body}</p>
                      <p className="mt-1 text-[10px] text-muted-foreground/70">
                        {(() => { try { return new Date(n.at).toLocaleString(); } catch { return ''; } })()}
                      </p>
                    </div>
                    {!n.read && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />}
                  </div>
                  {n.kind === 'follow_request' && !n.read && n.actorId && (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" className="h-7 flex-1 text-xs" disabled={busy === n.id} onClick={(e) => { e.stopPropagation(); handleAccept(n); }}>
                        <Check className="mr-1 h-3 w-3" /> Accept
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" disabled={busy === n.id} onClick={(e) => { e.stopPropagation(); handleDecline(n); }}>
                        <X className="mr-1 h-3 w-3" /> Decline
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}

export default NotificationBell;
