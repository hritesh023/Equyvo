import React, { useEffect, useRef, useState } from 'react';
import { Radio, Loader2, AlertTriangle } from 'lucide-react';
import { LiveRelay } from '@/lib/live-relay';

interface LiveRelayPlayerProps {
  room: string;
  onEnded?: () => void;
}

/** Renders a broadcaster's in-progress live session in real time. */
const LiveRelayPlayer: React.FC<LiveRelayPlayerProps> = ({ room, onEnded }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended' | 'error'>('connecting');

  useEffect(() => {
    let relay: LiveRelay | null = null;
    let cancelled = false;

    (async () => {
      try {
        relay = await LiveRelay.connect(room, 'viewer', {
          onReady: () => { if (!cancelled) setStatus('live'); },
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
            try { onEnded?.(); } catch { /* ignore */ }
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
  }, [room, onEnded]);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black">
      <canvas ref={canvasRef} className="max-h-full max-w-full object-contain" />
      {status === 'connecting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
          <Loader2 className="h-8 w-8 animate-pulse text-red-500" />
          <p className="text-sm">Connecting to live stream…</p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
          <AlertTriangle className="h-8 w-8 text-amber-400" />
          <p className="text-sm">Live stream is unavailable right now.</p>
          <p className="text-xs text-white/60">The replay will appear here after the stream ends.</p>
        </div>
      )}
      {status === 'ended' && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white">
          Live stream ended
        </div>
      )}
      <div className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white">
        <Radio className="h-3 w-3" /> LIVE
      </div>
    </div>
  );
};

export default LiveRelayPlayer;
