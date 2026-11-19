import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, Ban, ExternalLink, FileText, Flag, Image as ImageIcon,
  Link as LinkIcon, MessageSquare, MoreVertical, Phone, Trash2, Eraser,
  Volume2, VolumeX, X, Camera,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { showError, showSuccess } from '@/utils/toast';
import AvatarCropper from './AvatarCropper';
import ReportModal from './ReportModal';
import type { ChatMessage } from '@/lib/chat';
import api from '@/lib/api';

interface ChatContactInfoProps {
  open: boolean;
  peerId: string;
  peerName: string;
  peerAvatar?: string;
  online?: boolean;
  muted: boolean;
  blocked: boolean;
  messages: ChatMessage[];
  onClose: () => void;
  onToggleMute: () => void;
  onSetBlocked: (blocked: boolean) => Promise<void>;
  onViewProfile: () => void;
  onClearChat: () => void;
  onDeleteChat: () => void;
  /** Chat-scoped photo override (stored locally), unique to Equyvo chats. */
  onAvatarChanged?: (peerId: string, url: string) => void;
}

type MediaKind = 'media' | 'docs' | 'links';

/** WhatsApp-style "contact info" screen shown when tapping the profile inside
 *  a 1-on-1 conversation. It is deliberately NOT the Equyvo profile page —
 *  that one is reached from the chat list avatar / "View Equyvo profile". */
