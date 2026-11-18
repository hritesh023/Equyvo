import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageCircle, Send, Paperclip, X, Palette, Search, Check, CheckCheck, Clock, ArrowLeft, Crop, Trash2, MoreVertical, Mic, Volume2, Eraser, Camera, ChevronDown, BarChart3, Image as ImageIcon, Film, File as FileIcon, Folder, Plus, ArrowRight, Pin, Archive } from 'lucide-react';
import { ChatCamera } from './ChatCamera';
import { showError, showSuccess } from '@/utils/toast';
import { useI18n } from '@/lib/i18n';
import api from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { ChatThemeSelector } from './ChatThemeSelector';
import MediaCropper from './MediaCropper';
import { useChatTheme } from '@/contexts/ChatThemeContext';
import { navigateToProfile } from '@/utils/profile-navigation';
import { getStoredUser } from '@/lib/auth';
import { getFollowers, getFollowing, type SocialProfile } from '@/lib/social';
import { pickDisplayName, nameFromEmail } from '@/lib/identity';
import {
  listThreads, listMessages, ensureThread, syncThreadsFromSocial,
  sendChatMessage, markThreadSeen, pullThreadMessages, deleteChatMessage,
  retryChatMessage, deleteThread, clearThread,
  type ChatThread, type ChatMessage,
} from '@/lib/chat';

/** Clock (sending) / single tick (sent) / double tick (delivered).
 *  Seen has NO tick on purpose — the user-facing signal is the "Seen"
 *  text label rendered inside the own bubble, under the timestamp. */
function Ticks({ status }: { status: ChatMessage['status'] }) {
  if (status === 'sending') return <Clock className="h-3.5 w-3.5 opacity-70" aria-label="Sending" />;
  if (status === 'sent') return <Check className="h-4 w-4 opacity-80" aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck className="h-4 w-4 opacity-80" aria-label="Delivered" />;
  if (status === 'failed') return <X className="h-4 w-4 text-red-400" aria-label="Failed to send" />;
  return null;
}

/** Voice-note player with a graceful fallback: if the audio can't play
 *  (codec gap in some WebViews, expired upload, dead URL) it degrades into a
 *  download link instead of a dead silent bubble. Player state resets when
 *  a different message is rendered (component keyed by message id). */
function VoiceBubble({ msg }: { msg: ChatMessage }) {
  const [broken, setBroken] = useState(false);
  const url = typeof msg.fileUrl === 'string' ? msg.fileUrl : '';
  if (broken || !url) {
    if (url) {
      return (
        <a
          href={url}
          download={msg.fileName || 'voice-message'}
          className="flex items-center gap-2 rounded-lg bg-white/10 px-2 py-1.5 text-xs font-medium underline underline-offset-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Volume2 className="h-4 w-4 shrink-0" /> Voice message — tap to download
        </a>
      );
    }
    return <div className="text-xs opacity-80">Voice message unavailable</div>;
  }
  return (
    <audio
      key={msg.id}
      controls
      preload="metadata"
      src={url}
      onError={() => setBroken(true)}
      className="h-9 w-[230px] max-w-full"
    />
  );
}

function isPollText(text: string): boolean {
  return typeof text === 'string' && text.trim().startsWith('[Poll]:');
}

function parsePollText(text: string): { question: string; options: string[] } | null {
  if (!isPollText(text)) return null;
  const lines = text.split('\n');
  const question = lines[0].replace('[Poll]:', '').trim();
  const options = lines.slice(1).map((l) => l.replace(/^\d+\.\s*/, '').trim()).filter(Boolean);
  if (!question || options.length < 2) return null;
  return { question, options };
}

