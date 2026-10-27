CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  bio TEXT NOT NULL,
  wallet_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  trial_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS carts (
  session_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  PRIMARY KEY (session_id, listing_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  ship_name TEXT NOT NULL,
  ship_address TEXT NOT NULL,
  ship_city TEXT NOT NULL,
  ship_postal TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  trial_id TEXT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  path TEXT NOT NULL,
  surface TEXT NOT NULL,
  action TEXT NOT NULL,
  query TEXT,
  filters_json TEXT,
  result_ids_json TEXT,
  status INTEGER NOT NULL,
  user_agent TEXT,
  colo TEXT,
  ray_id TEXT,
  handler_ms INTEGER NOT NULL,
  gap_ms INTEGER,
  robots_or_sitemap INTEGER NOT NULL,
  method TEXT NOT NULL,
  result_count INTEGER,
  empty_flag INTEGER,
  listing_id TEXT,
  category_id TEXT,
  seller_id TEXT,
  order_id TEXT,
  served_price_cents INTEGER,
  served_title TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_trial ON events (trial_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  seed_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  oracle_pass INTEGER,
  oracle_reason TEXT,
  oracle_detail_json TEXT,
  self_reported_tokens INTEGER,
  frozen_through_ts INTEGER
);
