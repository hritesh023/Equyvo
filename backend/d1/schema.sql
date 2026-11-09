-- Cloudflare D1 fallback schema (used only when Contabo storage > 65%)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  username TEXT,
  is_private INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS storage_guard (
  id INTEGER PRIMARY KEY,
  contabo_used_gb REAL,
  contabo_total_gb REAL,
  contabo_ram_used_gb REAL,
  contabo_ram_total_gb REAL,
  usage_pct REAL,
  shifted INTEGER DEFAULT 0,
  checked_at TEXT DEFAULT (datetime('now'))
);