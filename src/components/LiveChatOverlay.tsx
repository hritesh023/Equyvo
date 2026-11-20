import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '@/lib/api';

interface LiveChatOverlayProps {
  contentId: string;
  enabled?: boolean;
  /** Tapping a popping comment opens the full comments interface. */
  onCommentClick?: () => void;
}

interface ChatItem {
  id: string;
  authorName?: string;
  authorAvatar?: string;
  text?: string;
  createdAt?: string;
}

interface FloatingComment {
  key: string;
  name: string;
  text: string;
  top: number;
  accent: 'red' | 'blue' | 'emerald' | 'amber' | 'violet';
}

const ACCENTS: FloatingComment['accent'][] = ['red', 'blue', 'emerald', 'amber', 'violet'];

const ACCENT_CLASS: Record<FloatingComment['accent'], string> = {
  red: 'border-red-400/50 bg-red-500/20',
  blue: 'border-blue-400/50 bg-blue-500/20',
  emerald: 'border-emerald-400/50 bg-emerald-500/20',
  amber: 'border-amber-400/50 bg-amber-500/20',
  violet: 'border-violet-400/50 bg-violet-500/20',
};

const NAME_CLASS: Record<FloatingComment['accent'], string> = {
  red: 'text-red-200',
  blue: 'text-blue-200',
  emerald: 'text-emerald-200',
  amber: 'text-amber-200',
  violet: 'text-violet-200',
};

/**
 * "Overflowing" live chat: viewer comments pop up and drift across the live
 * video as they arrive (Twitch/Kick/YouTube style). Only NEW comments animate —
 * the backlog is marked as seen on first load so a long stream never bursts a
 * wall of old messages at the broadcaster.
 */
const LiveChatOverlay: React.FC<LiveChatOverlayProps> = ({ contentId, enabled = true, onCommentClick }) => {
  const [comments, setComments] = useState<FloatingComment[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const seqRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const reset = useCallback(() => {
    seenRef.current = null;
    setComments([]);
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => {
    reset();
  }, [contentId, reset]);

  const load = useCallback(async () => {
    try {
      const res = await api.getComments(contentId);
      const list = Array.isArray(res.data?.comments) ? (res.data.comments as ChatItem[]) : [];
      if (!seenRef.current) {
        seenRef.current = new Set(list.map((m) => String(m.id)));
        return;
      }
      const fresh = list.filter((m) => !seenRef.current!.has(String(m.id)));
      if (!fresh.length) return;
      fresh.forEach((m) => seenRef.current!.add(String(m.id)));

      const additions: FloatingComment[] = fresh.slice(-5).map((m, i) => {
        seqRef.current += 1;
        return {
          key: `${m.id}-${seqRef.current}`,
          name: (m.authorName || 'Viewer').slice(0, 24),
          text: (m.text || '').slice(0, 120),
          // Stagger the vertical lanes so simultaneous comments don't stack.
          top: 18 + ((seqRef.current * 17 + i * 9) % 56),
          accent: ACCENTS[seqRef.current % ACCENTS.length],
        };
      });

      setComments((prev) => [...prev, ...additions].slice(-12));
      additions.forEach((item) => {
        const timer = setTimeout(() => {
          setComments((prev) => prev.filter((c) => c.key !== item.key));
        }, 7200);
        timersRef.current.push(timer);
      });
    } catch {
      // Best-effort polling: a failed fetch simply waits for the next tick.
    }
  }, [contentId]);

  useEffect(() => {
    if (!enabled || !contentId) return;
    void load();
    const id = setInterval(() => { void load(); }, 2500);
    return () => clearInterval(id);
  }, [contentId, enabled, load]);

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  if (!enabled || !contentId) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-[25] overflow-hidden" aria-live="polite" aria-label="Live comments">
      {comments.map((c) => (
        <div
          key={c.key}
          role="button"
          tabIndex={0}
          onClick={onCommentClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onCommentClick?.(); }}
          className="equyvo-live-comment pointer-events-auto absolute left-3 max-w-[82vw] cursor-pointer rounded-2xl border px-3 py-2 shadow-lg backdrop-blur-md sm:left-6 sm:max-w-[60vw]"
          style={{ top: `${c.top}%` }}
          title="Open full comments"
        >
          <span className={`block text-[11px] font-bold ${NAME_CLASS[c.accent]}`}>
            {c.name}
          </span>
          <span className="block break-words text-sm font-medium text-white drop-shadow">{c.text}</span>
        </div>
      ))}
    </div>
  );
};

export default LiveChatOverlay;
