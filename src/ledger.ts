// repo: src/ledger.ts
// Append-only double-entry ledger.
//
// The only SQL verbs in this file are INSERT and SELECT. There is no update path and no
// delete path, and adding one is the wrong fix for any bug found here: a money log that
// can be edited is a money log that cannot be trusted after the fact. Corrections are
// made by appending an opposing entry, never by rewriting one.
//
// Every issuance appends two rows in one transaction: the treasury leg (negative) and the
// customer leg (positive). Both carry the order id, the wallet address and the tx hash
// once there is one, so a single row ties the merchant order, the on-chain transfer and
// the wallet together without a join.
//
// change (v1 -> final): settlement. v1 could only record a pending issuance, which left
// the obvious follow-up of `UPDATE ledger_entries SET status = 'confirmed' WHERE id = ?`.
// That statement is the thing this file exists to prevent. markConfirmed and markFailed
// instead APPEND a second pair of rows carrying the terminal status; the pending rows
// stay byte-identical to how they were written.
//
// The cost is two extra rows per issuance. What it buys: "what did we believe, and when
// did we learn otherwise" is answerable from the table alone, a settled amount cannot be
// rewritten because no code path exists that could, and an operator staring at a bad
// balance can replay the log instead of trusting it. Balance folds confirmed rows only,
// so the pending pair left behind is never double counted.

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { money } from './db.js';
import type { Hex, LedgerAccount, LedgerEntry, LedgerStatus } from './types.js';

interface Row {
  id: string;
  order_id: string;
  wallet_address: string;
  account: LedgerAccount;
  amount_base_units: string;
  status: LedgerStatus;
  tx_hash: string | null;
  failure_reason: string | null;
  created_at: string;
  settled_at: string | null;
}

const COLUMNS =
  'id, order_id, wallet_address, account, amount_base_units, status, tx_hash, failure_reason, created_at, settled_at';

const INSERT = `INSERT INTO ledger_entries (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const TERMINAL = ['confirmed', 'failed'] as const;

/**
 * Address the treasury leg is booked against. Set once at startup from the resolved
 * signer (see src/index.ts) so this module never touches a key or imports chain.ts.
 * Left as an obvious placeholder until then; it is a label on an accounting row, not
 * something anything sends to.
 */
let treasuryLeg: Hex = '0xTREASURY_UNSET';

export function setTreasuryAddress(address: Hex): void {
  treasuryLeg = address;
}

function toEntry(row: Row): LedgerEntry {
  return {
    id: row.id,
    orderId: row.order_id,
    walletAddress: row.wallet_address as Hex,
    account: row.account,
    amountBaseUnits: money.fromDb(row.amount_base_units),
    status: row.status,
    txHash: row.tx_hash as Hex | null,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

function insert(db: Db, entry: LedgerEntry): LedgerEntry {
  db.prepare(INSERT).run(
    entry.id,
    entry.orderId,
    entry.walletAddress,
    entry.account,
    money.toDb(entry.amountBaseUnits),
    entry.status,
    entry.txHash,
    entry.failureReason,
    entry.createdAt,
    entry.settledAt,
  );
  return entry;
}

export interface PendingInput {
  orderId: string;
  /** Customer's embedded wallet. The credit side. */
  walletAddress: Hex;
  /** Which leg the caller wants back. The other is written too. */
  account: LedgerAccount;
  /** Positive base units. The treasury leg is stored as the negation. */
  amountBaseUnits: bigint;
  /** Set only if the transfer was already broadcast. Usually null at this point. */
  txHash?: Hex | null;
  /** Override for the treasury leg's address; defaults to setTreasuryAddress(). */
  treasuryAddress?: Hex;
}

/**
 * Append the two pending legs of an issuance and return the requested one.
 *
 * Written BEFORE the transfer is broadcast: if the process dies mid-send, a pending row
 * exists to reconcile against the chain, which is recoverable. The reverse order leaves
 * an on-chain transfer nobody knows about, which is not.
 *
 * Pending contributes nothing to a balance (see balance.ts).
 */
export function appendPending(db: Db, input: PendingInput): LedgerEntry {
  if (input.amountBaseUnits <= 0n) {
    throw new Error(`refusing to append a non-positive issuance: ${input.amountBaseUnits}`);
  }
  const now = new Date().toISOString();
  const txHash = input.txHash ?? null;

  const treasury: LedgerEntry = {
    id: randomUUID(),
    orderId: input.orderId,
    walletAddress: input.treasuryAddress ?? treasuryLeg,
    account: 'treasury',
    amountBaseUnits: -input.amountBaseUnits,
    status: 'pending',
    txHash,
    failureReason: null,
    createdAt: now,
    settledAt: null,
  };
  const customer: LedgerEntry = {
    ...treasury,
    id: randomUUID(),
    walletAddress: input.walletAddress,
    account: 'customer',
    amountBaseUnits: input.amountBaseUnits,
  };

  // Both legs or neither. A half-written double entry does not balance.
  db.transaction(() => {
    insert(db, treasury);
    insert(db, customer);
  })();

  return input.account === 'treasury' ? treasury : customer;
}

function rowsFor(db: Db, orderId: string, status: LedgerStatus): LedgerEntry[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM ledger_entries WHERE order_id = ? AND status = ? ORDER BY account`)
    .all(orderId, status) as Row[];
  return rows.map(toEntry);
}

