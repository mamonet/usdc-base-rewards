-- repo: migrations/002_ledger.sql
-- The ledger. Append-only, double-entry.
--
-- THERE IS DELIBERATELY NO UPDATE PATH AND NO DELETE PATH. Nothing in src/ issues either
-- statement against this table. When a transfer confirms or fails, the pending row is not
-- edited: a new row is appended with the terminal status, the same order_id and account,
-- and its own created_at. The pending row stays exactly as it was written, so the history
-- of an issuance is readable after the fact instead of being overwritten by its outcome.
--
-- Balance is a fold over the confirmed rows (src/balance.ts). There is no balance column
-- in this schema and there should never be one.

CREATE TABLE IF NOT EXISTS ledger_entries (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL,
  wallet_address    TEXT NOT NULL,
  account           TEXT NOT NULL CHECK (account IN ('treasury', 'customer')),
  -- Signed integer base units as TEXT: credit to the customer positive, debit from the
  -- treasury negative. Both legs are appended together, so the two sum to zero per order.
  amount_base_units TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  tx_hash           TEXT,
  failure_reason    TEXT,              -- set on a 'failed' row, null otherwise
  created_at        TEXT NOT NULL,
  settled_at        TEXT               -- set on a terminal row
);

-- Balance fold: confirmed rows for one wallet.
CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries (wallet_address, status);

-- Replay, finalisation lookup and audit.
CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger_entries (order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries (tx_hash);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger_entries (created_at);

-- Last line of defence behind the idempotency claim. Even if two workers somehow raced
-- the same order, the second pending leg for that (order, account) cannot be inserted.
-- Finalisation rows differ in status, so appending confirmed/failed still succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_one_leg_per_order_status
  ON ledger_entries (order_id, account, status);

-- Per-attempt record of what was broadcast. Separate from the ledger so retry noise
-- never touches money rows; the ledger keeps one pending row and one terminal row while
-- this table keeps every attempt behind them.
CREATE TABLE IF NOT EXISTS tx_attempts (
  id              TEXT PRIMARY KEY,
  ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries (id),
  attempt         INTEGER NOT NULL,
  tx_hash         TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_attempts_entry ON tx_attempts (ledger_entry_id, attempt);

-- Postgres deployments should enforce append-only at the role level too, so a stray
-- statement cannot do what the code refuses to do. Uncomment once the app role exists:
-- REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM rewards_app;
