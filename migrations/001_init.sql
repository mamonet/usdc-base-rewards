-- repo: migrations/001_init.sql
-- Ingestion and identity: what arrived, what we parsed out of it, what we already
-- answered, and who owns which wallet.
--
-- src/db.ts carries the same DDL for the embedded SQLite path so a bare `npm run dev`
-- needs no migration tool. These files are the canonical schema and the one a Postgres
-- deployment runs. Keep the two in step.
--
-- Timestamps are ISO 8601 TEXT: SQLite has no timestamp type and the app passes ISO
-- strings around already.
-- Money is TEXT holding an integer count of USDC base units (6dp). Not INTEGER, because
-- the SQLite driver returns a JS number for INTEGER columns and would silently round
-- past 2^53. Not NUMERIC/REAL, because there is no float on the money path anywhere.

CREATE TABLE IF NOT EXISTS raw_events (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,          -- 'merchant' in the demo
  topic       TEXT NOT NULL,          -- e.g. 'orders/paid'
  signature   TEXT,                   -- the HMAC header as delivered, null if absent
  -- Exact bytes as received. The HMAC is computed over these, so the body is stored
  -- verbatim and never re-serialised.
  body        TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_events_received ON raw_events (received_at);

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,   -- merchant order id, also the idempotency key
  customer_email      TEXT NOT NULL,
  subtotal_base_units TEXT NOT NULL,
  currency            TEXT NOT NULL,
  created_at          TEXT NOT NULL,      -- merchant-side time
  raw_event_id        TEXT NOT NULL REFERENCES raw_events (id)
);

CREATE INDEX IF NOT EXISTS idx_orders_email ON orders (customer_email);

-- Reward policy lives in a table, not a constant, so the rate can change without a
-- deploy and an old entry can still be explained by the rule that was active.
CREATE TABLE IF NOT EXISTS reward_rules (
  id                      TEXT PRIMARY KEY,
  rate_bps                INTEGER NOT NULL,           -- 250 = 2.50%
  max_reward_base_units   TEXT NOT NULL DEFAULT '0',  -- '0' = uncapped
  min_subtotal_base_units TEXT NOT NULL DEFAULT '0',
  active                  INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL
);

-- Email -> embedded wallet. Written once, on the customer's first earn; every later
-- earn reads it back. UNIQUE on address so two customers can never share a wallet.
CREATE TABLE IF NOT EXISTS wallets (
  customer_email   TEXT PRIMARY KEY,
  address          TEXT NOT NULL UNIQUE,
  provider         TEXT NOT NULL,       -- 'privy' | 'coinbase' | 'local'
  provider_user_id TEXT NOT NULL,       -- opaque provider handle, never a key
  created_at       TEXT NOT NULL
);

-- One row per order id. The primary key is the concurrency guard: the insert either
-- claims the key or conflicts, so there is no read-then-write window for two concurrent
-- deliveries to both pass. 'claimed' means in flight, 'done' means result_json is the
-- answer to replay.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,       -- order id
  state        TEXT NOT NULL CHECK (state IN ('claimed', 'done')),
  result_json  TEXT,                   -- IssuanceResult; bigints serialised as strings
  claimed_at   TEXT NOT NULL,
  completed_at TEXT
);

-- Every gating decision, include and exclude, so the pilot's denominator can be
-- reconstructed later. Dropped with the cohort module when the pilot ends.
CREATE TABLE IF NOT EXISTS cohort_decisions (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  in_treatment   INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  decided_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cohort_order ON cohort_decisions (order_id);
