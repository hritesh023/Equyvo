// Real-time live relay client.
//
// Broadcaster: pushes canvas video frames + audio chunks to the room.
// Viewer: receives those frames and renders them as they arrive.
// Transport is a Cloudflare Durable Object WebSocket (see live-relay/).
const RELAY_BASE = (import.meta.env.VITE_LIVE_RELAY_URL as string | undefined)?.trim()
  || 'https://equyvo-live-relay.httpsacronous-landinghriteshkumarpatroworkersdev.workers.dev';

export interface RelayMessage {
  type: 'ready' | 'ended' | 'video' | 'audio' | 'viewers';
  data?: string;
  mime?: string;
  role?: string;
  viewers?: number;
}

export interface RelayHandlers {
  onVideo?: (dataUrl: string) => void;
  onAudio?: (base64: string, mime: string) => void;
  onEnded?: () => void;
  onReady?: (viewers: number) => void;
}

function socketUrl(room: string, role: 'broadcaster' | 'viewer'): string {
  const base = RELAY_BASE.replace(/^http/, 'ws');
  return `${base}/?room=${encodeURIComponent(room)}&role=${role}`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('Could not encode media chunk'));
    reader.readAsDataURL(blob);
  });
}

export class LiveRelay {
  private ws: WebSocket | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private audioRecorder: MediaRecorder | null = null;
  private audioStream: MediaStream | null = null;
  private closed = false;

  private constructor(private room: string, private role: 'broadcaster' | 'viewer', private handlers: RelayHandlers) {}

  static async connect(room: string, role: 'broadcaster' | 'viewer', handlers: RelayHandlers): Promise<LiveRelay> {
    const relay = new LiveRelay(room, role, handlers);
    await relay.open();
    return relay;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(socketUrl(this.room, this.role));
      this.ws = ws;
      ws.onopen = () => { if (!settled) { settled = true; resolve(); } };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('Live relay connection failed')); } };
      ws.onclose = () => {
        if (!settled) { settled = true; reject(new Error('Live relay closed before it opened')); }
        if (!this.closed) {
          this.closed = true;
          try { this.handlers.onEnded?.(); } catch { /* ignore */ }
        }
      };
      ws.onmessage = async (event) => {
        let msg: RelayMessage;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg.type === 'ready' || msg.type === 'viewers') {
          try { this.handlers.onReady?.(Number(msg.viewers || 0)); } catch { /* ignore */ }
          return;
        }
        if (msg.type === 'ended') {
          try { this.handlers.onEnded?.(); } catch { /* ignore */ }
          return;
        }
        if (msg.type === 'video' && msg.data) {
          try { this.handlers.onVideo?.(`data:image/jpeg;base64,${msg.data}`); } catch { /* ignore */ }
          return;
        }
        if (msg.type === 'audio' && msg.data) {
          try { this.handlers.onAudio?.(msg.data, msg.mime || 'audio/webm'); } catch { /* ignore */ }
        }
      };
    });
  }

  /** Starts capturing video frames + audio from an already-granted stream. */
  async startCapturing(stream: MediaStream): Promise<void> {
    if (this.role !== 'broadcaster') return;

    // Video frames via a hidden <video> → <canvas> → JPEG data URL.
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    try { await video.play(); } catch { /* some WebViews need a tick */ }
    this.videoEl = video;

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    this.frameTimer = setInterval(() => {
      if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        if (!video.videoWidth) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = canvas.toDataURL('image/jpeg', 0.6);
        const comma = frame.indexOf(',');
        if (comma < 0) return;
        this.send({ type: 'video', data: frame.slice(comma + 1) });
      } catch { /* skip a bad frame — keep the stream alive */ }
    }, 150);

    // Audio: audio-only MediaRecorder chunks are small (~1/sec) and decode
    // cleanly in the viewer's Web Audio context.
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length && typeof MediaRecorder !== 'undefined') {
      try {
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
          .find((m) => MediaRecorder.isTypeSupported(m)) || '';
        const audioStream = new MediaStream(audioTracks);
        this.audioStream = audioStream;
        const rec = mime ? new MediaRecorder(audioStream, { mimeType: mime }) : new MediaRecorder(audioStream);
        this.audioRecorder = rec;
        rec.ondataavailable = async (event) => {
          if (!event.data || event.data.size === 0 || this.closed) return;
          try {
            const data = await blobToBase64(event.data);
            this.send({ type: 'audio', data, mime: rec.mimeType || mime || 'audio/webm' });
          } catch { /* ignore a failed audio chunk */ }
        };
        rec.start(1000);
      } catch { /* video still streams without live audio */ }
    }
  }

  private send(message: RelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(message)); } catch { /* ignore */ }
  }

  close(): void {
    this.closed = true;
    if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = null; }
    if (this.audioRecorder && this.audioRecorder.state !== 'inactive') {
      try { this.audioRecorder.stop(); } catch { /* ignore */ }
    }
    try { this.audioStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.audioStream = null;
    this.audioRecorder = null;
    try { if (this.videoEl) this.videoEl.srcObject = null; } catch { /* ignore */ }
    this.videoEl = null;
    this.canvas = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}

/** True when a live session has a real-time relay available for viewers. */
export function relayRoomFor(contentId: string): string {
  return String(contentId || '').slice(0, 64);
}
