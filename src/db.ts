// repo: src/db.ts
// SQLite connection + a tiny forward-only migration runner.
// The DDL below mirrors migrations/001_init.sql and 002_ledger.sql so `npm run dev`
// needs no migration tool. Those files are canonical; keep the two in step.
// Money columns are TEXT: SQLite INTEGER is 64-bit signed and the driver hands back
// a JS number unless told otherwise, which would silently round. Store the decimal
// string, convert with BigInt() at the edge.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

export type Db = Database.Database;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    sql: `
      CREATE TABLE raw_events (
        id            TEXT PRIMARY KEY,
        source        TEXT NOT NULL,
        topic         TEXT NOT NULL,
        signature     TEXT,
        body          TEXT NOT NULL,
        received_at   TEXT NOT NULL
      );

      CREATE TABLE orders (
        id            TEXT PRIMARY KEY,
        customer_email TEXT NOT NULL,
        subtotal_base_units TEXT NOT NULL,
        currency      TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        raw_event_id  TEXT NOT NULL REFERENCES raw_events(id)
      );
      CREATE INDEX idx_raw_events_received ON raw_events(received_at);
      CREATE INDEX idx_orders_email ON orders(customer_email);

      CREATE TABLE reward_rules (
        id            TEXT PRIMARY KEY,
        rate_bps      INTEGER NOT NULL,
        max_reward_base_units TEXT NOT NULL DEFAULT '0',
        min_subtotal_base_units TEXT NOT NULL DEFAULT '0',
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE wallets (
        customer_email TEXT PRIMARY KEY,
        address        TEXT NOT NULL UNIQUE,
        provider       TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );

      -- Append-only. No DELETE path exists in code; the only UPDATE allowed is the
      -- pending -> confirmed|failed settle, guarded by a status predicate.
      CREATE TABLE ledger_entries (
        id             TEXT PRIMARY KEY,
        order_id       TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        account        TEXT NOT NULL CHECK (account IN ('treasury','customer')),
        amount_base_units TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')),
        tx_hash        TEXT,
        failure_reason TEXT,
        created_at     TEXT NOT NULL,
        settled_at     TEXT
      );
      CREATE INDEX idx_ledger_wallet ON ledger_entries(wallet_address, status);
      CREATE INDEX idx_ledger_order ON ledger_entries(order_id);
      CREATE INDEX idx_ledger_tx ON ledger_entries(tx_hash);
      CREATE INDEX idx_ledger_created ON ledger_entries(created_at);
      -- Last line of defence behind the idempotency claim: even if two workers raced the
      -- same order, a second pending leg for that (order, account) cannot be inserted.
      CREATE UNIQUE INDEX idx_ledger_one_leg_per_order_status
        ON ledger_entries(order_id, account, status);

      -- One row per order id. The UNIQUE PK is the concurrency guard: the insert
      -- either claims the key or conflicts, there is no read-then-write window.
      CREATE TABLE idempotency_keys (
        key           TEXT PRIMARY KEY,
        state         TEXT NOT NULL CHECK (state IN ('claimed','done')),
        result_json   TEXT,
        claimed_at    TEXT NOT NULL,
        completed_at  TEXT
      );

      CREATE TABLE cohort_decisions (
        id            TEXT PRIMARY KEY,
        order_id      TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        in_treatment  INTEGER NOT NULL,
        reason        TEXT NOT NULL,
        decided_at    TEXT NOT NULL
      );
      CREATE INDEX idx_cohort_order ON cohort_decisions(order_id);

      CREATE TABLE tx_attempts (
        id            TEXT PRIMARY KEY,
        ledger_entry_id TEXT NOT NULL REFERENCES ledger_entries(id),
        attempt       INTEGER NOT NULL,
        tx_hash       TEXT,
        status        TEXT NOT NULL,
        error         TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_tx_attempts_entry ON tx_attempts(ledger_entry_id, attempt);
    `,
  },
];

let handle: Db | null = null;

export function openDb(url: string = config().databaseUrl): Db {
  if (url !== ':memory:') mkdirSync(dirname(url), { recursive: true });
  const db = new Database(url);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Without this a concurrent writer fails instantly instead of waiting for the lock.
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function db(): Db {
  handle ??= openDb();
  return handle;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    })();
  }
}

/** Decimal string <-> bigint at the DB edge. */
export const money = {
  toDb(v: bigint): string {
    return v.toString(10);
  },
  fromDb(v: string): bigint {
    return BigInt(v);
  },
};
