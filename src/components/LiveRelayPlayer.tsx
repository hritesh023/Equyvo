import React, { useEffect, useRef, useState } from 'react';
import { Radio, Loader2, AlertTriangle, Users, Gauge, RotateCw, Eye } from 'lucide-react';
import { LiveRelay } from '@/lib/live-relay';

interface LiveRelayPlayerProps {
  room: string;
  onEnded?: () => void;
}

type Status = 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error';

/** Renders a broadcaster's in-progress live session in real time. */
const LiveRelayPlayer: React.FC<LiveRelayPlayerProps> = ({ room, onEnded }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const onEndedRef = useRef(onEnded);
  onEndedRef.current = onEnded;
  const [status, setStatus] = useState<Status>('connecting');
  const [viewers, setViewers] = useState(0);
  const [latency, setLatency] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    let relay: LiveRelay | null = null;
    let cancelled = false;

    (async () => {
      try {
        relay = await LiveRelay.connect(room, 'viewer', {
          onReady: (n) => {
            if (cancelled) return;
            setViewers(n);
            setStatus('live');
          },
          onViewers: (n) => { if (!cancelled) setViewers(n); },
          onReconnecting: (a) => {
            if (cancelled) return;
            setAttempt(a);
            setStatus('reconnecting');
          },
          onLatency: (ms) => { if (!cancelled) setLatency(ms); },
          onVideo: (dataUrl) => {
            if (cancelled) return;
            const img = new Image();
            img.onload = () => {
              const canvas = canvasRef.current;
              if (!canvas || cancelled) return;
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
                canvas.width = img.naturalWidth || 640;
                canvas.height = img.naturalHeight || 360;
              }
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            };
            img.src = dataUrl;
          },
          onAudio: async (base64, mime) => {
            if (cancelled) return;
            try {
              const binary = atob(base64);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              let ctx = audioCtxRef.current;
              if (!ctx) {
                ctx = new AudioContext();
                audioCtxRef.current = ctx;
              }
              if (ctx.state === 'suspended') await ctx.resume();
              // Safari cannot decode WebM audio — video still plays.
              const decoded = await ctx.decodeAudioData(bytes.buffer);
              const source = ctx.createBufferSource();
              source.buffer = decoded;
              source.connect(ctx.destination);
              source.start();
            } catch { /* audio is best-effort; keep the video playing */ }
          },
          onEnded: () => {
            if (cancelled) return;
            setStatus('ended');
            try { onEndedRef.current?.(); } catch { /* ignore */ }
          },
        });
        if (cancelled) { relay.close(); relay = null; }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      try { relay?.close(); } catch { /* ignore */ }
      try { void audioCtxRef.current?.close(); } catch { /* ignore */ }
      audioCtxRef.current = null;
    };
  }, [room, retryKey]);

  const latencyLabel = latency === null
    ? '—'
    : latency < 1000 ? `${latency} ms` : `${(latency / 1000).toFixed(1)} s`;

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black" onClick={() => setShowStats((s) => !s)}>
      <canvas ref={canvasRef} className="max-h-full max-w-full object-contain" />

      {status === 'connecting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
          <Loader2 className="h-8 w-8 animate-pulse text-red-500" />
          <p className="text-sm">Connecting to live stream…</p>
        </div>
      )}
      {status === 'reconnecting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
          <RotateCw className="h-8 w-8 animate-spin text-red-500" />
          <p className="text-sm">Reconnecting… (attempt {attempt})</p>
          <p className="text-xs text-white/60">Your stream will resume automatically.</p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80 px-6 text-center text-white">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm">Live stream is unavailable right now.</p>
          <p className="text-xs text-white/60">The replay will appear here after the stream ends.</p>
          <button
            type="button"
            className="mt-3 rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-black"
            onClick={(e) => { e.stopPropagation(); setStatus('connecting'); setRetryKey((k) => k + 1); }}
          >
            Retry
          </button>
        </div>
      )}
      {status === 'ended' && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white">
          Live stream ended
        </div>
      )}

      {status !== 'error' && status !== 'ended' && (
        <>
          <div className="absolute left-3 top-3 flex items-center gap-1.5">
            <span className="flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">
              <Radio className="h-3 w-3" /> LIVE
            </span>
            {viewers > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
                <Users className="h-3 w-3" /> {viewers}
              </span>
            )}
          </div>

          {showStats && (
            <div className="absolute right-3 top-3 space-y-1 rounded-lg bg-black/75 px-3 py-2 text-[11px] text-white backdrop-blur-sm">
              <p className="font-semibold text-white/90">Stream stats</p>
              <p className="flex items-center gap-1.5"><Eye className="h-3 w-3" /> Viewers: {viewers}</p>
              <p className="flex items-center gap-1.5"><Gauge className="h-3 w-3" /> Latency: {latencyLabel}</p>
              <p>Connection: {status}</p>
              <p>Quality: Auto (relay)</p>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default LiveRelayPlayer;
