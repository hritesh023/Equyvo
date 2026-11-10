import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Trash2, Eye, EyeOff, Loader2, Clock, Users, ThumbsUp } from 'lucide-react';
import api from '@/lib/api';
import { formatWatchTime } from '@/lib/media';
import { showSuccess, showError } from '@/utils/toast';

interface Props { userId: string; isSelf: boolean; }

const ContentManagementTab: React.FC<Props> = ({ userId, isSelf }) => {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<any[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await api.getUserContent(userId);
      if (error || !data) { showError(error || 'Failed to load content'); return; }
      const all = [
        ...(data.posts || []).map((p: any) => ({ ...p, _kind: 'post' })),
        ...(data.thoughts || []).map((t: any) => ({ ...t, _kind: 'thought' })),
        ...(data.stories || []).map((s: any) => ({ ...s, _kind: 'story' })),
        ...(data.moments || []).map((m: any) => ({ ...m, _kind: 'moment' })),
      ];
      setItems(all);
    } catch { showError('Failed to load content'); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (userId) load(); }, [userId]);

  const remove = async (item: any) => {
    try {
      if (item._kind === 'thought') await api.deleteThought(item.id);
      else if (item._kind === 'story') await api.deleteStory(item.id);
      else if (item._kind === 'moment') await api.deleteMoment(item.id);
      else await api.deletePost(item.id);
      setItems((prev) => prev.filter((x) => x.id !== item.id));
      showSuccess('Content deleted');
    } catch { showError('Delete failed'); }
  };

  const toggleVisibility = async (item: any) => {
    const next = item.visibility === 'private' ? 'public' : 'private';
    try {
      if (item._kind === 'thought') await api.updateThought(item.id, { visibility: next });
      else if (item._kind === 'story') await api.updateStory(item.id, { visibility: next });
      else if (item._kind === 'moment') await api.updateMoment(item.id, { visibility: next });
      else await api.updatePost(item.id, { visibility: next });
      setItems((prev) => prev.map((x) => x.id === item.id ? { ...x, visibility: next } : x));
      showSuccess(next === 'private' ? 'Hidden from public' : 'Made public');
    } catch { showError('Update failed'); }
  };

  if (!isSelf) return <div className="text-sm text-muted-foreground p-4">Manage your own content from your profile.</div>;
  if (loading) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Changing a thumbnail after posting updates only the preview image. The post itself, its views, likes, comments and shares remain unchanged. Earlier media is not deleted.
      </p>
      {items.length === 0 && <p className="text-sm text-muted-foreground p-4">No content yet.</p>}
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
          <img src={item.thumbnail || item.image || item.videoUrl} alt="" className="h-12 w-12 rounded object-cover bg-muted" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.title || item.content || item._kind}</p>
            <p className="text-xs text-muted-foreground">{item._kind} · {item.visibility || 'public'}</p>
             <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
               {item.views ? <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {item.views}</span> : null}
               {item.likes ? <span className="flex items-center gap-1"><ThumbsUp className="h-3 w-3" /> {item.likes}</span> : null}
               {formatWatchTime(item.duration) ? <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatWatchTime(item.duration)}</span> : null}
             </div>
          </div>
          <Button size="icon" variant="ghost" onClick={() => toggleVisibility(item)} title="Toggle visibility">
            {item.visibility === 'private' ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => remove(item)} title="Delete">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      ))}
    </div>
  );
};

export default ContentManagementTab;