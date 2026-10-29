/**
 * Central media normalisation.
 *
 * Content reaches the UI from many writers (legacy posts, the composer,
 * Cloudinary/R2 uploads, shared links, the standalone worker). Some store a
 * single `media` string, some store `media: [{ type, url, thumbnail }]`, some
 * store a media object, and some only fill `image`/`videoUrl`. Rendering those
 * raw shapes directly is what produced blank images and broken videos.
 *
 * Every item is normalised here exactly once, into a predictable shape:
 *   - `mediaItems`: every playable/viewable asset (array, never undefined)
 *   - `media`:      the primary asset URL (always a string)
 *   - `image`:      a still-image URL (never a video)
 *   - `thumbnail`:  a poster/small image URL (never a video)
 *   - `videoUrl`:   a playable video URL (empty for photos/text)
 *   - `mediaType`:  'video' | 'audio' | 'image' | 'text'
 *
 * The helpers are defensive: unknown/array/object inputs never throw, and a
 * malformed item is left renderable instead of crashing a feed.
 */

export type MediaKind = 'image' | 'video' | 'gif' | 'audio' | 'unknown';

export interface MediaItem {
  url: string;
  type: MediaKind;
  /** Poster for videos, small preview for images. */
  thumbnail?: string;
  duration?: number;
  width?: number;
  height?: number;
  publicId?: string;
  [key: string]: unknown;
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)(\?|#|$)/i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|heif)(\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac)(\?|#|$)/i;

/** True for URLs that a browser can actually load (remote, relative, blob, data). */
export function isRenderableUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (!url || url === '[object Object]' || url === 'undefined' || url === 'null') return false;
  return (
    /^(https?:)?\/\//i.test(url) ||
    /^(blob:|data:|file:)/i.test(url) ||
    url.startsWith('/')
  );
}

