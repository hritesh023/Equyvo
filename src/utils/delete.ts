import { showSuccess, showError } from '@/utils/toast';
import api from '@/lib/api';

export type DeletableContentType = 'post' | 'photo' | 'video' | 'thought' | 'moment' | 'story' | 'text-story' | 'comment' | 'live';

interface DeleteContentOptions {
  postId: string;
  contentType?: DeletableContentType | string;
  onDeleteComplete?: (postId: string) => void;
}

function friendlyType(contentType: string): string {
  const t = String(contentType || 'post').toLowerCase();
  if (t === 'text-story') return 'story';
  if (t === 'photo') return 'photo';
  if (t === 'video' || t === 'live') return 'video';
  if (t === 'moment') return 'moment';
  if (t === 'thought') return 'thought';
  if (t === 'story') return 'story';
  return 'post';
}

function isNotFoundMessage(msg: string): boolean {
  const m = String(msg || '').toLowerCase();
  return m.includes('not found') || m.includes('404');
}

function isOwnershipMessage(msg: string): boolean {
  const m = String(msg || '').toLowerCase();
  return m.includes('only the account') || m.includes('forbidden') || m.includes('403');
}

export const deleteContent = async (options: DeleteContentOptions): Promise<void> => {
  const { postId, contentType = 'post', onDeleteComplete } = options;
  const label = friendlyType(String(contentType));

  const finishLocalDelete = () => {
    try {
      window.dispatchEvent(new CustomEvent('userPostDeleted', { detail: { postId, contentType } }));
    } catch {
      /* ignore */
    }
    if (onDeleteComplete) {
      try {
        onDeleteComplete(postId);
      } catch {
        /* ignore */
      }
    }
  };

  let result;
  try {
    switch (label) {
      case 'thought':
        result = await api.deleteThought(postId);
        break;
      case 'moment':
        result = await api.deleteMoment(postId);
        break;
      case 'story':
        result = await api.deleteStory(postId);
        break;
      case 'photo':
      case 'video':
      case 'post':
      default:
        result = await api.deletePost(postId);
    }
  } catch (err: unknown) {
    showError(`Couldn't delete this ${label}. Please check your connection and try again.`);
    throw err;
  }

  if (result?.error) {
    // Already gone everywhere — treat as success so the item leaves the view
    // instead of trapping the user with an error.
    if (isNotFoundMessage(result.error)) {
      finishLocalDelete();
      showSuccess(`${label.charAt(0).toUpperCase() + label.slice(1)} deleted`);
      return;
    }
    if (isOwnershipMessage(result.error)) {
      showError(`Only you can delete your own ${label}. You can hide it from your view instead.`);
    } else {
      showError(`Couldn't delete this ${label}. Please try again.`);
    }
    throw new Error(result.error);
  }

  showSuccess(`${label.charAt(0).toUpperCase() + label.slice(1)} deleted`);

  finishLocalDelete();
};

export const confirmDelete = (contentType: string = 'post'): boolean => {
  const message = `Are you sure you want to delete this ${contentType}? This action cannot be undone.`;
  return window.confirm(message);
};