const ChatContactInfo: React.FC<ChatContactInfoProps> = ({
  open, peerId, peerName, peerAvatar, online, muted, blocked, messages,
  onClose, onToggleMute, onSetBlocked, onViewProfile, onClearChat, onDeleteChat,
  onAvatarChanged,
}) => {
  const [profile, setProfile] = useState<{ username?: string; bio?: string; name?: string; avatar?: string }>({});
  const [localAvatar, setLocalAvatar] = useState('');
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [confirmReport, setConfirmReport] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [mediaKind, setMediaKind] = useState<MediaKind | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !peerId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.getProfile(peerId);
        const p = (data as any)?.data || data;
        if (!cancelled && p) {
          setProfile({
            username: p.username || p.handle ? String(p.username || p.handle).replace(/^@/, '') : '',
            bio: p.bio || p.description || '',
            name: p.name || p.fullName,
            avatar: p.avatar || p.avatarUrl || '',
          });
        }
      } catch { /* offline — keep the thread's cached name/avatar */ }
    })();
    return () => { cancelled = true; };
  }, [open, peerId]);

  useEffect(() => {
    if (!peerId) return;
    try {
      const all = JSON.parse(localStorage.getItem('equyvo_chat_avatars') || '{}');
      setLocalAvatar(all[String(peerId).toLowerCase()] || '');
    } catch { setLocalAvatar(''); }
  }, [peerId, open]);

  const media = useMemo(() => {
    const images = messages.filter((m) => !m.deletedForEveryone && (m.type === 'image' || m.type === 'gif') && m.fileUrl);
    const docs = messages.filter((m) => !m.deletedForEveryone && m.type === 'file' && m.fileUrl);
    const links = messages.filter((m) => !m.deletedForEveryone && typeof m.text === 'string' && /https?:\/\//i.test(m.text));
    return { images, docs, links };
  }, [messages]);

  if (!open) return null;

  const displayName = profile.name || peerName || 'Contact';
  const avatar = localAvatar || profile.avatar || peerAvatar || '';
  const initials = (displayName || '?').slice(0, 2).toUpperCase();

  const doBlock = async () => {
    setBusy(true);
    try {
      await onSetBlocked(!blocked);
      setConfirmBlock(false);
      onClose();
      showSuccess(blocked ? 'Contact unblocked' : 'Contact blocked');
    } catch {
      showError('Could not update block list');
    } finally { setBusy(false); }
  };

  const Row = ({
    icon, label, detail, onClick, danger, right,
  }: {
    icon: React.ReactNode; label: string; detail?: string;
    onClick?: () => void; danger?: boolean; right?: React.ReactNode;
  }) => {
    const body = (
      <>
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${danger ? 'bg-red-500/10' : 'bg-cyan-500/10 text-cyan-500'}`}>{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
      </>
    );
    return (
      <div className={`flex w-full items-center gap-4 px-4 py-3.5 ${danger ? 'text-red-500' : ''}`}>
        {onClick ? (
          <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-4 text-left hover:opacity-80">{body}</button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-4">{body}</div>
        )}
        {right ?? (onClick ? <MoreVertical className="h-4 w-4 shrink-0 text-muted-foreground/60" /> : null)}
      </div>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[95] flex flex-col bg-background" onClick={onClose}>
      {/* WhatsApp-green header */}
      <div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-cyan-500 via-purple-600 to-pink-500 px-2 py-3 pt-[max(0.75rem,var(--equyvo-safe-top))] text-white shadow-lg">
        <Button variant="ghost" size="icon" className="h-9 w-9 text-white hover:bg-white/15" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h2 className="flex-1 text-base font-semibold">Contact info</h2>
        <Button variant="ghost" size="icon" className="h-9 w-9 text-white hover:bg-white/15" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close">
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Identity */}
        <div className="flex flex-col items-center bg-gradient-to-r from-cyan-500 via-purple-600 to-pink-500 px-6 pb-8 pt-3 text-white">
          <div className="relative">
            <button type="button" className="block" onClick={() => avatar && setLightbox(avatar)} aria-label="View profile photo">
              <Avatar className="h-28 w-28 border-4 border-white/20 shadow-xl">
                <AvatarImage src={avatar} alt={displayName} />
                <AvatarFallback className="bg-white/20 text-3xl text-white">{initials}</AvatarFallback>
              </Avatar>
            </button>
            {online && <span className="absolute bottom-1 right-1 h-5 w-5 rounded-full border-4 border-sky-700 bg-sky-300" />}
            <label className="absolute -bottom-1 -right-1 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-white text-sky-700 shadow-lg" title="Set chat photo">
              <Camera className="h-4 w-4" />
              <input type="file" accept="image/*,.gif" className="hidden" onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => setAvatarSrc(String(reader.result || ''));
                reader.onerror = () => showError('Could not read that image.');
                reader.readAsDataURL(f);
              }} />
            </label>
          </div>
          <h3 className="mt-4 text-xl font-semibold">{displayName}</h3>
          {profile.username && <p className="text-sm text-sky-100">@{profile.username}</p>}
          <p className="mt-1 text-xs text-sky-100/80">
            {online ? 'online' : blocked ? 'Blocked' : profile.bio || 'Equyvo contact'}
          </p>
        </div>

        <div className="-mt-4 space-y-3 px-3 pb-10">
          {/* Quick media actions */}
          <div className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="grid grid-cols-3 gap-2 text-center">
              {([
                { key: 'media', label: 'Media', icon: <ImageIcon className="h-5 w-5" />, count: media.images.length },
                { key: 'docs', label: 'Docs', icon: <FileText className="h-5 w-5" />, count: media.docs.length },
                { key: 'links', label: 'Links', icon: <LinkIcon className="h-5 w-5" />, count: media.links.length },
              ] as const).map((a) => (
                <button key={a.key} type="button" onClick={() => setMediaKind(a.key)} className="flex flex-col items-center gap-1 rounded-lg py-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                  <span className="text-cyan-500">{a.icon}</span>
                  <span className="text-xs font-medium">{a.label}</span>
                  <span className="text-[11px] text-muted-foreground">{a.count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Preferences */}
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
            <Row
              icon={muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              label="Mute notifications"
              detail={muted ? 'Notifications are muted' : 'Notifications are on'}
              right={<Switch checked={muted} onCheckedChange={onToggleMute} aria-label="Mute notifications" />}
            />
            <Row
              icon={<ExternalLink className="h-4 w-4" />}
              label="View Equyvo profile"
              detail="Posts, followers and more"
              onClick={onViewProfile}
              right={null}
            />
          </div>

          {/* Safety */}
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
            <Row
              icon={<Ban className="h-4 w-4" />}
              label={blocked ? `Unblock ${displayName}` : `Block ${displayName}`}
              detail={blocked ? 'You will receive their messages again' : "They won't be able to message you"}
              onClick={() => setConfirmBlock(true)}
              danger={!blocked}
              right={null}
            />
            <Row
              icon={<Flag className="h-4 w-4" />}
              label={`Report ${displayName}`}
              detail="Spam, harassment or inappropriate content"
              onClick={() => setConfirmReport(true)}
              right={null}
            />
          </div>

          {/* Chat actions */}
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
            <Row icon={<MessageSquare className="h-4 w-4" />} label="Message" detail="Back to this conversation" onClick={onClose} right={null} />
            <Row icon={<Eraser className="h-4 w-4" />} label="Clear chat" detail="Delete all messages in this chat" onClick={onClearChat} danger right={null} />
            <Row icon={<Trash2 className="h-4 w-4" />} label="Delete chat" detail="Remove this chat from your list" onClick={onDeleteChat} danger right={null} />
          </div>

        </div>
      </div>

      {/* Block confirmation */}
      {confirmBlock && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" onClick={() => setConfirmBlock(false)}>
          <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">{blocked ? `Unblock ${displayName}?` : `Block ${displayName}?`}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {blocked
                ? 'They will be able to send you messages again.'
                : 'Blocked contacts can no longer message you or add you to new groups. You can unblock them any time from Chats → Blocked contacts.'}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmBlock(false)}>Cancel</Button>
              <Button size="sm" variant={blocked ? 'default' : 'destructive'} disabled={busy} onClick={() => void doBlock()}>
                {busy ? 'Working…' : blocked ? 'Unblock' : 'Block'}
              </Button>
            </div>
          </div>
        </div>, document.body)}

      {/* Report confirmation then modal */}
      {confirmReport && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" onClick={() => setConfirmReport(false)}>
          <div className="w-full max-w-sm rounded-xl bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">Report {displayName}?</h3>
            <p className="mt-2 text-sm text-muted-foreground">Reports are reviewed privately by the Equyvo safety team. The contact will not be notified.</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmReport(false)}>Cancel</Button>
              <Button size="sm" onClick={() => { setConfirmReport(false); setReportOpen(true); }}>Continue</Button>
            </div>
          </div>
        </div>, document.body)}
      {avatarSrc && (
        <AvatarCropper
          imageSrc={avatarSrc}
          compact
          onCancel={() => setAvatarSrc(null)}
          onCropComplete={(file) => {
            const reader = new FileReader();
            reader.onload = () => {
              const url = String(reader.result || '');
              setAvatarSrc(null);
              setLocalAvatar(url);
              try {
                const all = JSON.parse(localStorage.getItem('equyvo_chat_avatars') || '{}');
                all[String(peerId).toLowerCase()] = url;
                localStorage.setItem('equyvo_chat_avatars', JSON.stringify(all));
              } catch { /* storage full — still show this session */ }
              onAvatarChanged?.(peerId, url);
              showSuccess('Chat photo updated');
            };
            reader.readAsDataURL(file);
          }}
        />
      )}
      <ReportModal isOpen={reportOpen} onClose={() => setReportOpen(false)} contentId={peerId} contentType="profile" />

      {/* Media / docs / links sheet */}
      {mediaKind && createPortal(
        <div className="fixed inset-0 z-[110] flex flex-col bg-background" onClick={() => setMediaKind(null)}>
          <div className="flex items-center gap-3 border-b p-3 pt-[max(0.75rem,var(--equyvo-safe-top))]" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" onClick={() => setMediaKind(null)} aria-label="Back"><ArrowLeft className="h-5 w-5" /></Button>
            <h3 className="flex-1 font-semibold capitalize">{mediaKind}</h3>
            <span className="text-xs text-muted-foreground">{mediaKind === 'media' ? media.images.length : mediaKind === 'docs' ? media.docs.length : media.links.length} items</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
            {mediaKind === 'media' && (
              <div className="grid grid-cols-3 gap-2">
                {media.images.map((m) => (
                  <button key={m.id} type="button" onClick={() => setLightbox(m.fileUrl!)} className="aspect-square overflow-hidden rounded-lg bg-muted">
                    <img src={m.fileUrl} alt="Shared media" className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
            {mediaKind === 'docs' && (
              <div className="space-y-2">
                {media.docs.map((m) => (
                  <a key={m.id} href={m.fileUrl} download={m.fileName} className="flex items-center gap-3 rounded-lg border p-3 text-sm hover:bg-muted/60">
                    <FileText className="h-5 w-5 text-cyan-500" />
                    <span className="min-w-0 flex-1 truncate">{m.fileName || 'Document'}</span>
                  </a>
                ))}
              </div>
            )}
            {mediaKind === 'links' && (
              <div className="space-y-2">
                {media.links.map((m) => {
                  const url = m.text.match(/https?:\/\/\S+/)?.[0] || '';
                  return (
                    <a key={m.id} href={url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-lg border p-3 text-sm hover:bg-muted/60">
                      <LinkIcon className="h-5 w-5 text-cyan-500" />
                      <span className="min-w-0 flex-1 truncate text-cyan-500 underline">{url}</span>
                    </a>
                  );
                })}
              </div>
            )}
            {(mediaKind === 'media' ? media.images.length : mediaKind === 'docs' ? media.docs.length : media.links.length) === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">No {mediaKind} shared yet.</p>
            )}
          </div>
        </div>, document.body)}

      {/* Full-screen image lightbox */}
      {lightbox && createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/95 p-4" onClick={() => setLightbox(null)}>
          <Button variant="ghost" size="icon" className="absolute right-4 top-4 z-10 text-white" onClick={() => setLightbox(null)} aria-label="Close"><X className="h-6 w-6" /></Button>
          <img src={lightbox} alt="Full size" className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
        </div>, document.body)}
    </div>,
    document.body,
  );
};

export default ChatContactInfo;
