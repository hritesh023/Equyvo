// Equyvo backend service — runs on Contabo VPS (Docker).
// Exposed to Cloudflare only via cloudflared tunnel (never public DB ports).
// Implements: health, DB/Redis checks, real-email verification, storage metrics,
// and D1-fallback guard support. Route handlers migrate from Cloudflare Pages
// Functions (KV) to this service during the dual-write phase.

import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import Redis from 'ioredis';
import dns from 'node:dns/promises';
import net from 'node:net';

const app = express();
app.use(express.json({ limit: '1mb' }));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://equyvo_app:change-me@127.0.0.1:5433/equyvo',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6380', {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

function serviceAuth(req, res, next) {
  const token = req.header('x-service-token');
  if (!process.env.EQUYVO_SERVICE_TOKEN || token !== process.env.EQUYVO_SERVICE_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', async (req, res) => {
  let db = 'down', cache = 'down';
  try { await pool.query('SELECT 1'); db = 'up'; } catch {}
  try { await redis.ping(); cache = 'up'; } catch {}
  const status = db === 'up' && cache === 'up' ? 'ok' : 'degraded';
  res.status(status === 'ok' ? 200 : 503).json({
    status, db, redis: cache, version: process.env.APP_VERSION || '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// Real-email verification: DNS MX + SMTP RCPT probe. Used by Cloudflare edge
// before allowing account creation.
app.post('/equyvo-api/auth/verify-email', serviceAuth, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ exists: false, error: 'invalid format' });
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  let mxHosts = [];
  try {
    const mx = await dns.resolveMx(domain);
    mxHosts = (mx || []).sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch {
    // Fall back to A record.
    try { await dns.resolve4(domain); mxHosts = [domain]; } catch { mxHosts = []; }
  }
  if (!mxHosts.length) return res.json({ exists: false });
  // SMTP probe (best-effort, short timeout).
  const probe = (host) => new Promise((resolve) => {
    const sock = net.createConnection({ host, port: 25, timeout: 4000 });
    let step = 0;
    const commands = ['HELO equyvo.com\r\n', 'MAIL FROM:<verify@equyvo.com>\r\n', 'RCPT TO:<' + email + '>\r\n', 'QUIT\r\n'];
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (step === 0 && /^220/.test(buf)) { sock.write(commands[step++]); buf = ''; }
      else if (step > 0 && step < 3 && /^[23]\d\d/.test(buf)) { sock.write(commands[step++]); buf = ''; }
      else if (step === 3 && /^[23]\d\d/.test(buf)) { resolve(true); sock.end(); }
      else if (/^[45]\d\d/.test(buf)) { resolve(false); sock.end(); }
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
    sock.on('close', () => resolve(null));
  });
  let exists = null;
  for (const host of mxHosts.slice(0, 2)) {
    exists = await probe(host);
    if (exists !== null) break;
  }
  if (exists === null) exists = true; // fail-open
  return res.json({ exists });
});

// Storage metrics for the guard: disk + ram usage of Contabo.
app.get('/equyvo-api/contabo/storage', serviceAuth, async (req, res) => {
  // Best-effort: read from /proc or df. Container may not have host metrics;
  // fall back to env-provided values or sane defaults.
  let diskUsedGB = Number(process.env.CONTABO_DISK_USED_GB || 0);
  let diskTotalGB = Number(process.env.CONTABO_DISK_TOTAL_GB || 300);
  let ramUsedGB = Number(process.env.CONTABO_RAM_USED_GB || 0);
  let ramTotalGB = Number(process.env.CONTABO_RAM_TOTAL_GB || 24);
  try {
    // Try to read actual container memory from /proc/meminfo.
    const fs = await import('node:fs/promises');
    const mem = await fs.readFile('/proc/meminfo', 'utf8').catch(() => '');
    const total = /MemTotal:\s+(\d+)/.exec(mem);
    const avail = /MemAvailable:\s+(\d+)/.exec(mem);
    if (total && avail) {
      const totalKb = Number(total[1]); const availKb = Number(avail[1]);
      ramTotalGB = totalKb / 1024 / 1024;
      ramUsedGB = (totalKb - availKb) / 1024 / 1024;
    }
  } catch { /* ignore */ }
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync("df -BG / | tail -1", { encoding: 'utf8' });
    const parts = out.trim().split(/\s+/);
    // Filesystem Size Used Avail Use% Mounted
    if (parts.length >= 3) {
      diskTotalGB = Number(String(parts[1]).replace('G', '')) || diskTotalGB;
      diskUsedGB = Number(String(parts[2]).replace('G', '')) || diskUsedGB;
    }
  } catch { /* ignore */ }
  return res.json({ diskUsedGB, diskTotalGB, ramUsedGB, ramTotalGB });
});

// Placeholder: identity verification is currently done at the Cloudflare edge.
app.get('/api/v1/me', async (req, res) => {
  const userId = req.header('x-user-id');
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await pool.query(
      'SELECT id, cognito_sub, email, username FROM users WHERE id = $1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await pool.end();
  redis.disconnect();
  process.exit(0);
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`equyvo-backend listening on ${port}`));