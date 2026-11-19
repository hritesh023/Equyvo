// Equyvo real-time live relay.
//
// A Durable Object holds one room per live session. The broadcaster pushes
// video frames (JPEG) and audio PCM chunks over a WebSocket; the room fans
// them out to every viewer immediately. This gives genuine real-time playback
// using only Cloudflare Workers we already own — no third-party streaming
// account or credentials required.
export interface Env {
  LIVE_ROOM: DurableObjectNamespace;
}

const MAX_VIEWERS = 500;
const MAX_MESSAGE_BYTES = 256 * 1024;

export class LiveRoom {
  private sessions = new Map<string, { ws: WebSocket; role: 'broadcaster' | 'viewer' }>();
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 400 });
    }
    const role = url.searchParams.get('role') === 'broadcaster' ? 'broadcaster' : 'viewer';
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.attach(server, role);
    return new Response(null, { status: 101, webSocket: client });
  }

  private attach(ws: WebSocket, role: 'broadcaster' | 'viewer'): void {
    ws.accept();
    const id = crypto.randomUUID();

    if (role === 'broadcaster') {
      // One active broadcaster per room. A second one replaces the first.
      for (const [key, session] of this.sessions) {
        if (session.role === 'broadcaster') {
          try { session.ws.close(4001, 'A new broadcaster took over'); } catch { /* ignore */ }
          this.sessions.delete(key);
        }
      }
    } else if (this.viewerCount() >= MAX_VIEWERS) {
      ws.close(4002, 'This live room is full');
      return;
    }

    this.sessions.set(id, { ws, role });
    try {
      ws.send(JSON.stringify({ type: 'ready', role, viewers: this.viewerCount() }));
    } catch { /* ignore */ }

    ws.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      const size = typeof data === 'string' ? data.length : (data instanceof ArrayBuffer ? data.byteLength : 0);
      if (!size || size > MAX_MESSAGE_BYTES) return;

      // Viewer ping/pong: echoed only to that viewer so they can estimate
      // one-way latency without relying on synchronised device clocks.
      if (role === 'viewer' && typeof data === 'string') {
        try {
          const msg = JSON.parse(data) as { type?: string; ts?: number };
          if (msg?.type === 'ping' && Number.isFinite(msg.ts)) {
            ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
            return;
          }
        } catch { /* ignore malformed ping */ }
      }

      // Only media from the broadcaster is forwarded. Viewers cannot inject
      // frames into someone else's live session.
      if (role !== 'broadcaster') return;
      for (const [key, session] of this.sessions) {
        if (key === id || session.role !== 'viewer') continue;
        if (session.ws.readyState === WebSocket.OPEN) {
          try { session.ws.send(data); } catch { /* drop a stalled viewer */ }
        }
      }
    });

    const cleanup = () => {
      this.sessions.delete(id);
      // Tell viewers their stream ended when the broadcaster disconnects.
      if (role === 'broadcaster') {
        for (const session of this.sessions.values()) {
          if (session.ws.readyState === WebSocket.OPEN) {
            try { session.ws.send(JSON.stringify({ type: 'ended' })); } catch { /* ignore */ }
          }
        }
      }
    };
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);
  }

  private viewerCount(): number {
    let n = 0;
    for (const session of this.sessions.values()) if (session.role === 'viewer') n++;
    return n;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const room = String(url.searchParams.get('room') || '').slice(0, 64);
    if (!room) return new Response('Missing room', { status: 400 });

    // Same-origin style guard: only Equyvo apps/sites may open a relay socket.
    const origin = request.headers.get('Origin') || '';
    if (origin) {
      const allowed = /^(https?:\/\/|capacitor:\/\/)(equyvo\.com|www\.equyvo\.com|equyvo\.acronous\.com|equyvo\.pages\.dev|.*\.equyvo\.pages\.dev|localhost(:\d+)?)$/i.test(origin);
      if (!allowed) return new Response('Forbidden origin', { status: 403 });
    }

    const id = env.LIVE_ROOM.idFromName(room);
    return env.LIVE_ROOM.get(id).fetch(request);
  },
};