function terminalEntries(db: Db, orderId: string): LedgerEntry[] {
  for (const status of TERMINAL) {
    const rows = rowsFor(db, orderId, status);
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * Append the terminal pair mirroring the pending one. Never touches the pending rows.
 *
 * Idempotent: if this order already settled, the existing rows come back and nothing is
 * written, so a reconciler racing the confirmation poller cannot append twice.
 */
function settle(
  db: Db,
  entryId: string,
  status: 'confirmed' | 'failed',
  txHash: Hex | null,
  failureReason: string | null,
): LedgerEntry[] {
  const origin = entryById(db, entryId);
  if (origin === null) throw new Error(`no ledger entry ${entryId}`);

  const already = terminalEntries(db, origin.orderId);
  if (already.length > 0) return already;

  const pending = rowsFor(db, origin.orderId, 'pending');
  if (pending.length === 0) throw new Error(`no pending ledger entry for order ${origin.orderId}`);

  const now = new Date().toISOString();
  const settled = pending.map((from) => ({
    ...from,
    id: randomUUID(),
    status,
    // Keep the hash the pending row was broadcast with if settlement supplies none.
    txHash: txHash ?? from.txHash,
    failureReason,
    createdAt: now,
    settledAt: now,
  }));

  db.transaction(() => {
    for (const entry of settled) insert(db, entry);
  })();
  return settled;
}

/** Confirmed on proof: a success receipt plus a matching Transfer log. Only now is it money. */
export function markConfirmed(db: Db, entryId: string, txHash: Hex): LedgerEntry[] {
  return settle(db, entryId, 'confirmed', txHash, null);
}

/**
 * Failed permanently. Recorded, not dropped: the pending rows stay, a failed pair is
 * appended with the reason, and no balance moves because neither status counts. Nothing
 * here marks the order as issued.
 */
export function markFailed(db: Db, entryId: string, reason: string, txHash: Hex | null = null): LedgerEntry[] {
  return settle(db, entryId, 'failed', txHash, reason);
}

/**
 * Outcome unknown: retries ran out but the tx may still land. Deliberately does NOT
 * write a ledger row. Pending is already the correct statement of what we know, and
 * inventing a status for "we are not sure" would put a guess in the money log. The note
 * goes to tx_attempts, which is operational history, and the reconciler picks the entry
 * up later from unsettledEntries().
 */
export function noteUnresolved(db: Db, entryId: string, detail: string, txHash: Hex | null = null): void {
  db.prepare(
    `INSERT INTO tx_attempts (id, ledger_entry_id, attempt, tx_hash, status, error, created_at)
     VALUES (?, ?, ?, ?, 'unresolved', ?, ?)`,
  ).run(randomUUID(), entryId, 0, txHash, detail, new Date().toISOString());
}

/** Terminal status for an order, 'pending' while in flight, null if unknown. */
export function statusForOrder(db: Db, orderId: string): LedgerStatus | null {
  const row = db
    .prepare(
      `SELECT status FROM ledger_entries WHERE order_id = ?
        ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END
        LIMIT 1`,
    )
    .get(orderId) as { status: LedgerStatus } | undefined;
  return row?.status ?? null;
}

/** Customer legs still in flight: pending with no terminal row behind them. Reconciler input. */
export function unsettledEntries(db: Db, limit = 100): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM ledger_entries p
        WHERE p.status = 'pending'
          AND p.account = 'customer'
          AND NOT EXISTS (
            SELECT 1 FROM ledger_entries t
             WHERE t.order_id = p.order_id AND t.account = p.account AND t.status IN ('confirmed', 'failed')
          )
        ORDER BY p.created_at
        LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(toEntry);
}

export function entryById(db: Db, id: string): LedgerEntry | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM ledger_entries WHERE id = ?`).get(id) as Row | undefined;
  return row === undefined ? null : toEntry(row);
}

export function entriesForOrder(db: Db, orderId: string): LedgerEntry[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM ledger_entries WHERE order_id = ? ORDER BY created_at, id`)
    .all(orderId) as Row[];
  return rows.map(toEntry);
}

export function entriesForWallet(db: Db, walletAddress: Hex): LedgerEntry[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM ledger_entries WHERE wallet_address = ? ORDER BY created_at, id`)
    .all(walletAddress) as Row[];
  return rows.map(toEntry);
}

/** Whole log, oldest first. Backs the export endpoint. */
export function listEntries(db: Db, limit = 1000, since: string | null = null): LedgerEntry[] {
  const rows = (
    since === null
      ? db.prepare(`SELECT ${COLUMNS} FROM ledger_entries ORDER BY created_at, id LIMIT ?`).all(limit)
      : db
          .prepare(`SELECT ${COLUMNS} FROM ledger_entries WHERE created_at >= ? ORDER BY created_at, id LIMIT ?`)
          .all(since, limit)
  ) as Row[];
  return rows.map(toEntry);
}
