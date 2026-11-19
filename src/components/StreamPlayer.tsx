import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Gauge, Layers, Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface StreamPlayerProps {
  src: string;
  poster?: string;
  lowLatency?: boolean;
  onEnded?: () => void;
}

/** Cloudflare Stream HLS player: adaptive bitrate, quality selector,
 *  low-latency mode, DVR/seek, and recovery — the YouTube/Twitch-style path. */
const StreamPlayer: React.FC<StreamPlayerProps> = ({ src, poster, lowLatency = true, onEnded }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<{ index: number; label: string }[]>([]);
  const [level, setLevel] = useState(-1);
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');
  const [info, setInfo] = useState({ bitrate: 0, latency: 0, buffered: 0 });
  const [retryKey, setRetryKey] = useState(0);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    let hls: Hls | null = null;
    setStatus('loading');

    const useNative = video.canPlayType('application/vnd.apple.mpegurl');
    if (useNative) {
      video.src = src;
      video.play().catch(() => undefined);
      setStatus('playing');
    } else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: lowLatency,
        backBufferLength: 90, // DVR window
        liveSyncDurationCount: lowLatency ? 1 : 3,
        liveMaxLatencyDurationCount: lowLatency ? 4 : 8,
        maxLiveSyncPlaybackRate: lowLatency ? 1.5 : 1,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels.map((l, i) => ({
          index: i,
          label: l.height ? `${l.height}p${l.frameRate ? ` ${Math.round(l.frameRate)}fps` : ''}` : `${Math.round((l.bitrate || 0) / 1000)} kbps`,
        })));
        video.play().catch(() => undefined);
        setStatus('playing');
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
        else setStatus('error');
      });
      const poll = setInterval(() => {
        if (!hls) return;
        const lvl = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0];
        setInfo({
          bitrate: Math.round((lvl?.bitrate || 0) / 1000),
          latency: Math.round(hls.latency * 10) / 10,
          buffered: Math.round((video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0) * 10) / 10,
        });
      }, 1000);
      return () => { clearInterval(poll); hls?.destroy(); hlsRef.current = null; };
    } else {
      setStatus('error');
    }
    return () => { hls?.destroy(); hlsRef.current = null; };
  }, [src, lowLatency, retryKey]);

  const chooseLevel = (value: number) => {
    setLevel(value);
    if (hlsRef.current) hlsRef.current.currentLevel = value;
  };

  const goLive = () => {
    const video = videoRef.current;
    if (video && video.buffered.length) video.currentTime = video.buffered.end(video.buffered.length - 1) - 0.5;
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black">
      <video
        ref={videoRef}
        poster={poster}
        className="max-h-full max-w-full object-contain"
        playsInline
        controls={false}
        autoPlay
        onEnded={() => onEndedRef.current?.()}
        onClick={(e) => {
          e.stopPropagation();
          const v = e.currentTarget;
          if (v.paused) v.play().catch(() => undefined);
          else v.pause();
        }}
      />

      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
          <Loader2 className="h-8 w-8 animate-spin text-red-500" />
          <p className="text-sm">Starting stream…</p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-white">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm">This stream could not be loaded.</p>
          <Button size="sm" onClick={() => setRetryKey((k) => k + 1)} className="mt-2">
            <RotateCw className="mr-1 h-4 w-4" /> Retry
          </Button>
        </div>
      )}

      {status === 'playing' && (
        <>
          <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">● LIVE</span>
            <span className="rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white/90 backdrop-blur-sm">HLS · Adaptive</span>
          </div>
          <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
            {levels.length > 1 && (
              <label className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white backdrop-blur-sm">
                <Layers className="h-3 w-3" />
                <select
                  value={level}
                  onChange={(e) => chooseLevel(Number(e.target.value))}
                  className="bg-transparent text-[10px] text-white outline-none [&>option]:bg-black"
                  aria-label="Stream quality"
                >
                  <option value={-1}>Auto</option>
                  {levels.map((l) => <option key={l.index} value={l.index}>{l.label}</option>)}
                </select>
              </label>
            )}
            <span className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[10px] text-white backdrop-blur-sm">
              <Gauge className="h-3 w-3" /> {info.bitrate} kbps · {info.latency}s
            </span>
          </div>
          <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
            <button type="button" onClick={goLive} className="rounded-full bg-black/60 px-2.5 py-1 text-[10px] font-semibold text-white backdrop-blur-sm hover:bg-black/80">
              Go live
            </button>
            <span className="rounded-full bg-black/60 px-2 py-1 text-[10px] text-white/80 backdrop-blur-sm">DVR {info.buffered}s</span>
          </div>
        </>
      )}
    </div>
  );
};

export default StreamPlayer;
