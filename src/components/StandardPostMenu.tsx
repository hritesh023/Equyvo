import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Copy, Share2, Flag, EyeOff, Edit } from 'lucide-react';
import { showSuccess, showError } from '@/utils/toast';
import DeleteButton from '@/components/ui/DeleteButton';
import ReportModal from '@/components/ReportModal';
import { deleteContent } from '@/utils/delete';
import { setContentVisibility } from '@/utils/visibility';
import { hideFromMyView } from '@/lib/feed-store';
import { isOwnContent } from '@/utils/ownership';

interface StandardPostMenuProps {
  postId: string;
  postUserId?: string;
  /** Owner/account id (preferred for ownership checks). */
  postOwnerId?: string;
  currentUserId?: string;
  /** Content collection used for delete/visibility calls. Defaults to 'post'. */
  contentType?: string;
  isProfilePage?: boolean;
  onReport?: (postId: string) => void;
  onDelete?: (postId: string) => void;
  /** Fired after any successful delete (including the built-in fallback). */
  onDeleted?: (postId: string) => void;
  onEdit?: (postId: string) => void;
  onShare?: (postId: string) => void;
  onHide?: (postId: string) => void;
  /** Fired after a hide (either personal or from-public). */
  onHidden?: (postId: string) => void;
  onCopyLink?: (postId: string) => void;
  className?: string;
}

function friendlyLabel(contentType: string): string {
  const t = String(contentType || 'post').toLowerCase();
  if (t === 'text-story' || t === 'story') return 'Story';
  if (t === 'moment') return 'Moment';
  if (t === 'thought') return 'Thought';
  if (t === 'video' || t === 'live') return 'Video';
  if (t === 'photo' || t === 'image') return 'Photo';
  return 'Post';
}

const StandardPostMenu: React.FC<StandardPostMenuProps> = ({
  postId,
  postUserId,
  postOwnerId,
  currentUserId,
  contentType = 'post',
  isProfilePage = false,
  onReport,
  onDelete,
  onDeleted,
  onEdit,
  onShare,
  onHide,
  onHidden,
  onCopyLink,
  className = ''
}) => {
  const [isSharing, setIsSharing] = useState(false);
  const [isHiding, setIsHiding] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // Only the account that posted this sees Delete. Everyone else gets
  // Hide (their own view only) + Report. Never errors for non-owners.
  const isOwnPost = isOwnContent(
    { ownerId: postOwnerId, user: postUserId },
    { currentUserId, postOwnerId, postUserId },
  );
  const label = friendlyLabel(contentType);

  const handleCopyLink = async () => {
    try {
      const shareUrl = `${window.location.origin}/posts/${postId}`;
      await navigator.clipboard.writeText(shareUrl);
      showSuccess('Link copied to clipboard!');
      onCopyLink?.(postId);
    } catch {
      showError("Couldn't copy the link. Please try again.");
    }
  };

  const handleShare = async () => {
    if (isSharing) return;

    setIsSharing(true);
    try {
      const shareUrl = `${window.location.origin}/posts/${postId}`;

      if (navigator.share) {
        try {
          await navigator.share({
            title: 'Check out this post!',
            text: 'Amazing content on Equyvo',
            url: shareUrl,
          });
        } catch (err: unknown) {
          // User dismissed the sheet — not an error.
          if (err instanceof Error && err.name === 'AbortError') return;
          await navigator.clipboard.writeText(shareUrl);
          showSuccess('Link copied to clipboard!');
        }
      } else {
        await navigator.clipboard.writeText(shareUrl);
        showSuccess('Link copied to clipboard!');
      }
      onShare?.(postId);
    } catch {
      showError("Couldn't share this right now. Please try again.");
    } finally {
      setIsSharing(false);
    }
  };

  const handleReport = () => {
    if (onReport) {
      onReport(postId);
      return;
    }
    if (isOwnPost) {
      showSuccess('This is yours — you can edit or delete it instead.');
      return;
    }
    setReportOpen(true);
  };

  const handleHide = async () => {
    if (isHiding) return;
    if (onHide) {
      setIsHiding(true);
      try {
        await onHide(postId);
        onHidden?.(postId);
      } catch {
        showError("Couldn't hide this right now. Please try again.");
      } finally {
        setIsHiding(false);
      }
      return;
    }
    setIsHiding(true);
    try {
      if (isOwnPost) {
        const ok = await setContentVisibility(postId, contentType, 'private');
        if (ok) onHidden?.(postId);
        return;
      }
      hideFromMyView(postId);
      showSuccess("Hidden from your view. You won't see it again.");
      onHidden?.(postId);
    } finally {
      setIsHiding(false);
    }
  };

  const handleBuiltInDelete = async () => {
    try {
      await deleteContent({ postId, contentType: contentType as never });
      onDeleted?.(postId);
    } catch {
      // deleteContent already explained what happened.
    }
  };

  const handleEdit = () => {
    onEdit?.(postId);
  };

  const deleteTitle = `Delete this ${label.toLowerCase()}?`;

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="More options"
          className={`h-8 w-8 text-muted-foreground hover:text-foreground ${className}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={handleCopyLink}>
          <Copy className="h-4 w-4 mr-2" />
          Copy Link
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleShare} disabled={isSharing}>
          <Share2 className="h-4 w-4 mr-2" />
          {isSharing ? 'Sharing...' : 'Share'}
        </DropdownMenuItem>
        {isOwnPost && onEdit && (
          <DropdownMenuItem onClick={handleEdit}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {!isOwnPost && (
          <DropdownMenuItem onClick={handleReport}>
            <Flag className="h-4 w-4 mr-2" />
            Report
          </DropdownMenuItem>
        )}
        {isOwnPost ? (
          <>
            <div className="p-1">
              <DeleteButton
                onDelete={() => {
                  if (onDelete) {
                    try {
                      const r = onDelete(postId);
                      if (r instanceof Promise) return r;
                      return Promise.resolve();
                    } catch {
                      return Promise.reject(new Error('delete failed'));
                    }
                  }
                  return handleBuiltInDelete();
                }}
                variant="ghost"
                size="sm"
                className="w-full justify-start h-8 px-2 text-sm"
                confirmationTitle={deleteTitle}
                confirmationDescription={`This will permanently remove your ${label.toLowerCase()} from Equyvo. This can't be undone. Only you can delete it — other people can only hide it from their own view.`}
                confirmButtonText={`Delete ${label}`}
                showIcon={true}
              />
            </div>
            <DropdownMenuItem onClick={handleHide} disabled={isHiding} className="text-red-600 focus:text-red-600">
              <EyeOff className="h-4 w-4 mr-2" />
              {isHiding ? 'Hiding...' : isProfilePage ? 'Hide from public' : 'Hide from public'}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onClick={handleHide} disabled={isHiding} className="text-red-600 focus:text-red-600">
            <EyeOff className="h-4 w-4 mr-2" />
            {isHiding ? 'Hiding...' : 'Hide'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    {reportOpen && (
      <ReportModal
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        contentId={postId}
        contentType={contentType === 'moment' ? 'moment' : contentType === 'thought' ? 'thought' : 'post'}
      />
    )}
    </>
  );
};

export default StandardPostMenu;
