import React, { useState, useEffect, useRef } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageCircle, Send, Paperclip, X, Palette, Search, Check, CheckCheck, Clock, ArrowLeft } from 'lucide-react';
import { showError } from '@/utils/toast';
import { useNavigate } from 'react-router-dom';
import { ChatThemeSelector } from './ChatThemeSelector';
import { useChatTheme } from '@/contexts/ChatThemeContext';
import { navigateToProfile } from '@/utils/profile-navigation';
import { getStoredUser } from '@/lib/auth';
import { getFollowers, getFollowing, type SocialProfile } from '@/lib/social';
import {
  listThreads, listMessages, ensureThread, syncThreadsFromSocial,
  sendChatMessage, markThreadSeen, pullThreadMessages,
  type ChatThread, type ChatMessage,
} from '@/lib/chat';

/** Single tick (server) / double tick (delivered) / blue double + Seen (read). */
function Ticks({ status }: { status: ChatMessage['status'] }) {
  if (status === 'sending') return <Clock className="h-3.5 w-3.5 opacity-70" aria-label="Sending" />;
  if (status === 'sent') return <Check className="h-4 w-4 opacity-80" aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck className="h-4 w-4 opacity-80" aria-label="Delivered" />;
  if (status === 'seen') return <CheckCheck className="h-4 w-4 text-sky-400" aria-label="Seen" />;
  return null;
}

const ChatSidebar = ({ isMobile = false }: { isMobile?: boolean }) => {
  const [tab, setTab] = useState<'followers' | 'following'>('followers');
  const [threads, setThreads] = useState<ChatThread[]>(() => listThreads());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

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
    const t = window.setInterval(() => {
      pullThreadMessages(activeId)
        .then(() => {
          refreshMsgs(activeId);
          markThreadSeen(activeId);
          refreshThreads();
        })
        .catch(() => {});
    }, 8000);
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
      return { backgroundImage: `url("${safeUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center', opacity };
    }
    return {};
  };

  const handleSendMessage = async () => {
    if ((!message.trim() && !attachedFile) || !activeChat || sending) return;
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
        setAttachedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
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

  const handleFileAttach = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showError('Attachment must be smaller than 10MB.');
      e.target.value = '';
      return;
    }
    setAttachedFile(file);
  };

  const shell = isMobile
    ? 'h-full w-full flex flex-col bg-background'
    : 'h-[calc(100vh-80px)] w-80 fixed right-4 top-24 bg-card/95 backdrop-blur-xl border border-border/50 rounded-2xl shadow-2xl overflow-hidden hidden lg:flex flex-col z-40';

  return (
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
        <div className={isMobile ? 'flex flex-1 flex-col min-h-0' : 'absolute inset-0 bg-background z-10 flex flex-col'}>
          <div className="p-3 border-b flex items-center gap-3 bg-secondary/30 backdrop-blur-md sticky top-0 z-10">
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
          </div>

          {/* WhatsApp-style message area */}
          <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 p-4 space-y-1.5 overflow-y-auto relative bg-[#0b141a] dark:bg-[#0b141a]">
            {chatTheme.type !== 'default' && (
              <div className="absolute inset-0 pointer-events-none" style={getChatBackgroundStyle()} />
            )}
            <div className="relative z-10 flex flex-col gap-1.5">
              {msgs.length === 0 && (
                <div className="text-center text-muted-foreground py-8">
                  <p className="mx-auto max-w-[260px] rounded-lg bg-black/40 px-3 py-1.5 text-xs text-amber-100/90">
                    Messages are gated by follow — {activeChat.relation === 'follower' ? `${activeChat.peerName} follows you, so they can write here.` : activeChat.relation === 'following' ? `You follow ${activeChat.peerName}, so you can write here.` : 'you follow each other.'}
                  </p>
                </div>
              )}
              {msgs.map((msg) => (
                <div key={msg.id} className={`flex ${msg.fromMe ? 'justify-end' : 'justify-start'}`}>
                  <div className="max-w-[80%]">
                    <div
                      className={`px-3 py-1.5 rounded-xl text-sm shadow-sm ${
                        msg.fromMe
                          ? 'bg-[#005c4b] text-white rounded-tr-none'
                          : 'bg-[#202c33] text-slate-100 rounded-tl-none dark:bg-[#202c33]'
                      }`}
                    >
                      {msg.type === 'image' && msg.fileUrl ? (
                        <div className="space-y-1.5">
                          <img src={msg.fileUrl} alt="Shared image" loading="lazy" className="max-w-full rounded-lg" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
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
                        {msg.fromMe && <Ticks status={msg.status} />}
                      </div>
                    </div>
                    {/* Read receipt label: only under MY messages, only when seen.
                        Incoming bubbles intentionally show nothing underneath. */}
                    {msg.fromMe && msg.status === 'seen' && (
                      <p className="mt-0.5 text-right text-[11px] italic text-sky-300/90">Seen</p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="p-3 border-t bg-background/50 backdrop-blur-md">
            {attachedFile && (
              <div className="mb-3 p-3 bg-secondary/50 rounded-lg border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Paperclip className="w-4 h-4" />
                  <span className="text-sm truncate max-w-[200px]">{attachedFile.name}</span>
                </div>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { setAttachedFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} aria-label="Remove attachment">
                  <X className="w-3 h-3" />
                </Button>
              </div>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSendMessage();
              }}
            >
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
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={`Message ${activeChat.peerName}…`}
                aria-label={`Message ${activeChat.peerName}`}
                className="bg-secondary/50"
                maxLength={2000}
                disabled={sending}
              />
              <Button
                type="submit"
                size="icon"
                className="h-10 w-10 rounded-full bg-emerald-600 hover:bg-emerald-500"
                disabled={(!message.trim() && !attachedFile) || sending}
                aria-label={sending ? 'Sending…' : 'Send message'}
                title={sending ? 'Sending…' : 'Send message (Enter)'}
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatSidebar;