/** Classify a URL without trusting a caller-supplied (often wrong) type. */
export function mediaKindOfUrl(url: string, hinted?: unknown): MediaKind {
  const u = String(url || '').trim();
  if (!u) return 'unknown';
  const hint = String(hinted || '').toLowerCase();
  if (hint === 'gif') return 'gif';
  if (hint === 'audio') return 'audio';
  if (hint === 'video' || hint === 'moment') {
    // A GIF mislabeled as video is still an image.
    return IMAGE_EXT.test(u) && !VIDEO_EXT.test(u) ? 'gif' : 'video';
  }
  if (/res\.cloudinary\.com\//i.test(u)) {
    if (/\/video\/upload\//i.test(u) && !IMAGE_EXT.test(u)) return 'video';
    if (/\.gif(\?|#|$)/i.test(u)) return 'gif';
    return 'image';
  }
  if (VIDEO_EXT.test(u)) return 'video';
  if (IMAGE_EXT.test(u)) return /\.gif(\?|#|$)/i.test(u) ? 'gif' : 'image';
  if (AUDIO_EXT.test(u)) return 'audio';
  // R2 proxy / signed URLs often have no extension. Trust the hint, then the
  // Cloudinary path, then default to image (the safer renderer).
  if (hint === 'image' || hint === 'photo' || hint === 'gif') return hint === 'gif' ? 'gif' : 'image';
  return hint === 'video' ? 'video' : 'image';
}

export function isVideoUrl(url: unknown): boolean {
  return mediaKindOfUrl(String(url || '')) === 'video';
}

/** First renderable URL from a string, array, or object at any depth. */
export function firstMediaUrl(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return isRenderableUrl(value) ? value.trim() : '';
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = firstMediaUrl(entry);
      if (url) return url;
    }
    return '';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const directKeys = [
      'url', 'secureUrl', 'secure_url', 'src', 'mediaUrl', 'media_url',
      'videoUrl', 'video_url', 'playbackUrl', 'playback_url', 'imageUrl',
      'image_url', 'path', 'link',
    ];
    for (const key of directKeys) {
      const url = firstMediaUrl(obj[key]);
      if (url) return url;
    }
    for (const key of ['image', 'video', 'media', 'thumbnail', 'poster', 'preview', 'original', 'optimized']) {
      const url = firstMediaUrl(obj[key]);
      if (url) return url;
    }
  }
  return '';
}

function pushItem(out: MediaItem[], seen: Set<string>, item: MediaItem) {
  if (!item.url || seen.has(item.url)) return;
  seen.add(item.url);
  out.push(item);
}

function itemFromObject(obj: Record<string, unknown>, fallbackUrl = ''): MediaItem | null {
  const url = firstMediaUrl(obj) || firstMediaUrl(fallbackUrl);
  if (!url) return null;
  const thumbnail = firstMediaUrl(obj.thumbnail) || firstMediaUrl(obj.poster) || firstMediaUrl(obj.preview);
  const type = mediaKindOfUrl(url, obj.type || obj.mediaType || obj.kind || obj.resourceType);
  const item: MediaItem = { url, type };
  if (thumbnail && thumbnail !== url) item.thumbnail = thumbnail;
  const duration = Number(obj.duration ?? obj.durationSec ?? obj.duration_sec);
  if (Number.isFinite(duration) && duration > 0) item.duration = duration;
  const width = Number(obj.width);
  const height = Number(obj.height);
  if (Number.isFinite(width) && width > 0) item.width = width;
  if (Number.isFinite(height) && height > 0) item.height = height;
  if (typeof obj.publicId === 'string') item.publicId = obj.publicId;
  if (typeof obj.public_id === 'string') item.publicId = obj.public_id;
  return item;
}

/**
 * Turn any supported media representation into a clean list of assets.
 * `hintedType` is the content-level mediaType (e.g. a thought's `mediaType`).
 */
export function resolveMediaItems(value: unknown, hintedType?: unknown): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();

  const visit = (input: unknown, hint?: unknown) => {
    if (input == null) return;
    if (Array.isArray(input)) {
      for (const entry of input) visit(entry, hint);
      return;
    }
    if (typeof input === 'string') {
      // Some legacy writers stored a JSON-encoded array/object in `media`.
      const trimmed = input.trim();
      if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length < 20_000) {
        try {
          visit(JSON.parse(trimmed), hint);
          return;
        } catch { /* not JSON — treat as URL */ }
      }
      if (!isRenderableUrl(trimmed)) return;
      pushItem(out, seen, {
        url: trimmed,
        type: mediaKindOfUrl(trimmed, hint),
      });
      return;
    }
    if (typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      const url = firstMediaUrl(obj);
      if (!url) {
        for (const key of ['media', 'items', 'files', 'assets', 'sources']) {
          if (obj[key] != null) visit(obj[key], hint);
        }
        return;
      }
      const item = itemFromObject(obj, url);
      if (!item) return;
      // Preserve an explicit type from the descriptor unless it contradicts a
      // clear extension (e.g. a `.gif` labelled "video" is a GIF).
      const explicit = String(obj.type || obj.mediaType || obj.kind || hint || '');
      item.type = mediaKindOfUrl(item.url, explicit);
      pushItem(out, seen, item);
    }
  };

  visit(value, hintedType);
  return out;
}

export interface NormalizedMediaFields {
  mediaItems: MediaItem[];
  media: string;
  image: string;
  thumbnail: string;
  videoUrl: string;
  audioUrl: string;
  mediaType: 'video' | 'audio' | 'image' | 'text';
}

export interface MediaSource {
  [key: string]: unknown;
  media?: unknown;
  mediaItems?: unknown;
  mediaType?: unknown;
  type?: unknown;
  contentType?: unknown;
  image?: unknown;
  imageUrl?: unknown;
  image_url?: unknown;
  audio?: unknown;
  audioUrl?: unknown;
  audio_url?: unknown;
  thumbnail?: unknown;
  poster?: unknown;
  video?: unknown;
  videoUrl?: unknown;
  video_url?: unknown;
  mediaUrl?: unknown;
  media_url?: unknown;
  src?: unknown;
  fallbackImage?: unknown;
}

/**
 * Derive the canonical display fields for one content item.
 * Original fields are only read — the caller decides what to overwrite.
 */
