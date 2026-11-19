import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft, BellOff, Bell, Camera, Check, ChevronRight, Crown, FileText,
  Image as ImageIcon, Link2, MoreVertical, Palette, Plus, Search, Shield,
  Trash2, UserMinus, UserPlus, X, Archive, Flag,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ChatThemeSelector } from './ChatThemeSelector';
import { showError, showSuccess } from '@/utils/toast';
import api from '@/lib/api';
import ReportModal from './ReportModal';

interface GroupSettingsProps {
  open: boolean;
  group: any;
  meId: string;
  muted: boolean;
  onClose: () => void;
  onToggleMute: () => void;
  onUpdated: () => Promise<void> | void;
  onClosedChat: () => void;
  onOpenContact: (userId: string, name: string, avatar?: string) => void;
  onCamera: () => void;
}

type Member = { id: string; name: string; avatar: string };

type ConfirmState =
  | { type: 'remove'; userId: string; name: string }
  | { type: 'leave' }
  | { type: 'delete' }
  | { type: 'archive' }
  | null;

/** WhatsApp-style "Group info / settings" page. All mutations go through the
 *  same /api/groups endpoints as before — the UX is what changed. */
const GroupSettings: React.FC<GroupSettingsProps> = ({
  open, group, meId, muted, onClose, onToggleMute, onUpdated, onClosedChat,
  onOpenContact, onCamera,
}) => {
  const [profiles, setProfiles] = useState<Record<string, Member>>({});
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [addResults, setAddResults] = useState<any[]>([]);
  const [addBusy, setAddBusy] = useState(false);
  const [memberMenu, setMemberMenu] = useState<string | null>(null);
  const [permOpen, setPermOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [busy, setBusy] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState<'media' | 'docs' | 'links' | null>(null);

  const isLeader = !!group && group.leaderId === meId;
  const isCoLeader = !!group && Array.isArray(group.coLeaders) && group.coLeaders.includes(meId);
  const canManage = isLeader || isCoLeader;
  const members: string[] = Array.isArray(group?.members) ? group.members : [];
  const replyPerm = group?.settings?.replyPermission || 'all';

  useEffect(() => {
    if (!open || !group) return;
    setEditName(group.name || '');
    setEditDesc(group.description || '');
    setEditAvatar(group.avatar || '');
    setSearch('');
    setMemberMenu(null);
    let cancelled = false;
    (async () => {
      const next: Record<string, Member> = {};
      for (const id of members) {
        try {
          const { data } = await api.getProfile(id);
          const p = (data as any)?.data || data;
          next[id] = {
            id,
            name: p?.name || p?.username || id,
            avatar: p?.avatar || p?.avatarUrl || '',
          };
        } catch {
          next[id] = { id, name: id, avatar: '' };
        }
      }
      if (!cancelled) setProfiles(next);
    })();
    return () => { cancelled = true; };
    // Seed profiles once each time the sheet opens for a group.
  }, [open, group?.id]);

  const memberName = (id: string) => profiles[id]?.name || id;
  const memberAvatar = (id: string) => profiles[id]?.avatar || '';

  const sortedMembers = useMemo(() => {
    const clean = search.trim().toLowerCase();
    return members
      .filter((id) => !clean || memberName(id).toLowerCase().includes(clean))
      .sort((a, b) => {
        if (a === group?.leaderId) return -1;
        if (b === group?.leaderId) return 1;
        return memberName(a).localeCompare(memberName(b));
      });
  }, [members, search, profiles, group?.leaderId]);

  const mutate = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try {
      const r: any = await fn();
      if (r?.error) { showError(r.error); return false; }
      await onUpdated();
      showSuccess(ok);
      return true;
    } catch {
      showError('Could not update group');
      return false;
    } finally { setBusy(false); }
  };

  const handleConfirm = async () => {
    if (!confirm || !group) return;
    if (confirm.type === 'remove') {
      const ok = await mutate(() => api.groupRemoveMember(group.id, confirm.userId), 'Member removed');
      if (ok) setConfirm(null);
    } else if (confirm.type === 'leave') {
      const ok = await mutate(() => api.groupRemoveMember(group.id, meId), 'Left group');
      if (ok) { setConfirm(null); onClose(); onClosedChat(); }
    } else if (confirm.type === 'delete') {
      const ok = await mutate(() => api.groupDeleteGroup(group.id), 'Group deleted');
      if (ok) { setConfirm(null); onClose(); onClosedChat(); }
    } else if (confirm.type === 'archive') {
      const ok = await mutate(() => api.groupArchive(group.id, true), 'Group archived');
      if (ok) { setConfirm(null); onClose(); onClosedChat(); }
    }
  };

  if (!open || !group) return null;

  const initials = (group.name || 'G').slice(0, 2).toUpperCase();

  const SettingsRow = ({
    icon, label, detail, onClick, danger, right,
  }: {
    icon: React.ReactNode; label: string; detail?: string;
    onClick?: () => void; danger?: boolean; right?: React.ReactNode;
  }) => (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-muted/60 ${danger ? 'text-red-500' : ''}`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${danger ? 'bg-red-500/10' : 'bg-primary/10 text-primary'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{label}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {right ?? (onClick ? <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/70" /> : null)}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[96] flex flex-col bg-background" onClick={onClose}>
      <div className="flex shrink-0 items-center gap-3 bg-gradient-to-b from-emerald-700 to-emerald-600 px-2 py-3 pt-[max(0.75rem,var(--equyvo-safe-top))] text-white shadow-lg">
        <Button variant="ghost" size="icon" className="h-9 w-9 text-white hover:bg-white/15" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h2 className="flex-1 text-base font-semibold">Group info</h2>
        {canManage && (
          <Button variant="ghost" size="icon" className="h-9 w-9 text-white hover:bg-white/15" onClick={(e) => { e.stopPropagation(); setEditOpen(true); }} aria-label="Edit group">
            <MoreVertical className="h-5 w-5" />
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Identity */}
        <div className="flex flex-col items-center bg-gradient-to-b from-emerald-700 to-emerald-600 px-6 pb-8 pt-3 text-white">
          <button type="button" onClick={() => group.avatar && setMediaOpen('media')} className="relative" aria-label="Group photo">
            <Avatar className="h-28 w-28 border-4 border-white/20 shadow-xl">
              <AvatarImage src={group.avatar || ''} alt={group.name} />
              <AvatarFallback className="bg-white/20 text-3xl text-white">{initials}</AvatarFallback>
            </Avatar>
            {canManage && (
              <label className="absolute bottom-0 right-0 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-white text-emerald-700 shadow-lg" title="Change group photo">
                <Camera className="h-4 w-4" />
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  try {
                    const up = await api.uploadFile(f, 'equyvo/group/avatars');
                    const url = up?.data?.secureUrl;
                    if (!url) throw new Error('upload');
                    const ok = await mutate(() => api.groupProfile(group.id, { image: url }), 'Group photo updated');
                    if (ok) setEditAvatar(url);
                  } catch { showError('Upload failed'); }
                }} />
              </label>
            )}
          </button>
          <h3 className="mt-4 text-xl font-semibold">{group.name}</h3>
          <p className="text-xs text-emerald-100/80">Group · {members.length} participants</p>
          {group.description && <p className="mt-2 max-w-sm text-center text-sm text-emerald-50/90">{group.description}</p>}
        </div>

        <div className="-mt-4 space-y-3 px-3 pb-10">
          {/* Quick actions */}
          <div className="rounded-xl border bg-card p-3 shadow-sm">
            <div className="grid grid-cols-3 gap-2 text-center">
              {([
                { key: 'media', label: 'Media', icon: <ImageIcon className="h-5 w-5" /> },
                { key: 'docs', label: 'Docs', icon: <FileText className="h-5 w-5" /> },
                { key: 'links', label: 'Links', icon: <Link2 className="h-5 w-5" /> },
              ] as const).map((a) => (
                <button key={a.key} type="button" onClick={() => setMediaOpen(a.key)} className="flex flex-col items-center gap-1 rounded-lg py-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
                  <span className="text-primary">{a.icon}</span>
                  <span className="text-xs font-medium">{a.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Group details */}
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
            {canManage && (
              <SettingsRow icon={<FileText className="h-4 w-4" />} label="Group subject" detail={group.name} onClick={() => setEditOpen(true)} />
            )}
            <SettingsRow
              icon={muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
              label="Mute notifications"
              detail={muted ? 'Notifications are muted' : 'Notifications are on'}
              onClick={onToggleMute}
              right={<Switch checked={muted} onCheckedChange={onToggleMute} aria-label="Mute notifications" />}
            />
            <SettingsRow
              icon={<Palette className="h-4 w-4" />}
              label="Chat wallpaper"
              detail="Customize this chat's background"
              right={
                <ChatThemeSelector>
                  <span className="flex cursor-pointer items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent"><ChevronRight className="h-4 w-4" /></span>
                </ChatThemeSelector>
              }
            />
            {isLeader && (
              <SettingsRow icon={<Shield className="h-4 w-4" />} label="Who can reply" detail={replyPerm === 'all' ? 'Everyone' : replyPerm === 'leaders' ? 'Leaders only' : 'Group leader only'} onClick={() => setPermOpen(true)} />
            )}
          </div>

          {/* Participants */}
          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <h4 className="flex-1 text-sm font-semibold">Participants</h4>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{members.length}</span>
              {canManage && <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setAddOpen(true); setAddQuery(''); setAddResults([]); }} aria-label="Add participant"><UserPlus className="h-4 w-4" /></Button>}
            </div>
            <div className="p-2">
              <div className="relative mb-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search participants" className="h-9 pl-8 text-sm" />
              </div>
            </div>
            <div className="divide-y">
              {sortedMembers.map((id) => {
                const role = id === group.leaderId ? 'Group leader' : Array.isArray(group.coLeaders) && group.coLeaders.includes(id) ? 'Admin' : memberName(id) === 'You' ? 'You' : '';
                return (
                  <div key={id} className="relative flex items-center gap-3 px-4 py-2.5">
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpenContact(id, memberName(id), memberAvatar(id))}>
                      <Avatar className="h-10 w-10 shrink-0">
                        <AvatarImage src={memberAvatar(id)} alt={memberName(id)} />
                        <AvatarFallback>{memberName(id).slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{id === meId ? 'You' : memberName(id)}</span>
                        {role && <span className="flex items-center gap-1 text-[11px] text-muted-foreground">{id === group.leaderId && <Crown className="h-3 w-3 text-amber-500" />}{role}</span>}
                      </span>
                    </button>
                    {isLeader && id !== meId && (
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMemberMenu(memberMenu === id ? null : id)} aria-label="Member options">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    )}
                    {memberMenu === id && (
                      <div className="absolute right-3 top-12 z-20 w-48 overflow-hidden rounded-lg border bg-popover shadow-xl">
                        {Array.isArray(group.coLeaders) && group.coLeaders.includes(id) ? (
                          <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-accent" disabled={busy} onClick={async () => { setMemberMenu(null); await mutate(() => api.groupSetRole(group.id, id, 'member'), 'Demoted to participant'); }}>Dismiss as admin</button>
                        ) : (
                          <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-accent" disabled={busy} onClick={async () => { setMemberMenu(null); await mutate(() => api.groupSetRole(group.id, id, 'coleader'), 'Promoted to admin'); }}>Make admin</button>
                        )}
                        <button type="button" className="w-full px-3 py-2 text-left text-sm text-red-500 hover:bg-accent" onClick={() => { setMemberMenu(null); setConfirm({ type: 'remove', userId: id, name: memberName(id) }); }}>
                          <span className="flex items-center gap-2"><UserMinus className="h-4 w-4" /> Remove from group</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {sortedMembers.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">No participants found.</p>}
            </div>
          </div>

          {/* Danger zone */}
          <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-sm">
            <SettingsRow icon={<Flag className="h-4 w-4" />} label="Report group" detail="Report spam or inappropriate content" onClick={() => setReportOpen(true)} />
            {isLeader && <SettingsRow icon={<Archive className="h-4 w-4" />} label="Archive group" onClick={() => setConfirm({ type: 'archive' })} />}
            <SettingsRow icon={<Trash2 className="h-4 w-4" />} label={isLeader ? 'Delete group' : 'Exit group'} detail={isLeader ? 'Permanently delete for everyone' : 'Leave this group'} danger onClick={() => setConfirm(isLeader ? { type: 'delete' } : { type: 'leave' })} />
          </div>

          <div className="pt-3 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-primary">Equyvo Groups</span>
            <p className="mt-2 text-[11px] text-muted-foreground">Created {group.createdAt ? new Date(group.createdAt).toLocaleDateString() : 'recently'} · leaders and admins manage membership and reply permissions.</p>
          </div>
        </div>
      </div>

      {/* Edit subject / description */}
      {editOpen && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" onClick={() => setEditOpen(false)}>
          <div className="w-full max-w-md space-y-4 rounded-xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Edit group</h3>
              <Button variant="ghost" size="icon" onClick={() => setEditOpen(false)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Group subject</label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={80} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} maxLength={300} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button size="sm" disabled={saving} onClick={async () => {
                if (!editName.trim()) { showError('Group name is required'); return; }
                setSaving(true);
                try {
                  const ok = await mutate(() => api.groupProfile(group.id, { name: editName.trim(), description: editDesc.trim(), image: editAvatar || undefined }), 'Group updated');
                  if (ok) setEditOpen(false);
                } finally { setSaving(false); }
              }}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        </div>, document.body)}

      {/* Add participant */}
      {addOpen && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" onClick={() => setAddOpen(false)}>
          <div className="flex max-h-[80vh] w-full max-w-md flex-col space-y-3 overflow-hidden rounded-xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Add participant</h3>
              <Button variant="ghost" size="icon" onClick={() => setAddOpen(false)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <Input value={addQuery} onChange={async (e) => {
              const q = e.target.value; setAddQuery(q);
              if (q.trim().length < 2) { setAddResults([]); return; }
              try {
                const res: any = await api.search(q, 10);
                const users = res?.data?.users || res?.data?.results || [];
                setAddResults(Array.isArray(users) ? users.filter((u: any) => !members.includes(String(u.id))) : []);
              } catch { setAddResults([]); }
            }} placeholder="Search by name or username" />
            <div className="max-h-72 flex-1 space-y-1 overflow-y-auto">
              {addResults.map((u: any) => (
                <button key={u.id} type="button" disabled={addBusy} onClick={async () => {
                  setAddBusy(true);
                  try { const ok = await mutate(() => api.groupAddMember(group.id, String(u.id)), 'Participant added'); if (ok) setAddOpen(false); }
                  finally { setAddBusy(false); }
                }} className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-muted/60">
                  <Avatar className="h-9 w-9"><AvatarImage src={u.avatar || ''} /><AvatarFallback>{String(u.name || u.username || '?').slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm">{u.name || u.username || u.id}</span>
                  <Plus className="h-4 w-4 text-primary" />
                </button>
              ))}
              {addResults.length === 0 && addQuery.trim().length >= 2 && <p className="py-6 text-center text-sm text-muted-foreground">No profiles found.</p>}
            </div>
          </div>
        </div>, document.body)}

      {/* Who can reply */}
      {permOpen && createPortal(
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4" onClick={() => setPermOpen(false)}>
          <div className="w-full max-w-sm rounded-xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">Who can reply</h3>
            <div className="space-y-1">
              {([
                { value: 'all', label: 'Everyone', detail: 'All participants can reply' },
                { value: 'leaders', label: 'Admins only', detail: 'Only leaders and admins can reply' },
                { value: 'leader', label: 'Group leader only', detail: 'Only you can reply' },
              ] as const).map((o) => (
                <button key={o.value} type="button" disabled={busy} onClick={async () => {
                  await mutate(() => api.groupSettings(group.id, o.value), 'Permission updated');
                  setPermOpen(false);
                }} className="flex w-full items-center gap-3 rounded-lg p-3 text-left hover:bg-muted/60">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary"><Shield className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{o.label}</span><span className="block text-xs text-muted-foreground">{o.detail}</span></span>
                  {replyPerm === o.value && <Check className="h-5 w-5 text-primary" />}
                </button>
              ))}
            </div>
          </div>
        </div>, document.body)}

      {/* Confirmation */}
      {confirm && createPortal(
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-4" onClick={() => setConfirm(null)}>
          <div className="w-full max-w-sm rounded-xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold">
              {confirm.type === 'remove' ? `Remove ${confirm.name}?` : confirm.type === 'leave' ? 'Exit group?' : confirm.type === 'delete' ? 'Delete group?' : 'Archive group?'}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {confirm.type === 'remove' ? 'They will no longer be able to read or send messages in this group.'
                : confirm.type === 'leave' ? 'You will no longer see messages from this group.'
                : confirm.type === 'delete' ? 'This permanently deletes the group and all its messages for everyone.'
                : 'The group will be moved to your archived chats.'}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => void handleConfirm()}>{busy ? 'Working…' : 'Confirm'}</Button>
            </div>
          </div>
        </div>, document.body)}

      <ReportModal isOpen={reportOpen} onClose={() => setReportOpen(false)} contentId={group.id || ''} contentType="profile" />

      {/* Media placeholder sheet — chat media is available in the conversation */}
      {mediaOpen && createPortal(
        <div className="fixed inset-0 z-[130] flex flex-col bg-background" onClick={() => setMediaOpen(null)}>
          <div className="flex items-center gap-3 border-b p-3 pt-[max(0.75rem,var(--equyvo-safe-top))]" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" onClick={() => setMediaOpen(null)} aria-label="Back"><ArrowLeft className="h-5 w-5" /></Button>
            <h3 className="flex-1 font-semibold capitalize">{mediaOpen}</h3>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" onClick={(e) => e.stopPropagation()}>
            <ImageIcon className="h-12 w-12 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">Shared {mediaOpen} appear here. Open the conversation to browse everything shared in this group.</p>
            <Button variant="outline" size="sm" onClick={() => setMediaOpen(null)}>Back to group info</Button>
          </div>
        </div>, document.body)}
    </div>,
    document.body,
  );
};

export default GroupSettings;
