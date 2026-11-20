import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Music2, Pause, Play, Repeat2, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  externalAudioDestination,
  getExternalAudioElement,
  getExternalAudioState,
  loadSavedExternalAudio,
  pauseExternalAudio,
  playExternalAudio,
  readExternalAudioFromSearch,
  saveExternalAudio,
  stopExternalAudio,
  subscribeExternalAudio,
  type ExternalAudioTrack,
} from '@/lib/external-audio';
import { classifyAudio, isReusableAudio } from '@/lib/audio-guard';
import { getStoredUser } from '@/lib/auth';

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Full-screen "Use this audio" page opened from the music pill on a Moment.
 * A single audio player previews the track; the CTA carries it into the
 * Moments / Photos composer (the only two surfaces that support it).
 */
const UseAudioPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rootRef = useRef<HTMLDivElement>(null);
  const [track, setTrack] = useState<ExternalAudioTrack | null>(() => (
    readExternalAudioFromSearch(searchParams.toString()) || loadSavedExternalAudio()
  ));
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Rights guard: original audio from someone else's Moment is view-only.
  const [allowed, setAllowed] = useState(() => isReusableAudio(track));

  const trackKey = useMemo(() => (track ? `${track.id}|${track.url}` : ''), [track]);

  useEffect(() => {
    const next = readExternalAudioFromSearch(searchParams.toString());
    if (next) setTrack(next);
  }, [searchParams]);

  // Re-run the AI + ownership guard even for a deep link (URLs can be forged).
  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    setAllowed(isReusableAudio(track));
    void classifyAudio(track, getStoredUser()?.id || '').then((verdict) => {
      if (cancelled) return;
      setAllowed(verdict.reusable);
      if (verdict.reusable) saveExternalAudio(track);
    });
    return () => { cancelled = true; };
  }, [trackKey]);

  // Only this page's player may be active while it is mounted/visible, and
  // only licensed music is previewed.
  useEffect(() => {
    if (!track || !allowed) return;
    const t = window.setTimeout(() => playExternalAudio(track), 80);
    return () => { window.clearTimeout(t); stopExternalAudio(); };
  }, [trackKey, allowed]);

  useEffect(() => {
    const sync = () => setPlaying(getExternalAudioState().playing);
    sync();
    const unsubscribe = subscribeExternalAudio(sync);
    const onEvent = () => sync();
    window.addEventListener('equyvo:external-audio', onEvent);
    return () => {
      unsubscribe();
      window.removeEventListener('equyvo:external-audio', onEvent);
    };
  }, []);

  // Keep progress in sync with the shared player element.
  useEffect(() => {
    const el = getExternalAudioElement();
    if (!el) return;
    const onTime = () => setCurrentTime(el.currentTime || 0);
    const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
    onTime();
    onMeta();
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
    };
  }, [trackKey, playing]);

  // Keep-alive pages are hidden with display:none instead of unmounted.
  // Pause the preview as soon as this page leaves the screen.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const el = rootRef.current;
      if (el && el.getBoundingClientRect().width === 0 && getExternalAudioState().playing) {
        pauseExternalAudio();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const toggle = useCallback(() => {
    if (!track || !allowed) return;
    const el = getExternalAudioElement();
    if (getExternalAudioState().id === track.id && el) {
      if (getExternalAudioState().playing) pauseExternalAudio();
      else { void el.play().catch(() => undefined); }
    } else {
      playExternalAudio(track);
    }
  }, [track, allowed]);

  const seek = (value: number) => {
    const el = getExternalAudioElement();
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.max(0, Math.min(value, el.duration));
    setCurrentTime(el.currentTime);
  };

  const useThisAudio = () => {
    if (!track || !allowed) return;
    saveExternalAudio(track);
    stopExternalAudio();
    navigate(externalAudioDestination(track));
  };

  return (
    <div ref={rootRef} className="fixed inset-0 z-[200] flex flex-col bg-black text-white">
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30 blur-2xl"
        style={track?.cover ? { backgroundImage: `url("${track.cover}")` } : undefined}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/70 to-black" />

      <header className="relative z-10 flex items-center gap-3 px-4 pt-[max(env(safe-area-inset-top,0px),1rem)] pb-4">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-wide text-white/60">Use this audio</p>
          <p className="truncate text-base font-semibold">{track?.name || 'Original audio'}</p>
        </div>
      </header>

      {!track ? (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <Music2 className="h-14 w-14 text-white/40" />
          <p className="text-lg font-semibold">No audio selected</p>
          <p className="text-sm text-white/60">Open the music tag on a Moment, then tap “Use this audio”.</p>
          <Button onClick={() => navigate('/app/moments')} className="mt-2">Browse moments</Button>
        </div>
      ) : (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-8 pb-[max(env(safe-area-inset-bottom,1rem),1.5rem)]">
          <div className="relative mb-8 h-64 w-64 overflow-hidden rounded-3xl border border-white/15 bg-white/5 shadow-2xl">
            {track.cover ? (
              <img src={track.cover} alt={`${track.name} cover`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-fuchsia-600/40 via-violet-600/30 to-blue-600/40">
                <Music2 className="h-20 w-20 text-white/70" />
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-4 pb-4 pt-10">
              <p className="truncate text-sm font-semibold">{track.name}</p>
              <p className="truncate text-xs text-white/65">{track.creator}</p>
            </div>
          </div>

          {allowed ? (
            /* The one and only audio preview player on this page. */
            <div className="w-full max-w-md space-y-3">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  aria-label={playing ? 'Pause audio' : 'Play audio'}
                  onClick={toggle}
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-black transition hover:scale-105"
                >
                  {playing ? <Pause className="h-6 w-6 fill-black" /> : <Play className="ml-0.5 h-6 w-6 fill-black" />}
                </button>
                <div className="flex-1">
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={Math.min(currentTime, duration || 0)}
                    onChange={(e) => seek(Number(e.target.value))}
                    aria-label="Audio progress"
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/25 accent-white"
                  />
                  <div className="mt-2 flex justify-between text-[11px] tabular-nums text-white/50">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                </div>
                <Repeat2 className="h-4 w-4 shrink-0 text-white/50" aria-label="Loops continuously" />
              </div>
              <p className="flex items-center justify-center gap-2 text-xs text-white/50">
                <Volume2 className="h-3.5 w-3.5" /> Previewing licensed music
              </p>
            </div>
          ) : (
            <div className="w-full max-w-md rounded-2xl border border-amber-400/30 bg-amber-500/10 p-5 text-center">
              <p className="text-sm font-semibold text-amber-200">Original audio — view only</p>
              <p className="mt-2 text-xs leading-relaxed text-amber-100/70">
                {track.guardReason || 'This is the creator’s original audio, not licensed music.'}
                Original audio cannot be used to compose a Moment or Photo. Upload your own audio in the Create page instead.
              </p>
            </div>
          )}

          <div className="mt-auto w-full max-w-md pt-8">
            <Button
              onClick={useThisAudio}
              disabled={!allowed}
              title={allowed ? 'Use this audio' : 'Original audio cannot be reused'}
              className="h-14 w-full rounded-full bg-white text-base font-bold text-black hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/50"
            >
              <Music2 className="mr-2 h-5 w-5" /> Use this audio
            </Button>
            <p className="mt-3 text-center text-[11px] leading-snug text-white/45">
              Only licensed music or audio you uploaded can be added to Moments and Photos.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default UseAudioPage;