export function resolveMediaFields(item: MediaSource): NormalizedMediaFields {
  const safe = (item || {}) as MediaSource;

  const hint = safe.mediaType || safe.type;
  const items: MediaItem[] = [];
  const seenItems = new Set<string>();
  // `mediaItems` (gallery) wins, but an empty array must not hide `media`.
  for (const source of [safe.mediaItems, safe.media]) {
    if (source == null) continue;
    for (const entry of resolveMediaItems(source, hint)) {
      if (seenItems.has(entry.url)) continue;
      seenItems.add(entry.url);
      items.push(entry);
    }
  }

  // Self-heal legacy rows that appended a cover as its own media entry: an
  // entry that only duplicates another entry's thumbnail/poster is a preview
  // of real media, not a second slide. Never drop the first/real asset.
  if (items.length > 1) {
    const previewUrls = new Set(
      items
        .map((m) => firstMediaUrl(m.thumbnail) || firstMediaUrl((m as MediaItem & { poster?: unknown }).poster))
        .filter(Boolean) as string[],
    );
    const nonDup = items.filter((m, index) => {
      if (index === 0) return true;
      if (!previewUrls.has(m.url)) return true;
      // An entry matching another slide's preview is droppable — but a real
      // multi-photo post never carries urls equal to another photo's preview
      // unless it IS that preview, so removal is safe.
      return false;
    });
    if (nonDup.length && nonDup.length !== items.length) {
      items.length = 0;
      items.push(...nonDup);
    }
  }

  // Also consider URLs that live outside `media`. Posters/thumbnails are
  // previews, not gallery slides, so they are only used when nothing else
  // plays or displays.
  const extraUrls: Array<[unknown, unknown]> = [
    [safe.videoUrl, 'video'],
    [safe.video_url, 'video'],
    [safe.video, 'video'],
    [safe.imageUrl, 'image'],
    [safe.image_url, 'image'],
    [safe.image, 'image'],
    [safe.audioUrl, 'audio'],
    [safe.audio_url, 'audio'],
    [safe.audio, 'audio'],
  ];
  const seen = new Set(items.map((m) => m.url));
  // Posters of already-resolved slides (videos with a cover, images with a
  // preview variant) are never their own slide. Pushing them listed the same
  // content twice: the actual media AND its thumbnail rendered as two
  // separate blocks inside one post.
  const coveredThumbs = new Set(
    items
      .map((m) => firstMediaUrl(m.thumbnail) || firstMediaUrl((m as MediaItem & { poster?: unknown }).poster))
      .filter(Boolean) as string[],
  );
  const hasPlayable = items.some((m) => m.type === 'video' || m.type === 'audio');
  for (const [value, hint] of extraUrls) {
    const url = firstMediaUrl(value);
    if (!url || seen.has(url)) continue;
    if (coveredThumbs.has(url)) continue;
    // Singular image/poster fields on playable items are legacy cover slots
    // (they hold the poster, not an extra asset). Only count them as slides
    // when the item also carries REAL separate image slides (a genuine
    // video+photo gallery written via `mediaItems`).
    if (hasPlayable && String(hint).toLowerCase().startsWith('image')) continue;
    seen.add(url);
    items.push({ url, type: mediaKindOfUrl(url, hint) });
  }
  if (items.length === 0) {
    const still = firstMediaUrl(safe.thumbnail) || firstMediaUrl(safe.poster);
    if (still) items.push({ url: still, type: mediaKindOfUrl(still, 'image') });
  }

  const videoItem = items.find((m) => m.type === 'video');
  const audioItem = items.find((m) => m.type === 'audio');
  const imageItem = items.find((m) => m.type !== 'video' && m.type !== 'audio');

  const explicitVideo = firstMediaUrl(safe.videoUrl) || firstMediaUrl(safe.video_url) || firstMediaUrl(safe.video);
  const videoUrl = videoItem?.url || (explicitVideo && isVideoUrl(explicitVideo) ? explicitVideo : '');
  const explicitAudio = firstMediaUrl(safe.audioUrl) || firstMediaUrl(safe.audio_url) || firstMediaUrl(safe.audio);
  const audioUrl = audioItem?.url || (explicitAudio && mediaKindOfUrl(explicitAudio, 'audio') === 'audio' ? explicitAudio : '');

  // Prefer the original image over a poster/thumbnail. Selecting the
  // thumbnail first made fullscreen photos open at preview resolution.
  const explicitImage =
    firstMediaUrl(safe.image) ||
    firstMediaUrl(safe.imageUrl) ||
    firstMediaUrl(safe.image_url);

  const image =
    explicitImage ||
    (!videoUrl && !audioUrl ? imageItem?.url || '' : '') ||
    '';

  const thumbnail = firstMediaUrl(safe.thumbnail) || firstMediaUrl(safe.poster) || imageItem?.thumbnail || image || '';

  const primary = videoUrl || image || audioUrl || items[0]?.url || '';
  const mediaType: NormalizedMediaFields['mediaType'] = videoUrl
    ? 'video'
    : audioUrl
      ? 'audio'
      : (image || items.length)
        ? 'image'
        : 'text';

  return {
    mediaItems: items,
    media: primary,
    image: videoUrl && image === videoUrl ? '' : image,
    thumbnail: thumbnail === videoUrl ? '' : thumbnail,
    videoUrl,
    audioUrl,
    mediaType,
  };
}

