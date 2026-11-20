import React, { useEffect, useState } from 'react';
import { Music2, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getExternalAudioState,
  isValidExternalAudio,
  stopExternalAudio,
  subscribeExternalAudio,
  toggleExternalAudio,
  type ExternalAudioTrack,
} from '@/lib/external-audio';

interface Props {
  audio: unknown;
  className?: string;
}

/**
 * Music tag shown on posts that carry external audio (Moments + Photos).
 * Tapping it previews the track; only one track plays app-wide.
 */
const ExternalAudioChip: React.FC<Props> = ({ audio, className }) => {
  const track: ExternalAudioTrack | null = isValidExternalAudio(audio) ? audio : null;
  const [playing, setPlaying] = useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => {
      const state = getExternalAudioState();
      setPlaying(state.playing && !!track && state.id === track.id);
    };
    sync();
    const unsubscribe = subscribeExternalAudio(sync);
    const onEvent = () => sync();
    window.addEventListener('equyvo:external-audio', onEvent);
    return () => {
      unsubscribe();
      window.removeEventListener('equyvo:external-audio', onEvent);
    };
  }, [track?.id]);

  // Stop when the viewer is closed or hidden behind another cached page.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const el = rootRef.current;
      const nowVisible = !el || el.getBoundingClientRect().width > 0;
      const state = getExternalAudioState();
      if (!nowVisible && state.playing && state.id === track?.id) stopExternalAudio();
    }, 300);
    return () => {
      window.clearInterval(timer);
      const state = getExternalAudioState();
      if (state.playing && state.id === track?.id) stopExternalAudio();
    };
  }, [track?.id]);

  if (!track) return null;

  return (
    <div ref={rootRef} className={cn('flex items-center', className)} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => toggleExternalAudio(track)}
        className="flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs text-white backdrop-blur-sm transition hover:bg-white/25"
        title={playing ? 'Pause audio' : `Play audio: ${track.name}`}
      >
        {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        <Music2 className="h-3 w-3" />
        <span className="max-w-[130px] truncate">{track.name}</span>
      </button>
    </div>
  );
};

export default ExternalAudioChip;
