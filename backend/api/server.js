// Equyvo backend service — runs on Contabo VPS (Docker).
// Exposed to Cloudflare only via cloudflared tunnel (never public DB ports).
// This is a scaffolding skeleton: health + DB/Redis checks + placeholder routes.
// Production route handlers will migrate from Cloudflare Pages Functions (KV)
// to this service during the dual-write phase (see BACKEND_ARCHITECTURE.md).

import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import Redis from 'ioredis';

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

// Placeholder: identity verification is currently done at the Cloudflare edge.
// This service trusts the X-User-Id / verified JWT passed by the edge proxy.
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
