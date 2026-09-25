import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Lock } from 'lucide-react';
import FollowButton from './FollowButton';
import type { SocialProfile } from '@/lib/social';

interface FollowListModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  list: SocialProfile[];
  restricted: boolean;
  loading?: boolean;
  emptyHint?: string;
}

/**
 * Instagram-ish followers/following sheet: avatar + name + handle + Follow
 * action per row. When `restricted` (private account + stranger), only the
 * counts are shown — never the names — matching the server gate.
 */
export function FollowListModal({ open, onOpenChange, title, list, restricted, loading, emptyHint }: FollowListModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-center text-sm font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[420px] overflow-y-auto">
          {loading ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>
          ) : restricted ? (
            <div className="px-6 py-10 text-center">
              <Lock className="mx-auto mb-3 h-8 w-8 opacity-50" />
              <p className="text-sm font-medium">This account is private</p>
              <p className="mt-1 text-xs text-muted-foreground">Follow this account to see their followers and following.</p>
            </div>
          ) : list.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyHint || 'Nothing here yet.'}</p>
          ) : (
            list.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/20">
                <Avatar className="h-9 w-9">
                  <AvatarImage src={p.avatar} />
                  <AvatarFallback>{(p.name || p.username || '?')[0]?.toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.username || p.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{p.name}</p>
                </div>
                <FollowButton userId={p.id} userName={p.username || p.name} size="sm" />
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border p-2">
          <Button variant="ghost" className="w-full text-xs" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default FollowListModal;
