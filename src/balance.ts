// repo: src/balance.ts
// Balance is a fold over ledger entries. Always computed, never stored.
//
// Why there is no balances table with a running total: a stored balance is a second copy
// of a fact the ledger already holds, and the two drift the first time anything goes
// wrong. A crash between the entry insert and the balance update, a retry that applies
// the same delta twice, a manual fix in prod that touches one and not the other, a bug in
// a code path added a year later that writes an entry without going through the helper.
// Each leaves a number that nobody can prove is right, and the only way to find out is to
// recompute from the log, which is the thing being avoided. So it is recomputed, always.
// The fold is an indexed SUM over one customer's rows; when that becomes too slow the
// answer is a periodic snapshot row plus the entries after it, still derived, never a
// mutable column.
//
// Only 'confirmed' rows count. Pending money is not the customer's yet, and failed money
// never was; both stay in the log for audit and contribute zero. This is also what stops
// the append-only settlement in ledger.ts from double counting, since an issuance's
// pending pair and its confirmed pair both remain in the table.

import type { Db } from './db.js';
import { money } from './db.js';
import type { Hex, LedgerEntry } from './types.js';

export interface BalanceView {
  customerEmail: string;
  walletAddress: Hex | null;
  /** Spendable: sum of confirmed entries. */
  confirmedBaseUnits: bigint;
  /** In flight, not yet counted. */
  pendingBaseUnits: bigint;
  /** Recorded failures, counted nowhere. Surfaced so a support question has an answer. */
  failedBaseUnits: bigint;
  entryCount: number;
}

/** The fold itself. Pure, so a test can compare it against the SQL path. */
export function foldBalance(entries: readonly LedgerEntry[]): bigint {
  return entries.reduce((sum, e) => (e.status === 'confirmed' ? sum + e.amountBaseUnits : sum), 0n);
}

function sumByStatus(entries: readonly LedgerEntry[], status: LedgerEntry['status']): bigint {
  return entries.reduce((sum, e) => (e.status === status ? sum + e.amountBaseUnits : sum), 0n);
}

export function walletForEmail(db: Db, customerEmail: string): Hex | null {
  const row = db
    .prepare('SELECT address FROM wallets WHERE customer_email = ?')
    .get(customerEmail.toLowerCase()) as { address: string } | undefined;
  return row === undefined ? null : (row.address as Hex);
}

/**
 * SUM in SQL for the hot read path. Same definition as foldBalance: confirmed only.
 * SUM over TEXT would coerce to a float, so the strings are summed as bigints here.
 */
export function balanceForWallet(db: Db, walletAddress: Hex): bigint {
  const rows = db
    .prepare(`SELECT amount_base_units FROM ledger_entries WHERE wallet_address = ? AND status = 'confirmed'`)
    .all(walletAddress) as { amount_base_units: string }[];
  return rows.reduce((sum, r) => sum + money.fromDb(r.amount_base_units), 0n);
}

export function balanceForEmail(db: Db, customerEmail: string, entries: readonly LedgerEntry[]): BalanceView {
  return {
    customerEmail: customerEmail.toLowerCase(),
    walletAddress: walletForEmail(db, customerEmail),
    confirmedBaseUnits: foldBalance(entries),
    pendingBaseUnits: sumByStatus(entries, 'pending'),
    failedBaseUnits: sumByStatus(entries, 'failed'),
    entryCount: entries.length,
  };
}

/**
 * Base units to a display string, integer math only. 1234500n -> "1.2345".
 * Presentation only; nothing downstream should parse this back into money.
 */
export function formatUsdc(baseUnits: bigint, decimals = 6): string {
  const negative = baseUnits < 0n;
  const abs = negative ? -baseUnits : baseUnits;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString(10).padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac.length > 0 ? `.${frac}` : ''}`;
}
