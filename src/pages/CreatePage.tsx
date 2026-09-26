import React, { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Text, Video, Camera, Mic, Zap, Upload, Image, FileVideo, Clock, X, Plus, Film, ImageIcon, Trash2, Calendar, Eye, Lock, Unlock, BarChart3, Users, TrendingUp, Play, Square, Brain, Loader2, Crop } from 'lucide-react';
import MediaCropper from '@/components/MediaCropper';
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { showSuccess, showError } from '@/utils/toast';
import { validateVideoDuration } from '@/lib/thoughts';
import { compressImage } from '@/lib/utils';
import { markHasRealContent } from '@/lib/data';
import { broadcastPostCreated, captureVideoPoster } from '@/lib/feed-store';
import { deleteContent } from '@/utils/delete';
import { setContentVisibility } from '@/utils/visibility';
import api from '@/lib/api';

// Helper to get current user info from localStorage
function getCurrentUserInfo(): { userId: string; username: string } {
  try {
    const stored = localStorage.getItem('equyvo_cognito_user');
    if (stored) {
      const user = JSON.parse(stored);
      return {
        userId: user.id || user.email || 'anonymous',
        username: user.username || user.email?.split('@')[0] || 'anonymous',
      };
    }
  } catch { /* no stored user — fall through to anonymous */ }
  return { userId: 'anonymous', username: 'anonymous' };
}

// Freshest author identity: profile page edits (name/avatar) win over the
// auth record, so new uploads are always stamped with the real current user.
function getCurrentAuthor(): { userId: string; username: string; avatar: string } {
  let userId = 'anonymous';
  let username = 'anonymous';
  let email = '';
  try {
    const stored = localStorage.getItem('equyvo_cognito_user');
    if (stored) {
      const u = JSON.parse(stored);
      userId = u.id || u.email || 'anonymous';
      email = u.email || '';
      username = u.username || u.fullName || (u.email ? String(u.email).split('@')[0] : 'anonymous');
    }
  } catch { /* fall through to anonymous */ }
  let avatar = '';
  try {
    const saved = localStorage.getItem('userProfile');
    if (saved) {
      const p = JSON.parse(saved);
      const belongs = !email || !p._userEmail || p._userEmail === email || p.id === userId;
      if (belongs) {
        if (p.username || p.name) username = p.username || p.name;
        if (typeof p.avatar === 'string' && p.avatar) avatar = p.avatar;
      }
    }
  } catch { /* ignore */ }
  return { userId, username, avatar };
}

// Local pre-upload preview: shows BOTH the file name and a live
// thumbnail/preview (image <img>, video <video>) before anything is posted.
function useLocalPreviewUrl(file: File | null | undefined): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) {
      setUrl('');
      return;
    }
    let u = '';
    try {
      u = URL.createObjectURL(file);
      setUrl(u);
    } catch {
      setUrl('');
      return;
    }
    return () => {
      try {
        URL.revokeObjectURL(u);
      } catch { /* ignore */ }
    };
  }, [file]);
  return url;
}

const LocalMediaThumb: React.FC<{ file: File; className?: string }> = ({ file, className }) => {
  const url = useLocalPreviewUrl(file);
  const cls = className || 'h-14 w-14 rounded-lg object-cover border bg-black';
  if (!url) {
    return (
      <div className="flex h-14 w-14 items-center justify-center rounded-lg border bg-muted">
        {file.type.startsWith('image/') ? (
          <ImageIcon className="h-5 w-5 text-blue-500" />
        ) : (
          <FileVideo className="h-5 w-5 text-green-500" />
        )}
      </div>
    );
  }
  if (file.type.startsWith('image/')) {
    return <img src={url} alt={file.name} className={cls} />;
  }
  if (file.type.startsWith('video/')) {
    return <video src={url} className={cls} muted playsInline preload="metadata" />;
  }
  return (
    <div className="flex h-14 w-14 items-center justify-center rounded-lg border bg-muted">
      <FileVideo className="h-5 w-5 text-muted-foreground" />
    </div>
  );
};

type ThumbKind =
  | 'video'
  | 'story'
  | 'photo'
  | 'moment'
  | 'thought'
  | 'live'
  | 'pending-video'
  | 'pending-moment'
  | 'pending-thought'
  | 'pending-story';

interface ThumbCropState {
  src: string;
  aspect: number;
  outW: number;
  outH: number;
  title: string;
  target: { kind: ThumbKind; id: string };
}

const THUMB_SPEC: Record<ThumbKind, { aspect: number; outW: number; outH: number; label: string }> = {
  video: { aspect: 16 / 9, outW: 1280, outH: 720, label: 'video thumbnail' },
  photo: { aspect: 16 / 9, outW: 1280, outH: 720, label: 'photo thumbnail' },
  live: { aspect: 16 / 9, outW: 1280, outH: 720, label: 'stream thumbnail' },
  story: { aspect: 9 / 16, outW: 720, outH: 1280, label: 'story cover' },
  moment: { aspect: 9 / 16, outW: 720, outH: 1280, label: 'moment cover' },
  thought: { aspect: 16 / 9, outW: 1280, outH: 720, label: 'thought thumbnail' },
  'pending-video': { aspect: 16 / 9, outW: 1280, outH: 720, label: 'video thumbnail' },
  'pending-moment': { aspect: 9 / 16, outW: 720, outH: 1280, label: 'moment cover' },
  'pending-thought': { aspect: 16 / 9, outW: 1280, outH: 720, label: 'thought thumbnail' },
  'pending-story': { aspect: 9 / 16, outW: 720, outH: 1280, label: 'story cover' },
};

