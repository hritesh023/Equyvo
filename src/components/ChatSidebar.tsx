import React, { useState, useEffect, useRef } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageCircle, Send, Paperclip, X, Palette, Search, Check, CheckCheck, Clock, ArrowLeft, Crop, Trash2, MoreVertical, Mic, Volume2 } from 'lucide-react';
import { showError } from '@/utils/toast';
import { useI18n } from '@/lib/i18n';
import api from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { ChatThemeSelector } from './ChatThemeSelector';
import MediaCropper from './MediaCropper';
import { useChatTheme } from '@/contexts/ChatThemeContext';
import { navigateToProfile } from '@/utils/profile-navigation';
import { getStoredUser } from '@/lib/auth';
import { getFollowers, getFollowing, type SocialProfile } from '@/lib/social';
import {
  listThreads, listMessages, ensureThread, syncThreadsFromSocial,
  sendChatMessage, markThreadSeen, pullThreadMessages, deleteChatMessage,
  retryChatMessage,
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

const ChatSidebar = ({ isMobile = false }: { isMobile?: boolean }) => {
  const { t } = useI18n();
  const [tab, setTab] = useState<'followers' | 'following'>('followers');
  const [threads, setThreads] = useState<ChatThread[]>(() => listThreads());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  // Image-attachment preview + crop/adjust step (same editor as thumbnails).
  const [attachPreview, setAttachPreview] = useState<string | null>(null);
  const [attachCropSrc, setAttachCropSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [menuMsgId, setMenuMsgId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
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

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  const { chatTheme } = useChatTheme();
  const navigate = useNavigate();

  const activeChat = threads.find((t) => t.id === activeId) || null;
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);

  const refreshThreads = () => setThreads(listThreads());
  const refreshMsgs = (id: string | null) => setMsgs(id ? listMessages(id) : []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [f, g] = await Promise.all([getFollowers(), getFollowing()]);
        if (cancelled) return;
        const toPeer = (p: SocialProfile) => ({
          id: p.id,
          name: p.name || p.username || p.id,
          avatar: p.avatar,
        });
        syncThreadsFromSocial(f.list.map(toPeer), g.list.map(toPeer));
        refreshThreads();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const onUpdate = () => {
      refreshThreads();
      if (activeId) refreshMsgs(activeId);
    };
    window.addEventListener('chatUpdated', onUpdate);
    window.addEventListener('followChanged', onUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('chatUpdated', onUpdate);
      window.removeEventListener('followChanged', onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    }, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    markThreadSeen(activeId ?? '');
    if (activeId) refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);

  useEffect(() => {
    if (stickToBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [msgs.length, activeId]);

  const visibleThreads = threads
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
    const threadId = activeChat.id;
    const textToSend = message.trim();
    const fileToSend = attachedFile;
    const attach = fileToSend
      ? {
          fileUrl: URL.createObjectURL(fileToSend),
          fileName: fileToSend.name,
          type: (fileToSend.type.startsWith('image/') ? 'image' : 'file') as 'image' | 'file',
        }
      : undefined;
    setSending(true);
    try {
      const sent = await sendChatMessage(threadId, textToSend, attach);
      if (!sent) {
        showError('Message could not be sent. Try again.');
        if (attach?.fileUrl) URL.revokeObjectURL(attach.fileUrl);
        return;
      }
      // Only clear the composer after the message is safely stored.
      if (threadId === activeChat?.id) {
        setMessage('');
        clearAttachment();
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
          const sent = await sendChatMessage(threadId, '', {
            fileUrl: data.secureUrl,
            fileName: 'Voice message',
            type: 'audio',
            durationSec: Math.max(1, secs || 0),
          });
          if (!sent) throw new Error('voice-send-failed');
          refreshMsgs(threadId);
          refreshThreads();
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

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showError('Attachment must be smaller than 10MB.');
      e.target.value = '';
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
        // Every image opens the crop/adjust editor (same as thumbnails).
        // GIFs keep their animation when confirmed untouched; adjusting
        // one exports a still frame instead (editor explains this inline).
        setAttachCropSrc(url);
      } catch { /* preview is best-effort */ }
    }
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
      await deleteChatMessage(activeChat.id, msg.id, forEveryone);
      refreshMsgs(activeChat.id);
      refreshThreads();
    } catch {
      showError('Could not delete message.');
    }
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
          <ChatThemeSelector>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Customize chat background" title="Customize chat background">
              <Palette className="w-4 h-4" />
            </Button>
          </ChatThemeSelector>
        </div>
        <Tabs value={tab} onValueChange={(v) => { setTab(v as 'followers' | 'following'); setSearchQuery(''); }} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="followers">Followers</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {tab === 'followers'
            ? 'Followers — accounts that follow you can message you here.'
            : 'Following — accounts you follow; you can message them here.'}
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

      {!activeChat && (
        <ScrollArea className="flex-1">
          <div className="divide-y divide-border/20">
            {loading && threads.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading your people…</div>
            ) : visibleThreads.length > 0 ? (
              visibleThreads.map((contact) => (
                <div
                  key={contact.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open chat with ${contact.peerName}${contact.unread > 0 ? `, ${contact.unread} unread` : ''}`}
                  className="flex items-center gap-3 p-3 hover:bg-secondary/20 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setActiveId(contact.id)}
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
          <div className="p-3 border-b flex items-center gap-3 bg-secondary/30 backdrop-blur-md shrink-0">
            <Button variant="ghost" size="icon" className="h-8 w-8 -ml-1 mr-1" onClick={() => { setActiveId(null); refreshThreads(); }} aria-label="Back to chat list" title="Back to chat list">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <Avatar className="h-8 w-8">
              <AvatarImage src={activeChat.peerAvatar} alt={`${activeChat.peerName} avatar`} />
              <AvatarFallback>{(activeChat.peerName || '?')[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{activeChat.peerName}</p>
              <p className="text-xs text-muted-foreground">
                {activeChat.relation === 'mutual' ? 'You follow each other' : activeChat.relation === 'follower' ? 'Follows you' : 'You follow them'}
                {activeChat.online ? ' · Online' : ''}
              </p>
            </div>
            {/* Background selector reachable even while the chat is open
                (the desktop sidebar header sits under the chat panel overlay). */}
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
                    Messages are gated by follow — {activeChat.relation === 'follower' ? `${activeChat.peerName} follows you, so they can write here.` : activeChat.relation === 'following' ? `You follow ${activeChat.peerName}, so you can write here.` : 'you follow each other.'}
                  </p>
                </div>
              )}
              {msgs.map((msg) => {
                if (msg.deletedForEveryone) {
                  return (
                    <div key={msg.id} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                      <div className="max-w-[80%]">
                        <div className="px-3 py-1.5 rounded-xl text-sm shadow-sm italic opacity-70 bg-slate-800/60 text-slate-300 rounded-tl-none">
                          This message was deleted
                          <div className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-400`}>
                            <span>{msg.timestamp}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                return (
                <div key={msg.id} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[80%] relative group">
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
                      }`}
                      onContextMenu={(e) => { e.preventDefault(); setMenuMsgId(msg.id); }}
                      onTouchStart={() => { const t = window.setTimeout(() => setMenuMsgId(msg.id), 500); (msg as any)._t = t; }}
                      onTouchEnd={() => { const t = (msg as any)._t; if (t) window.clearTimeout(t); }}
                      onTouchMove={() => { const t = (msg as any)._t; if (t) window.clearTimeout(t); }}
                    >
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
                      ) : (
                        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                      )}
                      <div className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] ${msg.fromMe ? 'text-white/70' : 'text-slate-400'}`}>
                        <span>{msg.timestamp}</span>
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

          <div className="p-3 border-t bg-background/50 backdrop-blur-md flex-none chat-overlay-composer">
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 text-muted-foreground"
                  aria-label="Attach file"
                  title="Attach file (images, PDF, DOC, TXT up to 10MB)"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="w-5 h-5" />
                </Button>
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
                disabled={sending}
              />
              <Button
                type="submit"
                size="icon"
                className="h-10 w-10 rounded-full bg-purple-600 hover:bg-purple-500"
                disabled={(!message.trim() && !attachedFile) || sending}
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
    </>
  );
};

export default ChatSidebar;
