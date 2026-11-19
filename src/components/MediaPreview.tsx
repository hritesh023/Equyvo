import React from 'react';
import ResilientImage from '@/components/ResilientImage';

interface MediaPreviewProps {
  /** Playable media URL. Only used as a still frame when no poster exists. */
  src?: string;
  /** Poster / thumbnail shown to the user (never a native <video controls>). */
  poster?: string;
  alt?: string;
  /** Opens Equyvo's full-screen viewer — the same player Discover uses. */
  onClick?: () => void;
  /** Use when a parent card also handles clicks (avoids double handling). */
  stopPropagation?: boolean;
  className?: string;
  fit?: 'contain' | 'cover';
}

/**
 * Discover-style media poster with NO overlay details (no views, duration,
 * category, LIVE badge or action menu). Tapping opens Equyvo's full-screen
 * player so Home and Profile never show the browser's native video UI.
 */
const MediaPreview: React.FC<MediaPreviewProps> = ({
  src,
  poster,
  alt = 'Post media',
  onClick,
  stopPropagation = false,
  className = '',
  fit = 'contain',
}) => {
  const fitClass = fit === 'cover' ? 'object-cover' : 'object-contain';
  return (
    <div
      className={`relative overflow-hidden bg-black ${className}`}
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onClick?.();
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {poster ? (
        <ResilientImage
          src={poster}
          alt={alt}
          loading="lazy"
          className={`w-full h-full ${fitClass}`}
        />
      ) : src ? (
        <video
          src={src}
          className={`w-full h-full ${fitClass}`}
          muted
          playsInline
          preload="metadata"
        />
      ) : null}
    </div>
  );
};

export default MediaPreview;