const CreatePage = () => {
  const [activeTab, setActiveTab] = useState('story');
  const [storyFiles, setStoryFiles] = useState<File[]>([]);
  const [thoughtContent, setThoughtContent] = useState('');
  const [thoughtVideo, setThoughtVideo] = useState<File | null>(null);
  const [liveTitle, setLiveTitle] = useState('');
  const [liveDescription, setLiveDescription] = useState('');
  const [liveThumbnailFile, setLiveThumbnailFile] = useState<File | null>(null);
  const [liveThumbnailPreview, setLiveThumbnailPreview] = useState<string>('');
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [recordedChunks, setRecordedChunks] = useState<Blob[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [textStoryContent, setTextStoryContent] = useState('');
  const [textStoryBackground, setTextStoryBackground] = useState('#000000');
  const [textStoryColor, setTextStoryColor] = useState('#FFFFFF');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [videoFiles, setVideoFiles] = useState<File[]>([]);
  const [photoCaption, setPhotoCaption] = useState('');
  const [momentFiles, setMomentFiles] = useState<File[]>([]);
  const [momentContent, setMomentContent] = useState('');
  const [videoCaption, setVideoCaption] = useState('');

  // ---- Pre-publish custom thumbnails (one section per media tab, like Live) ----
  // Each video/moment/thought/story tab gets its own separate thumbnail picker.
  // The picked file is uploaded at post time and used as the thumbnail/poster
  // for that batch, overriding the auto-captured poster.
  const [videoThumbFile, setVideoThumbFile] = useState<File | null>(null);
  const [videoThumbPreview, setVideoThumbPreview] = useState<string>('');
  const [momentThumbFile, setMomentThumbFile] = useState<File | null>(null);
  const [momentThumbPreview, setMomentThumbPreview] = useState<string>('');
  const [thoughtThumbFile, setThoughtThumbFile] = useState<File | null>(null);
  const [thoughtThumbPreview, setThoughtThumbPreview] = useState<string>('');
  const [storyThumbFile, setStoryThumbFile] = useState<File | null>(null);
  const [storyThumbPreview, setStoryThumbPreview] = useState<string>('');

  const [thumbCrop, setThumbCrop] = useState<ThumbCropState | null>(null);
  const [thumbBusyId, setThumbBusyId] = useState<string | null>(null);
  const thumbTargetRef = useRef<{ kind: ThumbKind; id: string } | null>(null);

  const clearVideoThumb = () => {
    if (videoThumbPreview.startsWith('blob:')) {
      try { URL.revokeObjectURL(videoThumbPreview); } catch { /* ignore */ }
    }
    setVideoThumbFile(null);
    setVideoThumbPreview('');
  };
  const clearMomentThumb = () => {
    if (momentThumbPreview.startsWith('blob:')) {
      try { URL.revokeObjectURL(momentThumbPreview); } catch { /* ignore */ }
    }
    setMomentThumbFile(null);
    setMomentThumbPreview('');
  };
  const clearThoughtThumb = () => {
    if (thoughtThumbPreview.startsWith('blob:')) {
      try { URL.revokeObjectURL(thoughtThumbPreview); } catch { /* ignore */ }
    }
    setThoughtThumbFile(null);
    setThoughtThumbPreview('');
  };
  const clearStoryThumb = () => {
    if (storyThumbPreview.startsWith('blob:')) {
      try { URL.revokeObjectURL(storyThumbPreview); } catch { /* ignore */ }
    }
    setStoryThumbFile(null);
    setStoryThumbPreview('');
  };

  /** Upload a pre-publish thumbnail file; returns '' on failure. */
  const uploadPendingThumb = async (file: File | null): Promise<string> => {
    if (!file) return '';
    try {
      const up = file.type.startsWith('image/') ? await compressImage(file) : file;
      const { data, error } = await api.uploadFile(up, 'equyvo/thumbnails');
      if (error || !data?.secureUrl) throw new Error(error || 'Thumbnail upload failed');
      return data.secureUrl;
    } catch {
      showError('Custom thumbnail upload failed — using auto poster instead.');
      return '';
    }
  };

  /** A cover/thumbnail may only exist alongside its actual media. This is the
   *  single gate used by every picker, so a cover can never be uploaded (or
   *  even selected) unless that tab's media is already chosen. */
  const hasMediaForPending = (
    kind: 'pending-video' | 'pending-moment' | 'pending-thought' | 'pending-story',
  ): boolean => {
    if (kind === 'pending-video') return videoFiles.length > 0;
    if (kind === 'pending-moment') return momentFiles.length > 0;
    if (kind === 'pending-thought') return thoughtVideo !== null;
    return storyFiles.length > 0;
  };

  const pendingMediaHint = (
    kind: 'pending-video' | 'pending-moment' | 'pending-thought' | 'pending-story',
  ): string => {
    if (kind === 'pending-video') return 'Select at least one video first — a thumbnail needs its video.';
    if (kind === 'pending-moment') return 'Select at least one moment photo/video first — a cover needs its media.';
    if (kind === 'pending-thought') return 'Attach the thought photo/video first — a thumbnail needs its media.';
    return 'Select at least one story photo/video first — a cover needs its media.';
  };

  /** Open the shared cropper for a pre-publish (not yet posted) thumbnail. */
  const openPendingThumbPicker = (
    kind: 'pending-video' | 'pending-moment' | 'pending-thought' | 'pending-story',
  ) => {
    if (!hasMediaForPending(kind)) {
      showError(pendingMediaHint(kind));
      return;
    }
    thumbTargetRef.current = { kind, id: kind };
    const input = document.getElementById('custom-thumb-upload') as HTMLInputElement | null;
    if (input) {
      input.value = '';
      input.click();
    }
  };

  const openThumbUpload = (kind: ThumbKind, id: string) => {
    // Live streams have no file: the title is the media commitment.
    if (kind === 'live' && !liveTitle.trim()) {
      showError('Enter a stream title first — a thumbnail needs its stream.');
      return;
    }
    thumbTargetRef.current = { kind, id };
    const input = document.getElementById('custom-thumb-upload') as HTMLInputElement | null;
    if (input) {
      input.value = '';
      input.click();
    }
  };

  const openThumbAdjust = (kind: ThumbKind, id: string, src: string) => {
    if (!src) {
      showError('No thumbnail to adjust yet — upload a separate one first.');
      return;
    }
    const spec = THUMB_SPEC[kind] || THUMB_SPEC.video;
    setThumbCrop({
      src,
      aspect: (spec && spec.aspect) || 16 / 9,
      outW: (spec && spec.outW) || 1280,
      outH: (spec && spec.outH) || 720,
      title: `Adjust ${(spec && spec.label) || 'thumbnail'}`,
      target: { kind, id },
    });
  };

  const handleCustomThumbPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const t = thumbTargetRef.current;
    thumbTargetRef.current = null;
    if (!file) return;
    if (!t) {
      showError('Upload target could not be identified. Please try again.');
      return;
    }
    if (!file.type.startsWith('image/')) {
      showError('Please select an image file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showError('Thumbnail must be less than 5MB');
      return;
    }

    const rawKind = (typeof t === 'object' && t !== null) ? t.kind : (typeof t === 'string' ? t : undefined);
    const rawId = (typeof t === 'object' && t !== null) ? t.id : (typeof t === 'string' ? t : undefined);
    const kind: ThumbKind = (rawKind && rawKind in THUMB_SPEC) ? (rawKind as ThumbKind) : 'video';
    const id: string = rawId || kind;
    // Defense in depth: even if the picker was forced open, a pre-publish
    // cover is rejected here unless its media is currently selected.
    if (
      (kind === 'pending-video' || kind === 'pending-moment' || kind === 'pending-thought' || kind === 'pending-story') &&
      !hasMediaForPending(kind)
    ) {
      showError(pendingMediaHint(kind));
      return;
    }
    const spec = THUMB_SPEC[kind] || THUMB_SPEC.video;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const src = typeof reader.result === 'string' ? reader.result : '';
        if (!src) throw new Error('Could not read image');
        setThumbCrop({
          src,
          aspect: (spec && spec.aspect) || 16 / 9,
          outW: (spec && spec.outW) || 1280,
          outH: (spec && spec.outH) || 720,
          title: `Crop ${(spec && spec.label) || 'thumbnail'}`,
          target: { kind, id },
        });
      } catch {
        showError('Could not process thumbnail image. Please try another one.');
      }
    };
    reader.onerror = () => {
      showError('Failed to read image file. Please try another one.');
    };
    reader.readAsDataURL(file);
  };

  // New states for scheduling and content management
  const [scheduledPosts, setScheduledPosts] = useState<ScheduledPost[]>([]);
  const [draftPosts, setDraftPosts] = useState<DraftPost[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');
  const [currentContentType, setCurrentContentType] = useState('');

  // State for uploaded content management
  const [uploadedVideos, setUploadedVideos] = useState<UploadedVideo[]>([]);
  const [uploadedStories, setUploadedStories] = useState<UploadedStory[]>([]);
  const [uploadedThoughts, setUploadedThoughts] = useState<UploadedThought[]>([]);
  const [uploadedPhotos, setUploadedPhotos] = useState<UploadedPhoto[]>([]);
  const [uploadedMoments, setUploadedMoments] = useState<UploadedMoment[]>([]);
  const [uploadedTextStories, setUploadedTextStories] = useState<UploadedTextStory[]>([]);
  const [showContentManagement, setShowContentManagement] = useState(false);
  const [activeManagementTab, setActiveManagementTab] = useState<'all' | 'videos' | 'stories' | 'thoughts' | 'photos' | 'moments' | 'text-stories'>('all');
  const [isUploading, setIsUploading] = useState(false);
  // Who can see new uploads: public (everyone), followers (followers-only),
  // private (only you). Sent to the server with every post; the server
  // enforces it for every account on every device.
  const [contentVisibility, setContentVisibilityState] = useState<'public' | 'followers' | 'private'>('public');

  // Default the selector from the account type (private accounts default to
  // followers-only), so uploads respect the signup/settings choice.
  useEffect(() => {
    try {
      const stored = localStorage.getItem('equyvo_cognito_user');
      const id = stored ? (JSON.parse(stored)?.id || '') : '';
      if (!id) return;
      api.getProfile(id).then(({ data, error }) => {
        if (!error && data && (data as any).isPrivate === true) {
          setContentVisibilityState('followers');
        }
      }).catch(() => {});
    } catch { /* ignore */ }
  }, []);

  // Load everything this account ever published into management, so the
  // thumbnail/delete/privacy controls exist for all uploads on any device.
  // (The in-session lists alone vanish on reload.)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = localStorage.getItem('equyvo_cognito_user');
        const uid = stored ? (JSON.parse(stored)?.id || '') : '';
        if (!uid) return;
        const { data, error } = await api.getUserContent(uid);
        if (cancelled || error || !data || typeof data !== 'object') return;
        const d = data as { posts?: any[]; thoughts?: any[]; stories?: any[]; moments?: any[] };
        const toDate = (v: unknown): Date => {
          const dt = v ? new Date(String(v)) : new Date();
          return isNaN(dt.getTime()) ? new Date() : dt;
        };
        const num = (v: unknown): number => {
          const n = Number(v);
          return Number.isFinite(n) ? n : 0;
        };
        const isPriv = (item: any): boolean =>
          String(item?.visibility || '').toLowerCase() === 'private';
        const lower = (v: unknown): string => String(v || '').toLowerCase();
        const videos: UploadedVideo[] = (d.posts || [])
          .filter((p) => lower(p?.type) === 'video')
          .map((p: any, i: number) => ({
            id: String(p.id ?? `srv-video-${i}`),
            title: String(p.content || p.title || 'Video'),
            fileName: '',
            fileSize: 0,
            duration: String(p.duration || ''),
            thumbnail: String(p.thumbnail || ''),
            videoUrl: String(p.videoUrl || p.media || ''),
            publicId: String(p.publicId || ''),
            resourceType: String(p.resourceType || ''),
            uploadDate: toDate(p.createdAt || p.created_at),
            isPrivate: isPriv(p),
            views: num(p.views),
            likes: num(p.likes),
            comments: num(p.comments),
            shares: num(p.shares),
            watchTime: 0,
            engagement: 0,
          }));
        const photos: UploadedPhoto[] = (d.posts || [])
          .filter((p) => ['photo', 'image'].includes(lower(p?.type)))
          .map((p: any, i: number) => ({
            id: String(p.id ?? `srv-photo-${i}`),
            fileName: '',
            fileSize: 0,
            thumbnail: String(p.thumbnail || p.image || p.media || ''),
            caption: String(p.content || ''),
            mediaType: (lower(p.mediaType) === 'video' ? 'video' : 'image') as 'image' | 'video',
            videoUrl: String(p.videoUrl || ''),
            publicId: String(p.publicId || ''),
            resourceType: String(p.resourceType || ''),
            uploadDate: toDate(p.createdAt || p.created_at),
            isPrivate: isPriv(p),
            views: num(p.views),
            likes: num(p.likes),
            comments: num(p.comments),
            shares: num(p.shares),
          }));
        const stories: UploadedStory[] = (d.stories || [])
          .filter((s) => lower(s?.type || 'story') !== 'text-story')
          .map((s: any, i: number) => {
            const isVid = lower(s.mediaType) === 'video' || !!s.videoUrl;
            return {
              id: String(s.id ?? `srv-story-${i}`),
              type: (isVid ? 'video' : 'image') as 'image' | 'video',
              fileName: '',
              fileSize: 0,
              duration: isVid ? String(s.duration || '0:15') : undefined,
              thumbnail: String(s.thumbnail || ''),
              publicId: String(s.publicId || ''),
              resourceType: String(s.resourceType || ''),
              uploadDate: toDate(s.createdAt || s.created_at),
              isPrivate: isPriv(s),
              views: num(s.views),
              likes: num(s.likes),
              comments: num(s.comments),
              shares: num(s.shares),
              expiresAt: new Date(toDate(s.createdAt || s.created_at).getTime() + 24 * 60 * 60 * 1000),
            };
          });
        const textStories: UploadedTextStory[] = (d.stories || [])
          .filter((s) => lower(s?.type) === 'text-story')
          .map((s: any, i: number) => {
            const at = toDate(s.createdAt || s.created_at);
            return {
              id: String(s.id ?? `srv-text-${i}`),
              content: String(s.content || ''),
              backgroundColor: String(s.backgroundColor || s.background || '#000000'),
              textColor: String(s.textColor || s.color || '#FFFFFF'),
              uploadDate: at,
              isPrivate: isPriv(s),
              views: num(s.views),
              likes: num(s.likes),
              comments: num(s.comments),
              shares: num(s.shares),
              expiresAt: new Date(at.getTime() + 24 * 60 * 60 * 1000),
            };
          });
        const moments: UploadedMoment[] = (d.moments || [])
          .map((m: any, i: number) => {
            const isVid = lower(m.mediaType) === 'video' || !!m.videoUrl;
            return {
              id: String(m.id ?? `srv-moment-${i}`),
              fileName: '',
              fileSize: 0,
              thumbnail: String(m.thumbnail || ''),
              mediaType: (isVid ? 'video' : 'image') as 'image' | 'video',
              videoUrl: String(m.videoUrl || ''),
              publicId: String(m.publicId || ''),
              resourceType: String(m.resourceType || ''),
              content: String(m.content || ''),
              uploadDate: toDate(m.createdAt || m.created_at),
              isPrivate: isPriv(m),
              views: num(m.views),
              likes: num(m.likes),
              comments: num(m.comments),
            };
          });
        const thoughts: UploadedThought[] = (d.thoughts || [])
          .map((t: any, i: number) => {
            const mediaArr = Array.isArray(t.media) ? t.media : [];
            const firstMedia = mediaArr[0] as { type?: string; url?: string; thumbnail?: string } | undefined;
            const videoUrl = firstMedia?.type === 'video' ? String(firstMedia.url || '') : String(t.videoUrl || '');
            const image = firstMedia && firstMedia.type !== 'video'
              ? String(firstMedia.url || firstMedia.thumbnail || '')
              : String(t.image || t.image_url || t.thumbnail || '');
            const mediaUrl = String(t.mediaUrl || videoUrl || image || '');
            return {
              id: String(t.id ?? `srv-thought-${i}`),
              content: String(t.content || ''),
              hasMedia: !!(mediaUrl || t.thumbnail),
              mediaType: (videoUrl ? 'video' : mediaUrl ? 'image' : undefined) as 'image' | 'video' | undefined,
              mediaUrl: mediaUrl || undefined,
              thumbnail: String(t.thumbnail || image || '') || undefined,
              publicId: String(t.publicId || ''),
              resourceType: String(t.resourceType || ''),
              uploadDate: toDate(t.createdAt || t.created_at),
              isPrivate: isPriv(t),
              views: num(t.views),
              likes: num(t.likes ?? t.likes_count),
              comments: num(t.comments ?? t.comments_count),
              shares: num(t.shares ?? t.shares_count),
              reacts: num(t.reacts ?? t.reacts_count),
            };
          });
        if (cancelled) return;
        function mergeById<T extends { id: string }>(prev: T[], incoming: T[]): T[] {
          if (!incoming.length) return prev;
          const seen = new Set(prev.map((x) => x.id));
          return [...prev, ...incoming.filter((x) => !seen.has(x.id))];
        }
        setUploadedVideos((prev) => mergeById(prev, videos));
        setUploadedPhotos((prev) => mergeById(prev, photos));
        setUploadedStories((prev) => mergeById(prev, stories));
        setUploadedTextStories((prev) => mergeById(prev, textStories));
        setUploadedMoments((prev) => mergeById(prev, moments));
        setUploadedThoughts((prev) => mergeById(prev, thoughts));
        if (videos.length + photos.length + stories.length + moments.length + thoughts.length + textStories.length > 0) {
          setShowContentManagement(true);
        }
      } catch {
        /* offline: session items still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Type definitions for scheduled and draft posts
  interface ScheduledPost {
    id: string;
    type: string;
    content: any;
    scheduledTime: Date;
    status: 'scheduled' | 'posted' | 'failed';
  }

  interface DraftPost {
    id: string;
    type: string;
    content: any;
    createdAt: Date;
  }

  interface UploadedVideo {
    id: string;
    title: string;
    fileName: string;
    fileSize: number;
    duration: string;
    thumbnail: string;
    videoUrl?: string;
    publicId?: string;
    resourceType?: string;
    uploadDate: Date;
    isPrivate: boolean;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    watchTime: number;
    engagement: number;
  }

  interface UploadedStory {
    id: string;
    type: 'image' | 'video';
    fileName: string;
    fileSize: number;
    duration?: string;
    thumbnail: string;
    publicId?: string;
    resourceType?: string;
    uploadDate: Date;
    isPrivate: boolean;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    expiresAt: Date;
  }

  interface UploadedThought {
    id: string;
    content: string;
    hasMedia: boolean;
    mediaType?: 'image' | 'video';
    mediaUrl?: string;
    thumbnail?: string;
    publicId?: string;
    resourceType?: string;
    uploadDate: Date;
    isPrivate: boolean;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    reacts: number;
  }

  interface UploadedPhoto {
    id: string;
    fileName: string;
    fileSize: number;
    thumbnail: string;
    caption: string;
    mediaType?: 'image' | 'video';
    videoUrl?: string;
    duration?: number;
    publicId?: string;
    resourceType?: string;
    uploadDate: Date;
    isPrivate: boolean;
    views: number;
    likes: number;
    comments: number;
    shares: number;
  }

  interface UploadedMoment {
    id: string;
    fileName: string;
    fileSize: number;
    thumbnail: string;
    mediaType?: 'image' | 'video';
    videoUrl?: string;
    publicId?: string;
    resourceType?: string;
    content: string;
    uploadDate: Date;
    isPrivate: boolean;
    views: number;
    likes: number;
    comments: number;
  }

  interface UploadedTextStory {
    id: string;
    content: string;
    backgroundColor: string;
    textColor: string;
    uploadDate: Date;
    isPrivate: boolean;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    expiresAt: Date;
  }

  function getThumbnailFromUpload(result: { secureUrl: string; resourceType: string; variants?: { thumbnail?: string } | null } | null | undefined): string {
  if (!result?.secureUrl) return '';
  // Server-computed thumbnail wins when available.
  if (result.variants?.thumbnail) return result.variants.thumbnail;
  if (result.resourceType === 'image') return result.secureUrl;
  // Hosted video: derive a lightweight poster when the URL pattern allows
  // it — otherwise return '' so UI falls back to the <video> element.
  if (result.secureUrl.includes('res.cloudinary.com/')) {
    return result.secureUrl.replace('/video/upload/', '/video/upload/w_400,f_auto/').replace(/\.[^.]+$/, '.jpg');
  }
  return '';
}

// Shared helper: persist content to API, index for search, update localStorage, notify other pages
// STRICT type routing: each type is written to exactly ONE collection so a
// photo can never leak into Moments and a moment never leaks into Thoughts.
  async function persistContent(content: Record<string, unknown>) {
    // Real author identity: profile edits (name/avatar) are stamped onto
    // every upload so feeds show the authentic user, never a stale name.
    const author = getCurrentAuthor();
    const postData = {
      ...content,
      userId: author.userId,
      user: (content.user as string) || author.username,
      creator: (content.creator as string) || author.username,
      avatar: (content.avatar as string) || author.avatar,
      // Per-upload audience chosen in the UI; the server enforces it for
      // every account on every device (private accounts default sensibly).
      visibility: (content.visibility as string) || contentVisibility,
      time: 'just now',
      createdAt: new Date().toISOString(),
    };
    const type = (content.type as string) || 'post';
    // Surface the API result so callers can surface auth/quota errors instead
    // of silently showing "success" while only localStorage was updated.
    let persistError: string | null = null;
    try {
      if (type === 'story' || type === 'text-story') {
        const { error } = await api.createStory(postData);
        if (error) persistError = error;
      } else if (type === 'thought') {
        const { error } = await api.createThought(postData);
        if (error) persistError = error;
      } else if (type === 'moment') {
        const { error } = await api.createMoment(postData);
        if (error) persistError = error;
      } else {
        const { error } = await api.createPost(postData);
        if (error) persistError = error;
      }
      if (!persistError) markHasRealContent();
      else console.error('Failed to persist to API:', persistError);
    } catch (err) {
      persistError = err instanceof Error ? err.message : 'persist failed';
      console.error('Failed to persist to API:', err);
    }
    try {
      // Index with full media so Discover/Search/Thoughts render correctly.
      // thumbnail stays an IMAGE (never a video URL); videoUrl/imageUrl carry
      // the playable/full-res assets separately.
      const thumbCandidate = (content.thumbnail || content.image || '') as string;
      const mediaStr = typeof content.media === 'string' ? (content.media as string) : '';
      const { error: indexError } = await api.indexContent({
        id: content.id as string,
        title: ((content.content as string)?.slice(0, 60) || (content.title as string)?.slice(0, 60) || type) as string,
        description: (content.content as string)?.slice(0, 120) || '',
        type: (type === 'text-story' ? 'story' : type === 'photo' ? 'photo' : type === 'video' ? 'video' : type) as any,
        creator: postData.user,
        creatorAvatar: (content.avatar as string) || '',
        views: '0',
        thumbnail: thumbCandidate || mediaStr,
        videoUrl: (content.videoUrl as string) || '',
        imageUrl: ((content.image as string) || mediaStr || thumbCandidate || '') as string,
        category: (content.category as string) || 'general',
        tags: (content.tags as string[]) || [],
        visibility: (postData as Record<string, unknown>).visibility as string,
        publishedAt: new Date().toISOString(),
        content: (content.content as string) || '',
      });
      if (indexError) {
        persistError = persistError || indexError;
        console.error('Failed to index content:', indexError);
      }
      // Also index the user profile for search discoverability
      const savedProfile = localStorage.getItem('userProfile');
      if (savedProfile) {
        const profile = JSON.parse(savedProfile);
        if (profile.name || profile.username) {
          await api.indexContent({
            id: 'profile-' + (profile.id || userInfo.userId),
            title: profile.name || profile.username || postData.user,
            description: profile.bio || '',
            type: 'post',
            creator: profile.name || profile.username || postData.user,
            creatorAvatar: profile.avatar || '',
            views: '0',
            thumbnail: profile.avatar || '',
            category: 'profile',
            tags: ['profile', (profile.name || '').toLowerCase(), (profile.username || '').toLowerCase(), postData.user.toLowerCase()],
            publishedAt: new Date().toISOString(),
            content: profile.bio || '',
          });
        }
      }
    } catch (err) { console.error('Failed to index content:', err); }
    try {
      const savedProfile = localStorage.getItem('userProfile');
      const profile = savedProfile
        ? JSON.parse(savedProfile)
        : {
            _userEmail: author.userId,
            id: author.userId,
            name: author.username,
            username: author.username,
            avatar: author.avatar,
            bio: '',
            followers: 0,
            following: 0,
            posts: [],
          };
      // Preserve full-res image SEPARATELY from video so previews never crop
      // and a video URL is never rendered inside an <img>.
      const videoUrlStr = (content.videoUrl as string) || '';
      const mediaStr = typeof content.media === 'string' ? (content.media as string) : '';
      const imageStr = (content.image as string) || '';
      const thumbStr = (content.thumbnail as string) || '';
      const isVideo = content.mediaType === 'video' || type === 'video' || !!videoUrlStr;
      // For photos: image/media/thumbnail all carry the FULL image URL.
      // For videos: videoUrl/media carry the playable URL, thumbnail the poster.
      const fullImage = imageStr || (!isVideo ? (mediaStr || thumbStr) : '') || '';
      const fullThumb = thumbStr || fullImage || '';
      const fullMedia = isVideo ? (videoUrlStr || mediaStr) : (fullImage || mediaStr);
      profile.posts = [{
        id: content.id,
        user: postData.user,
        avatar: (content.avatar as string) || (postData.avatar as string) || '',
        time: 'just now',
        content: (content.content as string) || '',
        image: fullImage || fullMedia,
        media: content.media ?? fullMedia,
        thumbnail: fullThumb || (fullMedia as string),
        videoUrl: videoUrlStr,
        mediaType: (content.mediaType as string) || (isVideo ? 'video' : 'image'),
        duration: (content.duration as number) || 0,
        publicId: (content.publicId as string) || '',
        resourceType: (content.resourceType as string) || '',
        likes: 0,
        comments: 0,
        shares: 0,
        type,
        createdAt: new Date().toISOString(),
      }, ...(profile.posts || [])];
      localStorage.setItem('userProfile', JSON.stringify(profile));
    } catch (err) { console.error('Failed to update localStorage profile:', err); }
    // Invalidate search cache so new content appears immediately on EVERY
    // surface (ForYou, Following, Discover, Moments, Thoughts).
    broadcastPostCreated(postData, type);
    return persistError;
  }

  const handleFileUpload = async (files: FileList | null, type: string) => {
    if (!files || files.length === 0) return;

    const file = files[0];

    switch (type) {
      case 'story':
        if (files.length > 0) {
          const validFiles = Array.from(files).filter(file => {
            const isValidType = file.type.startsWith('image/') || file.type.startsWith('video/');
            const isValidSize = file.size <= 50 * 1024 * 1024; // 50MB limit
            if (!isValidType) {
              showError('Please select only images or videos');
              return false;
            }
            if (!isValidSize) {
              showError('File size must be less than 50MB');
              return false;
            }
            return true;
          });
          setStoryFiles(validFiles);
        }
        break;

      case 'thought':
        if (file.type.startsWith('video/') || file.type.startsWith('image/')) {
          if (file.type.startsWith('video/')) {
            // Check video duration (helper returns { valid, error }).
            const durationCheck = await validateVideoDuration(file);
            const validDuration = typeof durationCheck === 'boolean' ? durationCheck : durationCheck.valid;
            const durationError = typeof durationCheck === 'object' ? durationCheck.error : undefined;
            if (!validDuration) {
              showError(durationError || 'Video must be less than 5 minutes long');
              return;
            }
            
            // Also check file size (reasonable limit for 5-minute video)
            const isValidSize = file.size <= 300 * 1024 * 1024; // 300MB limit
            if (!isValidSize) {
              showError('Video size must be less than 300MB');
              return;
            }
            
            setThoughtVideo(file);
          } else {
            // Image validation
            const isValidSize = file.size <= 50 * 1024 * 1024; // 50MB for images/GIFs
            if (isValidSize) {
              setThoughtVideo(file);
            } else {
              showError('Image/GIF must be less than 50MB');
            }
          }
        } else {
          showError('Please select a video, photo, or GIF');
        }
        break;


      case 'photo':
        if (file.type.startsWith('image/')) {
          const validPhotos = Array.from(files).filter(file => {
            const isValidType = file.type.startsWith('image/');
            const isValidSize = file.size <= 50 * 1024 * 1024; // 50MB limit
            if (!isValidType) {
              showError('Please select only images');
              return false;
            }
            if (!isValidSize) {
              showError('Image size must be less than 50MB');
              return false;
            }
            return true;
          });
          setPhotoFiles(validPhotos);
        } else {
          showError('Please select images only');
        }
        break;

      case 'video':
        if (file.type.startsWith('video/')) {
          const validVideos = Array.from(files).filter(file => {
            const isValidType = file.type.startsWith('video/');
            const isValidSize = file.size <= 500 * 1024 * 1024; // 500MB limit for longer videos
            if (!isValidType) {
              showError('Please select only videos');
              return false;
            }
            if (!isValidSize) {
              showError('Video size must be less than 500MB');
              return false;
            }
            return true;
          });
          setVideoFiles(validVideos);
        } else {
          showError('Please select videos only');
        }
        break;

      case 'moment':
        if (files.length > 0) {
          const validFiles = Array.from(files).filter(file => {
            const isValidType = file.type.startsWith('image/') || file.type.startsWith('video/');
            const isValidSize = file.size <= 100 * 1024 * 1024;
            if (!isValidType) {
              showError('Please select only images or videos');
              return false;
            }
            if (!isValidSize) {
              showError('File size must be less than 100MB');
              return false;
            }
            return true;
          });
          setMomentFiles(validFiles);
        }
        break;
    }
  };

  const handleRemoveFile = (index: number, type: string) => {
    switch (type) {
      case 'story':
        // A cover cannot outlive its media: dropping the last file drops the cover too.
        setStoryFiles(prev => {
          const next = prev.filter((_, i) => i !== index);
          if (next.length === 0) clearStoryThumb();
          return next;
        });
        break;
      case 'thought':
        setThoughtVideo(null);
        clearThoughtThumb();
        break;

      case 'photo':
        setPhotoFiles(prev => prev.filter((_, i) => i !== index));
        break;

      case 'video':
        setVideoFiles(prev => {
          const next = prev.filter((_, i) => i !== index);
          if (next.length === 0) clearVideoThumb();
          return next;
        });
        break;

      case 'moment':
        setMomentFiles(prev => {
          const next = prev.filter((_, i) => i !== index);
          if (next.length === 0) clearMomentThumb();
          return next;
        });
        break;
    }
  };

  const handlePostStory = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    if (storyFiles.length === 0) {
      showError('Please select at least one file for your story');
      return;
    }

    const storyContent = {
      files: storyFiles,
      caption: (document.getElementById('story-caption') as HTMLTextAreaElement)?.value || ''
    };

    switch (action) {
      case 'post':
        setIsUploading(true);
        const uploadedStoryResults = await Promise.all(
          storyFiles.map(async (file) => {
            try {
              const uploadFile = file.type.startsWith('image/') ? await compressImage(file) : file;
              const { data, error } = await api.uploadFile(uploadFile, 'equyvo/stories');
              if (error) throw new Error(error);
              return { file, result: data };
            } catch (err) {
              showError(`Upload failed for ${file.name}`);
            }
            return { file, result: null };
          })
        );

        // Robust pairing: only media that actually uploaded gets persisted.
        // Failed files are left selected for retry and no orphan cover-only
        // story is ever created.
        const storySuccesses = uploadedStoryResults.filter(
          (r): r is { file: File; result: NonNullable<typeof r.result> } => !!r.result,
        );
        if (storySuccesses.length === 0) {
          setIsUploading(false);
          showError('Story upload failed — no cover was posted without its media.');
          break;
        }
        // The custom cover is uploaded only now that its media exists.
        const storyCustomThumb = await uploadPendingThumb(storyThumbFile);
        const newUploadedStories: UploadedStory[] = storySuccesses.map(({ file, result }, index) => ({
          id: Date.now().toString() + index,
          type: file.type.startsWith('image/') ? 'image' : 'video',
          fileName: file.name,
          fileSize: file.size,
          duration: file.type.startsWith('video/') ? '0:15' : undefined,
          thumbnail: storyCustomThumb || getThumbnailFromUpload(result),
          publicId: result?.publicId || '',
          resourceType: result?.resourceType || '',
          uploadDate: new Date(),
          isPrivate: contentVisibility !== 'public',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }));

        setUploadedStories(prev => [...prev, ...newUploadedStories]);
        let storyPersistError: string | null = null;
        for (let i = 0; i < newUploadedStories.length; i++) {
          const s = newUploadedStories[i];
          const secureUrl = storySuccesses[i]?.result?.secureUrl || '';
          if (!secureUrl) continue;
          const isVid = s.type === 'video';
          const err = await persistContent({
            id: s.id,
            type: 'story',
            content: (document.getElementById('story-caption') as HTMLTextAreaElement)?.value || '',
            image: isVid ? '' : secureUrl,
            media: secureUrl,
            thumbnail: s.thumbnail || secureUrl,
            videoUrl: isVid ? secureUrl : '',
            mediaType: isVid ? 'video' : 'image',
            publicId: s.publicId,
            resourceType: s.resourceType,
            user: getCurrentAuthor().username,
            avatar: getCurrentAuthor().avatar,
          });
          if (err) storyPersistError = err;
        }
        setIsUploading(false);
        if (storyPersistError) {
          showError('Saved locally but feed sync failed: ' + storyPersistError);
        } else if (storySuccesses.length < uploadedStoryResults.length) {
          showSuccess(`${storySuccesses.length} story item(s) posted; failed files were kept for retry.`);
        } else {
          showSuccess('Story posted successfully! It will be available for 24 hours.');
        }
        // Keep failed files selected for retry; the consumed cover is cleared.
        setStoryFiles(prev => prev.filter(f => !storySuccesses.some(s => s.file === f)));
        clearStoryThumb();

        window.dispatchEvent(new CustomEvent('storyUploaded', { detail: newUploadedStories }));
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledStory: ScheduledPost = {
          id: Date.now().toString(),
          type: 'story',
          content: storyContent,
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledStory]);
        showSuccess('Story scheduled successfully!');
        setStoryFiles([]);
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftStory: DraftPost = {
          id: Date.now().toString(),
          type: 'story',
          content: storyContent,
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftStory]);
        showSuccess('Story saved as draft!');
        break;
    }
  };

  const handlePostTextStory = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    if (!textStoryContent.trim()) {
      showError('Please enter some text for your story');
      return;
    }

    const textStoryData = {
      content: textStoryContent,
      background: textStoryBackground,
      color: textStoryColor
    };

    switch (action) {
      case 'post':
        // Add text story to uploaded text stories list with analytics
        const newUploadedTextStory: UploadedTextStory = {
          id: Date.now().toString(),
          content: textStoryContent,
          backgroundColor: textStoryBackground,
          textColor: textStoryColor,
          uploadDate: new Date(),
          isPrivate: contentVisibility !== 'public',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours from now
        };

        setUploadedTextStories(prev => [...prev, newUploadedTextStory]);
        const textStoryErr = await persistContent({ id: newUploadedTextStory.id, type: 'text-story', content: newUploadedTextStory.content, thumbnail: '', image: '' });
        if (textStoryErr) {
          showError('Saved locally but feed sync failed: ' + textStoryErr);
        } else {
          showSuccess('Text story posted successfully! It will be available for 24 hours.');
        }
        setTextStoryContent('');
        setTextStoryBackground('#000000');
        setTextStoryColor('#FFFFFF');
        
        // Emit event to notify HomePage that user has uploaded stories
        window.dispatchEvent(new CustomEvent('storyUploaded', { detail: [newUploadedTextStory] }));
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledTextStory: ScheduledPost = {
          id: Date.now().toString(),
          type: 'text-story',
          content: textStoryData,
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledTextStory]);
        showSuccess('Text story scheduled successfully!');
        setTextStoryContent('');
        setTextStoryBackground('#000000');
        setTextStoryColor('#FFFFFF');
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftTextStory: DraftPost = {
          id: Date.now().toString(),
          type: 'text-story',
          content: textStoryData,
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftTextStory]);
        showSuccess('Text story saved as draft!');
        break;
    }
  };

  const handlePostThought = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    if (!thoughtContent.trim()) {
      showError('Please enter your thought');
      return;
    }

    const thoughtData = {
      content: thoughtContent,
      video: thoughtVideo
    };

    switch (action) {
      case 'post':
        setIsUploading(true);
        let thoughtUploadResult: { secureUrl: string; resourceType: string; publicId?: string; variants?: { thumbnail?: string } | null } | null = null;
        if (thoughtVideo) {
          try {
            const uploadFile = thoughtVideo.type.startsWith('image/') ? await compressImage(thoughtVideo) : thoughtVideo;
            const { data, error } = await api.uploadFile(uploadFile, 'equyvo/thoughts');
            if (error) throw new Error(error);
            thoughtUploadResult = { secureUrl: data!.secureUrl, resourceType: data!.resourceType, publicId: data!.publicId || undefined, variants: data!.variants };
          } catch (err) {
            showError('Upload failed for thought media');
          }
        }

        let thoughtThumbnail = getThumbnailFromUpload(thoughtUploadResult);
        // The thumbnail is uploaded only when there is real thought media:
        // a cover can never be posted without its photo/video.
        const thoughtMediaType = thoughtVideo?.type.startsWith('image/') ? 'image' : thoughtVideo?.type.startsWith('video/') ? 'video' : undefined;
        const thoughtSecureUrl = thoughtUploadResult?.secureUrl || '';
        if (thoughtVideo && !thoughtSecureUrl) {
          setIsUploading(false);
          showError('Thought media upload failed — nothing was posted without its media.');
          break;
        }
        const thoughtCustomThumb = await uploadPendingThumb(thoughtVideo ? thoughtThumbFile : null);
        if (thoughtCustomThumb) thoughtThumbnail = thoughtCustomThumb;
        // Videos without a server poster get one captured client-side so the
        // Thoughts feed still shows a preview (never a blank card).
        if (thoughtVideo?.type.startsWith('video/') && !thoughtThumbnail) {
          try {
            const poster = await captureVideoPoster(thoughtVideo);
            if (poster) thoughtThumbnail = poster;
          } catch { /* poster is best-effort */ }
        }
        const newUploadedThought: UploadedThought = {
          id: Date.now().toString(),
          content: thoughtContent,
          hasMedia: !!thoughtVideo,
          mediaType: thoughtMediaType,
          mediaUrl: thoughtSecureUrl || (thoughtVideo ? '' : undefined),
          thumbnail: thoughtThumbnail || thoughtSecureUrl || undefined,
          publicId: thoughtUploadResult?.publicId || '',
          resourceType: thoughtUploadResult?.resourceType || '',
          uploadDate: new Date(),
          isPrivate: contentVisibility !== 'public',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          reacts: 0
        };

        setUploadedThoughts(prev => [...prev, newUploadedThought]);
        // Preserve the playable URL + ThoughtsPage media array. Without this
        // the thought text saved but its photo/video never rendered.
        const thoughtMediaArray = thoughtSecureUrl && thoughtMediaType
          ? [{ type: thoughtMediaType === 'video' ? 'video' : thoughtVideo?.type === 'image/gif' ? 'gif' : 'photo', url: thoughtSecureUrl, thumbnail: thoughtThumbnail || thoughtSecureUrl }]
          : undefined;
        const persistErr = await persistContent({
          id: newUploadedThought.id,
          type: 'thought',
          content: newUploadedThought.content,
          image: thoughtMediaType === 'video' ? '' : (thoughtSecureUrl || thoughtThumbnail),
          thumbnail: thoughtThumbnail || thoughtSecureUrl,
          media: thoughtMediaArray ?? thoughtSecureUrl,
          mediaUrl: thoughtSecureUrl || undefined,
          videoUrl: thoughtMediaType === 'video' ? thoughtSecureUrl : '',
          mediaType: thoughtMediaType,
          image_url: thoughtMediaType === 'video' ? '' : (thoughtSecureUrl || thoughtThumbnail),
          publicId: newUploadedThought.publicId,
          resourceType: newUploadedThought.resourceType,
        });
        setIsUploading(false);
        if (persistErr) {
          showError('Thought saved locally but feed sync failed: ' + persistErr);
        } else {
          showSuccess('Thought posted successfully!');
        }
        setThoughtContent('');
        setThoughtVideo(null);
        clearThoughtThumb();
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledThought: ScheduledPost = {
          id: Date.now().toString(),
          type: 'thought',
          content: thoughtData,
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledThought]);
        showSuccess('Thought scheduled successfully!');
        setThoughtContent('');
        setThoughtVideo(null);
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftThought: DraftPost = {
          id: Date.now().toString(),
          type: 'thought',
          content: thoughtData,
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftThought]);
        showSuccess('Thought saved as draft!');
        break;
    }
  };

  const handlePostPhotos = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    if (photoFiles.length === 0) {
      showError('Please select at least one photo');
      return;
    }

    const photosData = {
      files: photoFiles,
      caption: photoCaption
    };

    switch (action) {
      case 'post':
        setIsUploading(true);
        const uploadedPhotoResults = await Promise.all(
          photoFiles.map(async (file) => {
            try {
              const uploadFile = file.type.startsWith('image/') ? await compressImage(file) : file;
              const { data, error } = await api.uploadFile(uploadFile, 'equyvo/photos');
              if (error) throw new Error(error);
              return { file, result: data };
            } catch (err) {
              showError(`Upload failed for ${file.name}`);
            }
            return { file, result: null };
          })
        );

        // Only photos that actually uploaded are persisted — failed files stay
        // selected for retry and no media-less item is ever created.
        const photoSuccesses = uploadedPhotoResults.filter(
          (r): r is { file: File; result: NonNullable<typeof r.result> } => !!r.result,
        );
        if (photoSuccesses.length === 0) {
          setIsUploading(false);
          showError('Photo upload failed — nothing was posted without its media.');
          break;
        }
        const newUploadedPhotos: UploadedPhoto[] = photoSuccesses.map(({ file, result }, index) => ({
          id: Date.now().toString() + index,
          fileName: file.name,
          fileSize: file.size,
          thumbnail: getThumbnailFromUpload(result) || (result?.secureUrl && file.type.startsWith('image/') ? result.secureUrl : ''),
          caption: photoCaption,
          mediaType: file.type.startsWith('video/') ? 'video' : 'image',
          videoUrl: file.type.startsWith('video/') ? result?.secureUrl || '' : '',
          duration: result?.duration,
          publicId: result?.publicId || '',
          resourceType: result?.resourceType || '',
          uploadDate: new Date(),
          isPrivate: contentVisibility !== 'public',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0
        }));

        setUploadedPhotos(prev => [...prev, ...newUploadedPhotos]);
        let photoPersistError: string | null = null;
        for (let i = 0; i < newUploadedPhotos.length; i++) {
          const p = newUploadedPhotos[i];
          // Full-res URL straight from the upload result — never the cropped thumbnail.
          const secureUrl = photoSuccesses[i]?.result?.secureUrl || '';
          if (!secureUrl) continue;
          const err = await persistContent({
            id: p.id,
            type: p.mediaType === 'video' ? 'video' : 'photo',
            content: p.caption,
            image: p.mediaType === 'video' ? '' : secureUrl,
            media: secureUrl,
            thumbnail: p.thumbnail || secureUrl,
            videoUrl: p.videoUrl,
            mediaType: p.mediaType,
            duration: p.duration,
            publicId: p.publicId,
            resourceType: p.resourceType,
          });
          if (err) photoPersistError = err;
        }
        setIsUploading(false);
        if (photoPersistError) {
          showError('Saved locally but feed sync failed: ' + photoPersistError);
        } else if (photoSuccesses.length < uploadedPhotoResults.length) {
          showSuccess(`${photoSuccesses.length} photo(s) posted; failed files were kept for retry.`);
        } else {
          showSuccess(`${photoSuccesses.length} photo(s) posted successfully!`);
        }
        // Keep failed files selected for retry.
        setPhotoFiles(prev => prev.filter(f => !photoSuccesses.some(s => s.file === f)));
        setPhotoCaption('');
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledPhotos: ScheduledPost = {
          id: Date.now().toString(),
          type: 'photos',
          content: photosData,
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledPhotos]);
        showSuccess(`${photoFiles.length} photo(s) scheduled successfully!`);
        setPhotoFiles([]);
        setPhotoCaption('');
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftPhotos: DraftPost = {
          id: Date.now().toString(),
          type: 'photos',
          content: photosData,
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftPhotos]);
        showSuccess(`${photoFiles.length} photo(s) saved as draft!`);
        break;
    }
  };

  const handlePostVideos = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    if (videoFiles.length === 0) {
      showError('Please select at least one video');
      return;
    }

    const videosData = {
      files: videoFiles,
      caption: videoCaption
    };

    switch (action) {
      case 'post':
        setIsUploading(true);
        const uploadedVideoResults = await Promise.all(
          videoFiles.map(async (file) => {
            try {
              const uploadFile = file.type.startsWith('image/') ? await compressImage(file) : file;
              const { data, error } = await api.uploadFile(uploadFile, 'equyvo/videos');
              if (error) throw new Error(error);
              return { file, result: data };
            } catch (err) {
              showError(`Upload failed for ${file.name}`);
            }
            return { file, result: null };
          })
        );

        // Only videos that actually uploaded are persisted — failed files are
        // kept selected for retry and no thumbnail-only item is ever created.
        const videoSuccesses = uploadedVideoResults.filter(
          (r): r is { file: File; result: NonNullable<typeof r.result> } => !!r.result,
        );
        if (videoSuccesses.length === 0) {
          setIsUploading(false);
          showError('Video upload failed — no thumbnail was posted without its video.');
          break;
        }
        // Custom thumbnail from the separate section wins (uploaded only now
        // that its video media exists).
        const videoCustomThumb = await uploadPendingThumb(videoThumbFile);

        // Client posters for videos that arrived without a thumbnail.
        const videoPosters = await Promise.all(
          videoSuccesses.map(async ({ file, result }) => {
            const t = getThumbnailFromUpload(result);
            if (t) return t;
            try {
              const poster = await captureVideoPoster(file);
              return poster || '';
            } catch { return ''; }
          })
        );
        const newUploadedVideos: UploadedVideo[] = videoSuccesses.map(({ file, result }, index) => ({
          id: Date.now().toString() + index,
          title: videoCaption || file.name,
          fileName: file.name,
          fileSize: file.size,
          duration: result?.duration ? `${Math.floor(result.duration / 60)}:${String(Math.floor(result.duration % 60)).padStart(2, '0')}` : '0:00',
          thumbnail: videoCustomThumb || videoPosters[index] || getThumbnailFromUpload(result),
          videoUrl: result?.secureUrl || '',
          publicId: result?.publicId || '',
          resourceType: result?.resourceType || '',
          uploadDate: new Date(),
          isPrivate: contentVisibility !== 'public',
          views: 0,
          likes: 0,
          comments: 0,
          shares: 0,
          watchTime: 0,
          engagement: 0
        }));

        setUploadedVideos(prev => [...prev, ...newUploadedVideos]);
        let videoPersistError: string | null = null;
        for (const v of newUploadedVideos) {
          if (!v.videoUrl) continue;
          const err = await persistContent({ id: v.id, type: 'video', content: v.title, image: '', media: v.videoUrl, thumbnail: v.thumbnail, videoUrl: v.videoUrl, mediaType: 'video', publicId: v.publicId, resourceType: v.resourceType });
          if (err) videoPersistError = err;
        }
        setIsUploading(false);
        if (videoPersistError) {
          showError('Saved locally but feed sync failed: ' + videoPersistError);
        } else if (videoSuccesses.length < uploadedVideoResults.length) {
          showSuccess(`${videoSuccesses.length} video(s) posted; failed files were kept for retry.`);
        } else {
          showSuccess(`${videoSuccesses.length} video(s) posted successfully!`);
        }
        // Keep failed files selected for retry; the consumed thumbnail is cleared.
        setVideoFiles(prev => prev.filter(f => !videoSuccesses.some(s => s.file === f)));
        setVideoCaption('');
        clearVideoThumb();
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledVideos: ScheduledPost = {
          id: Date.now().toString(),
          type: 'videos',
          content: videosData,
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledVideos]);
        showSuccess(`${videoFiles.length} video(s) scheduled successfully!`);
        setVideoFiles([]);
        setVideoCaption('');
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftVideos: DraftPost = {
          id: Date.now().toString(),
          type: 'videos',
          content: videosData,
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftVideos]);
        showSuccess(`${videoFiles.length} video(s) saved as draft!`);
        break;
    }
  };

  const handlePostLive = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    switch (action) {
      case 'post':
        if (!liveTitle.trim()) {
          showError('Please enter a title for your live stream');
          return;
        }
        await handleStartLive();
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledLive: ScheduledPost = {
          id: Date.now().toString(),
          type: 'live',
          content: { title: liveTitle, description: liveDescription },
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledLive]);
        showSuccess('Live stream scheduled successfully!');
        setLiveTitle('');
        setLiveDescription('');
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftLive: DraftPost = {
          id: Date.now().toString(),
          type: 'live',
          content: { title: liveTitle, description: liveDescription },
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftLive]);
        showSuccess('Live stream saved as draft!');
        break;
    }
  };

  const handlePostMoment = async (action: 'post' | 'schedule' | 'draft' = 'post') => {
    if (momentFiles.length === 0) {
      showError('Please select at least one photo or video');
      return;
    }

    const momentsData = { files: momentFiles, content: momentContent };

    switch (action) {
      case 'post':
        setIsUploading(true);
        const uploadedResults = await Promise.all(
          momentFiles.map(async (file) => {
            try {
              const uploadFile = file.type.startsWith('image/') ? await compressImage(file) : file;
              const { data, error } = await api.uploadFile(uploadFile, 'equyvo/moments');
              if (error) throw new Error(error);
              return { file, result: data };
            } catch (err) {
              showError(`Upload failed for ${file.name}`);
            }
            return { file, result: null };
          })
        );

        // Only moment media that actually uploaded is persisted — failed files
        // stay selected for retry and no cover-only item is ever created.
        const momentSuccesses = uploadedResults.filter(
          (r): r is { file: File; result: NonNullable<typeof r.result> } => !!r.result,
        );
        if (momentSuccesses.length === 0) {
          setIsUploading(false);
          showError('Moment upload failed — no cover was posted without its media.');
          break;
        }
        // Custom cover from the separate thumbnail section wins (uploaded only
        // now that its moment media exists).
        const momentCustomThumb = await uploadPendingThumb(momentThumbFile);

        // Posters for video moments + full URLs for photo moments.
        const momentPosters = await Promise.all(
          momentSuccesses.map(async ({ file, result }) => {
            const t = getThumbnailFromUpload(result);
            if (t) return t;
            if (file.type.startsWith('video/')) {
              try {
                const poster = await captureVideoPoster(file);
                return poster || '';
              } catch { return ''; }
            }
            return result?.secureUrl || '';
          })
        );
        const newUploadedMoments: UploadedMoment[] = momentSuccesses.map(({ file, result }, index) => ({
          id: Date.now().toString() + index,
          fileName: file.name,
          fileSize: file.size,
          thumbnail: momentCustomThumb || momentPosters[index] || getThumbnailFromUpload(result) || (result?.secureUrl && file.type.startsWith('image/') ? result.secureUrl : ''),
          mediaType: file.type.startsWith('image/') ? 'image' : 'video',
          videoUrl: file.type.startsWith('video/') ? result?.secureUrl || '' : '',
          publicId: result?.publicId || '',
          resourceType: result?.resourceType || '',
          content: momentContent,
          uploadDate: new Date(),
          isPrivate: contentVisibility !== 'public',
          views: 0,
          likes: 0,
          comments: 0,
        }));

        setUploadedMoments(prev => [...prev, ...newUploadedMoments]);
        let momentPersistError: string | null = null;
        for (let i = 0; i < newUploadedMoments.length; i++) {
          const m = newUploadedMoments[i];
          const secureUrl = momentSuccesses[i]?.result?.secureUrl || '';
          if (!secureUrl) continue;
          // Photo moment: media/image/thumbnail = full image. Video moment:
          // media/videoUrl = playable URL, thumbnail = poster only.
          const err = await persistContent({
            id: m.id,
            type: 'moment',
            content: m.content,
            image: m.mediaType === 'video' ? '' : (secureUrl || m.thumbnail),
            media: m.mediaType === 'video' ? (m.videoUrl || secureUrl) : (secureUrl || m.thumbnail),
            thumbnail: m.thumbnail || secureUrl,
            mediaType: m.mediaType,
            videoUrl: m.videoUrl,
            publicId: m.publicId,
            resourceType: m.resourceType,
          });
          if (err) momentPersistError = err;
        }
        setIsUploading(false);
        if (momentPersistError) {
          showError('Saved locally but feed sync failed: ' + momentPersistError);
        } else if (momentSuccesses.length < uploadedResults.length) {
          showSuccess(`${momentSuccesses.length} moment(s) posted; failed files were kept for retry.`);
        } else {
          showSuccess(`${momentSuccesses.length} moment(s) posted successfully!`);
        }
        // Keep failed files selected for retry; the consumed cover is cleared.
        setMomentFiles(prev => prev.filter(f => !momentSuccesses.some(s => s.file === f)));
        setMomentContent('');
        clearMomentThumb();
        break;
      case 'schedule':
        if (!scheduleDateTime) {
          showError('Please select a date and time for scheduling');
          return;
        }
        const newScheduledMoments: ScheduledPost = {
          id: Date.now().toString(),
          type: 'moments',
          content: momentsData,
          scheduledTime: new Date(scheduleDateTime),
          status: 'scheduled'
        };
        setScheduledPosts(prev => [...prev, newScheduledMoments]);
        showSuccess(`${momentFiles.length} moment(s) scheduled successfully!`);
        setMomentFiles([]);
        setMomentContent('');
        setShowScheduleModal(false);
        setScheduleDateTime('');
        break;
      case 'draft':
        const newDraftMoments: DraftPost = {
          id: Date.now().toString(),
          type: 'moments',
          content: momentsData,
          createdAt: new Date()
        };
        setDraftPosts(prev => [...prev, newDraftMoments]);
        showSuccess(`${momentFiles.length} moment(s) saved as draft!`);
        break;
    }
  };

  const handleStartLive = async () => {
    if (!liveTitle.trim()) {
      showError('Please enter a title for your live stream');
      return;
    }

    try {
      setIsUploading(true);

      // Upload thumbnail if provided
      let liveThumbnailUrl = '';
      let liveThumbnailPublicId = '';
      let liveThumbnailResourceType = '';
      if (liveThumbnailFile) {
        try {
          const { data, error } = await api.uploadFile(liveThumbnailFile, 'equyvo/live/thumbnails');
          if (!error && data) {
            liveThumbnailUrl = data.secureUrl;
            liveThumbnailPublicId = data.publicId;
            liveThumbnailResourceType = data.resourceType;
          }
        } catch {
          showError('Failed to upload thumbnail');
        }
      }

      const author = getCurrentAuthor();

      // Create live content entry
      const liveId = Date.now().toString();
      const liveContent = {
        id: liveId,
        type: 'live',
        contentType: 'live',
        title: liveTitle,
        description: liveDescription,
        thumbnail: liveThumbnailUrl,
        publicId: liveThumbnailPublicId,
        resourceType: liveThumbnailResourceType,
        user: author.username,
        userId: author.userId,
        avatar: author.avatar,
        creator: author.username,
        isLive: true,
        live: true,
        time: 'just now',
        createdAt: new Date().toISOString(),
        views: 0,
        likes: 0,
        comments: 0,
      };

      // Persist the live content (warn, but still start locally on failure)
      const liveErr = await persistContent(liveContent);
      if (liveErr) {
        showError('Live announcement sync failed (other devices may not see it): ' + liveErr);
      }

      // Store active live stream info in localStorage for other pages
      localStorage.setItem('equyvo_active_live', JSON.stringify(liveContent));

      // Dispatch live notification event for followers
      window.dispatchEvent(new CustomEvent('userWentLive', {
        detail: liveContent
      }));

      // Store notification for followers to see
      const existingNotifs = JSON.parse(localStorage.getItem('equyvo_live_notifications') || '[]');
      existingNotifs.unshift({
        id: liveId,
        title: liveTitle,
        user: userInfo.username,
        thumbnail: liveThumbnailUrl || '',
        startedAt: new Date().toISOString(),
      });
      localStorage.setItem('equyvo_live_notifications', JSON.stringify(existingNotifs.slice(0, 20)));

      // Request camera and microphone permissions
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
      });

      setStream(mediaStream);

      // Initialize MediaRecorder
      const recorder = new MediaRecorder(mediaStream, {
        mimeType: 'video/webm;codecs=vp9'
      });

      const chunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        handleSaveRecording(blob);
      };

      setMediaRecorder(recorder);
      setRecordedChunks(chunks);

      // Start recording
      recorder.start();
      setIsRecording(true);
      setIsUploading(false);

      showSuccess('Live stream started! Followers have been notified.');

    } catch (error) {
      setIsUploading(false);
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          showError('Camera and microphone access denied. Please allow access to go live.');
        } else if (error.name === 'NotFoundError') {
          showError('No camera or microphone found. Please connect a device to go live.');
        } else {
          showError('Failed to access camera/microphone. Please check your device permissions.');
        }
      }
    }
  };

  const handleEndLive = async () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }

    setIsRecording(false);
    setMediaRecorder(null);
    setStream(null);

    // Clear active live stream
    localStorage.removeItem('equyvo_active_live');

    // Dispatch end live event
    window.dispatchEvent(new CustomEvent('userWentOffline', {
      detail: { title: liveTitle }
    }));

    showSuccess('Live stream ended and recording saved!');
    setLiveTitle('');
    setLiveDescription('');
    setLiveThumbnailFile(null);
    setLiveThumbnailPreview('');
  };

  const handleSaveRecording = async (blob: Blob) => {
    const file = new File([blob], `live-stream-${Date.now()}.webm`, { type: 'video/webm' });

    setIsUploading(true);
    let liveUploadResult: { secureUrl: string; publicId: string; resourceType: string; duration?: number } | null = null;
    try {
      const { data, error } = await api.uploadFile(file, 'equyvo/live');
      if (error) throw new Error(error);
      liveUploadResult = data!;
    } catch (err) {
      showError('Upload failed for live recording');
    }
    setIsUploading(false);

    const liveThumbnail = getThumbnailFromUpload(liveUploadResult);
    const newUploadedVideo: UploadedVideo = {
      id: Date.now().toString(),
      title: liveTitle || `Live Stream ${new Date().toLocaleString()}`,
      fileName: file.name,
      fileSize: file.size,
      duration: liveUploadResult?.duration
        ? `${Math.floor(liveUploadResult.duration / 60)}:${String(Math.floor(liveUploadResult.duration % 60)).padStart(2, '0')}`
        : '0:00',
      thumbnail: liveThumbnail,
      uploadDate: new Date(),
      isPrivate: contentVisibility !== 'public',
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      watchTime: 0,
      engagement: 0
    };

    setUploadedVideos(prev => [...prev, newUploadedVideo]);
    await persistContent({ id: newUploadedVideo.id, type: 'video', content: newUploadedVideo.title, image: liveThumbnail, thumbnail: liveThumbnail });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDeleteScheduledPost = (id: string) => {
    setScheduledPosts(prev => prev.filter(post => post.id !== id));
    showSuccess('Scheduled post deleted successfully!');
  };

  const handleDeleteDraftPost = (id: string) => {
    setDraftPosts(prev => prev.filter(post => post.id !== id));
    showSuccess('Draft deleted successfully!');
  };

  // Content management functions — every action hits the server first (the
  // owner-only source of truth) and updates local state only on success, so
  // deletes/privacy actually hold on every device and for every account.
  const handleDeleteVideo = async (id: string) => {
    try {
      await deleteContent({ postId: id, contentType: 'post' });
      setUploadedVideos(prev => prev.filter(video => video.id !== id));
    } catch { /* deleteContent already reported the failure */ }
  };

  const handleDeleteStory = async (id: string) => {
    try {
      await deleteContent({ postId: id, contentType: 'story' });
      setUploadedStories(prev => prev.filter(story => story.id !== id));
    } catch { /* already reported */ }
  };

  const handleDeleteThought = async (id: string) => {
    try {
      await deleteContent({ postId: id, contentType: 'thought' });
      setUploadedThoughts(prev => prev.filter(thought => thought.id !== id));
    } catch { /* already reported */ }
  };

  const handleDeletePhoto = async (id: string) => {
    try {
      await deleteContent({ postId: id, contentType: 'post' });
      setUploadedPhotos(prev => prev.filter(photo => photo.id !== id));
    } catch { /* already reported */ }
  };

  const handleDeleteMoment = async (id: string) => {
    try {
      await deleteContent({ postId: id, contentType: 'moment' });
      setUploadedMoments(prev => prev.filter(moment => moment.id !== id));
    } catch { /* already reported */ }
  };

  const handleDeleteTextStory = async (id: string) => {
    try {
      await deleteContent({ postId: id, contentType: 'story' });
      setUploadedTextStories(prev => prev.filter(textStory => textStory.id !== id));
    } catch { /* already reported */ }
  };

  const managementKindFor = (contentType: string): string => {
    switch (contentType) {
      case 'video':
      case 'photo':
        return 'post';
      case 'story':
      case 'text-story':
        return 'story';
      case 'thought':
        return 'thought';
      case 'moment':
      case 'moments':
        return 'moment';
      default:
        return 'post';
    }
  };

  const isCurrentlyPrivate = (contentType: string, id: string): boolean => {
    switch (contentType) {
      case 'video': return !!uploadedVideos.find(v => v.id === id)?.isPrivate;
      case 'story': return !!uploadedStories.find(s => s.id === id)?.isPrivate;
      case 'thought': return !!uploadedThoughts.find(t => t.id === id)?.isPrivate;
      case 'photo': return !!uploadedPhotos.find(p => p.id === id)?.isPrivate;
      case 'moment':
      case 'moments': return !!uploadedMoments.find(m => m.id === id)?.isPrivate;
      case 'text-story': return !!uploadedTextStories.find(t => t.id === id)?.isPrivate;
      default: return false;
    }
  };

  // Owner-only "hide from public": flips server visibility, then mirrors
  // locally. Reverts nothing on failure — local state only changes on success.
  const handleTogglePrivacy = async (contentType: string, id: string) => {
    const makePrivate = !isCurrentlyPrivate(contentType, id);
    const ok = await setContentVisibility(id, managementKindFor(contentType), makePrivate ? 'private' : 'public');
    if (!ok) return;
    switch (contentType) {
      case 'video':
        setUploadedVideos(prev => prev.map(video =>
          video.id === id ? { ...video, isPrivate: makePrivate } : video
        ));
        break;
      case 'story':
        setUploadedStories(prev => prev.map(story =>
          story.id === id ? { ...story, isPrivate: makePrivate } : story
        ));
        break;
      case 'thought':
        setUploadedThoughts(prev => prev.map(thought =>
          thought.id === id ? { ...thought, isPrivate: makePrivate } : thought
        ));
        break;
      case 'photo':
        setUploadedPhotos(prev => prev.map(photo =>
          photo.id === id ? { ...photo, isPrivate: makePrivate } : photo
        ));
        break;
      case 'moment':
      case 'moments':
        setUploadedMoments(prev => prev.map(moment =>
          moment.id === id ? { ...moment, isPrivate: makePrivate } : moment
        ));
        break;
      case 'text-story':
        setUploadedTextStories(prev => prev.map(textStory =>
          textStory.id === id ? { ...textStory, isPrivate: makePrivate } : textStory
        ));
        break;
    }
  };

  // ---- Custom thumbnails (upload a separate one, or adjust the current) ----
  // Works for videos, stories, photos and moments. The cropped image is
  // uploaded, then saved on the published post so feeds, profile and search
  // all show it. Live streams keep theirs locally until you go live.

  const patchLocalThumb = (id: string, url: string) => {
    try {
      const saved = localStorage.getItem('userProfile');
      if (!saved) return;
      const profile = JSON.parse(saved);
      if (!Array.isArray(profile.posts)) return;
      let changed = false;
      profile.posts = profile.posts.map((p: unknown) => {
        const post = p as Record<string, unknown>;
        if (post && String(post.id) === String(id)) {
          changed = true;
          return { ...post, thumbnail: url };
        }
        return post;
      });
      if (changed) localStorage.setItem('userProfile', JSON.stringify(profile));
    } catch {
      /* ignore */
    }
  };

  const handleThumbCropComplete = async (file: File) => {
    const t = thumbCrop?.target;
    setThumbCrop(null);
    if (!t) return;
    const busyKey = `${t.kind}:${t.id}`;
    setThumbBusyId(busyKey);
    try {
      if (t.kind === 'live') {
        // Live isn't published yet — keep the file; go-live uploads it.
        if (liveThumbnailPreview.startsWith('blob:')) {
          try {
            URL.revokeObjectURL(liveThumbnailPreview);
          } catch {
            /* ignore */
          }
        }
        setLiveThumbnailFile(file);
        setLiveThumbnailPreview(URL.createObjectURL(file));
        showSuccess('Stream thumbnail updated');
        return;
      }
      if (t.kind === 'pending-video' || t.kind === 'pending-moment' || t.kind === 'pending-thought' || t.kind === 'pending-story') {
        // Pre-publish thumbnails aren't posted yet — keep the cropped file
        // locally; the post handler uploads it and uses it as the poster.
        const previewUrl = URL.createObjectURL(file);
        if (t.kind === 'pending-video') {
          if (videoThumbPreview.startsWith('blob:')) {
            try { URL.revokeObjectURL(videoThumbPreview); } catch { /* ignore */ }
          }
          setVideoThumbFile(file);
          setVideoThumbPreview(previewUrl);
          showSuccess('Video thumbnail set — it will be used when you post.');
        } else if (t.kind === 'pending-moment') {
          if (momentThumbPreview.startsWith('blob:')) {
            try { URL.revokeObjectURL(momentThumbPreview); } catch { /* ignore */ }
          }
          setMomentThumbFile(file);
          setMomentThumbPreview(previewUrl);
          showSuccess('Moment cover set — it will be used when you post.');
        } else if (t.kind === 'pending-thought') {
          if (thoughtThumbPreview.startsWith('blob:')) {
            try { URL.revokeObjectURL(thoughtThumbPreview); } catch { /* ignore */ }
          }
          setThoughtThumbFile(file);
          setThoughtThumbPreview(previewUrl);
          showSuccess('Thought thumbnail set — it will be used when you post.');
        } else {
          if (storyThumbPreview.startsWith('blob:')) {
            try { URL.revokeObjectURL(storyThumbPreview); } catch { /* ignore */ }
          }
          setStoryThumbFile(file);
          setStoryThumbPreview(previewUrl);
          showSuccess('Story cover set — it will be used when you post.');
        }
        return;
      }
      const up = file.type.startsWith('image/') ? await compressImage(file) : file;
      const { data, error } = await api.uploadFile(up, 'equyvo/thumbnails');
      if (error || !data?.secureUrl) throw new Error(error || 'Thumbnail upload failed');
      const url = data.secureUrl;
      if (t.kind === 'video') {
        setUploadedVideos((prev) => prev.map((v) => (v.id === t.id ? { ...v, thumbnail: url } : v)));
      } else if (t.kind === 'photo') {
        setUploadedPhotos((prev) => prev.map((p) => (p.id === t.id ? { ...p, thumbnail: url } : p)));
      } else if (t.kind === 'story') {
        setUploadedStories((prev) => prev.map((s) => (s.id === t.id ? { ...s, thumbnail: url } : s)));
      } else if (t.kind === 'thought') {
        setUploadedThoughts((prev) => prev.map((x) => (x.id === t.id ? { ...x, thumbnail: url } : x)));
      } else {
        setUploadedMoments((prev) => prev.map((m) => (m.id === t.id ? { ...m, thumbnail: url } : m)));
      }
      const { error: updateError } =
        t.kind === 'story'
          ? await api.updateStory(t.id, { thumbnail: url })
          : t.kind === 'moment'
            ? await api.updateMoment(t.id, { thumbnail: url })
            : t.kind === 'thought'
              ? await api.updateThought(t.id, { thumbnail: url })
              : await api.updatePost(t.id, { thumbnail: url });
      if (updateError) throw new Error(updateError);
      patchLocalThumb(t.id, url);
      try {
        window.dispatchEvent(new CustomEvent('feedRefresh'));
      } catch {
        /* ignore */
      }
      showSuccess('Thumbnail updated everywhere');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      showError(msg || "Couldn't update the thumbnail. Please try again.");
    } finally {
      setThumbBusyId(null);
    }
  };

  const thumbBusy = (kind: ThumbKind, id: string) => thumbBusyId === `${kind}:${id}`;

  const handleEditDraftPost = (draft: DraftPost) => {
    // Load draft content back into form
    switch (draft.type) {
      case 'story':
        setStoryFiles(draft.content.files);
        if (draft.content.caption) {
          (document.getElementById('story-caption') as HTMLTextAreaElement).value = draft.content.caption;
        }
        setActiveTab('story');
        break;
      case 'text-story':
        setTextStoryContent(draft.content.content);
        setTextStoryBackground(draft.content.background);
        setTextStoryColor(draft.content.color);
        setActiveTab('text-story');
        break;
      case 'thought':
        setThoughtContent(draft.content.content);
        setThoughtVideo(draft.content.video);
        setActiveTab('thought');
        break;
      case 'photos':
        setPhotoFiles(draft.content.files);
        setPhotoCaption(draft.content.caption);
        setActiveTab('photo');
        break;
      case 'videos':
        setVideoFiles(draft.content.files);
        setVideoCaption(draft.content.caption);
        setActiveTab('video');
        break;
    }
    // Remove the draft after loading
    handleDeleteDraftPost(draft.id);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatScheduledTime = (date: Date) => {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  };

  return (
    <div className="space-y-4 md:space-y-6 w-full px-4 sm:px-6 lg:px-8 pb-20 md:pb-6 lg:pb-8">
      <h1 className="text-lg md:text-2xl lg:text-3xl font-bold">Create New Content</h1>

      {/* Content Management Toggle */}
      {[
        ...uploadedVideos,
        ...uploadedStories,
        ...uploadedThoughts,
        ...uploadedPhotos,
        ...uploadedMoments,
        ...uploadedTextStories
      ].length > 0 && (
          <Card>
            <CardContent className="p-3 md:p-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                  <BarChart3 className="h-4 w-4 md:h-5 md:w-5 text-blue-500" />
                  <span className="font-medium text-sm md:text-base">
                    Manage Your Content ({[
                      ...uploadedVideos,
                      ...uploadedStories,
                      ...uploadedThoughts,
                      ...uploadedPhotos,
                      ...uploadedMoments,
                      ...uploadedTextStories
                    ].length})
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowContentManagement(!showContentManagement)}
                  className="text-xs md:text-sm"
                >
                  {showContentManagement ? 'Hide' : 'Show'} Management
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      {/* Unified Content Management Section */}
      {showContentManagement && [
        ...uploadedVideos,
        ...uploadedStories,
        ...uploadedThoughts,
        ...uploadedPhotos,
        ...uploadedMoments,
        ...uploadedTextStories
      ].length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-blue-500" />
                Your Content Analytics & Management
              </CardTitle>
              {/* Management Tabs */}
              <div className="flex gap-1 bg-muted rounded-lg p-1 overflow-x-auto scroll-px-2 pr-5 scrollbar-hide max-w-full">
                {(['all', 'videos', 'stories', 'thoughts', 'photos', 'moments', 'text-stories'] as const).map((tab) => (
                  <Button
                    key={tab}
                    variant={activeManagementTab === tab ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setActiveManagementTab(tab)}
                    className="capitalize whitespace-nowrap shrink-0 text-xs md:text-sm"
                  >
                    {(() => {
                      switch (tab) {
                        case 'all': return 'All';
                        case 'videos': return '🎬 Videos';
                        case 'stories': return '📱 Stories';
                        case 'thoughts': return '💭 Thoughts';
                        case 'photos': return '🖼️ Photos';
                        case 'moments': return '⚡ Moments';
                        case 'text-stories': return '📝 Text Stories';
                        default: return tab;
                      }
                    })()}
                  </Button>
                ))}
                <span aria-hidden="true" className="w-1 shrink-0" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {/* Videos */}
                {(activeManagementTab === 'all' || activeManagementTab === 'videos') && uploadedVideos.map((video) => (
                  <div key={video.id} className="border rounded-lg p-3 md:p-4 space-y-3 md:space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      <div className="relative">
                        <img
                          src={video.thumbnail}
                          alt={video.title}
                          className="w-16 h-12 md:w-20 md:h-14 object-cover rounded"
                        />
                        <Play className="absolute bottom-1 right-1 h-3 w-3 md:h-4 md:w-4 text-white drop-shadow-md" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-sm md:text-base truncate">{video.title}</h3>
                        <p className="text-xs md:text-sm text-muted-foreground truncate">
                          {video.fileName} • {formatFileSize(video.fileSize)}
                        </p>
                        <p className="text-xs md:text-sm text-muted-foreground">
                          Uploaded {formatScheduledTime(video.uploadDate)}
                        </p>
                        {video.isPrivate && (
                          <div className="flex items-center gap-1 text-xs text-orange-600 mt-1">
                            <Lock className="h-3 w-3" />
                            Private
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                        <Button
                          variant={video.isPrivate ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleTogglePrivacy('video', video.id)}
                          className="flex items-center gap-1"
                        >
                          {video.isPrivate ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                          {video.isPrivate ? 'Private' : 'Public'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={thumbBusy('video', video.id)}
                          onClick={() => openThumbUpload('video', video.id)}
                          className="flex items-center gap-1"
                          title="Upload a separate thumbnail"
                        >
                          {thumbBusy('video', video.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                          Thumb
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!video.thumbnail || thumbBusy('video', video.id)}
                          onClick={() => openThumbAdjust('video', video.id, video.thumbnail)}
                          className="flex items-center gap-1"
                          title="Crop and reposition the current thumbnail"
                        >
                          <Crop className="h-4 w-4" />
                          Adjust
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteVideo(video.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-blue-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-lg font-bold">{video.views.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-red-600">
                          <TrendingUp className="h-4 w-4" />
                          <span className="text-lg font-bold">{video.likes}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Likes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-green-600">
                          <Users className="h-4 w-4" />
                          <span className="text-lg font-bold">{video.comments}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Comments</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-purple-600">
                          <BarChart3 className="h-4 w-4" />
                          <span className="text-lg font-bold">{video.engagement}%</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Engagement</p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs text-muted-foreground pt-2 border-t">
                      <span>Watch Time: {video.watchTime} minutes</span>
                      <span>Shares: {video.shares}</span>
                      <span>Duration: {video.duration}</span>
                    </div>
                  </div>
                ))}

                {/* Moments */}
                {(activeManagementTab === 'all' || activeManagementTab === 'moments') && uploadedMoments.map((moment) => (
                  <div key={moment.id} className="border rounded-lg p-3 md:p-4 space-y-3 md:space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                      <div className="relative">
                        {moment.thumbnail ? (
                          <img
                            src={moment.thumbnail}
                            alt={moment.fileName}
                            className="w-16 h-24 md:w-20 md:h-28 object-cover rounded"
                          />
                        ) : (
                          <div className="w-16 h-24 md:w-20 md:h-28 rounded bg-muted flex items-center justify-center">
                            <Film className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        {moment.mediaType === 'video' && <Play className="absolute bottom-1 right-1 h-3 w-3 md:h-4 md:w-4 text-white drop-shadow-md" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-sm md:text-base truncate">{moment.content || moment.fileName}</h3>
                        <p className="text-xs md:text-sm text-muted-foreground truncate">
                          {moment.fileName} • {formatFileSize(moment.fileSize)} • {moment.mediaType === 'video' ? 'Video' : 'Photo'}
                        </p>
                        <p className="text-xs md:text-sm text-muted-foreground">
                          Uploaded {formatScheduledTime(moment.uploadDate)}
                        </p>
                        {moment.isPrivate && (
                          <div className="flex items-center gap-1 text-xs text-orange-600 mt-1">
                            <Lock className="h-3 w-3" />
                            Private
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                        <Button
                          variant={moment.isPrivate ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleTogglePrivacy('moment', moment.id)}
                          className="flex items-center gap-1"
                        >
                          {moment.isPrivate ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                          {moment.isPrivate ? 'Private' : 'Public'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={thumbBusy('moment', moment.id)}
                          onClick={() => openThumbUpload('moment', moment.id)}
                          className="flex items-center gap-1"
                          title="Upload a separate cover"
                        >
                          {thumbBusy('moment', moment.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                          Cover
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!moment.thumbnail || thumbBusy('moment', moment.id)}
                          onClick={() => openThumbAdjust('moment', moment.id, moment.thumbnail)}
                          className="flex items-center gap-1"
                          title="Crop and reposition the current cover"
                        >
                          <Crop className="h-4 w-4" />
                          Adjust
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteMoment(moment.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-blue-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-lg font-bold">{moment.views.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-red-600">
                          <TrendingUp className="h-4 w-4" />
                          <span className="text-lg font-bold">{moment.likes}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Likes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-green-600">
                          <Users className="h-4 w-4" />
                          <span className="text-lg font-bold">{moment.comments}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Comments</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-purple-600">
                          <BarChart3 className="h-4 w-4" />
                          <span className="text-lg font-bold">{moment.mediaType === 'video' ? 'Video' : 'Photo'}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Type</p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Stories */}
                {(activeManagementTab === 'all' || activeManagementTab === 'stories') && uploadedStories.map((story) => (
                  <div key={story.id} className="border rounded-lg p-4 space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <img
                            src={story.thumbnail}
                            alt={story.fileName}
                            className="w-20 h-24 object-cover rounded"
                          />
                          {story.type === 'video' && <Play className="absolute bottom-1 right-1 h-4 w-4 text-white drop-shadow-md" />}
                        </div>
                        <div>
                          <h3 className="font-semibold text-sm">{story.type === 'video' ? 'Video Story' : 'Photo Story'}</h3>
                          <p className="text-xs text-muted-foreground">
                            {story.fileName} • {formatFileSize(story.fileSize)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Uploaded {formatScheduledTime(story.uploadDate)}
                          </p>
                          <p className="text-xs text-orange-600">
                            Expires in 24 hours
                          </p>
                          {story.isPrivate && (
                            <div className="flex items-center gap-1 text-xs text-orange-600 mt-1">
                              <Lock className="h-3 w-3" />
                              Private
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                        <Button
                          variant={story.isPrivate ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleTogglePrivacy('story', story.id)}
                          className="flex items-center gap-1"
                        >
                          {story.isPrivate ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                          {story.isPrivate ? 'Private' : 'Public'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={thumbBusy('story', story.id)}
                          onClick={() => openThumbUpload('story', story.id)}
                          className="flex items-center gap-1"
                          title="Upload a separate cover"
                        >
                          {thumbBusy('story', story.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                          Cover
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!story.thumbnail || thumbBusy('story', story.id)}
                          onClick={() => openThumbAdjust('story', story.id, story.thumbnail)}
                          className="flex items-center gap-1"
                          title="Crop and reposition the current cover"
                        >
                          <Crop className="h-4 w-4" />
                          Adjust
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteStory(story.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-blue-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-lg font-bold">{story.views.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-red-600">
                          <TrendingUp className="h-4 w-4" />
                          <span className="text-lg font-bold">{story.likes}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Likes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-green-600">
                          <Users className="h-4 w-4" />
                          <span className="text-lg font-bold">{story.comments}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Comments</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-purple-600">
                          <BarChart3 className="h-4 w-4" />
                          <span className="text-lg font-bold">{story.shares}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Shares</p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Thoughts */}
                {(activeManagementTab === 'all' || activeManagementTab === 'thoughts') && uploadedThoughts.map((thought) => (
                  <div key={thought.id} className="border rounded-lg p-4 space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        {thought.hasMedia && (thought.thumbnail || thought.mediaUrl) && (
                          <img
                            src={thought.thumbnail || thought.mediaUrl}
                            alt="Thought media"
                            className="w-16 h-16 object-cover rounded"
                          />
                        )}
                        <div className="w-full sm:flex-1">
                          <h3 className="font-semibold text-sm line-clamp-2">{thought.content}</h3>
                          <p className="text-xs text-muted-foreground mt-1">
                            {thought.hasMedia ? `${thought.mediaType} • ` : ''}Thought
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Posted {formatScheduledTime(thought.uploadDate)}
                          </p>
                          {thought.isPrivate && (
                            <div className="flex items-center gap-1 text-xs text-orange-600 mt-1">
                              <Lock className="h-3 w-3" />
                              Private
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                        <Button
                          variant={thought.isPrivate ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleTogglePrivacy('thought', thought.id)}
                          className="flex items-center gap-1"
                        >
                          {thought.isPrivate ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                          {thought.isPrivate ? 'Private' : 'Public'}
                        </Button>
                        {thought.mediaType === 'video' && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={thumbBusy('thought', thought.id)}
                              onClick={() => openThumbUpload('thought', thought.id)}
                              className="flex items-center gap-1"
                              title="Upload a separate thumbnail"
                            >
                              {thumbBusy('thought', thought.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                              Thumb
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={!thought.thumbnail || thumbBusy('thought', thought.id)}
                              onClick={() => openThumbAdjust('thought', thought.id, thought.thumbnail || '')}
                              className="flex items-center gap-1"
                              title="Crop and reposition the current thumbnail"
                            >
                              <Crop className="h-4 w-4" />
                              Adjust
                            </Button>
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteThought(thought.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-blue-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-lg font-bold">{thought.views.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-red-600">
                          <TrendingUp className="h-4 w-4" />
                          <span className="text-lg font-bold">{thought.likes}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Likes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-green-600">
                          <Users className="h-4 w-4" />
                          <span className="text-lg font-bold">{thought.comments}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Comments</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-purple-600">
                          <BarChart3 className="h-4 w-4" />
                          <span className="text-lg font-bold">{thought.reacts}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Reacts</p>
                      </div>
                    </div>
                  </div>
                ))}


                {/* Photos */}
                {(activeManagementTab === 'all' || activeManagementTab === 'photos') && uploadedPhotos.map((photo) => (
                  <div key={photo.id} className="border rounded-lg p-4 space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <img
                          src={photo.thumbnail}
                          alt={photo.fileName}
                          className="w-20 h-24 object-cover rounded"
                        />
                        <div>
                          <h3 className="font-semibold text-sm line-clamp-2">{photo.caption || 'Photo'}</h3>
                          <p className="text-xs text-muted-foreground">
                            {photo.fileName} • {formatFileSize(photo.fileSize)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Posted {formatScheduledTime(photo.uploadDate)}
                          </p>
                          {photo.isPrivate && (
                            <div className="flex items-center gap-1 text-xs text-orange-600 mt-1">
                              <Lock className="h-3 w-3" />
                              Private
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                        <Button
                          variant={photo.isPrivate ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleTogglePrivacy('photo', photo.id)}
                          className="flex items-center gap-1"
                        >
                          {photo.isPrivate ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                          {photo.isPrivate ? 'Private' : 'Public'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={thumbBusy('photo', photo.id)}
                          onClick={() => openThumbUpload('photo', photo.id)}
                          className="flex items-center gap-1"
                          title="Upload a separate thumbnail"
                        >
                          {thumbBusy('photo', photo.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                          Thumb
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!photo.thumbnail || thumbBusy('photo', photo.id)}
                          onClick={() => openThumbAdjust('photo', photo.id, photo.thumbnail)}
                          className="flex items-center gap-1"
                          title="Crop and reposition the current thumbnail"
                        >
                          <Crop className="h-4 w-4" />
                          Adjust
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeletePhoto(photo.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-blue-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-lg font-bold">{photo.views.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-red-600">
                          <TrendingUp className="h-4 w-4" />
                          <span className="text-lg font-bold">{photo.likes}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Likes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-green-600">
                          <Users className="h-4 w-4" />
                          <span className="text-lg font-bold">{photo.comments}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Comments</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-purple-600">
                          <BarChart3 className="h-4 w-4" />
                          <span className="text-lg font-bold">{photo.shares}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Shares</p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Text Stories */}
                {(activeManagementTab === 'all' || activeManagementTab === 'text-stories') && uploadedTextStories.map((textStory) => (
                  <div key={textStory.id} className="border rounded-lg p-4 space-y-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-20 h-24 rounded flex items-center justify-center text-center p-2"
                          style={{
                            backgroundColor: textStory.backgroundColor,
                            color: textStory.textColor
                          }}
                        >
                          <p className="text-xs font-medium line-clamp-3">{textStory.content}</p>
                        </div>
                        <div>
                          <h3 className="font-semibold text-sm line-clamp-2">Text Story</h3>
                          <p className="text-xs text-muted-foreground">
                            Text Story • Posted {formatScheduledTime(textStory.uploadDate)}
                          </p>
                          <p className="text-xs text-orange-600">
                            Expires in 24 hours
                          </p>
                          {textStory.isPrivate && (
                            <div className="flex items-center gap-1 text-xs text-orange-600 mt-1">
                              <Lock className="h-3 w-3" />
                              Private
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                        <Button
                          variant={textStory.isPrivate ? "default" : "outline"}
                          size="sm"
                          onClick={() => handleTogglePrivacy('text-story', textStory.id)}
                          className="flex items-center gap-1"
                        >
                          {textStory.isPrivate ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                          {textStory.isPrivate ? 'Private' : 'Public'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteTextStory(textStory.id)}
                          className="text-red-500 hover:text-red-600 hover:bg-red-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-blue-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-lg font-bold">{textStory.views.toLocaleString()}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Views</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-red-600">
                          <TrendingUp className="h-4 w-4" />
                          <span className="text-lg font-bold">{textStory.likes}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Likes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-green-600">
                          <Users className="h-4 w-4" />
                          <span className="text-lg font-bold">{textStory.comments}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Comments</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 text-purple-600">
                          <BarChart3 className="h-4 w-4" />
                          <span className="text-lg font-bold">{textStory.shares}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Shares</p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Empty state for filtered tabs */}
                {(() => {
                  const hasNoContent = uploadedVideos.length === 0 &&
                    uploadedStories.length === 0 &&
                    uploadedThoughts.length === 0 &&
                    uploadedPhotos.length === 0 &&
                    uploadedMoments.length === 0 &&
                    uploadedTextStories.length === 0;

                  const shouldShowEmptyState =
                    (activeManagementTab === 'all' && hasNoContent) ||
                    (activeManagementTab === 'videos' && uploadedVideos.length === 0) ||
                    (activeManagementTab === 'stories' && uploadedStories.length === 0) ||
                    (activeManagementTab === 'thoughts' && uploadedThoughts.length === 0) ||
                    (activeManagementTab === 'photos' && uploadedPhotos.length === 0) ||
                    (activeManagementTab === 'moments' && uploadedMoments.length === 0) ||
                    (activeManagementTab === 'text-stories' && uploadedTextStories.length === 0);

                  return shouldShowEmptyState && (
                    <div className="text-center py-12">
                      <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                      <p className="text-muted-foreground text-lg mb-2">
                        No {activeManagementTab === 'all' ? 'content' : activeManagementTab.replace('-', ' ')} found
                      </p>
                      <p className="text-muted-foreground text-sm">
                        Create and post some {activeManagementTab === 'all' ? 'content' : activeManagementTab.replace('-', ' ')} to see them here
                      </p>
                    </div>
                  );
                })()}
              </div>
            </CardContent>
          </Card>
        )}

      {/* Upload audience */}
      <Card>
        <CardContent className="p-3 md:p-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Eye className="h-4 w-4 text-muted-foreground" />
              Who can see your uploads
            </div>
            <div className="flex gap-2" role="radiogroup" aria-label="Who can see your uploads">
              {([
                { value: 'public', label: 'Everyone', hint: 'Shown across the app' },
                { value: 'followers', label: 'Followers', hint: 'Followers only' },
                { value: 'private', label: 'Only me', hint: 'Hidden from everyone else' },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={contentVisibility === opt.value}
                  title={opt.hint}
                  onClick={() => setContentVisibilityState(opt.value)}
                  className={`rounded-lg border px-3 py-1.5 text-xs md:text-sm font-medium transition-colors ${
                    contentVisibility === opt.value
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content Type Selection */}
      <Card>
        <CardHeader>
          <CardTitle>What would you like to create?</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-4">
          <Button
            variant={activeTab === 'story' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('story')}
          >
            <Camera className="h-8 w-8 text-pink-500" />
            <span>Story</span>
            <span className="text-xs text-muted-foreground">24hr</span>
          </Button>
          <Button
            variant={activeTab === 'text-story' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('text-story')}
          >
            <Text className="h-8 w-8 text-blue-400" />
            <span>Text Story</span>
            <span className="text-xs text-muted-foreground">24hr</span>
          </Button>
          <Button
            variant={activeTab === 'thought' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('thought')}
          >
            <Brain className="h-8 w-8 text-purple-500" />
            <span>Thought</span>
            <span className="text-xs text-muted-foreground">&lt;5min</span>
          </Button>
          <Button
            variant={activeTab === 'photo' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('photo')}
          >
            <ImageIcon className="h-8 w-8 text-blue-500" />
            <span>Photos</span>
            <span className="text-xs text-muted-foreground">Post</span>
          </Button>
          <Button
            variant={activeTab === 'video' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('video')}
          >
            <Film className="h-8 w-8 text-green-500" />
            <span>Videos</span>
            <span className="text-xs text-muted-foreground">Long</span>
          </Button>
          <Button
            variant={activeTab === 'live' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('live')}
          >
            <Zap className="h-8 w-8 text-red-500 fill-red-500 animate-pulse" />
            <span>Go Live!</span>
            <span className="text-xs text-muted-foreground">Stream</span>
          </Button>
          <Button
            variant={activeTab === 'moment' ? 'default' : 'outline'}
            className="flex flex-col h-28 items-center justify-center gap-2 hover:scale-105 transition-transform duration-200"
            onClick={() => setActiveTab('moment')}
          >
            <Video className="h-8 w-8 text-orange-500" />
            <span>Moments</span>
            <span className="text-xs text-muted-foreground">Clips</span>
          </Button>
        </CardContent>
      </Card>

      {/* Create Content Tabs — horizontally scrollable icon pills on mobile
          so labels never squeeze/wrap ("Text Story" etc.); grid on desktop. */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex w-full max-w-full justify-start gap-1.5 overflow-x-auto scroll-px-3 scrollbar-hide bg-transparent py-1 pl-1 pr-6 md:grid md:grid-cols-7 md:overflow-visible md:bg-muted md:rounded-md md:pr-1">
          {[
            { value: 'story', label: 'Story', Icon: Camera },
            { value: 'text-story', label: 'Text', Icon: Text },
            { value: 'thought', label: 'Thought', Icon: Brain },
            { value: 'photo', label: 'Photos', Icon: ImageIcon },
            { value: 'video', label: 'Videos', Icon: Film },
            { value: 'live', label: 'Live', Icon: Zap },
            { value: 'moment', label: 'Moments', Icon: Video },
          ].map(({ value, label, Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border/60 bg-card px-3.5 py-2 text-xs font-medium data-[state=active]:border-primary/40 data-[state=active]:bg-primary/10 data-[state=active]:text-primary md:rounded-sm md:border-transparent md:bg-transparent md:px-3 md:text-sm"
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </TabsTrigger>
          ))}
          <span aria-hidden="true" className="w-1 shrink-0 md:hidden" />
        </TabsList>

        {/* Story Upload */}
        <TabsContent value="story" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Create Story (24 hours)
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Share photos, videos, GIFs, or text that disappear after 24 hours
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* File Upload Area */}
              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-semibold mb-2">Upload Story Content</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Photos, Videos, or GIFs
                </p>
                <Input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={(e) => handleFileUpload(e.target.files, 'story')}
                  className="max-w-xs mx-auto"
                />
              </div>

              {/* Selected files: file name + live preview before posting */}
              {storyFiles.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Selected Files ({storyFiles.length}):</h4>
                  {storyFiles.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between p-3 border rounded-lg gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <LocalMediaThumb file={file} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-[220px]" title={file.name}>{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {file.type.startsWith('image/') ? 'Image' : 'Video'} • {(file.size / (1024 * 1024)).toFixed(1)} MB
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveFile(index, 'story')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Story Caption */}
              <div>
                <Label htmlFor="story-caption">Add Caption (Optional)</Label>
                <Textarea
                  id="story-caption"
                  placeholder="What's happening in your story?"
                  className="mt-1"
                />
              </div>

              {/* Story Cover — separate thumbnail section, like Live */}
              <div>
                <Label>Story Cover (optional)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Upload a separate cover for video stories. Photos use the photo itself unless you override it here.
                  A cover requires its story media — select media first.
                </p>
                <div className="mt-1 flex items-center gap-4">
                  {storyThumbPreview ? (
                    <div className="flex items-center gap-2">
                      <div className="relative w-20 h-32 rounded-lg overflow-hidden border">
                        <img src={storyThumbPreview} alt="Story cover preview" className="w-full h-full object-cover" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 bg-black/50 hover:bg-black/70 text-white"
                          onClick={clearStoryThumb}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openThumbAdjust('pending-story', 'pending-story', storyThumbPreview)}
                        className="flex items-center gap-1"
                        title="Crop and reposition this cover"
                      >
                        <Crop className="h-4 w-4" />
                        Adjust
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={storyFiles.length === 0}
                        title={storyFiles.length === 0 ? 'Select story media first — a cover needs its media' : 'Upload a separate cover'}
                        onClick={() => openPendingThumbPicker('pending-story')}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Cover
                      </Button>
                      <span className="text-xs text-muted-foreground">Recommended: 720x1280</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={() => handlePostStory('post')} className="w-full sm:flex-1">
                  Post Story
                </Button>
                <Button
                  onClick={() => {
                    setCurrentContentType('story');
                    setShowScheduleModal(true);
                  }}
                  variant="outline"
                  className="w-full sm:flex-1"
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </Button>
                <Button
                  onClick={() => handlePostStory('draft')}
                  variant="secondary"
                  className="w-full sm:flex-1"
                >
                  Save as Draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Text Story Upload */}
        <TabsContent value="text-story" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Text className="h-5 w-5" />
                Create Text Story (24 hours)
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Share text with custom colors and backgrounds that disappear after 24 hours
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Story Preview */}
              <div
                className="w-full h-64 rounded-lg flex items-center justify-center p-8 text-center"
                style={{
                  backgroundColor: textStoryBackground,
                  color: textStoryColor
                }}
              >
                <p className="text-lg font-medium break-words">
                  {textStoryContent || 'Your text will appear here...'}
                </p>
              </div>

              {/* Text Input */}
              <div>
                <Label htmlFor="text-story-content">Your Text</Label>
                <Textarea
                  id="text-story-content"
                  placeholder="What's on your mind?"
                  value={textStoryContent}
                  onChange={(e) => setTextStoryContent(e.target.value)}
                  className="mt-1"
                  rows={3}
                  maxLength={200}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {textStoryContent.length}/200 characters
                </p>
              </div>

              {/* Color Options */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="text-color">Text Color</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      type="color"
                      id="text-color"
                      value={textStoryColor}
                      onChange={(e) => setTextStoryColor(e.target.value)}
                      className="w-16 h-10 p-1"
                    />
                    <Input
                      type="text"
                      value={textStoryColor}
                      onChange={(e) => setTextStoryColor(e.target.value)}
                      placeholder="#FFFFFF"
                      className="w-full sm:flex-1"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="bg-color">Background Color</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      type="color"
                      id="bg-color"
                      value={textStoryBackground}
                      onChange={(e) => setTextStoryBackground(e.target.value)}
                      className="w-16 h-10 p-1"
                    />
                    <Input
                      type="text"
                      value={textStoryBackground}
                      onChange={(e) => setTextStoryBackground(e.target.value)}
                      placeholder="#000000"
                      className="w-full sm:flex-1"
                    />
                  </div>
                </div>
              </div>

              {/* Quick Background Templates */}
              <div>
                <Label>Quick Backgrounds</Label>
                <div className="grid grid-cols-6 gap-2 mt-2">
                  {[
                    { bg: '#000000', color: '#FFFFFF', name: 'Black' },
                    { bg: '#FFFFFF', color: '#000000', name: 'White' },
                    { bg: '#FF6B6B', color: '#FFFFFF', name: 'Red' },
                    { bg: '#4ECDC4', color: '#000000', name: 'Green' },
                    { bg: '#45B7D1', color: '#FFFFFF', name: 'Blue' },
                    { bg: '#FFA07A', color: '#000000', name: 'Orange' },
                    { bg: '#98D8C8', color: '#000000', name: 'Mint' },
                    { bg: '#FFD93D', color: '#000000', name: 'Yellow' },
                    { bg: '#6C5CE7', color: '#FFFFFF', name: 'Purple' },
                    { bg: '#FF69B4', color: '#000000', name: 'Pink' },
                    { bg: '#20B2AA', color: '#FFFFFF', name: 'Teal' },
                    { bg: '#795548', color: '#FFFFFF', name: 'Brown' },
                  ].map((template, index) => (
                    <button
                      key={index}
                      className="w-10 h-10 rounded border-2 border-gray-200 hover:border-gray-400 transition-colors"
                      style={{ backgroundColor: template.bg }}
                      onClick={() => {
                        setTextStoryBackground(template.bg);
                        setTextStoryColor(template.color);
                      }}
                      title={template.name}
                    />
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={() => handlePostTextStory('post')} className="w-full sm:flex-1">
                  Post Text Story
                </Button>
                <Button
                  onClick={() => {
                    setCurrentContentType('text-story');
                    setShowScheduleModal(true);
                  }}
                  variant="outline"
                  className="w-full sm:flex-1"
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </Button>
                <Button
                  onClick={() => handlePostTextStory('draft')}
                  variant="secondary"
                  className="w-full sm:flex-1"
                >
                  Save as Draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Thought Creation */}
        <TabsContent value="thought" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Text className="h-5 w-5" />
                Share Your Thought
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Express yourself with text and optional short video
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="thought-content">Your Thought</Label>
                <Textarea
                  id="thought-content"
                  placeholder="What's on your mind?"
                  value={thoughtContent}
                  onChange={(e) => setThoughtContent(e.target.value)}
                  className="mt-1 min-h-[120px]"
                />
              </div>

              {/* Optional Video Upload */}
              <div>
                <Label htmlFor="thought-video">Add Video or Photos (Optional)</Label>
                <p className="text-sm text-muted-foreground mb-2">
                  Enhance your thought with a short video clip, photo, or GIF to make it more engaging
                </p>
                <div className="mt-1">
                  {thoughtVideo ? (
                    <div className="flex items-center justify-between p-3 border rounded-lg gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <LocalMediaThumb file={thoughtVideo} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-[220px]" title={thoughtVideo.name}>{thoughtVideo.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {thoughtVideo.type.startsWith('image/') ? 'Photo' : 'Video'} • {(thoughtVideo.size / (1024 * 1024)).toFixed(1)} MB
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveFile(0, 'thought')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-4 text-center">
                      <Video className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground mb-2">
                        Upload a short video, photo, or GIF
                      </p>
                      <Input
                        type="file"
                        accept="video/*,image/*,image/gif"
                        onChange={(e) => handleFileUpload(e.target.files, 'thought')}
                        className="max-w-xs mx-auto"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Thought Thumbnail — separate section, like Live */}
              <div>
                <Label>Video Thumbnail (optional)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Upload a separate thumbnail for thought videos. Used as the poster across feeds when you post.
                  A thumbnail requires its thought media — attach media first.
                </p>
                <div className="mt-1 flex items-center gap-4">
                  {thoughtThumbPreview ? (
                    <div className="flex items-center gap-2">
                      <div className="relative w-32 h-20 rounded-lg overflow-hidden border">
                        <img src={thoughtThumbPreview} alt="Thought thumbnail preview" className="w-full h-full object-cover" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 bg-black/50 hover:bg-black/70 text-white"
                          onClick={clearThoughtThumb}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openThumbAdjust('pending-thought', 'pending-thought', thoughtThumbPreview)}
                        className="flex items-center gap-1"
                        title="Crop and reposition this thumbnail"
                      >
                        <Crop className="h-4 w-4" />
                        Adjust
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!thoughtVideo}
                        title={!thoughtVideo ? 'Attach the thought photo/video first — a thumbnail needs its media' : 'Upload a separate thumbnail'}
                        onClick={() => openPendingThumbPicker('pending-thought')}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Thumbnail
                      </Button>
                      <span className="text-xs text-muted-foreground">Recommended: 1280x720</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={() => handlePostThought('post')} className="w-full sm:flex-1">
                  Post Thought
                </Button>
                <Button
                  onClick={() => {
                    setCurrentContentType('thought');
                    setShowScheduleModal(true);
                  }}
                  variant="outline"
                  className="w-full sm:flex-1"
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </Button>
                <Button
                  onClick={() => handlePostThought('draft')}
                  variant="secondary"
                  className="w-full sm:flex-1"
                >
                  Save as Draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>


        {/* Photo Upload */}
        <TabsContent value="photo" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ImageIcon className="h-5 w-5 text-blue-500" />
                Share Photos
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Upload and share your favorite photos with your followers
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Photo Upload Area */}
              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                <ImageIcon className="h-12 w-12 mx-auto mb-4 text-blue-500" />
                <p className="text-lg font-semibold mb-2">Upload Photos</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Multiple photos supported
                </p>
                <Input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => handleFileUpload(e.target.files, 'photo')}
                  className="max-w-xs mx-auto"
                />
              </div>

              {/* Selected photos: file name + live preview before posting */}
              {photoFiles.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Selected Photos ({photoFiles.length}):</h4>
                  {photoFiles.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between p-3 border rounded-lg gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <LocalMediaThumb file={file} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-[220px]" title={file.name}>{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)} • Photo
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveFile(index, 'photo')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Photo Caption */}
              <div>
                <Label htmlFor="photo-caption">Add Caption</Label>
                <Textarea
                  id="photo-caption"
                  placeholder="Tell your photo story..."
                  value={photoCaption}
                  onChange={(e) => setPhotoCaption(e.target.value)}
                  className="mt-1"
                />
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={() => handlePostPhotos('post')} className="w-full sm:flex-1">
                  Post Photos
                </Button>
                <Button
                  onClick={() => {
                    setCurrentContentType('photos');
                    setShowScheduleModal(true);
                  }}
                  variant="outline"
                  className="w-full sm:flex-1"
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </Button>
                <Button
                  onClick={() => handlePostPhotos('draft')}
                  variant="secondary"
                  className="w-full sm:flex-1"
                >
                  Save as Draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Video Upload */}
        <TabsContent value="video" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Film className="h-5 w-5 text-green-500" />
                Share Videos
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Upload longer videos for your followers to enjoy
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Video Upload Area */}
              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                <Film className="h-12 w-12 mx-auto mb-4 text-green-500" />
                <p className="text-lg font-semibold mb-2">Upload Videos</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Multiple videos supported
                </p>
                <Input
                  type="file"
                  accept="video/*"
                  multiple
                  onChange={(e) => handleFileUpload(e.target.files, 'video')}
                  className="max-w-xs mx-auto"
                />
              </div>

              {/* Selected videos: file name + live preview before posting */}
              {videoFiles.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Selected Videos ({videoFiles.length}):</h4>
                  {videoFiles.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between p-3 border rounded-lg gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <LocalMediaThumb file={file} className="h-14 w-20 rounded-lg object-cover border bg-black" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-[220px]" title={file.name}>{file.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)} • Video
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveFile(index, 'video')}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* Video Caption */}
              <div>
                <Label htmlFor="video-caption">Add Caption</Label>
                <Textarea
                  id="video-caption"
                  placeholder="Describe your video..."
                  value={videoCaption}
                  onChange={(e) => setVideoCaption(e.target.value)}
                  className="mt-1"
                />
              </div>

              {/* Video Thumbnail — separate section, like Live */}
              <div>
                <Label>Video Thumbnail (optional)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Upload a separate thumbnail for your video. It is shown across feeds instead of the auto poster.
                  A thumbnail requires its video — select a video first.
                </p>
                <div className="mt-1 flex items-center gap-4">
                  {videoThumbPreview ? (
                    <div className="flex items-center gap-2">
                      <div className="relative w-32 h-20 rounded-lg overflow-hidden border">
                        <img src={videoThumbPreview} alt="Video thumbnail preview" className="w-full h-full object-cover" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 bg-black/50 hover:bg-black/70 text-white"
                          onClick={clearVideoThumb}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openThumbAdjust('pending-video', 'pending-video', videoThumbPreview)}
                        className="flex items-center gap-1"
                        title="Crop and reposition this thumbnail"
                      >
                        <Crop className="h-4 w-4" />
                        Adjust
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={videoFiles.length === 0}
                        title={videoFiles.length === 0 ? 'Select at least one video first — a thumbnail needs its video' : 'Upload a separate thumbnail'}
                        onClick={() => openPendingThumbPicker('pending-video')}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Thumbnail
                      </Button>
                      <span className="text-xs text-muted-foreground">Recommended: 1280x720</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={() => handlePostVideos('post')} className="w-full sm:flex-1">
                  Post Videos
                </Button>
                <Button
                  onClick={() => {
                    setCurrentContentType('videos');
                    setShowScheduleModal(true);
                  }}
                  variant="outline"
                  className="w-full sm:flex-1"
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </Button>
                <Button
                  onClick={() => handlePostVideos('draft')}
                  variant="secondary"
                  className="w-full sm:flex-1"
                >
                  Save as Draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Live Stream */}
        <TabsContent value="live" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-red-500" />
                Start Live Stream
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Go live and engage with your audience in real-time
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="live-title">Stream Title</Label>
                <Input
                  id="live-title"
                  placeholder="Give your stream a catchy title"
                  value={liveTitle}
                  onChange={(e) => setLiveTitle(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label htmlFor="live-description">Description</Label>
                <Textarea
                  id="live-description"
                  placeholder="What's your stream about?"
                  value={liveDescription}
                  onChange={(e) => setLiveDescription(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Stream Thumbnail</Label>
                <div className="mt-1 flex items-center gap-4">
                  {liveThumbnailPreview ? (
                    <div className="flex items-center gap-2">
                      <div className="relative w-32 h-20 rounded-lg overflow-hidden border">
                        <img src={liveThumbnailPreview} alt="Thumbnail preview" className="w-full h-full object-cover" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 bg-black/50 hover:bg-black/70 text-white"
                          onClick={() => { setLiveThumbnailFile(null); setLiveThumbnailPreview(''); }}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={thumbBusy('live', 'live')}
                        onClick={() => openThumbAdjust('live', 'live', liveThumbnailPreview)}
                        className="flex items-center gap-1"
                        title="Crop and reposition this thumbnail"
                      >
                        <Crop className="h-4 w-4" />
                        Adjust
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!liveTitle.trim()}
                        title={!liveTitle.trim() ? 'Enter a stream title first — a thumbnail needs its stream' : 'Upload a stream thumbnail'}
                        onClick={() => openThumbUpload('live', 'live')}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Thumbnail
                      </Button>
                      <span className="text-xs text-muted-foreground">Recommended: 1280x720</span>
                    </div>
                  )}
                  <Input
                    id="live-thumbnail-upload"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      if (!file.type.startsWith('image/')) {
                        showError('Please select an image file');
                        return;
                      }
                      if (file.size > 5 * 1024 * 1024) {
                        showError('Thumbnail must be less than 5MB');
                        return;
                      }
                      const spec = THUMB_SPEC.live;
                      const reader = new FileReader();
                      reader.onload = () => {
                        try {
                          const src = typeof reader.result === 'string' ? reader.result : '';
                          if (!src) throw new Error('Failed to read image');
                          setThumbCrop({
                            src,
                            aspect: (spec && spec.aspect) || 16 / 9,
                            outW: (spec && spec.outW) || 1280,
                            outH: (spec && spec.outH) || 720,
                            title: `Crop ${(spec && spec.label) || 'stream thumbnail'}`,
                            target: { kind: 'live', id: 'live' },
                          });
                        } catch {
                          showError('Could not process thumbnail image. Please try another one.');
                        }
                      };
                      reader.onerror = () => {
                        showError('Failed to read thumbnail file. Please try another one.');
                      };
                      reader.readAsDataURL(file);
                    }}
                  />
                </div>
              </div>

              <div className="bg-muted/50 rounded-lg p-4">
                <h4 className="font-semibold mb-2">Before you go live:</h4>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Make sure you have a stable internet connection</li>
                  <li>• Find a quiet, well-lit space</li>
                  <li>• Test your camera and microphone</li>
                  <li>• Prepare topics to discuss</li>
                </ul>
              </div>

              {isRecording && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                    <span className="font-semibold text-red-700">Recording in Progress</span>
                  </div>
                  <p className="text-sm text-red-600">
                    Your live stream is being recorded. Click "End Live Stream" to stop recording and save the video.
                  </p>
                </div>
              )}

              {!isRecording ? (
                <div className="flex flex-col sm:flex-row gap-2">
                  <Button onClick={() => handlePostLive('post')} className="w-full sm:flex-1 bg-red-500 hover:bg-red-600">
                    <Zap className="h-4 w-4 mr-2" />
                    Go Live Now
                  </Button>
                  <Button
                    onClick={() => {
                      setCurrentContentType('live');
                      setShowScheduleModal(true);
                    }}
                    variant="outline"
                    className="w-full sm:flex-1"
                  >
                    <Calendar className="h-4 w-4 mr-2" />
                    Schedule
                  </Button>
                  <Button
                    onClick={() => handlePostLive('draft')}
                    variant="secondary"
                    className="w-full sm:flex-1"
                  >
                    Save Draft
                  </Button>
                </div>
              ) : (
                <Button onClick={handleEndLive} className="w-full bg-gray-800 hover:bg-gray-900">
                  <Square className="h-4 w-4 mr-2" />
                  End Live Stream
                </Button>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Moments Upload */}
        <TabsContent value="moment" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Video className="h-5 w-5 text-orange-500" />
                Create Moments
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Share short moments — photos or video clips
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="moment-content">Caption</Label>
                <Textarea
                  id="moment-content"
                  placeholder="What's happening?"
                  value={momentContent}
                  onChange={(e) => setMomentContent(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                <Upload className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
                <p className="text-lg font-semibold mb-2">Upload Moment Media</p>
                <p className="text-sm text-muted-foreground mb-4">
                  Photos or Videos
                </p>
                <Input
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={(e) => handleFileUpload(e.target.files, 'moment')}
                  className="max-w-xs mx-auto"
                />
              </div>
              {momentFiles.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Selected Files ({momentFiles.length}):</h4>
                  {momentFiles.map((file, index) => (
                    <div key={`${file.name}-${file.size}-${index}`} className="flex items-center justify-between p-3 border rounded-lg gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <LocalMediaThumb file={file} className="h-16 w-12 rounded-lg object-cover border bg-black" />
                        <div className="min-w-0">
                          <p className="font-medium truncate max-w-[200px]" title={file.name}>{file.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {(file.size / (1024 * 1024)).toFixed(1)} MB • {file.type.startsWith('image/') ? 'Photo' : 'Video'}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemoveFile(index, 'moment')}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {/* Moment Cover — separate thumbnail section, like Live */}
              <div>
                <Label>Moment Cover (optional)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Upload a separate cover for video moments. Photo moments use the photo itself unless you override it here.
                  A cover requires its moment media — select media first.
                </p>
                <div className="mt-1 flex items-center gap-4">
                  {momentThumbPreview ? (
                    <div className="flex items-center gap-2">
                      <div className="relative w-20 h-32 rounded-lg overflow-hidden border">
                        <img src={momentThumbPreview} alt="Moment cover preview" className="w-full h-full object-cover" />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute top-1 right-1 h-6 w-6 bg-black/50 hover:bg-black/70 text-white"
                          onClick={clearMomentThumb}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => openThumbAdjust('pending-moment', 'pending-moment', momentThumbPreview)}
                        className="flex items-center gap-1"
                        title="Crop and reposition this cover"
                      >
                        <Crop className="h-4 w-4" />
                        Adjust
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={momentFiles.length === 0}
                        title={momentFiles.length === 0 ? 'Select moment media first — a cover needs its media' : 'Upload a separate cover'}
                        onClick={() => openPendingThumbPicker('pending-moment')}
                      >
                        <Upload className="h-4 w-4 mr-2" />
                        Upload Cover
                      </Button>
                      <span className="text-xs text-muted-foreground">Recommended: 720x1280</span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button onClick={() => handlePostMoment('post')} disabled={isUploading || momentFiles.length === 0} className="w-full sm:flex-1">
                  {isUploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    'Post Moments'
                  )}
                </Button>
                <Button
                  onClick={() => {
                    setCurrentContentType('moments');
                    setShowScheduleModal(true);
                  }}
                  variant="outline"
                  className="w-full sm:flex-1"
                  disabled={momentFiles.length === 0}
                >
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </Button>
                <Button
                  onClick={() => handlePostMoment('draft')}
                  variant="secondary"
                  className="w-full sm:flex-1"
                  disabled={momentFiles.length === 0}
                >
                  Save Draft
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Scheduled Posts Section */}
      {scheduledPosts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              Scheduled Posts ({scheduledPosts.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {scheduledPosts.map((post) => (
                <div key={post.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${post.status === 'scheduled' ? 'bg-blue-500' :
                        post.status === 'posted' ? 'bg-green-500' : 'bg-red-500'
                      }`} />
                    <div>
                      <p className="text-sm font-medium capitalize">{post.type}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatScheduledTime(post.scheduledTime)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                    <span className={`text-xs px-2 py-1 rounded ${post.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                        post.status === 'posted' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                      {post.status}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteScheduledPost(post.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Drafts Section */}
      {draftPosts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileVideo className="h-5 w-5" />
              Drafts ({draftPosts.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {draftPosts.map((draft) => (
                <div key={draft.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="w-3 h-3 rounded-full bg-gray-500" />
                    <div>
                      <p className="text-sm font-medium capitalize">{draft.type} draft</p>
                      <p className="text-xs text-muted-foreground">
                        Created {formatScheduledTime(draft.createdAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEditDraftPost(draft)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteDraftPost(draft.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload Loading Overlay */}
      {isUploading && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <Card className="p-8 text-center">
            <Loader2 className="h-10 w-10 animate-spin mx-auto mb-4 text-primary" />
            <p className="text-lg font-semibold">Uploading your media...</p>
            <p className="text-sm text-muted-foreground mt-2">This may take a moment depending on file size</p>
          </Card>
        </div>
      )}

      {/* Shared thumbnail picker + cropper for all media kinds */}
      <input
        id="custom-thumb-upload"
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleCustomThumbPicked}
      />
      {thumbCrop && (
        <MediaCropper
          imageSrc={thumbCrop.src}
          aspect={thumbCrop.aspect || 16 / 9}
          output={[thumbCrop.outW || 1280, thumbCrop.outH || 720]}
          title={thumbCrop.title || 'Adjust thumbnail'}
          onCancel={() => setThumbCrop(null)}
          onCropComplete={handleThumbCropComplete}
        />
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Schedule Post</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="schedule-date">Date and Time</Label>
                <Input
                  type="datetime-local"
                  id="schedule-date"
                  value={scheduleDateTime}
                  onChange={(e) => setScheduleDateTime(e.target.value)}
                  className="mt-1"
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)} // Minimum 1 minute from now
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  onClick={() => {
                    switch (currentContentType) {
                      case 'story':
                        handlePostStory('schedule');
                        break;
                      case 'text-story':
                        handlePostTextStory('schedule');
                        break;
                      case 'thought':
                        handlePostThought('schedule');
                        break;
                      case 'photos':
                        handlePostPhotos('schedule');
                        break;
                      case 'videos':
                        handlePostVideos('schedule');
                        break;
                      case 'moments':
                        handlePostMoment('schedule');
                        break;
                      case 'live':
                        handlePostLive('schedule');
                        break;
                    }
                  }}
                  className="w-full sm:flex-1"
                  disabled={!scheduleDateTime}
                >
                  Confirm Schedule
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowScheduleModal(false);
                    setScheduleDateTime('');
                    setCurrentContentType('');
                  }}
                  className="w-full sm:flex-1"
                >
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};

export default CreatePage;