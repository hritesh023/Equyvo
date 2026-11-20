import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, Send, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';

interface LiveChatPanelProps {
  contentId: string;
  onClose: () => void;
  /** Host-only: keeps End Live reachable while the panel covers the screen. */
  onEndLive?: () => void;
}

interface ChatItem {
  id: string;
  authorName?: string;
  authorAvatar?: string;
  text?: string;
  createdAt?: string;
}

/** Live chat side panel for a broadcast. Reuses the persistent per-content
 *  comment ledger so messages survive reloads and are visible to every viewer. */
const LiveChatPanel: React.FC<LiveChatPanelProps> = ({ contentId, onClose, onEndLive }) => {
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getComments(contentId);
      if (!res.error && Array.isArray(res.data?.comments)) {
        setMessages(res.data.comments as ChatItem[]);
      }
    } catch { /* best-effort polling */ }
  }, [contentId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      const res = await api.postComment({ contentId, text: value.slice(0, 300) });
      if (!res.error) {
        setText('');
        await load();
      }
    } catch { /* keep the text so the user can retry */ }
    finally { setSending(false); }
  };

  return (
    <div
      className="absolute right-0 top-0 z-40 flex h-full w-[min(92vw,340px)] flex-col border-l border-white/10 bg-black/85 backdrop-blur-md"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header is pushed BELOW the device status/notification bar. Previously
          the close control sat at the very top where every mobile/tablet status
          bar swallows taps, trapping people inside the panel while live. */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 pb-2.5 pt-[calc(env(safe-area-inset-top,0px)+0.875rem)]">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <MessageCircle className="h-4 w-4 text-red-400" /> Live chat
        </div>
        <div className="flex items-center gap-1.5">
          {onEndLive && (
            <button
              type="button"
              onClick={onEndLive}
              className="rounded-full bg-red-600 px-3 py-1.5 text-[11px] font-bold text-white shadow-lg hover:bg-red-700"
              aria-label="End live"
            >
              End Live
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-white/80 hover:bg-white/10 hover:text-white"
            aria-label="Close chat"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-xs text-white/50">No messages yet — say hello!</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex items-start gap-2">
            <Avatar className="h-7 w-7 shrink-0">
              {m.authorAvatar ? <AvatarImage src={m.authorAvatar} alt="" /> : null}
              <AvatarFallback className="text-[10px]">{(m.authorName || 'U').slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium text-red-300">{m.authorName || 'Viewer'}</p>
              <p className="break-words text-xs leading-relaxed text-white/90">{m.text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-white/10 p-2.5">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }}
          placeholder="Send a message…"
          maxLength={300}
          className="h-9 border-white/20 bg-white/10 text-xs text-white placeholder:text-white/40"
        />
        <Button size="icon" onClick={() => void send()} disabled={sending || !text.trim()} className="h-9 w-9 shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};

export default LiveChatPanel;
