// Real-time live relay client.
//
// Broadcaster: pushes canvas video frames + audio chunks to the room.
// Viewer: receives those frames and renders them as they arrive.
// Transport is a Cloudflare Durable Object WebSocket (see live-relay/).
const RELAY_BASE = (import.meta.env.VITE_LIVE_RELAY_URL as string | undefined)?.trim()
  || 'https://equyvo-live-relay.httpsacronous-landinghriteshkumarpatroworkersdev.workers.dev';

const MAX_RECONNECTS = 12;

export interface RelayMessage {
  type: 'ready' | 'ended' | 'video' | 'audio' | 'viewers' | 'ping' | 'pong';
  data?: string;
  mime?: string;
  role?: string;
  viewers?: number;
  ts?: number;
}

export interface RelayHandlers {
  onVideo?: (dataUrl: string) => void;
  onAudio?: (base64: string, mime: string) => void;
  onEnded?: () => void;
  onReady?: (viewers: number) => void;
  onViewers?: (viewers: number) => void;
  onReconnecting?: (attempt: number) => void;
  /** One-way latency estimate from a relay ping/pong (clock-skew-free). */
  onLatency?: (ms: number) => void;
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
  private frameLoop: (() => void) | null = null;
  private frameIntervalMs = 150;
  private fastFrames = 0;
  private videoEl: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private audioRecorder: MediaRecorder | null = null;
  private audioStream: MediaStream | null = null;
  private endedByServer = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
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

      ws.onopen = () => {
        if (!settled) { settled = true; resolve(); }
        this.reconnectAttempt = 0;
        // Host and viewers both get latency + viewer-count telemetry.
        this.startPing();
      };
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('Live relay connection failed')); }
      };
      ws.onclose = () => {
        if (this.ws !== ws) return; // stale socket from an older attempt
        this.ws = null;
        this.stopPing();
        if (this.closed) return;
        if (this.endedByServer) {
          try { this.handlers.onEnded?.(); } catch { /* ignore */ }
          return;
        }
        // A dropped connection is NOT the end of the stream — retry with
        // capped exponential backoff instead of leaving the viewer stranded.
        this.scheduleReconnect();
      };
      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        let msg: RelayMessage;
        try { msg = JSON.parse(String(event.data)); } catch { return; }
        if (msg.type === 'ready' || msg.type === 'viewers') {
          const n = Number(msg.viewers || 0);
          try {
            // Only the initial 'ready' marks the connection healthy; later
            // 'viewers' pushes just refresh the audience count.
            if (msg.type === 'ready') this.handlers.onReady?.(n);
            this.handlers.onViewers?.(n);
          } catch { /* ignore */ }
          return;
        }
        if (msg.type === 'ended') {
          this.endedByServer = true;
          try { this.handlers.onEnded?.(); } catch { /* ignore */ }
          return;
        }
        if (msg.type === 'pong' && Number.isFinite(msg.ts)) {
          const rtt = Math.max(0, Date.now() - Number(msg.ts));
          try { this.handlers.onLatency?.(Math.round(rtt / 2)); } catch { /* ignore */ }
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

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > MAX_RECONNECTS) {
      try { this.handlers.onEnded?.(); } catch { /* ignore */ }
      return;
    }
    const delay = Math.min(8000, Math.round(400 * Math.pow(1.7, this.reconnectAttempt - 1)));
    try { this.handlers.onReconnecting?.(this.reconnectAttempt); } catch { /* ignore */ }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.open().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private startPing(): void {
    if (this.pingTimer) return;
    const sendPing = () => {
      if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ type: 'ping', ts: Date.now() });
    };
    sendPing();
    this.pingTimer = setInterval(sendPing, 5000);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
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
    // Some WebViews refuse play() until the element has rendered a frame.
    try {
      await video.play();
    } catch {
      await new Promise((r) => setTimeout(r, 80));
      try { await video.play(); } catch { /* frame loop retries too */ }
    }
    this.videoEl = video;

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Adaptive frame rate: back off when a frame costs too long to encode or
    // send (weak device/uplink), recover slowly when there is headroom.
    this.frameLoop = () => {
      if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        if (!video.videoWidth) {
          try { void video.play().catch(() => {}); } catch { /* ignore */ }
          return;
        }
        const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const start = now();
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = canvas.toDataURL('image/jpeg', 0.6);
        const comma = frame.indexOf(',');
        if (comma >= 0) this.send({ type: 'video', data: frame.slice(comma + 1) });
        const cost = now() - start;
        if (cost > this.frameIntervalMs * 0.85 && this.frameIntervalMs < 400) {
          this.frameIntervalMs = Math.min(400, this.frameIntervalMs + 50);
          this.scheduleFrameLoop();
        } else if (cost < this.frameIntervalMs * 0.3 && this.frameIntervalMs > 120) {
          this.fastFrames += 1;
          if (this.fastFrames >= 20) {
            this.frameIntervalMs = Math.max(120, this.frameIntervalMs - 30);
            this.fastFrames = 0;
            this.scheduleFrameLoop();
          }
        }
      } catch { /* skip a bad frame — keep the stream alive */ }
    };
    this.scheduleFrameLoop();

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

  private scheduleFrameLoop(): void {
    if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = null; }
    if (this.frameLoop) this.frameTimer = setInterval(this.frameLoop, this.frameIntervalMs);
  }

  private send(message: RelayMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(message)); } catch { /* ignore */ }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopPing();
    if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = null; }
    this.frameLoop = null;
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
