import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useNavigate } from 'react-router-dom';
import { 
  Maximize2, 
  Minimize2, 
  Eye, 
  Clock, 
  ThumbsUp, 
  MessageCircle,
  Share2,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Image as ImageIcon
} from 'lucide-react';
import VideoSeekBar from './VideoSeekBar';
import ExpandableDescription from './ExpandableDescription';
import { cn } from '@/lib/utils';
import { showSuccess, showError } from '@/utils/toast';
import { shareItem } from '@/utils/share';
import ReportButton from './ReportButton';
import type { ContentIndexItem } from '@/lib/content-index';

interface SplitScreenViewProps {
  items: ContentIndexItem[];
  selectedItem: ContentIndexItem | null;
  onSelectItem: (item: ContentIndexItem) => void;
  onClose: () => void;
  onFullscreen?: (content: any) => void;
  className?: string;
}

const SplitScreenView: React.FC<SplitScreenViewProps> = ({
  items,
  selectedItem,
  onSelectItem,
  onClose,
  onFullscreen,
  className = ''
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Same control set as the fullscreen media player: play/pause, mute, seek
  // bar with preview and time. Native <video controls> are intentionally off
  // so the player looks identical everywhere (except Moments/Story).
  const splitVideoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const navigate = useNavigate();

  const togglePlay = () => {
    const v = splitVideoRef.current;
    if (!v) return;
    if (v.paused) { void v.play().catch(() => {}); } else { v.pause(); }
  };
  const toggleMute = () => {
    const v = splitVideoRef.current;
    const next = !isMuted;
    if (v) v.muted = next;
    setIsMuted(next);
  };
  const formatTime = (seconds: number) => {
    const s = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  useEffect(() => {
    setIsPlaying(false);
    setIsMuted(true);
    setCurrentTime(0);
    setDuration(0);
  }, [selectedItem?.id]);

  const handleShare = async () => {
    if (!selectedItem) return;
    const shareUrl = `${window.location.origin}/app/home?post=${encodeURIComponent(selectedItem.id)}`;
    const result = await shareItem(selectedItem.id, {
      title: selectedItem.title || 'Check this out on Equyvo',
      text: selectedItem.description || selectedItem.title || '',
      url: shareUrl,
    });
    if (!result.success && !result.cancelled) {
      showError(result.error || 'Could not share this content');
      return;
    }
    if (result.success && result.recorded === false) {
      showError(result.error || 'The share count could not be saved');
    }
  };

  const handleToggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  const formatNumber = (num: string | number) => {
    const n = typeof num === 'number' ? num : parseInt(num);
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return n.toString();
  };

  return (
    <div className={cn(
      // Bar-anchored overlay: sits between the shell's in-flow bars so the
      // app navigation (Home, Discover, Create, Moments…) stays visible
      // while the desktop/split view is open.
      'bar-anchored-overlay bg-background/95 backdrop-blur-sm z-50 flex',
      className
    )}>
      <div className={cn(
        'flex min-h-0 w-full h-full flex-col sm:flex-row',
        isFullscreen ? 'gap-0' : 'gap-2 p-2 sm:gap-4 sm:p-4'
      )}>
        {/* Left Panel - Video/Content Viewer */}
        <div className={cn(
          'flex-1 min-h-0 flex flex-col bg-background overflow-hidden',
          isFullscreen ? 'sm:w-2/3' : ''
        )}>
          {selectedItem ? (
            <>
              {/* Content Header */}
              <div className="p-4 border-b border-border">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h2 className="text-xl font-bold mb-2">{selectedItem.title}</h2>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span>{selectedItem.creator}</span>
                      <div className="flex items-center gap-1">
                        <Eye className="h-4 w-4" />
                        {formatNumber(selectedItem.views)} views
                      </div>
                      <div className="flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        {selectedItem.publishedAt}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ReportButton
                      contentId={selectedItem.id}
                      contentType={selectedItem.type === 'video' ? 'video' : 'post'}
                      variant="icon"
                    />
                    <Button variant="ghost" size="sm" onClick={handleShare} aria-label="Share this content" title="Share this content" disabled={!selectedItem}>
                      <Share2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Content Display */}
              <div className="flex-1 overflow-y-auto p-4">
                {/* Main Content */}
                <div className="mb-4">
                  {selectedItem.type === 'video' ? (
                    <div 
                      className="relative aspect-video bg-black rounded-lg overflow-hidden cursor-pointer"
                      onClick={() => {
                        // Create fullscreen content similar to LongFormVideos
                        const fullscreenContent = {
                          ...selectedItem,
                          type: 'video',
                          mediaUrl: selectedItem.videoUrl,
                          thumbnail: selectedItem.thumbnail,
                          title: selectedItem.title,
                          caption: selectedItem.description,
                          creator: selectedItem.creator
                        };
                        // Call the onFullscreen callback if provided
                        if (onFullscreen) {
                          onFullscreen(fullscreenContent);
                        }
                      }}
                    >
                      {selectedItem.videoUrl ? (
                      <video
                        ref={splitVideoRef}
                        src={selectedItem.videoUrl}
                        className="w-full h-full object-contain"
                        controls={false}
                        playsInline
                        autoPlay
                        muted={isMuted}
                        poster={selectedItem.thumbnail}
                        preload="metadata"
                        onPlay={() => setIsPlaying(true)}
                        onPause={() => setIsPlaying(false)}
                        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                        onError={(e) => {
                          const v = e.currentTarget;
                          const attempts = Number(v.dataset.splitRetry || '0');
                          if (selectedItem.videoUrl && attempts < 2) {
                            v.dataset.splitRetry = String(attempts + 1);
                            v.src = `${selectedItem.videoUrl}${selectedItem.videoUrl.includes('?') ? '&' : '?'}retry=${attempts + 1}`;
                            v.load();
                          }
                        }}
                      />
                      ) : null}
                      {/* Canonical player controls — identical to the
                          fullscreen player (except Moments / Story). */}
                      {selectedItem.videoUrl && (
                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2 pt-6 text-white" onClick={(e) => e.stopPropagation()}>
                          <VideoSeekBar
                            videoRef={splitVideoRef as React.RefObject<HTMLVideoElement>}
                            currentTime={currentTime}
                            duration={duration || 0}
                            onSeek={(time: number) => {
                              const v = splitVideoRef.current;
                              if (v) v.currentTime = time;
                              setCurrentTime(time);
                            }}
                          />
                          <div className="mt-1 flex items-center gap-3">
                            <button type="button" onClick={togglePlay} aria-label={isPlaying ? 'Pause' : 'Play'} className="rounded-full p-1.5 hover:bg-white/15">
                              {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                            </button>
                            <button type="button" onClick={() => {
                              const v = splitVideoRef.current;
                              if (v) v.currentTime = Math.max(0, v.currentTime - 5);
                            }} aria-label="Rewind 5 seconds" className="rounded-full p-1.5 hover:bg-white/15">
                              <span className="text-xs font-semibold">−5</span>
                            </button>
                            <button type="button" onClick={() => {
                              const v = splitVideoRef.current;
                              if (v) v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
                            }} aria-label="Forward 5 seconds" className="rounded-full p-1.5 hover:bg-white/15">
                              <span className="text-xs font-semibold">+5</span>
                            </button>
                            <button type="button" onClick={toggleMute} aria-label={isMuted ? 'Unmute' : 'Mute'} className="rounded-full p-1.5 hover:bg-white/15">
                              {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                            </button>
                            <span className="text-xs tabular-nums">{formatTime(currentTime)} / {formatTime(duration)}</span>
                          </div>
                        </div>
                      )}
                      {/* Play button overlay */}
                      <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity pointer-events-none">
                        <div className="bg-white/90 rounded-full p-4 shadow-lg">
                          <Maximize2 className="h-6 w-6 text-black" />
                        </div>
                      </div>
                      {!selectedItem.videoUrl && (
                        <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                          Click for fullscreen
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="relative">
                      <img
                        src={selectedItem.thumbnail}
                        alt={selectedItem.title}
                        className="w-full rounded-lg"
                        onError={(e) => {
                          const img = e.currentTarget;
                          const attempts = Number(img.dataset.splitRetry || '0');
                          const base = selectedItem.thumbnail || '';
                          if (!base) { img.style.display = 'none'; return; }
                          if (attempts < 1) {
                            img.dataset.splitRetry = '1';
                            img.src = `${base}${base.includes('?') ? '&' : '?'}retry=1`;
                          } else {
                            img.style.display = 'none';
                          }
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* Content Info */}
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold mb-2">Description</h3>
                    <ExpandableDescription text={selectedItem.description} className="text-muted-foreground" />
                  </div>

                  <div>
                    <h3 className="font-semibold mb-2">Category & Tags</h3>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="secondary">{selectedItem.category}</Badge>
                      {selectedItem.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs cursor-pointer" onClick={() => navigate(`/app/discover?tag=${encodeURIComponent(String(tag).replace(/^#/, '').toLowerCase())}`)}>
                          #{tag}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <Separator />

                  {/* Engagement Stats */}
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2">
                      <ThumbsUp className="h-5 w-5 text-muted-foreground" />
                      <span>{selectedItem.likes ? formatNumber(selectedItem.likes) : '0'}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <MessageCircle className="h-5 w-5 text-muted-foreground" />
                      <span>{selectedItem.comments ? formatNumber(selectedItem.comments) : '0'}</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <ImageIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>Select an item to preview</p>
              </div>
            </div>
          )}
        </div>

        {/* Right Panel - Content List for Browsing (stacks under the viewer
            on phones so both halves are usable without horizontal squeeze) */}
        <div className={cn(
          'bg-background border-t sm:border-t-0 sm:border-l border-border overflow-hidden flex flex-col h-[45%] shrink-0 sm:h-auto sm:shrink sm:min-h-0',
          isFullscreen ? 'sm:w-1/3' : 'sm:w-1/2 sm:max-w-md'
        )}>
          {/* Header */}
          <div className="p-4 border-b border-border">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Browse Content</h3>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleToggleFullscreen}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
                <Button variant="ghost" size="sm" onClick={onClose}>
                  ×
                </Button>
              </div>
            </div>
          </div>

          {/* Content List */}
          <div className="flex-1 overflow-y-auto">
            {items.map((item) => (
              <Card
                key={item.id}
                className={cn(
                  'm-2 cursor-pointer transition-all hover:shadow-md',
                  selectedItem?.id === item.id && 'ring-2 ring-primary'
                )}
                onClick={() => onSelectItem(item)}
              >
                <CardContent className="p-3">
                  <div className="flex gap-3">
                    <div className="relative flex-shrink-0">
                      <img
                        src={item.thumbnail}
                        alt={item.title}
                        className="w-20 h-14 object-cover rounded"
                        onError={(e) => {
                          const img = e.currentTarget;
                          const base = item.thumbnail || '';
                          if (!base) { img.style.display = 'none'; return; }
                          const attempts = Number(img.dataset.listRetry || '0');
                          if (attempts < 1) {
                            img.dataset.listRetry = '1';
                            img.src = `${base}${base.includes('?') ? '&' : '?'}retry=1`;
                          } else {
                            img.style.display = 'none';
                          }
                        }}
                      />
                      {item.type === 'video' && (
                        <div className="absolute inset-0 bg-black/40 rounded flex items-center justify-center">
                          <Play className="h-4 w-4 text-white" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-sm line-clamp-1 mb-1">
                        {item.title}
                      </h4>
                      <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                        {item.description}
                      </p>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{item.creator}</span>
                        <div className="flex items-center gap-1">
                          <Eye className="h-3 w-3" />
                          {formatNumber(item.views)}
                        </div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SplitScreenView;
