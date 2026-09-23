import { showSuccess, showError } from '@/utils/toast';
import api from '@/lib/api';

export type ContentVisibility = 'public' | 'followers' | 'private';

function updaterFor(contentType: string) {
  const t = String(contentType || 'post').toLowerCase();
  if (t === 'moment') return api.updateMoment.bind(api);
  if (t === 'thought') return api.updateThought.bind(api);
  if (t === 'story' || t === 'text-story') return api.updateStory.bind(api);
  return api.updatePost.bind(api);
}

/**
 * Owner-only visibility change ("hide from public" without deleting).
 * Only the owning account can call this — the server rejects anyone else.
 */
export async function setContentVisibility(
  postId: string,
  contentType: string,
  visibility: ContentVisibility,
): Promise<boolean> {
  try {
    const update = updaterFor(contentType);
    const { error } = await update(postId, { visibility });
    if (error) throw new Error(error);
    if (visibility === 'private') showSuccess('Hidden from public. Only you can see it now.');
    else if (visibility === 'followers') showSuccess('Visible to your followers only.');
    else showSuccess('Now visible to everyone.');
    try {
      window.dispatchEvent(new CustomEvent('feedRefresh'));
    } catch { /* ignore */ }
    return true;
  } catch (err: any) {
    showError(err?.message || 'Could not change visibility. Please try again.');
    return false;
  }
}
