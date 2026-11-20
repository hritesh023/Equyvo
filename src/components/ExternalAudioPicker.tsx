import React, { useEffect, useRef, useState } from 'react';
import { Music2, Pause, Play, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import api from '@/lib/api';
import { showError, showSuccess } from '@/utils/toast';
import {
  getExternalAudioState,
  loadSavedExternalAudio,
  playExternalAudio,
  saveExternalAudio,
  stopExternalAudio,
  subscribeExternalAudio,
  toggleExternalAudio,
  type ExternalAudioTrack,
} from '@/lib/external-audio';

interface Props {
  track: ExternalAudioTrack | null;
  onChange: (track: ExternalAudioTrack | null) => void;
  /** Compact layout for the full-screen camera controls. */
  compact?: boolean;
  /** Only Moments + Photos may use external audio. */
  allowed?: boolean;
}

/**
 * Add / preview / remove background music for a Moment or Photo.
 * Audio files are uploaded up front so the track URL is durable and can be
 * saved with the post (and played back wherever the post is displayed).
 */
const ExternalAudioPicker: React.FC<Props> = ({ track, onChange, compact = false, allowed = true }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const saved = loadSavedExternalAudio();

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

  // A removed track must not keep playing in the background.
  useEffect(() => () => {
    const state = getExternalAudioState();
    if (state.playing && state.id === track?.id) stopExternalAudio();
  }, [track?.id]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/') && !/\.(mp3|m4a|aac|ogg|wav|webm)$/i.test(file.name)) {
      showError('Please choose an audio file (MP3, M4A, WAV, OGG…).');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await api.uploadFile(file, 'equyvo/audio');
      if (error || !data?.secureUrl) throw new Error(error || 'Audio upload failed');
      const next: ExternalAudioTrack = {
        id: `audio-${data.publicId || Date.now()}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        creator: 'You',
        url: String(data.secureUrl),
        from: 'moment',
      };
      saveExternalAudio(next);
      onChange(next);
      setOpen(false);
      showSuccess('Audio added. It will play with your Moment or Photo.');
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Could not add this audio.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const useSaved = () => {
    if (!saved) return;
    onChange(saved);
    setOpen(false);
    showSuccess('Saved audio attached.');
  };

  if (!allowed) return null;

  const cardClass = compact
    ? 'flex w-full items-center gap-2 rounded-full border border-white/30 bg-black/70 px-3 py-2 text-white backdrop-blur'
    : 'flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3';

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        className="sr-only"
        onChange={(e) => void pickFile(e.target.files?.[0])}
      />
      {track ? (
        <div className={cardClass}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-fuchsia-600/50 to-blue-600/50">
            {track.cover ? (
              <img src={track.cover} alt="" className="h-full w-full object-cover" />
            ) : (
              <Music2 className="h-5 w-5 text-white" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className={`truncate font-medium ${compact ? 'text-xs' : 'text-sm'}`}>{track.name}</p>
            <p className={`truncate ${compact ? 'text-[10px] text-white/60' : 'text-xs text-muted-foreground'}`}>
              External audio · {track.creator}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => toggleExternalAudio(track)}
            aria-label={playing ? 'Pause audio preview' : 'Play audio preview'}
            className={compact ? 'h-8 w-8 text-white hover:bg-white/20 hover:text-white' : 'h-8 w-8'}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => { stopExternalAudio(); onChange(null); }}
            aria-label="Remove external audio"
            className={compact ? 'h-8 w-8 text-white/80 hover:bg-white/20 hover:text-white' : 'h-8 w-8 text-destructive'}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant={compact ? 'secondary' : 'outline'}
          size={compact ? 'sm' : 'default'}
          onClick={() => setOpen(true)}
          className={compact ? 'rounded-full border-white/30 bg-black/70 text-white hover:bg-black/90 hover:text-white' : 'w-full'}
        >
          <Music2 className="mr-2 h-4 w-4" /> Add external audio
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Music2 className="h-5 w-5" /> External audio</DialogTitle>
            <DialogDescription>
              Add background music to this Moment or Photo. Only these two post types support external audio.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="mr-2 h-4 w-4" /> {busy ? 'Uploading audio…' : 'Upload an audio file'}
            </Button>
            {saved && (
              <Button type="button" variant="secondary" className="w-full justify-start" onClick={useSaved}>
                <Music2 className="mr-2 h-4 w-4" />
                <span className="truncate">Use saved audio: {saved.name}</span>
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Tip: tap the music tag at the bottom of a Moment, then “Use this audio” to bring its audio here.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ExternalAudioPicker;
