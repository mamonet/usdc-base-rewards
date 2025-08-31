// repo: src/ledger.ts
// Append-only double-entry ledger.
//
// The only SQL verbs in this file are INSERT and SELECT. There is no update path and no
// delete path, and adding one is the wrong fix for any bug found here: a money log that
// can be edited is a money log that cannot be trusted after the fact. Corrections are
// made by appending an opposing entry, never by rewriting one.
//
// Every issuance appends two rows in one transaction: the treasury leg (negative) and the
// customer leg (positive). Both carry the order id, the customer's wallet address and the
// tx hash once there is one, so a single row ties the merchant order, the on-chain
// transfer and the wallet together without a join.

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