/**
 * Normalise one content item returned by any API. Keeps the original `type`
 * (routing depends on it) but makes every media field render-safe and adds
 * `mediaItems` for galleries. Never mutates the input.
 */
export function normalizeContentItem<T = Record<string, unknown>>(item: T): T {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const source = item as unknown as MediaSource;
  const fields = resolveMediaFields(source);

  const next = { ...(item as Record<string, unknown>) } as Record<string, unknown>;
  next.mediaItems = fields.mediaItems;
  next.media = fields.media;
  next.image = fields.image;
  next.thumbnail = fields.thumbnail;
  next.videoUrl = fields.videoUrl;
  next.audioUrl = fields.audioUrl;
  next.mediaType = fields.mediaType;

  // A video-only item mislabeled as a still image should route as video.
  const type = String(next.type || next.contentType || '').toLowerCase();
  if (!type || type === 'image' || type === 'photo') {
    next.type = fields.videoUrl
      ? 'video'
      : fields.audioUrl
        ? 'audio'
        : (fields.media ? 'photo' : next.type);
  }
  // Keep the nested author object intact (thoughts render `user.username`)
  // and expose flat helpers for feeds that render a single string.
  const nestedUser = next.user && typeof next.user === 'object' && !Array.isArray(next.user)
    ? next.user as Record<string, unknown>
    : null;
  const rawUserName = typeof next.user === 'string'
    ? next.user
    : nestedUser
      ? String(nestedUser.username || nestedUser.name || nestedUser.handle || '')
      : '';
  const cleanUserName = rawUserName && !/^(anonymous|unknown|user|someone)$/i.test(rawUserName.trim())
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawUserName.trim())
    ? rawUserName.trim()
    : '';
  if (cleanUserName) {
    next.userName = cleanUserName;
    if (!next.creator || /^(anonymous|unknown)$/i.test(String(next.creator))) next.creator = cleanUserName;
    if (!next.avatar) {
      const avatar = nestedUser
        ? (nestedUser.avatar_url || nestedUser.avatarUrl || nestedUser.avatar)
        : '';
      if (typeof avatar === 'string' && avatar) next.avatar = avatar;
    }
  }
  return next as unknown as T;
}

/** Normalise a list, preserving nulls/ads/other non-content entries. */
export function normalizeContentList<T = Record<string, unknown>>(items: unknown): T[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => normalizeContentItem(item as T));
}

/** Convenience wrappers used by feeds that receive already-normalised items. */
export function imageOf(item: MediaSource | null | undefined): string {
  if (!item) return '';
  return resolveMediaFields(item).image;
}

export function videoOf(item: MediaSource | null | undefined): string {
  if (!item) return '';
  return resolveMediaFields(item).videoUrl;
}

export function isVideoItem(item: MediaSource | null | undefined): boolean {
  if (!item) return false;
  return Boolean(resolveMediaFields(item).videoUrl);
}
