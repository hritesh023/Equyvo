import { showSuccess, showError } from '@/utils/toast';
import api from '@/lib/api';

interface DeleteContentOptions {
  postId: string;
  contentType?: 'post' | 'thought' | 'moment' | 'story' | 'comment';
  onDeleteComplete?: (postId: string) => void;
}

export const deleteContent = async (options: DeleteContentOptions): Promise<void> => {
  const { postId, contentType = 'post', onDeleteComplete } = options;

  let result;
  try {
    switch (contentType) {
      case 'thought':
        result = await api.deleteThought(postId);
        break;
      case 'moment':
        result = await api.deleteMoment(postId);
        break;
      case 'story':
        result = await api.deleteStory(postId);
        break;
      default:
        result = await api.deletePost(postId);
    }
  } catch (err: any) {
    showError(`Failed to delete ${contentType}. Please try again.`);
    throw err;
  }

  if (result?.error) {
    showError(`Failed to delete ${contentType}. Please try again.`);
    throw new Error(result.error);
  }

  showSuccess(`${contentType.charAt(0).toUpperCase() + contentType.slice(1)} deleted successfully`);

  window.dispatchEvent(new CustomEvent('userPostDeleted', { detail: { postId, contentType } }));

  if (onDeleteComplete) {
    onDeleteComplete(postId);
  }
};

export const confirmDelete = (contentType: string = 'post'): boolean => {
  const message = `Are you sure you want to delete this ${contentType}? This action cannot be undone.`;
  return window.confirm(message);
};
