import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Share2, Users, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { getFollowers, getFollowing, type SocialProfile } from '@/lib/social';
import { getStoredUser } from '@/lib/auth';
import { ensureThread, sendChatMessage } from '@/lib/chat';
import api from '@/lib/api';
import { showSuccess, showError } from '@/utils/toast';
import { openShareSheet } from '@/utils/share';

export interface ShareSheetPayload {
  id?: string;
  user?: string;
  content?: string;
  image?: string;
  title?: string;
  text?: string;
  url?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  payload: ShareSheetPayload;
  onShared?: () => void | Promise<void>;
}

const InAppShareSheet: React.FC<Props> = ({ open, onClose, payload, onShared }) => {
  const [tab, setTab] = useState<'followers' | 'following'>('followers');
  const [profiles, setProfiles] = useState<SocialProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = tab === 'followers' ? await getFollowers() : await getFollowing();
        if (!cancelled) setProfiles(res.list || []);
      } catch {
        if (!cancelled) setProfiles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, tab]);

  if (!open) return null;

  const shareUrl = payload.url || (payload.id ? `${window.location.origin}/app/home?post=${encodeURIComponent(payload.id)}` : window.location.href);
  const shareTitle = payload.title || `Post by ${payload.user || 'creator'} on Equyvo`;
  const shareText = payload.text || payload.content || '';

  const handleOsShare = async () => {
    try {
      const r = await openShareSheet({ title: shareTitle, text: shareText, url: shareUrl });
      if (r.success) {
        if (payload.id) {
          try { await api.share(payload.id); } catch { /* best-effort */ }
        }
        if (onShared) await onShared();
        showSuccess('Shared');
        onClose();
      } else if (!r.cancelled) {
        showError(r.error || 'Could not share');
      }
    } catch {
      showError('Could not share');
    }
  };

  const handleShareToProfile = async (p: SocialProfile) => {
    if (busyId) return;
    setBusyId(p.id);
    try {
      const me = getStoredUser();
      const rel = tab === 'followers' ? 'follower' : 'following';
      const thread = ensureThread({ id: p.id, name: p.name || p.username || p.id, avatar: p.avatar }, rel as any);
      const link = shareUrl;
      const msg = `${shareText ? shareText + ' ' : ''}${link}`;
      await sendChatMessage(thread.id, msg);
      if (payload.id) {
        try { await api.share(payload.id); } catch { /* best-effort */ }
      }
      if (onShared) await onShared();
      showSuccess(`Sent to ${p.name || p.username}`);
      onClose();
    } catch {
      showError('Could not send');
    } finally {
      setBusyId(null);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-end justify-center sm:items-center">
      <button className="absolute inset-0 bg-black/50" onClick={onClose} aria-label="Close share" />
      <div className="relative w-full sm:max-w-md bg-background rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <p className="font-semibold">Share</p>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <div className="px-4 py-3">
          <Button onClick={handleOsShare} className="w-full" variant="outline">
            <Share2 className="h-4 w-4 mr-2" /> Share via…
          </Button>
        </div>
        <div className="flex gap-2 px-4 pb-2">
          <Button variant={tab === 'followers' ? 'default' : 'outline'} size="sm" onClick={() => setTab('followers')} className="flex-1">
            <UserPlus className="h-3.5 w-3.5 mr-1" /> Followers
          </Button>
          <Button variant={tab === 'following' ? 'default' : 'outline'} size="sm" onClick={() => setTab('following')} className="flex-1">
            <Users className="h-3.5 w-3.5 mr-1" /> Following
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-6">Loading…</p>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No {tab} yet.</p>
          ) : (
            <ul className="space-y-2">
              {profiles.map((p) => (
                <li key={p.id} className="flex items-center gap-3">
                  <Avatar className="h-9 w-9">
                    <AvatarImage src={p.avatar} alt={p.name} />
                    <AvatarFallback>{(p.name || '?')[0]?.toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate text-sm">{p.name || p.username}</span>
                  <Button size="sm" disabled={busyId === p.id} onClick={() => handleShareToProfile(p)}>
                    {busyId === p.id ? 'Sending…' : 'Send'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default InAppShareSheet;