const ChatPollBox: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const parsed = parsePollText(msg.text);
  const [counts, setCounts] = useState<number[]>([]);
  const [total, setTotal] = useState(0);
  const [userVote, setUserVote] = useState<number | null>(null);
  const [voting, setVoting] = useState(false);
  const [showVoters, setShowVoters] = useState(false);
  const [voters, setVoters] = useState<{ id: string; name: string; avatar?: string; option: number }[]>([]);
  const [votersLoading, setVotersLoading] = useState(false);
  const loadVoters = async () => {
    if (!msg.id) return;
    setShowVoters(true);
    setVotersLoading(true);
    try {
      const { data } = await api.storyPoll(String(msg.id));
      const d = (data as any)?.data || data;
      const votes = d?.votes || {};
      const entries = Object.entries(votes) as [string, number][];
      const resolved = await Promise.all(entries.map(async ([uid, opt]) => {
        try {
          const { data: prof } = await api.getProfile(uid);
          const p = (prof as any)?.data || prof;
          return { id: uid, name: p?.name || p?.username || 'User', avatar: p?.avatar || p?.avatarUrl, option: Number(opt) };
        } catch {
          return { id: uid, name: 'User', avatar: undefined, option: Number(opt) };
        }
      }));
      setVoters(resolved);
    } catch { setVoters([]); }
    finally { setVotersLoading(false); }
  };
  useEffect(() => {
    if (!parsed || !msg.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.storyPoll(String(msg.id));
        if (cancelled) return;
        const d = (data as any)?.data || data;
        if (d) {
          setCounts(Array.isArray(d.counts) ? d.counts : []);
          setTotal(Number(d.total) || 0);
          setUserVote(d.userVote === null || d.userVote === undefined ? null : Number(d.userVote));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [msg.id]);
  if (!parsed) return <p className="whitespace-pre-wrap break-words">{msg.text}</p>;
  const { question, options } = parsed;
  const handleVote = async (idx: number) => {
    if (voting || userVote !== null) return;
    // Optimistic so Remove vote appears immediately.
    setUserVote(idx);
    setCounts((prev) => {
      const next = prev.length ? [...prev] : Array.from({ length: options.length }, () => 0);
      if (idx >= 0 && idx < next.length) next[idx] += 1;
      return next;
    });
    setTotal((t) => t + 1);
    setVoting(true);
    try {
      await api.storyPollVote({ storyId: msg.id, optionIndex: idx, optionCount: options.length });
    } catch {
      showError('Vote failed');
      setUserVote(null);
      setCounts((prev) => {
        const next = prev.length ? [...prev] : Array.from({ length: options.length }, () => 0);
        if (idx >= 0 && idx < next.length) next[idx] = Math.max(0, next[idx] - 1);
        return next;
      });
      setTotal((t) => Math.max(0, t - 1));
    }
    finally { setVoting(false); }
  };

  const handleRemoveVote = async () => {
    if (voting || userVote === null) return;
    const prevVote = userVote;
    setVoting(true);
    try {
      await api.storyPollVote({ storyId: msg.id, optionIndex: -1, optionCount: options.length });
      setUserVote(null);
      setCounts((prev) => {
        const next = prev.length ? [...prev] : Array.from({ length: options.length }, () => 0);
        if (prevVote >= 0 && prevVote < next.length) next[prevVote] = Math.max(0, next[prevVote] - 1);
        return next;
      });
      setTotal((t) => Math.max(0, t - 1));
    } catch { showError('Vote removal failed'); }
    finally { setVoting(false); }
  };
  return (
    <>
      <div className="rounded-xl bg-white/10 border border-white/20 p-3 space-y-2 min-w-[200px]">
        <p className="font-semibold text-sm">{question}</p>
      <div className="space-y-1.5">
        {options.map((opt, idx) => {
          const count = counts[idx] || 0;
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const voted = userVote === idx;
          // Chat polls allow previewing results before voting (unlike story polls).
          const showResults = true;
          return (
            <button
              key={idx}
              type="button"
              onClick={(e) => { e.stopPropagation(); handleVote(idx); }}
              disabled={userVote !== null || voting}
              className={`relative w-full text-left rounded-full border px-3 py-1.5 overflow-hidden text-sm transition ${voted ? 'border-blue-400 bg-blue-500/30' : 'border-white/30 bg-white/5 hover:bg-white/15'}`}
            >
              {showResults && <div className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${pct}%` }} />}
              <span className="relative flex items-center justify-between gap-2">
                <span className="truncate">{opt}</span>
                {showResults && <span className="text-xs opacity-80">{pct}%</span>}
              </span>
            </button>
          );
        })}
      </div>
      {userVote !== null && <p className="text-[11px] opacity-70">{total} vote{total === 1 ? '' : 's'}</p>}
      {userVote !== null && (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleRemoveVote(); }} className="rounded-full border border-white/30 bg-white/10 px-3 py-1 text-[11px] font-medium hover:bg-white/20 disabled:opacity-50" disabled={voting} style={{ pointerEvents: 'auto' }}>
          {voting ? 'Removing...' : 'Remove vote'}
        </button>
      )}
      {msg.fromMe && (
        <button type="button" onClick={(e) => { e.stopPropagation(); void loadVoters(); }} className="text-[11px] underline opacity-80 hover:opacity-100">
          View voters
        </button>
      )}
      {userVote === null && <p className="text-[11px] opacity-70">Tap an option to vote</p>}
    </div>
    {showVoters && (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70" onClick={(e) => { e.stopPropagation(); setShowVoters(false); }}>
        <div className="w-80 max-h-[70vh] overflow-auto rounded-lg bg-card p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-semibold">Poll voters</h3>
          {votersLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : voters.length === 0 ? (
            <p className="text-sm text-muted-foreground">No votes yet.</p>
          ) : (
            <ul className="space-y-2">
              {voters.map((v) => (
                <li key={v.id} className="flex items-center gap-2 text-sm">
                  <img src={v.avatar || ''} alt="" className="h-8 w-8 rounded-full object-cover bg-muted" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  <span className="flex-1 truncate">{v.name}</span>
                  <span className="text-xs text-muted-foreground">Option {v.option + 1}</span>
                </li>
              ))}
            </ul>
          )}
          <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setShowVoters(false); }}>Close</Button>
        </div>
      </div>
    )}
    </>
  );
};

const ChatSidebar = ({ isMobile = false }: { isMobile?: boolean }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<'followers' | 'following' | 'groups'>('followers');
  const [threads, setThreads] = useState<ChatThread[]>(() => listThreads());
  const [activeId, setActiveId] = useState<string | null>(null);
  // Groups
  const [groups, setGroups] = useState<any[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [isGroupChat, setIsGroupChat] = useState(false);
  const [groupMuted, setGroupMuted] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [forwardTarget, setForwardTarget] = useState<string>('');
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);
  const [groupEditOpen, setGroupEditOpen] = useState(false);
  const [groupEditName, setGroupEditName] = useState('');
  const [groupEditDesc, setGroupEditDesc] = useState('');
  const [groupEditImage, setGroupEditImage] = useState('');
  const [groupProfileImageOpen, setGroupProfileImageOpen] = useState(false);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [groupSelectionMode, setGroupSelectionMode] = useState(false);
  const [archivedThreadIds, setArchivedThreadIds] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem('equyvo_archived_threads'); return new Set(raw ? JSON.parse(raw) : []); } catch { return new Set(); }
  });
  const [showArchived, setShowArchived] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupMembers, setNewGroupMembers] = useState<string[]>([]);
  const [followCandidates, setFollowCandidates] = useState<any[]>([]);
  const [groupSearch, setGroupSearch] = useState('');
  const [groupSearchResults, setGroupSearchResults] = useState<any[]>([]);
  const [groupMsgs, setGroupMsgs] = useState<any[]>([]);
  const [message, setMessage] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [pollComposerOpen, setPollComposerOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState('');
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const fileInput2Ref = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [sending, setSending] = useState(false);
  // Image-attachment preview + crop/adjust step (same editor as thumbnails).
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const [attachCropSrc, setAttachCropSrc] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [menuMsgId, setMenuMsgId] = useState<string | null>(null);
  // Message selection (long-press) state
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [pinnedMsgId, setPinnedMsgId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId) { setPinnedMsgId(null); return; }
    try { setPinnedMsgId(localStorage.getItem('equyvo_pinned_' + activeId) || null); } catch { setPinnedMsgId(null); }
  }, [activeId]);
  useEffect(() => {
    if (!activeId) return;
    try {
      if (pinnedMsgId) localStorage.setItem('equyvo_pinned_' + activeId, pinnedMsgId);
      else localStorage.removeItem('equyvo_pinned_' + activeId);
    } catch { /* ignore */ }
  }, [activeId, pinnedMsgId]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const chatLongPressRef = useRef<{ timer: number | null; triggered: boolean }>({ timer: null, triggered: false });

  const startChatLongPress = (id: string) => {
    if (chatLongPressRef.current.timer) window.clearTimeout(chatLongPressRef.current.timer);
    chatLongPressRef.current.triggered = false;
    chatLongPressRef.current.timer = window.setTimeout(() => {
      chatLongPressRef.current.triggered = true;
      const ok = window.confirm('Delete this chat?');
      if (ok) {
        deleteThread(id);
        refreshThreads();
        if (activeId === id) setActiveId(null);
      }
    }, 500);
  };
  const cancelChatLongPress = () => {
    if (chatLongPressRef.current.timer) {
      window.clearTimeout(chatLongPressRef.current.timer);
      chatLongPressRef.current.timer = null;
    }
  };
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // --- Voice messages (mic in the composer) ---------------------------------
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recChunksRef = useRef<Blob[]>([]);
  const recStreamRef = useRef<MediaStream | null>(null);
  const recTimerRef = useRef<number | null>(null);
  const recSecsRef = useRef(0);
  const recCancelRef = useRef(false);
  const MAX_VOICE_SECS = 120;

  const [showScrollDown, setShowScrollDown] = useState(false);
  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stickToBottomRef.current = nearBottom;
    setShowScrollDown(!nearBottom);
  };
  const { chatTheme } = useChatTheme();
  const navigate = useNavigate();

  const activeGroupObj = isGroupChat ? (groups.find((g: any) => g.id === activeGroupId) || null) : null;
  const meId = String(getStoredUser()?.id || '');
  const isGroupLeader = !!activeGroupObj && activeGroupObj.leaderId === meId;
  const isGroupCoLeader = !!activeGroupObj && Array.isArray(activeGroupObj.coLeaders) && activeGroupObj.coLeaders.includes(meId);
  const groupReplyPerm = activeGroupObj?.settings?.replyPermission || 'all';
  const canGroupReply = !isGroupChat || groupReplyPerm === 'all' || (groupReplyPerm === 'leaders' && (isGroupLeader || isGroupCoLeader)) || (groupReplyPerm === 'leader' && isGroupLeader);
  const selectionMode = selectedMsgIds.size > 0;
  const activeChat = isGroupChat && activeGroupObj
    ? ({ id: activeGroupObj.id, peerId: activeGroupObj.id, peerName: activeGroupObj.name, peerAvatar: '', relation: 'group', online: false, lastMessage: '', timestamp: '', unread: 0 } as any)
    : (threads.find((t) => t.id === activeId) || null);
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);

  // Notify the app shell (bottom nav) whenever a conversation is open so the
  // nav can step out of the way of the pinned composer (WhatsApp-style).
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('equyvo:chat-open', { detail: { open: !!(activeId || activeGroupId) } }));
    return () => {
      window.dispatchEvent(new CustomEvent('equyvo:chat-open', { detail: { open: false } }));
    };
  }, [activeId, activeGroupId]);

  const refreshThreads = () => setThreads(listThreads());
  const refreshMsgs = (id: string | null) => setMsgs(id ? listMessages(id) : []);
  const refreshGroups = async () => {
    try {
      const res: any = await api.groupsList();
      setGroups(Array.isArray(res?.data?.groups) ? res.data.groups : []);
    } catch { setGroups([]); }
  };
  const openGroupChat = async (id: string) => {
    setActiveGroupId(id);
    setIsGroupChat(true);
    setActiveId(null);
    await refreshGroupMsgs(id);
  };
  const refreshGroupMsgs = async (id: string | null) => {
    if (!id) { setGroupMsgs([]); setMsgs([]); return; }
    try {
      const res: any = await api.groupMessages(id, 200);
      const group = res?.data?.group;
      if (group) {
        setGroups((prev: any[]) => prev.map((g: any) => g.id === id ? { ...g, ...group } : g));
      }
      let list = Array.isArray(res?.data?.messages) ? res.data.messages : [];
      const clearedAt = Number(group?.clearedAt || 0);
      if (clearedAt) list = list.filter((m: any) => Number(m?.createdAt || 0) > clearedAt);
      setGroupMsgs(list);
      setMsgs(list);
      const pinned = list.find((m: any) => m.pinned);
      if (pinned) setPinnedMsgId(pinned.id); else setPinnedMsgId(null);
    } catch { setGroupMsgs([]); setMsgs([]); }
  };

  // Presence heartbeat: keep this account's lastSeen fresh so followers/following
  // see an accurate online indicator in their chats.
  useEffect(() => {
    // try/catch cannot catch an async rejection — attach .catch explicitly.
    const beat = () => { try { void api.presence().catch(() => {}); } catch { /* ignore */ } };
    beat();
    const t = window.setInterval(beat, 30000);
    const onVis = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Initial: merge legacy localStorage contacts once, then load social graph.
  useEffect(() => {
    try {
      const raw = localStorage.getItem('equyvo_chat_contacts');
      if (raw) {
        const legacy = JSON.parse(raw);
        if (Array.isArray(legacy)) {
          const stored = getStoredUser();
          const selfIds = stored
            ? [stored.id, stored.username, stored.fullName, stored.email].filter(Boolean).map((s) => String(s).toLowerCase())
            : [];
          for (const c of legacy) {
            const name = String(c?.name || c?.id || '');
            if (!name || selfIds.includes(name.toLowerCase()) || selfIds.includes(String(c?.id || '').toLowerCase())) continue;
            ensureThread({ id: String(c?.id || name), name, avatar: String(c?.avatar || '') }, 'following');
          }
        }
      }
    } catch { /* ignore */ }
    refreshThreads();
     
  }, []);

  useEffect(() => { void refreshGroups(); }, []);
  useEffect(() => {
    if (!createGroupOpen) return;
    (async () => {
      try {
        const stored = getStoredUser();
        const uid = stored?.id || stored?.email || '';
        const [f, g] = await Promise.all([api.followers(uid), api.following(uid)]);
        const list = [...(f?.data?.profiles || f?.data?.ids || []), ...(g?.data?.profiles || g?.data?.ids || [])];
        // normalize to objects with id/name
        const norm = list.map((x: any) => (typeof x === 'string' ? { id: x, name: x } : x));
        // dedupe by id
        const seen = new Set();
        const uniq = norm.filter((x: any) => { const k = String(x.id || x); if (seen.has(k)) return false; seen.add(k); return true; });
        setFollowCandidates(uniq);
      } catch { setFollowCandidates([]); }
    })();
  }, [createGroupOpen]);
  useEffect(() => {
    let cancelled = false;
    const syncSocial = async () => {
      try {
        const [f, g] = await Promise.all([getFollowers(), getFollowing()]);
        if (cancelled) return;
        const toPeer = (p: SocialProfile) => {
          const resolved = pickDisplayName(p.name, p.username) || nameFromEmail(p.id) || String(p.id || '').trim();
          const online = p.online === true || (typeof p.lastSeen === 'string' && !!p.lastSeen && (Date.now() - new Date(p.lastSeen).getTime()) < 120000);
          return {
            id: p.id,
            name: resolved || String(p.id || '').trim(),
            avatar: p.avatar,
            online,
          };
        };
        syncThreadsFromSocial(f.list.map(toPeer), g.list.map(toPeer));
        refreshThreads();
        if (activeId) refreshMsgs(activeId);
      } catch {
        /* ignore */
      }
    };
    (async () => {
      setLoading(true);
      await syncSocial();
      if (!cancelled) setLoading(false);
    })();
    const onUpdate = () => {
      refreshThreads();
      if (activeId) refreshMsgs(activeId);
    };
    const onFollowChanged = () => { void syncSocial(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void syncSocial(); };
    const presenceTick = window.setInterval(() => { void syncSocial(); }, 30000);
    window.addEventListener('chatUpdated', onUpdate);
    window.addEventListener('followChanged', onFollowChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(presenceTick);
      window.removeEventListener('chatUpdated', onUpdate);
      window.removeEventListener('followChanged', onFollowChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
     
  }, [activeId]);

  // Mark seen on open AND when new messages arrive while the thread is open.
  useEffect(() => {
    if (!activeId) return;
    refreshMsgs(activeId);
    markThreadSeen(activeId);
    refreshThreads();
    pullThreadMessages(activeId).catch(() => {});
    let pollCount = 0;
    const t = window.setInterval(() => {
      pollCount += 1;
      pullThreadMessages(activeId)
        .then(() => {
          refreshMsgs(activeId);
          markThreadSeen(activeId);
          // Threads (unread badges) refresh every other cycle; ticks and
          // "Seen" labels arrive every poll.
          if (pollCount % 2 === 0) refreshThreads();
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(t);
     
  }, [activeId]);

  useEffect(() => {
    markThreadSeen(activeId ?? '');
    if (activeId) refreshThreads();
     
  }, [msgs.length]);

  useEffect(() => {
    if (activeGroupId && isGroupChat) {
      try { setGroupMuted(localStorage.getItem('equyvo_mute_group_' + activeGroupId) === '1'); } catch { setGroupMuted(false); }
      void refreshGroupMsgs(activeGroupId);
    }
  }, [activeGroupId]);
  useEffect(() => {
    if (!activeGroupObj) return;
    const members = Array.isArray(activeGroupObj.members) ? activeGroupObj.members : [];
    const missing = members.filter((m: string) => !memberNames[m]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const next = { ...memberNames };
      for (const m of missing) {
        try {
          const { data } = await api.getProfile(m);
          const p = (data as any)?.data || data;
          next[m] = p?.name || p?.username || m;
        } catch {
          next[m] = m;
        }
      }
      if (!cancelled) setMemberNames(next);
    })();
    return () => { cancelled = true; };
  }, [activeGroupObj, groupSettingsOpen]);
  useEffect(() => {
    if (groupEditOpen && activeGroupObj) {
      setGroupEditName(activeGroupObj.name || '');
      setGroupEditDesc(activeGroupObj.description || '');
      setGroupEditImage(activeGroupObj.avatar || '');
    }
  }, [groupEditOpen]);
  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [msgs.length, activeId, activeGroupId]);

  const visibleThreads = threads
    .filter((t) => !archivedThreadIds.has(t.id))
    .filter((t) => (tab === 'followers' ? t.relation === 'follower' || t.relation === 'mutual' : t.relation === 'following' || t.relation === 'mutual'))
    .filter((t) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      return (t.peerName || '').toLowerCase().includes(q) || (t.lastMessage || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (b.unread - a.unread) || b.timestamp.localeCompare(a.timestamp));

  const getChatBackgroundStyle = (): React.CSSProperties => {
    const opacity = typeof chatTheme.opacity === 'number' && Number.isFinite(chatTheme.opacity)
      ? Math.min(1, Math.max(0.05, chatTheme.opacity))
      : 1;
    if (chatTheme.type === 'color' && chatTheme.value) {
      return { backgroundColor: chatTheme.value, opacity };
    } else if (chatTheme.type === 'image' && chatTheme.value) {
      const safeUrl = String(chatTheme.value).replace(/"/g, '%22');
      return {
        backgroundImage: `url("${safeUrl}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        opacity,
      };
    }
    return {};
  };

  const clearAttachment = () => {
    setAttachedFile(null);
    if (attachPreview) {
      try { URL.revokeObjectURL(attachPreview); } catch { /* ignore */ }
      setAttachPreview(null);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSendMessage = async () => {
    if (recording || (!message.trim() && !attachedFile) || !activeChat || sending) return;
    if (isGroupChat && activeGroupId) {
      // Group send
      setSending(true);
      try {
        const textToSend = message.trim();
        let fileUrl = '', fileName = '', type: any = 'text';
        if (attachedFile) {
          const up = await api.uploadFile(attachedFile, 'equyvo/chat/attachments');
          if (up.error || !up?.data?.secureUrl) throw new Error('attachment-upload-failed');
          fileUrl = up.data.secureUrl;
          fileName = attachedFile.name;
          const mime = String(attachedFile.type || '').toLowerCase();
          type = mime === 'image/gif' ? 'gif' : mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file';
        }
        await api.groupSend(activeGroupId, { text: textToSend, type, fileUrl, fileName, replyTo: replyTo?.id });
        setMessage('');
        clearAttachment();
        setReplyTo(null);
        await refreshGroupMsgs(activeGroupId);
      } catch { showError('Message could not be sent. Try again.'); }
      finally { setSending(false); }
      return;
    }
    const threadId = activeChat.id;
    const textToSend = message.trim();
    const fileToSend = attachedFile;
    let attach: { fileUrl: string; fileName: string; type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'gif'; replyTo?: string } | undefined;
    setSending(true);
    try {
      if (fileToSend) {
        const up = await api.uploadFile(fileToSend, 'equyvo/chat/attachments');
        if (up.error || !up?.data?.secureUrl) throw new Error('attachment-upload-failed');
        const mime = String(fileToSend.type || '').toLowerCase();
        const type: 'text' | 'image' | 'file' | 'audio' | 'video' | 'gif' =
          mime === 'image/gif' ? 'gif'
            : mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video'
            : mime.startsWith('audio/') ? 'audio'
            : 'file';
        attach = {
          fileUrl: up.data.secureUrl,
          fileName: fileToSend.name,
          type,
          replyTo: replyTo?.id,
        };
      } else if (replyTo?.id) {
        attach = { fileUrl: '', fileName: '', type: 'text', replyTo: replyTo.id };
      }
      // attach replyTo for text-only replies
      if (replyTo?.id && attach) attach.replyTo = replyTo.id;
      if (replyTo?.id && !attach) {
        // text-only with reply: pass via a dummy attach? sendChatMessage attach optional; use replyTo in text? Instead call directly.
      }
      const sent = await sendChatMessage(threadId, textToSend, attach && attach.fileUrl ? attach : (replyTo?.id ? { fileUrl: '', fileName: '', type: 'text', replyTo: replyTo.id } : undefined));
      if (!sent) {
        showError('Message could not be sent. Try again.');
        if (attach?.fileUrl) URL.revokeObjectURL(attach.fileUrl);
        return;
      }
      // Only clear the composer after the message is safely stored.
      if (threadId === activeChat?.id) {
        setMessage('');
        clearAttachment();
        setReplyTo(null);
      }
      refreshMsgs(threadId);
      refreshThreads();
    } catch {
      showError('Message could not be sent. Try again.');
      if (attach?.fileUrl) URL.revokeObjectURL(attach.fileUrl);
    } finally {
      setSending(false);
    }
  };

  /** mm:ss label for the recording timer. */
  const recTimerLabel = `${String(Math.floor(recSecs / 60)).padStart(2, '0')}:${String(recSecs % 60).padStart(2, '0')}`;

  const stopRecTracks = () => {
    try { recStreamRef.current?.getTracks().forEach((tr) => tr.stop()); } catch { /* ignore */ }
    recStreamRef.current = null;
  };
  const stopRecTimer = () => {
    if (recTimerRef.current) { window.clearInterval(recTimerRef.current); recTimerRef.current = null; }
  };

  const startVoiceRecording = async () => {
    if (!activeChat || recording || sending) return;
    const threadId = activeChat.id;
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === 'undefined') {
      showError('Voice messages need microphone support on this device.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recStreamRef.current = stream;
      const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mime = mimes.find((m) => { try { return window.MediaRecorder.isTypeSupported(m); } catch { return false; } });
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunksRef.current = [];
      recCancelRef.current = false;
      setRecSecs(0);
      recSecsRef.current = 0;
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stopRecTimer();
        stopRecTracks();
        setRecording(false);
        const secs = recSecsRef.current;
        const cancelled = recCancelRef.current;
        recCancelRef.current = false;
        recorderRef.current = null;
        if (cancelled) return; // discarded — nothing uploaded or sent
        const blob = new Blob(recChunksRef.current, { type: rec.mimeType || 'audio/webm' });
        recChunksRef.current = [];
        if (!blob.size) {
          showError('Recording was empty — try again.');
          return;
        }
        setSending(true);
        try {
          const ext = String(rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
          const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type || 'audio/webm' });
          // One automatic retry: a network blip right after recording should
          // not waste the whole take. Second failure surfaces the toast.
          let up: { data?: { secureUrl?: string }; error?: unknown } = {};
          for (let attempt = 0; attempt < 2 && !up?.data?.secureUrl; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 800));
            up = await api.uploadFile(file, 'equyvo/chat/voice');
          }
          const data = up?.data;
          const error = up?.error;
          if (error || !data?.secureUrl) throw new Error('voice-upload-failed');
          setReplyTo(null);
          if (isGroupChat && activeGroupId) {
            await api.groupSend(activeGroupId, { text: '', type: 'audio', fileUrl: data.secureUrl, fileName: 'Voice message', durationSec: Math.max(1, secs || 0) });
            await refreshGroupMsgs(activeGroupId);
          } else {
            const sent = await sendChatMessage(threadId, '', {
              fileUrl: data.secureUrl,
              fileName: 'Voice message',
              type: 'audio',
              durationSec: Math.max(1, secs || 0),
              replyTo: replyTo?.id,
            });
            if (!sent) throw new Error('voice-send-failed');
            refreshMsgs(threadId);
            refreshThreads();
          }
        } catch (err: unknown) {
          const e = err as { name?: string; message?: string };
          showError(e?.name === 'ContentBlockedError' ? String(e.message) : 'Voice message could not be sent. Try again.');
          refreshMsgs(threadId);
        } finally {
          setSending(false);
        }
      };
      recorderRef.current = rec;
      setRecording(true);
      rec.start(250); // gather audio chunks every 250 ms
      recTimerRef.current = window.setInterval(() => {
        setRecSecs((s) => {
          const next = s + 1;
          recSecsRef.current = next;
          if (next >= MAX_VOICE_SECS) {
            try { if (rec.state === 'recording') rec.stop(); } catch { /* ignore */ }
          }
          return next;
        });
      }, 1000);
    } catch (err) {
      stopRecTimer();
      stopRecTracks();
      setRecording(false);
      const e = err as { name?: string };
      if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') {
        showError('No microphone was found on this device.');
      } else if (e?.name === 'NotReadableError') {
        showError('Your microphone is being used by another app. Close it and try again.');
      } else {
        // NotAllowedError / SecurityError / anything else → permission story.
        showError('Microphone permission is needed to record voice messages. Allow the mic for Equyvo, then tap the mic again.');
      }
    }
  };

  const cancelVoiceRecording = () => {
    recCancelRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') {
      try { rec.stop(); } catch { stopRecTimer(); stopRecTracks(); setRecording(false); }
    } else {
      recCancelRef.current = false;
      stopRecTimer();
      stopRecTracks();
      setRecording(false);
    }
  };

  const finishVoiceRecording = () => {
    const rec = recorderRef.current;
    if (rec && rec.state === 'recording') {
      try { rec.stop(); } catch { stopRecTimer(); stopRecTracks(); setRecording(false); }
    }
  };

  // If the sidebar unmounts mid-recording, release the mic and timers.
  useEffect(() => () => {
    recCancelRef.current = true;
    try { if (recorderRef.current && recorderRef.current.state === 'recording') recorderRef.current.stop(); } catch { /* ignore */ }
    stopRecTimer();
    stopRecTracks();
  }, []);

  const attachFile = (file: File) => {
    if (file.size > 10 * 1024 * 1024) {
      showError('Attachment must be smaller than 10MB.');
      return;
    }
    if (attachPreview) {
      try { URL.revokeObjectURL(attachPreview); } catch { /* ignore */ }
      setAttachPreview(null);
    }
    setAttachedFile(file);
    if (file.type.startsWith('image/')) {
      try {
        const url = URL.createObjectURL(file);
        setAttachPreview(url);
        setAttachCropSrc(url);
      } catch { /* preview is best-effort */ }
    }
  };
  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    attachFile(file);
    if (e.target) e.target.value = '';
  };

  const handleAttachCropComplete = (file: File) => {
    const original = attachedFile?.name || 'chat-image.jpg';
    // An adjusted GIF exports as a JPEG still — fix the extension so the
    // message renders as an image instead of a misnamed GIF.
    const name = file.type === 'image/jpeg' && /\.gif$/i.test(original)
      ? original.replace(/\.gif$/i, '.jpg')
      : original;
    const adjusted = new File([file], name, { type: file.type || 'image/jpeg' });
    if (attachPreview) {
      try { URL.revokeObjectURL(attachPreview); } catch { /* ignore */ }
    }
    setAttachedFile(adjusted);
    try {
      setAttachPreview(URL.createObjectURL(adjusted));
    } catch {
      setAttachPreview(null);
    }
    setAttachCropSrc(null);
  };

  const handleDeleteMessage = async (msg: ChatMessage, forEveryone: boolean) => {
    setMenuMsgId(null);
    if (!activeChat) return;
    if (forEveryone && !msg.fromMe) return;
    try {
      if (isGroupChat && activeGroupId) {
        await api.groupDeleteMsg(activeGroupId, msg.id, forEveryone);
        await refreshGroupMsgs(activeGroupId);
      } else {
        await deleteChatMessage(activeChat.id, msg.id, forEveryone);
        refreshMsgs(activeChat.id);
        refreshThreads();
      }
    } catch {
      showError('Could not delete message.');
    }
  };

  const handleCopyMessage = async (msg: ChatMessage) => {
    setMenuMsgId(null);
    const text = String(msg.text || msg.fileName || '').trim();
    if (!text) { showError('Nothing to copy.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      showSuccess('Copied to clipboard.');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showSuccess('Copied to clipboard.');
      } catch {
        showError('Could not copy.');
      }
    }
  };

  const handleReplyMessage = (msg: ChatMessage) => {
    setMenuMsgId(null);
    setReplyTo(msg);
  };

  const toggleSelectMsg = (id: string) => {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedMsgIds(new Set());
  const persistArchived = (next: Set<string>) => {
    try { localStorage.setItem('equyvo_archived_threads', JSON.stringify([...next])); } catch {}
  };
  const archiveThread = (id: string) => {
    setArchivedThreadIds((prev) => { const next = new Set(prev); next.add(id); persistArchived(next); return next; });
    if (activeId === id) { setActiveId(null); setMsgs([]); }
  };
  const unarchiveThread = (id: string) => {
    setArchivedThreadIds((prev) => { const next = new Set(prev); next.delete(id); persistArchived(next); return next; });
  };
  const deleteSelectedMsgs = async () => {
    if (!activeChat) return;
    for (const id of selectedMsgIds) {
      if (isGroupChat && activeGroupId) {
        try { await api.groupDeleteMsg(activeGroupId, id, false); } catch { /* ignore */ }
      } else {
        try { await deleteChatMessage(activeChat.id, id, false); } catch { /* ignore */ }
      }
    }
    clearSelection();
    if (isGroupChat && activeGroupId) await refreshGroupMsgs(activeGroupId);
    else refreshMsgs(activeChat.id);
  };
  const forwardSelectedMsgs = () => {
    setForwardTarget('');
    setForwardOpen(true);
  };
  const doForward = async () => {
    const target = forwardTarget;
    if (!target) return;
    const selected = msgs.filter((m: any) => selectedMsgIds.has(m.id));
    for (const m of selected) {
      const text = String(m.text || m.fileName || '');
      try {
        if (String(target).startsWith('grp_')) {
          await api.groupSend(String(target), { text, type: m.type || 'text', fileUrl: m.fileUrl || '', fileName: m.fileName || '', forwarded: true });
        } else {
          await sendChatMessage(String(target), text, { fileUrl: m.fileUrl || '', fileName: m.fileName || '', type: (m.type || 'text') as any, forwarded: true });
        }
      } catch { /* best-effort */ }
    }
    clearSelection();
    setForwardOpen(false);
    showSuccess('Forwarded');
  };
  const pinSelectedMsg = async () => {
    const first = [...selectedMsgIds][0];
    if (!first) return;
    if (pinnedMsgId === first) {
      setPinnedMsgId(null);
      if (isGroupChat && activeGroupId) { try { await api.groupPin(activeGroupId, first, false); } catch {} }
    } else {
      setPinnedMsgId(first);
      if (isGroupChat && activeGroupId) { try { await api.groupPin(activeGroupId, first, true); } catch {} }
    }
    clearSelection();
  };

  const isAttachedImage = !!attachedFile && attachedFile.type.startsWith('image/');
  const isAttachedGif = !!attachedFile && attachedFile.type === 'image/gif';

  const shell = isMobile
    ? 'chat-mobile-shell w-full flex flex-col bg-background'
    : 'h-[calc(100vh-6.5rem)] w-80 fixed right-4 top-24 bg-card/95 backdrop-blur-xl border border-border/50 rounded-2xl shadow-2xl overflow-hidden hidden lg:flex flex-col z-40';

  return (
    <>
    <div className={shell}>
      <div className="p-4 border-b border-border bg-muted/30">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-lg flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-primary" /> Chats
          </h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Archived" title="Archived chats" onClick={() => setShowArchived(true)}>
            <Archive className="w-4 h-4" />
          </Button>
          <ChatThemeSelector>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Customize chat background" title="Customize chat background">
              <Palette className="w-4 h-4" />
            </Button>
          </ChatThemeSelector>
        </div>
        <Tabs value={tab} onValueChange={(v) => { setTab(v as 'followers' | 'following' | 'groups'); setSearchQuery(''); }} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="followers">Followers</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {tab === 'followers'
            ? 'Followers — accounts that follow you can message you here.'
            : tab === 'following'
            ? 'Following — accounts you follow; you can message them here.'
            : 'Groups — create groups and chat with multiple people at once.'}
        </p>
      </div>

      <div className="relative p-4 pb-2">
        <Search aria-hidden className="absolute left-6 top-[26px] h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={tab === 'followers' ? 'Search followers…' : 'Search following…'}
          aria-label={tab === 'followers' ? 'Search followers' : 'Search following'}
          className="pl-8 pr-8 bg-background/50"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          maxLength={100}
        />
        {searchQuery && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-5 top-[20px] h-6 w-6"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {!activeChat && !activeGroupId && (
        <ScrollArea className="flex-1">
          <div className="divide-y divide-border/20">
            {tab === 'groups' ? (
              <>
                <div className="p-3 flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Groups</p>
                  <Button size="sm" variant="outline" onClick={() => setCreateGroupOpen(true)}>
                    <Plus className="h-4 w-4 mr-1" /> New group
                  </Button>
                </div>
                <div className="p-3">
                  <Input placeholder="Search groups…" value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)} />
                </div>
                {groupSelectionMode && (
                  <div className="p-3 flex items-center gap-2 bg-purple-500/10 border-b border-purple-500/30">
                    <span className="text-sm font-medium flex-1">{selectedGroupId ? '1 group selected' : 'Select a group'}</span>
                    {selectedGroupId && (
                      <>
                        <Button size="sm" variant="outline" onClick={async () => {
                          const g = groups.find((x: any) => x.id === selectedGroupId);
                          if (!g) return;
                          const next = !g.archived;
                          try { await api.groupArchive(selectedGroupId, next); setGroups((prev: any[]) => prev.map((x: any) => x.id === selectedGroupId ? { ...x, archived: next } : x)); await refreshGroups(); showSuccess(next ? 'Archived' : 'Unarchived'); } catch { showError('Could not archive'); }
                          setGroupSelectionMode(false); setSelectedGroupId(null);
                        }}>Archive</Button>
                        <Button size="sm" variant="destructive" onClick={async () => {
                          if (!selectedGroupId) return;
                          const ok = window.confirm('Delete this group permanently?');
                          if (!ok) return;
                          try { await api.groupDeleteGroup(selectedGroupId); setGroups((prev: any[]) => prev.filter((g: any) => g.id !== selectedGroupId)); await refreshGroups(); showSuccess('Group deleted'); } catch { showError('Could not delete group'); }
                          setGroupSelectionMode(false); setSelectedGroupId(null);
                        }}>Delete</Button>
                      </>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => { setGroupSelectionMode(false); setSelectedGroupId(null); }}>Cancel</Button>
                  </div>
                )}
                {groups.filter((g: any) => !g.archived).filter((g: any) => !groupSearch.trim() || String(g.name || '').toLowerCase().includes(groupSearch.trim().toLowerCase())).length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">
                    <MessageCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    {groups.length === 0 ? (
                      <>
                        <p className="text-sm font-medium">No groups yet</p>
                        <p className="mt-1 text-xs opacity-80">Create a group to chat with multiple people.</p>
                        <Button className="mt-3" size="sm" onClick={() => setCreateGroupOpen(true)}>Create group</Button>
                      </>
                    ) : groupSearch.trim() ? (
                      <>
                        <p className="text-sm font-medium">No matching results</p>
                        <p className="mt-1 text-xs opacity-80">No groups match "{groupSearch.trim()}".</p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium">No groups yet</p>
                      </>
                    )}
                  </div>
                ) : (
                  groups
                    .filter((g: any) => !g.archived)
                    .filter((g: any) => !groupSearch.trim() || String(g.name || '').toLowerCase().includes(groupSearch.trim().toLowerCase()))
                    .map((g: any) => (
                      <div key={g.id} role="button" tabIndex={0} className={`flex items-center gap-3 p-3 hover:bg-secondary/20 cursor-pointer transition-colors ${selectedGroupId === g.id ? 'bg-purple-500/20 ring-1 ring-purple-500/40' : ''}`}
                        onClick={() => {
                          if (groupSelectionMode) {
                            setSelectedGroupId(selectedGroupId === g.id ? null : g.id);
                            return;
                          }
                          setIsGroupChat(true); void openGroupChat(g.id);
                        }}
                        onTouchStart={() => {
                          if (groupSelectionMode) return;
                          const t = window.setTimeout(() => {
                            setGroupSelectionMode(true);
                            setSelectedGroupId(g.id);
                          }, 500);
                          (g as any)._t = t;
                        }}
                        onTouchEnd={() => { const t = (g as any)._t; if (t) window.clearTimeout(t); }}
                        onTouchMove={() => { const t = (g as any)._t; if (t) window.clearTimeout(t); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setGroupSelectionMode(true);
                          setSelectedGroupId(g.id);
                        }}
                      >
                        <Avatar><AvatarFallback>{String(g.name || 'G').slice(0,2).toUpperCase()}</AvatarFallback></Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{g.name}</p>
                          <p className="text-xs text-muted-foreground truncate">{(g.members || []).length} members</p>
                        </div>
                      </div>
                    ))
                )}
              </>
            ) : loading && threads.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading your people…</div>
            ) : visibleThreads.length > 0 ? (
              visibleThreads.map((contact) => (
                <div
                  key={contact.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open chat with ${contact.peerName}${contact.unread > 0 ? `, ${contact.unread} unread` : ''}`}
                  className="flex items-center gap-3 p-3 hover:bg-secondary/20 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    if (chatLongPressRef.current.triggered) {
                      chatLongPressRef.current.triggered = false;
                      return;
                    }
                    setActiveId(contact.id);
                  }}
                  onTouchStart={() => startChatLongPress(contact.id)}
                  onTouchEnd={cancelChatLongPress}
                  onTouchMove={cancelChatLongPress}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const ok = window.confirm('Delete this chat?');
                    if (ok) {
                      deleteThread(contact.id);
                      refreshThreads();
                      if (activeId === contact.id) setActiveId(null);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setActiveId(contact.id);
                    }
                  }}
                >
                  <div className="relative">
                    <Avatar
                      className="cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigateToProfile(navigate, contact.peerId, contact.peerName);
                      }}
                      title={`${contact.peerName}'s Profile`}
                    >
                      <AvatarImage src={contact.peerAvatar} alt={`${contact.peerName} avatar`} />
                      <AvatarFallback>{(contact.peerName || '?')[0]?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                    {contact.online && (
                      <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-background" aria-label="Online" role="status" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="font-medium text-sm truncate">{contact.peerName}</p>
                      <span className="text-xs text-muted-foreground shrink-0">{contact.timestamp}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground truncate">{contact.lastMessage || (contact.relation === 'mutual' ? 'You follow each other — say hi' : tab === 'followers' ? 'Follows you' : 'You follow them')}</p>
                      {contact.unread > 0 && (
                        <span
                          aria-label={`${contact.unread} unread messages`}
                          className="flex h-5 min-w-5 items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[11px] font-bold text-white"
                        >
                          {contact.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-8 text-center text-muted-foreground">
                <MessageCircle className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p className="text-sm font-medium">{tab === 'followers' ? 'No followers yet' : 'You are not following anyone yet'}</p>
                <p className="mt-1 text-xs opacity-80">
                  {tab === 'followers' ? 'When accounts follow you, they appear here and can message you.' : 'Follow accounts to message them from this tab.'}
                </p>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      {activeChat && (
        /* Mobile: fixed full-screen overlay — the composer stays pinned to the
           viewport bottom (adjustResize shrinks the webview under the
           keyboard), so the input bar is ALWAYS visible. Covers the app
           bottom nav while a chat is open, like WhatsApp. */
        <div className={isMobile
          ? 'chat-open-overlay fixed inset-x-0 bottom-0 top-0 z-50 flex flex-col bg-[#0b141a]'
          : 'absolute inset-0 bg-background z-10 flex flex-col'}
        >
          <div className="p-3 border-b flex items-center gap-3 bg-white/95 dark:bg-secondary/30 backdrop-blur-md shrink-0">
            {selectionMode ? (
              <>
                <Button variant="ghost" size="icon" className="h-8 w-8 -ml-1 mr-1" onClick={clearSelection} aria-label="Clear selection" title="Clear selection">
                  <X className="w-4 h-4" />
                </Button>
                <span className="font-semibold text-sm">{selectedMsgIds.size} selected</span>
                <div className="flex-1" />
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void deleteSelectedMsgs()} aria-label="Delete selected" title="Delete selected">
                  <Trash2 className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void forwardSelectedMsgs()} aria-label="Forward selected" title="Forward selected">
                  <ArrowRight className="w-4 h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void pinSelectedMsg()} aria-label="Pin/unpin selected" title="Pin/unpin selected">
                  <Pin className="w-4 h-4" />
                </Button>
              </>
            ) : (
            isGroupChat ? (
            <>
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-1 mr-1" onClick={() => { setActiveId(null); setActiveGroupId(null); setIsGroupChat(false); setMsgs([]); refreshThreads(); void refreshGroups(); }} aria-label="Back to chat list" title="Back to chat list">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <button
              type="button"
              onClick={() => setGroupProfileImageOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label="Open group profile image"
              title="Open group profile image"
            >
              <Avatar className="h-8 w-8 shrink-0 cursor-pointer">
                <AvatarImage src={activeGroupObj?.avatar || ''} alt={`${activeGroupObj?.name || 'Group'} avatar`} />
                <AvatarFallback>{(activeGroupObj?.name || 'G').slice(0,2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate hover:underline">{activeGroupObj?.name || activeChat.peerName}</p>
                <p className="text-xs text-muted-foreground">{(activeGroupObj?.members || []).length} members</p>
              </div>
            </button>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Group settings" title="Group settings" onClick={() => setGroupSettingsOpen(true)}>
              <MoreVertical className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Clear chat" title="Clear chat" onClick={() => {
              if (!activeGroupId) return;
              const ok = window.confirm('Clear all messages in this group?');
              if (!ok) return;
              void api.groupClear(activeGroupId).then((r: any) => { if (r?.error) { showError(r.error); return; } setGroupMsgs([]); setMsgs([]); showSuccess('Chat cleared'); }).catch(() => { showError('Could not clear chat'); });
              try { localStorage.setItem('equyvo_chat_cleared_' + activeGroupId, String(Date.now())); } catch {}
            }}>
              <Eraser className="w-4 h-4" />
            </Button>
            </>
            ) : (
            <>

            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-1 mr-1" onClick={() => { setActiveId(null); setActiveGroupId(null); setIsGroupChat(false); setMsgs([]); refreshThreads(); void refreshGroups(); }} aria-label="Back to chat list" title="Back to chat list">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <button
              type="button"
              onClick={() => {
                // Close the conversation before routing so the chat overlay
                // never covers the profile being opened.
                setActiveId(null);
                navigateToProfile(navigate, activeChat.peerId, activeChat.peerName);
              }}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={`Open ${activeChat.peerName}'s profile`}
              title={`Open ${activeChat.peerName}'s profile`}
            >
              <Avatar className="h-8 w-8 shrink-0 cursor-pointer">
                <AvatarImage src={activeChat.peerAvatar} alt={`${activeChat.peerName} avatar`} />
                <AvatarFallback>{(activeChat.peerName || '?')[0]?.toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate hover:underline">{activeChat.peerName}</p>
                <p className="text-xs text-muted-foreground">
                  {activeChat.relation === 'mutual' ? 'You follow each other' : activeChat.relation === 'follower' ? 'Follows you' : 'You follow them'}
                  {activeChat.online ? ' · Online' : ''}
                </p>
              </div>
            </button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Open camera"
              title="Open camera"
              onClick={() => setCameraOpen(true)}
            >
              <Camera className="w-4 h-4" />
            </Button>
            {/* Background selector reachable even while the chat is open
                (the desktop sidebar header sits under the chat panel overlay). */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label="Clear chat"
              title="Clear chat"
              onClick={() => {
                if (!activeChat) return;
                const ok = window.confirm('Clear all messages in this chat?');
                if (!ok) return;
                void clearThread(activeChat.id);
                refreshMsgs(activeChat.id);
                refreshThreads();
              }}
            >
              <Eraser className="w-4 h-4" />
            </Button>
            {!isGroupChat && (
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Archive chat" title="Archive chat" onClick={() => {
                if (!activeChat) return;
                archiveThread(activeChat.id);
                showSuccess('Archived');
              }}>
                <Archive className="w-4 h-4" />
              </Button>
            )}
            {isGroupChat && (isGroupLeader || isGroupCoLeader) && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Add member"
                title="Add member"
                onClick={async () => {
                  const q = window.prompt('Search profile name to add');
                  if (!q) return;
                  try {
                    const res: any = await api.search(q, 5);
                    const users = res?.data?.users || res?.data?.results || [];
                    if (!Array.isArray(users) || users.length === 0) { showError('No profile found'); return; }
                    const u = users[0];
                    await api.groupAddMember(activeGroupId!, String(u.id));
                    await refreshGroups();
                    showSuccess('Member added');
                  } catch { showError('Could not add member'); }
                }}
              >
                <Plus className="w-4 h-4" />
              </Button>
            )}
            {isGroupChat && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label={groupMuted ? 'Unmute group' : 'Mute group'}
                title={groupMuted ? 'Unmute group' : 'Mute group'}
                onClick={() => {
                  const next = !groupMuted;
                  setGroupMuted(next);
                  try {
                    if (next) localStorage.setItem('equyvo_mute_group_' + activeGroupId, '1');
                    else localStorage.removeItem('equyvo_mute_group_' + activeGroupId);
                  } catch { /* ignore */ }
                }}
              >
                <Volume2 className="w-4 h-4" />
              </Button>
            )}
            {isGroupChat && (isGroupLeader || isGroupCoLeader) && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Edit group"
                title="Edit group name/description"
                onClick={async () => {
                  const name = window.prompt('Group name', activeGroupObj?.name || '');
                  if (name === null) return;
                  const description = window.prompt('Group description', activeGroupObj?.description || '');
                  if (description === null) return;
                  try {
                    await api.groupProfile(activeGroupId!, { name: name.trim() || undefined, description: description.trim() });
                    await refreshGroups();
                    showSuccess('Group updated');
                  } catch { showError('Could not update group'); }
                }}
              >
                <MoreVertical className="w-4 h-4" />
              </Button>
            )}
            {isGroupChat && isGroupLeader && (
              <select
                className="h-8 rounded-md border bg-background px-2 text-xs"
                value={groupReplyPerm}
                onChange={async (e) => {
                  try { await api.groupSettings(activeGroupId!, e.target.value); await refreshGroups(); } catch { /* ignore */ }
                }}
                aria-label="Reply permission"
                title="Who can reply"
              >
                <option value="all">All can reply</option>
                <option value="leaders">Leaders can reply</option>
                <option value="leader">Only leader</option>
              </select>
            )}
            <ChatThemeSelector>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Customize chat background"
                title="Customize chat background"
              >
                <Palette className="w-4 h-4" />
              </Button>
            </ChatThemeSelector>
            </>

            )
            )}
          </div>

          {/* WhatsApp-style message area. Background is a sibling layer of the
              scroll container so it ALWAYS covers the visible area (it never
              scrolls away with content) and renders as soon as an image/GIF
              theme is applied. */}
          <div className={`relative flex-1 min-h-0 bg-[#0b141a] dark:bg-[#0b141a] overflow-hidden`}>
            {chatTheme.type !== 'default' && (
              <div
                className="absolute inset-0 pointer-events-none"
                style={getChatBackgroundStyle()}
                aria-hidden
              />
            )}
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="absolute inset-0 z-10 overflow-y-auto overscroll-contain p-4"
            >
              <div className="flex flex-col gap-1.5">
                {msgs.length === 0 && (
                <div className="text-center text-muted-foreground py-8">
                  <p className="mx-auto max-w-[260px] rounded-lg bg-black/40 px-3 py-1.5 text-xs text-amber-100/90">
                    {isGroupChat ? 'No messages yet in this group. Say hi!' : `Messages are gated by follow — ${activeChat.relation === 'follower' ? `${activeChat.peerName} follows you, so they can write here.` : activeChat.relation === 'following' ? `You follow ${activeChat.peerName}, so you can write here.` : 'you follow each other.'}`}
                  </p>
                </div>
              )}
              {msgs.map((msg) => {
                if (msg.deletedForEveryone) {
                  const sel = selectedMsgIds.has(msg.id);
                  return (
                    <div key={msg.id} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] relative group ${sel ? 'ring-2 ring-purple-500/60 rounded-xl' : ''}`}>
                        {selectionMode && (
                          <div className={`absolute ${msg.fromMe ? '-left-7' : '-right-7'} top-1/2 -translate-y-1/2`}>
                            <div className={`h-5 w-5 rounded-full border flex items-center justify-center ${sel ? 'bg-purple-600 border-purple-600 text-white' : 'border-slate-400'}`}>
                              {sel && <Check className="h-3 w-3" />}
                            </div>
                          </div>
                        )}
                        <div
                          className={`px-3 py-1.5 rounded-xl text-sm shadow-sm italic opacity-70 bg-slate-800/60 text-slate-300 rounded-tl-none ${sel ? 'bg-purple-500/20' : ''}`}
                          onContextMenu={(e) => { e.preventDefault(); setMenuMsgId(msg.id); }}
                          onTouchStart={() => { const t = window.setTimeout(() => toggleSelectMsg(msg.id), 500); (msg as any)._t = t; }}
                          onTouchEnd={() => { const t = (msg as any)._t; if (t) window.clearTimeout(t); }}
                          onTouchMove={() => { const t = (msg as any)._t; if (t) window.clearTimeout(t); }}
                          onClick={() => { if (selectionMode) toggleSelectMsg(msg.id); }}
                        >
                          This message was deleted
                          <div className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-400`}>
                            <span>{new Date(msg.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                const msgSelected = selectedMsgIds.has(msg.id);
                return (
                <div key={msg.id} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] relative group ${msgSelected ? 'ring-2 ring-purple-500/60 rounded-xl' : ''}`}>
                    {selectionMode && (
                      <div className={`absolute ${msg.fromMe ? '-left-7' : '-right-7'} top-1/2 -translate-y-1/2 z-30`}>
                        <div className={`h-5 w-5 rounded-full border flex items-center justify-center ${msgSelected ? 'bg-purple-600 border-purple-600 text-white' : 'border-slate-400 bg-slate-900/60'}`}>
                          {msgSelected && <Check className="h-3 w-3" />}
                        </div>
                      </div>
                    )}
                    <button
                      type="button"
                      aria-label="Message actions"
                      className="absolute -top-2 -right-2 z-20 hidden group-hover:flex h-6 w-6 items-center justify-center rounded-full bg-slate-900/80 text-slate-200 hover:text-white"
                      onClick={() => setMenuMsgId(menuMsgId === msg.id ? null : msg.id)}
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                    <div
                      className={`px-3 py-1.5 rounded-xl text-sm shadow-sm ${
                        msg.fromMe
                          ? 'bg-purple-600 text-white rounded-tr-none'
                          : 'bg-slate-700 text-slate-100 rounded-tl-none dark:bg-slate-700'
                      } ${msgSelected ? 'bg-purple-500/30' : ''}`}
                      onContextMenu={(e) => { e.preventDefault(); setMenuMsgId(msg.id); }}
                      onTouchStart={() => { const t = window.setTimeout(() => toggleSelectMsg(msg.id), 500); (msg as any)._t = t; }}
                      onTouchEnd={() => { const t = (msg as any)._t; if (t) window.clearTimeout(t); }}
                      onTouchMove={() => { const t = (msg as any)._t; if (t) window.clearTimeout(t); }}
                      onClick={() => { if (selectionMode) toggleSelectMsg(msg.id); }}
                    >
                      {isGroupChat && !msg.fromMe && (msg as any).senderName && (
                        <p className="text-[11px] font-semibold text-sky-300/90 mb-0.5">{(msg as any).senderName}</p>
                      )}
                      {msg.forwarded && (
                        <p className="text-[11px] italic opacity-70 mb-1">Forwarded</p>
                      )}
                      {pinnedMsgId === msg.id && (
                        <p className="text-[11px] opacity-70 mb-1 flex items-center gap-1"><Pin className="h-3 w-3" /> Pinned</p>
                      )}
                      {msg.replyTo && (
                        <div className="mb-1 border-l-2 border-white/40 pl-2 text-xs opacity-80">
                          {msgs.find((m) => m.id === msg.replyTo)?.text || msgs.find((m) => m.id === msg.replyTo)?.fileName || 'Message'}
                        </div>
                      )}
                      {msg.type === 'image' && msg.fileUrl ? (
                        <div className="space-y-1.5">
                          <img src={msg.fileUrl} alt="Shared image" loading="lazy" className="max-w-full rounded-lg" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          {msg.text && <p className="whitespace-pre-wrap break-words">{msg.text}</p>}
                        </div>
                      ) : msg.type === 'audio' && msg.fileUrl ? (
                        <div className="min-w-[210px] space-y-1">
                          <VoiceBubble msg={msg} />
                          {!!msg.durationSec && <p className="text-[11px] opacity-80 text-right">Voice message · {msg.durationSec}s</p>}
                          {msg.text && <p className="whitespace-pre-wrap break-words">{msg.text}</p>}
                        </div>
                      ) : msg.type === 'file' && msg.fileUrl ? (
                        <div className="flex items-center gap-2">
                          <Paperclip className="w-4 h-4 shrink-0" />
                          <div className="min-w-0">
                            <a href={msg.fileUrl} download={msg.fileName || 'attachment'} className="truncate font-medium underline underline-offset-2 hover:opacity-80" onClick={(e) => e.stopPropagation()}>
                              {msg.fileName || 'Attachment'}
                            </a>
                            {msg.text && <p className="text-xs opacity-80">{msg.text}</p>}
                          </div>
                        </div>
                      ) : isPollText(msg.text) ? (
                        <ChatPollBox msg={msg} />
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                      )}
                      <div className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] ${msg.fromMe ? 'text-white/70' : 'text-slate-400'}`}>
                        <span>{new Date(msg.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        {msg.fromMe && msg.status === 'failed' ? (
                          <button
                            type="button"
                            className="ml-0.5 flex items-center gap-1 rounded text-red-400 hover:text-red-300"
                            title="Not delivered — tap to retry"
                            aria-label="Not delivered, tap to retry"
                            onClick={() => { void retryChatMessage(msg.threadId, msg.id); }}
                          >
                            <X className="h-4 w-4" />
                            <span className="text-[10px] font-medium">Retry</span>
                          </button>
                        ) : msg.fromMe && <Ticks status={msg.status} />}
                      </div>
                      {/* Read receipt INSIDE the bubble, under the timestamp: only
                          for MY messages, only when seen (the ONLY seen signal — no
                          blue tick). Incoming bubbles show nothing. */}
                      {msg.fromMe && msg.status === 'seen' && (
                        <p className="text-right text-[11px] text-sky-300/90">Seen</p>
                      )}
                    </div>
                    {menuMsgId === msg.id && (
                      <div className={`mt-1 flex flex-col gap-1 rounded-lg border border-slate-600 bg-slate-900 p-1 shadow-lg ${msg.fromMe ? 'items-end' : 'items-start'}`}>
                        <button
                          type="button"
                          className="flex items-center gap-2 rounded px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
                          onClick={() => handleCopyMessage(msg)}
                        >
                          <Check className="h-3 w-3" /> Copy
                        </button>
                        <button
                          type="button"
                          className="flex items-center gap-2 rounded px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
                          onClick={() => handleReplyMessage(msg)}
                        >
                          <MessageCircle className="h-3 w-3" /> Reply
                        </button>
                        <button
                          type="button"
                          className="flex items-center gap-2 rounded px-2 py-1 text-xs text-slate-200 hover:bg-slate-700"
                          onClick={() => handleDeleteMessage(msg, false)}
                        >
                          <Trash2 className="h-3 w-3" /> Delete for me
                        </button>
                        {msg.fromMe && (
                          <button
                            type="button"
                            className="flex items-center gap-2 rounded px-2 py-1 text-xs text-red-300 hover:bg-slate-700"
                            onClick={() => handleDeleteMessage(msg, true)}
                          >
                            <Trash2 className="h-3 w-3" /> Delete for everyone
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
              <div ref={bottomRef} />
              </div>
            </div>
           </div>
             {showScrollDown && (
               <button
                 type="button"
                 aria-label="Scroll to latest message"
                 title="Scroll to latest message"
                 onClick={() => {
                   const el = scrollContainerRef.current;
                   if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                   stickToBottomRef.current = true;
                   setShowScrollDown(false);
                 }}
                 className="absolute bottom-4 right-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-purple-600 text-white shadow-lg hover:bg-purple-500"
               >
                 <ChevronDown className="h-5 w-5" />
               </button>
             )}

           <div className="p-3 border-t bg-white/95 dark:bg-background/50 backdrop-blur-md flex-none chat-overlay-composer">
            {replyTo && (
              <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-slate-600 bg-slate-800/60 px-3 py-2 text-xs text-slate-200">
                <div className="min-w-0">
                  <p className="font-medium text-slate-100">Replying to {replyTo.fromMe ? 'yourself' : activeChat?.peerName}</p>
                  <p className="truncate text-slate-300">{replyTo.text || replyTo.fileName || 'Attachment'}</p>
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
            {attachedFile && (
              <div className="mb-3 p-3 bg-secondary/50 rounded-lg border">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {isAttachedImage && attachPreview ? (
                      <img
                        src={attachPreview}
                        alt="Attachment preview"
                        className="h-12 w-12 shrink-0 rounded-md border object-cover"
                        onError={() => setAttachPreview(null)}
                      />
                    ) : (
                      <Paperclip className="w-4 h-4 shrink-0" />
                    )}
                    <span className="text-sm truncate max-w-[160px]">{attachedFile.name}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {isAttachedImage && attachPreview && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setAttachCropSrc(attachPreview)}
                        aria-label="Crop or adjust attached image"
                        title={isAttachedGif ? 'Adjust GIF (keeps animation when unchanged)' : 'Crop or adjust attached image'}
                      >
                        <Crop className="w-3 h-3 mr-1" /> Adjust
                      </Button>
                    )}
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={clearAttachment} aria-label="Remove attachment">
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                {isAttachedGif && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">GIF stays animated when sent as-is.</p>
                )}
              </div>
            )}
            {!canGroupReply && (
              <p className="mb-2 text-xs text-muted-foreground">Only leaders can reply in this group.</p>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendMessage();
              }}
            >
              {recording ? (
                // Voice-recording bar — replaces the text input while recording.
                <div className="flex flex-1 items-center gap-2">
                  <span className="flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
                    <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
                    {recTimerLabel}
                  </span>
                  <span className="flex-1 truncate text-xs text-muted-foreground">Recording voice message…</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10 text-muted-foreground"
                    onClick={cancelVoiceRecording}
                    disabled={sending}
                    aria-label="Cancel recording"
                    title="Cancel recording"
                  >
                    <X className="w-5 h-5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    className="h-10 w-10 rounded-full bg-purple-600 hover:bg-purple-500"
                    onClick={finishVoiceRecording}
                    disabled={sending}
                    aria-label="Send voice message"
                    title="Send voice message"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
              <>
              <div className="relative">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf,.doc,.docx,.txt"
                  onChange={handleFileAttach}
                  className="sr-only"
                  aria-label="Attach file"
                  tabIndex={-1}
                />
                <input ref={photoInputRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value=''; if (f) { attachFile(f); setAttachMenuOpen(false); } }} />
                <input ref={videoInputRef} type="file" accept="video/*" multiple className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value=''; if (f) { attachFile(f); setAttachMenuOpen(false); } }} />
                <input ref={fileInput2Ref} type="file" accept="*/*" multiple className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value=''; if (f) { attachFile(f); setAttachMenuOpen(false); } }} />
                <input ref={folderInputRef} type="file" multiple {...({ webkitdirectory: '', directory: '' } as any)} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value=''; if (f) { attachFile(f); setAttachMenuOpen(false); } }} />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 text-muted-foreground"
                  aria-label="Attach"
                  title="Attach"
                  onClick={() => setAttachMenuOpen((v) => !v)}
                >
                  <Paperclip className="w-5 h-5" />
                </Button>
                {/* menu rendered at root level (see below) */}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 text-muted-foreground"
                onClick={() => void startVoiceRecording()}
                disabled={sending}
                aria-label="Record voice message"
                title="Record voice message"
              >
                <Mic className="w-5 h-5" />
              </Button>
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={`${t('chat.message')} ${activeChat.peerName}…`}
                aria-label={`${t('chat.message')} ${activeChat.peerName}`}
                className="bg-secondary/50"
                maxLength={2000}
                disabled={sending || !canGroupReply}
              />
              <Button
                type="submit"
                size="icon"
                className="h-10 w-10 rounded-full bg-purple-600 hover:bg-purple-500"
                disabled={(!message.trim() && !attachedFile) || sending || !canGroupReply}
                aria-label={sending ? 'Sending…' : 'Send message'}
                title={sending ? 'Sending…' : 'Send message (Enter)'}
              >
                <Send className="w-4 h-4" />
              </Button>
              </>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
    {cameraOpen && (
      <ChatCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onAttach={(file) => { attachFile(file); setCameraOpen(false); }}
      />
    )}
    {/* Image/GIF crop/adjust editor — same tool as thumbnails. Untouched
        GIFs stay animated; adjusting one exports a still frame. */}
    {attachCropSrc && (
      <MediaCropper
        imageSrc={attachCropSrc}
        preserveAspect
        isGif={isAttachedGif}
        keepOriginalLabel="Send GIF as-is"
        title="Adjust image"
        confirmLabel="Use image"
        fileName={attachedFile?.name || 'chat-image.jpg'}
        onCancel={() => setAttachCropSrc(null)}
        onKeepOriginal={() => setAttachCropSrc(null)}
        onCropComplete={handleAttachCropComplete}
      />
    )}
    {pollComposerOpen && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-sm rounded-lg bg-card p-4 space-y-3">
          <h3 className="font-semibold">Create Poll</h3>
          <Input placeholder="Poll question" value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} />
          {pollOptions.map((opt, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input placeholder={`Option ${idx + 1}`} value={opt} onChange={(e) => { const n = [...pollOptions]; n[idx] = e.target.value; setPollOptions(n); }} />
              {pollOptions.length > 2 && (
                <Button type="button" variant="ghost" size="icon" onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== idx))}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPollOptions([...pollOptions, ''])}>
              <Plus className="h-4 w-4 mr-1" /> Add option
            </Button>
          </div>
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={() => setPollComposerOpen(false)}>Cancel</Button>
            <Button type="button" onClick={async () => {
              const q = pollQuestion.trim();
              const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
              if (!q || opts.length < 2) { showError('Enter a question and at least 2 options'); return; }
              if (!activeChat) return;
              const text = `[Poll]: ${q}\n` + opts.map((o, i) => `${i + 1}. ${o}`).join('\n');
              setSending(true);
              try {
                if (isGroupChat && activeGroupId) {
                  await api.groupSend(activeGroupId, { text, type: 'text' });
                  await refreshGroupMsgs(activeGroupId);
                } else {
                  const sent = await sendChatMessage(activeChat.id, text);
                  if (!sent) { showError('Poll could not be sent.'); return; }
                  refreshMsgs(activeChat.id);
                  refreshThreads();
                }
                setPollQuestion('');
                setPollOptions(['', '']);
                setPollComposerOpen(false);
              } catch { showError('Poll could not be sent.'); }
              finally { setSending(false); }
            }}>Send Poll</Button>
          </div>
        </div>
      </div>
    )}
    {attachMenuOpen && createPortal(
      <div
        className="fixed bottom-24 left-4 z-[2147483647] w-44 rounded-lg border bg-popover p-2 shadow-lg space-y-1"
        style={{ pointerEvents: 'auto' }}
      >
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { setPollComposerOpen(true); setAttachMenuOpen(false); }}>
          <BarChart3 className="h-4 w-4" /> Poll
        </button>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { photoInputRef.current?.click(); setAttachMenuOpen(false); }}>
          <ImageIcon className="h-4 w-4" /> Photos
        </button>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { videoInputRef.current?.click(); setAttachMenuOpen(false); }}>
          <Film className="h-4 w-4" /> Videos
        </button>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { fileInput2Ref.current?.click(); setAttachMenuOpen(false); }}>
          <FileIcon className="h-4 w-4" /> Files
        </button>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent" onClick={() => { folderInputRef.current?.click(); setAttachMenuOpen(false); }}>
          <Folder className="h-4 w-4" /> Folders
        </button>
      </div>,
      document.body
    )}
    {createGroupOpen && createPortal(
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70" onClick={() => setCreateGroupOpen(false)}>
        <div className="w-96 max-h-[80vh] overflow-auto rounded-lg bg-card p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-semibold">Create group</h3>
          <Input placeholder="Group name" value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} />
          <div>
            <p className="text-xs text-muted-foreground mb-1">Add members from followers/following</p>
            {followCandidates.length > 0 && (
              <div className="max-h-32 overflow-auto space-y-1 mb-2">
                {followCandidates.map((u: any) => {
                  const id = String(u.id);
                  const selected = newGroupMembers.includes(id);
                  return (
                    <div key={u.id} role="button" tabIndex={0}
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-1 ${selected ? 'bg-purple-500/20' : 'hover:bg-accent'}`}
                      onClick={() => setNewGroupMembers((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])}
                    >
                      <div className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? 'bg-purple-600 border-purple-600 text-white' : 'border-slate-400'}`}>
                        {selected && <Check className="h-3 w-3" />}
                      </div>
                      <span>{u.name || u.username || u.id}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground mb-1">Or search any profile</p>
            <Input placeholder="Search profile name…" value={groupSearch} onChange={async (e) => {
              const q = e.target.value; setGroupSearch(q);
              if (q.trim().length < 2) { setGroupSearchResults([]); return; }
              try {
                const res: any = await api.search(q, 10);
                const users = res?.data?.users || res?.data?.results || [];
                setGroupSearchResults(Array.isArray(users) ? users : []);
              } catch { setGroupSearchResults([]); }
            }} />
            {groupSearchResults.length > 0 && (
              <div className="mt-2 max-h-40 overflow-auto space-y-1">
                {groupSearchResults.map((u: any) => {
                  const id = String(u.id);
                  const selected = newGroupMembers.includes(id);
                  return (
                    <div key={u.id} role="button" tabIndex={0}
                      className={`flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-1 ${selected ? 'bg-purple-500/20' : 'hover:bg-accent'}`}
                      onClick={() => setNewGroupMembers((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])}
                    >
                      <div className={`h-4 w-4 rounded border flex items-center justify-center ${selected ? 'bg-purple-600 border-purple-600 text-white' : 'border-slate-400'}`}>
                        {selected && <Check className="h-3 w-3" />}
                      </div>
                      <span>{u.name || u.username || u.id}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreateGroupOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={async () => {
              if (!newGroupName.trim()) { showError('Group name required'); return; }
              try {
                const res: any = await api.groupCreate({ name: newGroupName.trim(), members: newGroupMembers });
                if (res?.error) { showError(res.error); return; }
                setNewGroupName(''); setNewGroupMembers([]); setGroupSearch(''); setGroupSearchResults([]);
                setCreateGroupOpen(false);
                await refreshGroups();
                showSuccess('Group created');
              } catch { showError('Could not create group'); }
            }}>Create</Button>
          </div>
        </div>
      </div>,
      document.body
    )}
    {groupProfileImageOpen && createPortal(
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90" onClick={() => setGroupProfileImageOpen(false)}>
        <div className="relative max-w-3xl w-full p-4" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="absolute top-2 right-2 text-white" onClick={() => setGroupProfileImageOpen(false)} aria-label="Close">
            <X className="w-5 h-5" />
          </Button>
          {activeGroupObj?.avatar ? (
            <img src={activeGroupObj.avatar} alt="Group profile" className="mx-auto max-h-[80vh] max-w-full rounded-lg object-contain" />
          ) : (
            <div className="mx-auto h-40 w-40 rounded-full bg-muted flex items-center justify-center text-4xl font-bold">
              {(activeGroupObj?.name || 'G').slice(0,2).toUpperCase()}
            </div>
          )}
          \"\"
        </div>
      </div>,
      document.body
    )}
    {groupSettingsOpen && createPortal(
      <div className="fixed inset-0 z-[85] bg-background flex flex-col" onClick={() => setGroupSettingsOpen(false)}>
        <div className="flex items-center gap-3 p-3 border-b shrink-0 pt-8" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setGroupSettingsOpen(false)} aria-label="Close settings">
            <X className="w-4 h-4" />
          </Button>
          <h2 className="font-bold text-lg">Group settings</h2>
          <div className="flex-1" />
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={activeGroupObj?.avatar || ''} />
              <AvatarFallback>{(activeGroupObj?.name || 'G').slice(0,2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="font-semibold truncate">{activeGroupObj?.name}</p>
              <p className="text-xs text-muted-foreground">{(activeGroupObj?.members || []).length} members</p>
            </div>
            {(isGroupLeader || isGroupCoLeader) && (
              <Button size="sm" variant="outline" onClick={() => setGroupEditOpen(true)}>Edit</Button>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Members</p>
            <div className="space-y-1">
              {(activeGroupObj?.members || []).map((m: string) => (
                <div key={m} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                  <span className="truncate">{memberNames[m] || m}</span>
                  <div className="flex items-center gap-1">
                    {m === activeGroupObj?.leaderId && <span className="text-xs text-muted-foreground">Leader</span>}
                    {Array.isArray(activeGroupObj?.coLeaders) && activeGroupObj.coLeaders.includes(m) && m !== activeGroupObj?.leaderId && <span className="text-xs text-muted-foreground">Co-leader</span>}
                    {isGroupLeader && m !== meId && (
                      <>
                        <Button size="sm" variant="ghost" disabled={Array.isArray(activeGroupObj?.coLeaders) && activeGroupObj.coLeaders.includes(m)} onClick={async () => {
                          const ok = window.confirm(`Promote ${memberNames[m] || m} to co-leader?`);
                          if (!ok) return;
                          try { const r: any = await api.groupSetRole(activeGroupId!, m, 'coleader'); if (r?.error) { showError(r.error); return; } await refreshGroups(); showSuccess('Promoted to co-leader'); } catch { showError('Could not update role'); }
                        }}>Promote</Button>
                        <Button size="sm" variant="ghost" disabled={!(Array.isArray(activeGroupObj?.coLeaders) && activeGroupObj.coLeaders.includes(m))} onClick={async () => {
                          const ok = window.confirm(`Demote ${memberNames[m] || m} from co-leader to member?`);
                          if (!ok) return;
                          try { const r: any = await api.groupSetRole(activeGroupId!, m, 'member'); if (r?.error) { showError(r.error); return; } await refreshGroups(); showSuccess('Demoted to member'); } catch { showError('Could not update role'); }
                        }}>Demote</Button>
                        <Button size="sm" variant="ghost" onClick={async () => {
                          const ok = window.confirm(`Remove ${memberNames[m] || m} from the group?`);
                          if (!ok) return;
                          try { const r: any = await api.groupRemoveMember(activeGroupId!, m); if (r?.error) { showError(r.error); return; } await refreshGroups(); showSuccess('Removed'); } catch { showError('Could not remove'); }
                        }}><Trash2 className="w-4 h-4" /></Button>
                      </>
                    )}
                    {!isGroupLeader && m === meId && (
                      <Button size="sm" variant="ghost" onClick={async () => {
                        try { const r: any = await api.groupRemoveMember(activeGroupId!, meId); if (r?.error) { showError(r.error); return; } await refreshGroups(); showSuccess('Left group'); setActiveGroupId(null); setIsGroupChat(false); setMsgs([]); setGroupSettingsOpen(false); } catch { showError('Could not leave'); }
                      }}>Leave</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {(isGroupLeader || isGroupCoLeader) && (
              <Button size="sm" variant="outline" onClick={async () => {
                const q = window.prompt('Search profile name to add');
                if (!q) return;
                try {
                  const res: any = await api.search(q, 5);
                  const users = res?.data?.users || res?.data?.results || [];
                  if (!Array.isArray(users) || users.length === 0) { showError('No profile found'); return; }
                  const u = users[0];
                  const r: any = await api.groupAddMember(activeGroupId!, String(u.id));
                  if (r?.error) { showError(r.error); return; }
                  await refreshGroups();
                  showSuccess('Member added');
                } catch { showError('Could not add member'); }
              }}><Plus className="w-4 h-4 mr-1" /> Add member</Button>
            )}
          </div>

          {isGroupLeader && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Reply permission</p>
              <select className="h-8 rounded-md border bg-background px-2 text-xs" value={groupReplyPerm} onChange={async (e) => {
                try { const r: any = await api.groupSettings(activeGroupId!, e.target.value); if (r?.error) { showError(r.error); return; } await refreshGroups(); } catch { showError('Could not update settings'); }
              }}>
                <option value="all">All can reply</option>
                <option value="leaders">Leaders can reply</option>
                <option value="leader">Only leader</option>
              </select>
            </div>
          )}

          <div className="space-y-2">
            <p className="text-sm font-medium">Chat features</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setCameraOpen(true)}><Camera className="w-4 h-4 mr-1" /> Camera</Button>
              <ChatThemeSelector>
                <Button size="sm" variant="outline"><Palette className="w-4 h-4 mr-1" /> Theme</Button>
              </ChatThemeSelector>
              <Button size="sm" variant="outline" onClick={() => {
                const next = !groupMuted;
                setGroupMuted(next);
                try { if (next) localStorage.setItem('equyvo_mute_group_' + activeGroupId, '1'); else localStorage.removeItem('equyvo_mute_group_' + activeGroupId); } catch {}
              }}><Volume2 className="w-4 h-4 mr-1" /> {groupMuted ? 'Unmute' : 'Mute'}</Button>
            </div>
          </div>

          {isGroupLeader && (
            <div className="space-y-2">
              <Button size="sm" variant="destructive" onClick={async () => {
                if (!activeGroupId) return;
                const ok = window.confirm('Delete this group permanently?');
                if (!ok) return;
                try { const r: any = await api.groupDeleteGroup(activeGroupId); if (r?.error) { showError(r.error); return; } setGroups((prev: any[]) => prev.filter((g: any) => g.id !== activeGroupId)); await refreshGroups(); showSuccess('Group deleted'); setActiveGroupId(null); setIsGroupChat(false); setMsgs([]); setGroupSettingsOpen(false); } catch { showError('Could not delete group'); }
              }}>Delete group</Button>
              <Button size="sm" variant="outline" onClick={async () => {
                if (!activeGroupId) return;
                try { const r: any = await api.groupArchive(activeGroupId, true); if (r?.error) { showError(r.error); return; } setGroups((prev: any[]) => prev.map((g: any) => g.id === activeGroupId ? { ...g, archived: true } : g)); await refreshGroups(); showSuccess('Archived'); setActiveGroupId(null); setIsGroupChat(false); setMsgs([]); setGroupSettingsOpen(false); } catch { showError('Could not archive'); }
              }}>Archive group</Button>
            </div>
          )}
        </div>
      </div>,
      document.body
    )}
    {groupEditOpen && createPortal(
      <div className="fixed inset-0 z-[90] bg-background flex flex-col" onClick={() => setGroupEditOpen(false)}>
        <div className="flex items-center gap-3 p-3 border-b shrink-0 pt-8" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setGroupEditOpen(false)} aria-label="Close">
            <X className="w-4 h-4" />
          </Button>
          <h2 className="font-bold text-lg">Edit group</h2>
          <div className="flex-1" />
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
          <div className="flex flex-col items-center gap-2">
            {groupEditImage ? (
              <img src={groupEditImage} alt="Group" className="h-24 w-24 rounded-full object-cover" />
            ) : (
              <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center text-2xl font-bold">
                {(groupEditName || 'G').slice(0,2).toUpperCase()}
              </div>
            )}
            {(isGroupLeader || isGroupCoLeader) && (
              <label className="cursor-pointer rounded-md bg-primary/10 px-3 py-1.5 text-sm text-primary hover:bg-primary/20">
                Change photo
                <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f || !activeGroupId) return;
                  try {
                    const up = await api.uploadFile(f, 'equyvo/group/avatars');
                    const url = up?.data?.secureUrl;
                    if (!url) { showError('Upload failed'); return; }
                    setGroupEditImage(url);
                  } catch { showError('Upload failed'); }
                }} />
              </label>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Group name</label>
            <Input value={groupEditName} onChange={(e) => setGroupEditName(e.target.value)} disabled={!(isGroupLeader || isGroupCoLeader)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Description</label>
            <Input value={groupEditDesc} onChange={(e) => setGroupEditDesc(e.target.value)} disabled={!(isGroupLeader || isGroupCoLeader)} />
          </div>
          {(isGroupLeader || isGroupCoLeader) && (
            <Button size="sm" onClick={async () => {
              if (!activeGroupId) return;
              try {
                const r: any = await api.groupProfile(activeGroupId, { name: groupEditName.trim() || undefined, description: groupEditDesc.trim(), image: groupEditImage || undefined });
                if (r?.error) { showError(r.error); return; }
                await refreshGroups();
                showSuccess('Group updated');
                setGroupEditOpen(false);
              } catch { showError('Could not update group'); }
            }}>Save</Button>
          )}
        </div>
      </div>,
      document.body
    )}
    {showArchived && createPortal(
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70" onClick={() => setShowArchived(false)}>
        <div className="w-96 max-h-[80vh] overflow-auto rounded-lg bg-card p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-semibold">Archived</h3>
          <div className="space-y-1">
            {threads.filter((t) => archivedThreadIds.has(t.id)).map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                <span className="truncate">{t.peerName}</span>
                <Button size="sm" variant="ghost" onClick={() => unarchiveThread(t.id)}>Unarchive</Button>
              </div>
            ))}
            {groups.filter((g: any) => g.archived).map((g: any) => (
              <div key={g.id} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent">
                <span className="truncate">{g.name}</span>
                <Button size="sm" variant="ghost" onClick={async () => {
                  try { const r: any = await api.groupArchive(g.id, false); if (r?.error) { showError(r.error); return; } await refreshGroups(); showSuccess('Unarchived'); } catch { showError('Could not unarchive'); }
                }}>Unarchive</Button>
              </div>
            ))}
            {threads.filter((t) => archivedThreadIds.has(t.id)).length === 0 && groups.filter((g: any) => g.archived).length === 0 && (
              <p className="text-sm text-muted-foreground">No archived chats.</p>
            )}
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setShowArchived(false)}>Close</Button>
          </div>
        </div>
      </div>,
      document.body
    )}
    {forwardOpen && createPortal(
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70" onClick={() => setForwardOpen(false)}>
        <div className="w-96 max-h-[80vh] overflow-auto rounded-lg bg-card p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-semibold">Forward to</h3>
          <div className="space-y-1 max-h-60 overflow-auto">
            {threads.map((t: any) => (
              <button key={t.id} className={`w-full text-left rounded px-2 py-1.5 text-sm hover:bg-accent ${forwardTarget === t.id ? 'bg-accent' : ''}`} onClick={() => setForwardTarget(t.id)}>
                {t.peerName} <span className="text-xs text-muted-foreground">(chat)</span>
              </button>
            ))}
            {groups.map((g: any) => (
              <button key={g.id} className={`w-full text-left rounded px-2 py-1.5 text-sm hover:bg-accent ${forwardTarget === g.id ? 'bg-accent' : ''}`} onClick={() => setForwardTarget(g.id)}>
                {g.name} <span className="text-xs text-muted-foreground">(group)</span>
              </button>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setForwardOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => void doForward()} disabled={!forwardTarget}>Forward</Button>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
};

export default ChatSidebar;
