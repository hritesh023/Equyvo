import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  MessageCircle, Send, X, Heart, Pin, PinOff, Edit2, Trash2, Share2,
  Reply, MoreHorizontal, MessageSquareOff, MessageSquare, Loader2, Check, User as UserIcon,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { showSuccess, showError } from '@/utils/toast';
import api from '@/lib/api';
import { myCommentIdentity, refreshMyCommentIdentity, type CommentIdentity } from '@/lib/comment-identity';
import { resolveAvatar, avatarInitials } from '@/utils/avatar';

interface CommentReply {
  id: string;
  authorId: string;
  authorName: string;
  authorUsername: string;
  authorAvatar: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  likes: number;
  hasLiked?: boolean;
  shares?: number;
  isEdited?: boolean;
}

interface CommentItem extends CommentReply {
  parentId?: string | null;
  isPinned?: boolean;
  repliesCount?: number;
  replies?: CommentReply[];
}

interface CommentSectionProps {
  isOpen: boolean;
  onClose: () => void;
  postId: string;
  postUser: string;
  onCommentCountChange?: (postId: string, count: number) => void;
  showPinOptions?: boolean;
}

function timeAgo(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 10) return 'Just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d}d ago`;
    const w = Math.floor(d / 7);
    if (w < 5) return `${w}w ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;
    return `${Math.floor(d / 365)}y ago`;
  } catch {
    return '';
  }
}

function initialsOf(name: string): string {
  return avatarInitials(name) || 'U';
}

const CommentSection: React.FC<CommentSectionProps> = ({
  isOpen, onClose, postId, postUser, onCommentCountChange,
}) => {
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [commentsEnabled, setCommentsEnabled] = useState(true);
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [replyTo, setReplyTo] = useState<CommentItem | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [togglingSettings, setTogglingSettings] = useState(false);
  const [me, setMe] = useState<CommentIdentity>(() => myCommentIdentity());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!postId) return;
    setLoading(true);
    setLoadError('');
    try {
      const res = await api.getComments(postId);
      if (res.error) {
        setLoadError(res.error);
        return;
      }
      const d = (res as { data?: { comments?: CommentItem[]; totalCount?: number; commentsEnabled?: boolean; isOwner?: boolean } }).data;
      setComments(Array.isArray(d?.comments) ? d.comments : []);
      setTotalCount(Number(d?.totalCount ?? d?.comments?.length ?? 0));
      setCommentsEnabled(d?.commentsEnabled !== false);
      setIsOwner(d?.isOwner === true);
    } catch {
      setLoadError('Could not load comments. Check your connection and retry.');
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    if (!isOpen) return;
    setMe(myCommentIdentity());
    void refreshMyCommentIdentity().then(setMe).catch(() => {});
    void load();
  }, [isOpen, load]);

  useEffect(() => {
    if (isOpen && inputRef.current && !loading) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 150);
      return () => window.clearTimeout(t);
    }
  }, [isOpen, loading, replyTo]);

  useEffect(() => {
    if (onCommentCountChange && postId) onCommentCountChange(postId, totalCount);
  }, [totalCount, postId, onCommentCountChange]);

  // Escape closes; lock body scroll while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !editingId) onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, editingId, onClose]);

  const patchComment = (id: string, patch: Partial<CommentItem>) => {
    setComments((prev) => prev.map((c) => {
      if (c.id === id) return { ...c, ...patch };
      if (c.replies?.some((r) => r.id === id)) {
        return { ...c, replies: c.replies.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
      }
      return c;
    }));
  };

  const removeCommentLocal = (id: string) => {
    setComments((prev) => {
      const next: CommentItem[] = [];
      for (const c of prev) {
        if (c.id === id) continue;
        if (c.replies?.some((r) => r.id === id)) {
          next.push({ ...c, replies: c.replies.filter((r) => r.id !== id), repliesCount: Math.max(0, (c.repliesCount ?? c.replies.length) - 1) });
        } else next.push(c);
      }
      return next;
    });
  };

  const handleSend = async () => {
    const text = newComment.trim();
    if (!text || posting || !postId) return;
    if (!commentsEnabled && !isOwner) {
      showError('Comments are turned off for this post.');
      return;
    }
    if (!me.id) {
      showError('Please sign in to comment.');
      return;
    }
    setPosting(true);
    try {
      const res = await api.postComment({ contentId: postId, text: text.slice(0, 1000), parentId: replyTo?.id ?? null });
      if (res.error) {
        showError(res.error);
        return;
      }
      const saved = (res as { data?: { comment?: CommentItem } }).data?.comment;
      // Keep the new row visually consistent with the composer: the server
      // resolves identity from the stored profile, which can lag a just-
      // uploaded avatar. Prefer the fresh local identity when the server
      // has nothing newer (both are the same real account — never a stand-in).
      const mine: CommentItem | undefined = saved
        ? {
            ...saved,
            authorAvatar: saved.authorAvatar || me.avatar || '',
            authorName: saved.authorName || me.name || '',
            authorUsername: saved.authorUsername || me.name || '',
          }
        : undefined;
      if (replyTo && mine) {
        setComments((prev) => prev.map((c) => {
          const rootId = replyTo.parentId ? String(replyTo.parentId) : replyTo.id;
          if (c.id === rootId || c.id === replyTo.id) {
            const replies = [...(c.replies || []), { ...mine, parentId: c.id }];
            return { ...c, replies, repliesCount: replies.length };
          }
          return c;
        }));
      } else if (mine) {
        setComments((prev) => [{ ...mine, replies: [] }, ...prev]);
      } else {
        void load();
      }
      setTotalCount((n) => n + 1);
      setNewComment('');
      setReplyTo(null);
      showSuccess('Comment posted.');
      requestAnimationFrame(() => listRef.current?.scrollTo({ top: 0, behavior: 'smooth' }));
    } catch {
      showError('Could not post your comment. Try again.');
    } finally {
      setPosting(false);
    }
  };

  const handleLike = async (c: CommentItem | CommentReply) => {
    if (busyId) return;
    const was = !!c.hasLiked;
    patchComment(c.id, { hasLiked: !was, likes: Math.max(0, (c.likes || 0) + (was ? -1 : 1)) });
    setBusyId(c.id);
    try {
      const res = await api.likeComment(c.id);
      if (res.error) {
        patchComment(c.id, { hasLiked: was, likes: c.likes });
        showError(res.error);
        return;
      }
      const saved = (res as { data?: { comment?: CommentItem } }).data?.comment;
      if (saved) patchComment(c.id, { hasLiked: saved.hasLiked, likes: saved.likes });
    } catch {
      patchComment(c.id, { hasLiked: was, likes: c.likes });
      showError('Could not like this comment.');
    } finally {
      setBusyId(null);
    }
  };

  const handleShare = async (c: CommentItem | CommentReply) => {
    const text = String(c.text || '').slice(0, 200);
    try {
      const res = await api.shareComment(c.id);
      const url = (res as { data?: { shareUrl?: string } }).data?.shareUrl || `${window.location.origin}/app/home?comment=${encodeURIComponent(c.id)}`;
      if (!res.error) patchComment(c.id, { shares: (c.shares || 0) + 1 });
      if (navigator.share) {
        await navigator.share({ title: `Comment by ${c.authorName || 'someone'}`, text, url }).catch(() => {});
      } else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        showSuccess('Comment link copied.');
      }
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        showSuccess('Comment copied.');
      } catch {
        showError('Could not share this comment.');
      }
    }
  };

  const handlePin = async (c: CommentItem) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const res = await api.pinComment(c.id);
      if (res.error) {
        showError(res.error);
        return;
      }
      const saved = (res as { data?: { comment?: CommentItem } }).data?.comment;
      const pinned = saved ? !!saved.isPinned : !c.isPinned;
      patchComment(c.id, { isPinned: pinned });
      showSuccess(pinned ? 'Comment pinned.' : 'Comment unpinned.');
      void load();
    } catch {
      showError('Could not pin this comment.');
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveEdit = async () => {
    const text = editingText.trim();
    if (!editingId || !text) return;
    setBusyId(editingId);
    try {
      const res = await api.updateComment(editingId, { text: text.slice(0, 1000) });
      if (res.error) {
        showError(res.error);
        return;
      }
      const saved = (res as { data?: { comment?: CommentItem } }).data?.comment;
      patchComment(editingId, { text: saved?.text ?? text, isEdited: true });
      setEditingId(null);
      setEditingText('');
      showSuccess('Comment updated.');
    } catch {
      showError('Could not update this comment.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (c: CommentItem | CommentReply) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const res = await api.deleteComment(c.id);
      if (res.error) {
        showError(res.error);
        return;
      }
      const deleted = Number((res as { data?: { deleted?: number } }).data?.deleted ?? 1);
      removeCommentLocal(c.id);
      setTotalCount((n) => Math.max(0, n - deleted));
      showSuccess('Comment deleted.');
    } catch {
      showError('Could not delete this comment.');
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleComments = async () => {
    if (togglingSettings || !postId) return;
    setTogglingSettings(true);
    try {
      const res = await api.setCommentSettings(postId, !commentsEnabled);
      if (res.error) {
        showError(res.error);
        return;
      }
      const enabled = (res as { data?: { commentsEnabled?: boolean } }).data?.commentsEnabled !== false;
      setCommentsEnabled(enabled);
      showSuccess(enabled ? 'Comments turned on.' : 'Comments turned off.');
    } catch {
      showError('Could not change this setting.');
    } finally {
      setTogglingSettings(false);
    }
  };

  if (!isOpen) return null;

  const canAct = (c: CommentItem | CommentReply) => String(c.authorId || '') !== '' && me.id !== '' && String(c.authorId) === String(me.id);
  const composerDisabled = posting || (!commentsEnabled && !isOwner);

  const renderActions = (c: CommentItem | CommentReply, isTop: boolean) => (
    <div className="flex flex-wrap items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className={`h-7 rounded-full px-2.5 text-xs ${c.hasLiked ? 'bg-rose-500/10 text-rose-500 hover:text-rose-500' : 'text-muted-foreground'}`}
        onClick={() => void handleLike(c)}
        disabled={busyId === c.id}
        aria-label={c.hasLiked ? 'Unlike comment' : 'Like comment'}
      >
        <Heart className={`mr-1 h-3.5 w-3.5 ${c.hasLiked ? 'fill-current' : ''}`} />
        {c.likes || 0}
      </Button>
      {commentsEnabled && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
          onClick={() => {
            const root = isTop ? (c as CommentItem) : comments.find((t) => t.replies?.some((r) => r.id === c.id)) ?? null;
            setReplyTo((root ?? c) as CommentItem);
          }}
          aria-label="Reply to comment"
        >
          <Reply className="mr-1 h-3.5 w-3.5" /> Reply
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
        onClick={() => void handleShare(c)}
        aria-label="Share comment"
      >
        <Share2 className="mr-1 h-3.5 w-3.5" />
        {(c.shares || 0) > 0 ? c.shares : 'Share'}
      </Button>
      {canAct(c) && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-2.5 text-xs text-muted-foreground"
            onClick={() => { setEditingId(c.id); setEditingText(c.text); }}
            aria-label="Edit comment"
          >
            <Edit2 className="mr-1 h-3.5 w-3.5" /> Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-2.5 text-xs text-destructive/80 hover:text-destructive"
            onClick={() => void handleDelete(c)}
            disabled={busyId === c.id}
            aria-label="Delete comment"
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
          </Button>
        </>
      )}
      {isOwner && isTop && (
        <Button
          variant="ghost"
          size="sm"
          className={`h-7 rounded-full px-2.5 text-xs ${(c as CommentItem).isPinned ? 'bg-amber-500/10 text-amber-500 hover:text-amber-500' : 'text-muted-foreground'}`}
          onClick={() => void handlePin(c as CommentItem)}
          disabled={busyId === c.id}
          aria-label={(c as CommentItem).isPinned ? 'Unpin comment' : 'Pin comment'}
        >
          {(c as CommentItem).isPinned ? <PinOff className="mr-1 h-3.5 w-3.5" /> : <Pin className="mr-1 h-3.5 w-3.5" />}
          {(c as CommentItem).isPinned ? 'Unpin' : 'Pin'}
        </Button>
      )}
      {isOwner && !isTop && !canAct(c) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void handleDelete(c)} className="text-destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove reply
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {isOwner && isTop && !canAct(c) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2.5 text-xs text-destructive/80 hover:text-destructive"
          onClick={() => void handleDelete(c)}
          disabled={busyId === c.id}
          aria-label="Remove comment"
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove
        </Button>
      )}
    </div>
  );

  const renderComment = (c: CommentItem | CommentReply, isTop: boolean) => {
    const avatar = resolveAvatar(c.authorAvatar);
    const name = String(c.authorName || c.authorUsername || 'User');
    const mineRow = me.id !== '' && String(c.authorId) === String(me.id);
    return (
      <div key={c.id} className={`flex gap-2.5 ${isTop ? '' : 'ml-9 mt-2.5 border-l-2 border-border/60 pl-3'}`}>
        <Avatar className={`${isTop ? 'h-9 w-9' : 'h-7 w-7'} shrink-0`}>
          {avatar ? <AvatarImage src={avatar} alt={name} /> : null}
          <AvatarFallback className="text-[11px] font-semibold">{initialsOf(name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {isTop && (c as CommentItem).isPinned && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-500">
                <Pin className="h-2.5 w-2.5" /> Pinned
              </span>
            )}
            <span className="truncate text-sm font-semibold">{name}</span>
            {mineRow && (
              <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">You</span>
            )}
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {timeAgo(c.createdAt)}{c.isEdited ? ' · Edited' : ''}
            </span>
          </div>
          {editingId === c.id ? (
            <div className="mt-1.5 space-y-2">
              <Input
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                maxLength={1000}
                aria-label="Edit comment text"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSaveEdit(); }
                  else if (e.key === 'Escape') { setEditingId(null); setEditingText(''); }
                }}
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void handleSaveEdit()} disabled={!editingText.trim() || busyId === c.id}>
                  {busyId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  <span className="ml-1">Save</span>
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setEditingId(null); setEditingText(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{c.text}</p>
          )}
          <div className="mt-1">{renderActions(c, isTop)}</div>
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Comments on ${postUser}'s post`}
    >
      <Card
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <CardContent className="flex min-h-0 flex-col p-0">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <MessageCircle className="h-5 w-5 shrink-0" />
              <h3 className="truncate font-semibold">Comments</h3>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {totalCount}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isOwner && (
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-8 w-8 ${commentsEnabled ? 'text-muted-foreground' : 'text-amber-500'}`}
                  onClick={() => void handleToggleComments()}
                  disabled={togglingSettings}
                  title={commentsEnabled ? 'Turn off comments' : 'Turn on comments'}
                  aria-label={commentsEnabled ? 'Turn off comments' : 'Turn on comments'}
                >
                  {togglingSettings ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : commentsEnabled ? (
                    <MessageSquareOff className="h-4 w-4" />
                  ) : (
                    <MessageSquare className="h-4 w-4" />
                  )}
                </Button>
              )}
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close comments">
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>

          {!commentsEnabled && (
            <div className="border-b bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-600 dark:text-amber-400">
              {isOwner ? 'Comments are off · only you can comment.' : 'Comments are off.'}
            </div>
          )}

          {/* List */}
          <div ref={listRef} className="min-h-[180px] flex-1 space-y-4 overflow-y-auto p-4">
            {loading ? (
              <div className="space-y-4" aria-label="Loading comments">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex animate-pulse gap-2.5">
                    <div className="h-9 w-9 shrink-0 rounded-full bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-1/3 rounded bg-muted" />
                      <div className="h-3 w-full rounded bg-muted" />
                      <div className="h-3 w-2/3 rounded bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="py-10 text-center">
                <MessageCircle className="mx-auto mb-2 h-10 w-10 opacity-40" />
                <p className="text-sm text-muted-foreground">{loadError}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
                  Try again
                </Button>
              </div>
            ) : comments.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">
                <MessageCircle className="mx-auto mb-2 h-12 w-12 opacity-40" />
                <p className="font-medium">No comments yet</p>
                <p className="mt-1 text-sm">
                  {commentsEnabled ? 'Be the first to comment.' : 'New comments are off.'}
                </p>
              </div>
            ) : (
              comments.map((c) => (
                <div key={c.id}>
                  {renderComment(c, true)}
                  {(c.replies || []).map((r) => renderComment(r, false))}
                </div>
              ))
            )}
          </div>

          {/* Composer */}
          <div className="border-t bg-background/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            {replyTo && (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-1.5 text-xs">
                <span className="truncate text-muted-foreground">
                  Replying to <span className="font-semibold text-foreground">{replyTo.authorName || 'comment'}</span>
                </span>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
            >
              <Avatar className="h-9 w-9 shrink-0">
                {me.id ? (
                  <>
                    {me.avatar ? <AvatarImage src={me.avatar} alt={me.name} /> : null}
                    <AvatarFallback className="text-xs font-semibold">{me.initials}</AvatarFallback>
                  </>
                ) : (
                  <AvatarFallback className="text-muted-foreground" aria-hidden>
                    <UserIcon className="h-4 w-4" />
                  </AvatarFallback>
                )}
              </Avatar>
              <Input
                ref={inputRef}
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={
                  !me.id
                    ? 'Sign in to comment…'
                    : !commentsEnabled && !isOwner
                      ? 'Comments are off'
                      : replyTo
                        ? `Reply to ${replyTo.authorName || 'comment'}…`
                        : `Comment as ${me.name}…`
                }
                aria-label={replyTo ? `Reply to ${replyTo.authorName}` : 'Write a comment'}
                className="flex-1"
                maxLength={1000}
                disabled={composerDisabled || !me.id}
              />
              <Button
                type="submit"
                size="icon"
                disabled={!newComment.trim() || composerDisabled || !me.id}
                aria-label={posting ? 'Posting comment' : 'Post comment'}
                title={!me.id ? 'Sign in to comment' : 'Post comment'}
              >
                {posting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
            {!me.id && (
              <p className="mt-1.5 text-center text-[11px] text-muted-foreground">Sign in to join the conversation.</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default CommentSection;
