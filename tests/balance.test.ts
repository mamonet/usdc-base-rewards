// repo: tests/balance.test.ts
// Balance is the fold, and nothing else is allowed to disagree with it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import {
  appendPending,
  entriesForWallet,
  markConfirmed,
  markFailed,
  setTreasuryAddress,
} from '../src/ledger.js';
import { balanceForEmail, balanceForWallet, foldBalance, formatUsdc, walletForEmail } from '../src/balance.js';
import type { Hex } from '../src/types.js';

const TREASURY: Hex = '0xdeadtreasury';
const WALLET: Hex = '0xdeadwallet01';
const EMAIL = 'buyer@example.test';

let db: Db;

function issue(orderId: string, amount: bigint): string {
  return appendPending(db, { orderId, walletAddress: WALLET, account: 'customer', amountBaseUnits: amount }).id;
}

beforeEach(() => {
  db = openDb(':memory:');
  setTreasuryAddress(TREASURY);
  db.prepare(
    `INSERT INTO wallets (customer_email, address, provider, provider_user_id, created_at)
     VALUES (?, ?, 'local', 'stub', ?)`,
  ).run(EMAIL, WALLET, '2024-01-01T00:00:00Z');
});

afterEach(() => {
  db.close();
});

describe('balance', () => {
  it('equals the fold of the entries', () => {
    markConfirmed(db, issue('order-1', 1_000_000n), '0xdeadtx01');
    markConfirmed(db, issue('order-2', 250_000n), '0xdeadtx02');
    markConfirmed(db, issue('order-3', 7n), '0xdeadtx03');

    const entries = entriesForWallet(db, WALLET);
    expect(balanceForWallet(db, WALLET)).toBe(1_250_007n);
    // The SQL path and the pure fold are two implementations of one definition. If they
    // ever disagree, the definition moved and something is now lying to a customer.
    expect(balanceForWallet(db, WALLET)).toBe(foldBalance(entries));
  });

  it('does not count a failed entry', () => {
    markConfirmed(db, issue('order-1', 1_000_000n), '0xdeadtx01');
    markFailed(db, issue('order-2', 900_000n), 'reverted on chain', '0xdeadtx02');

    const entries = entriesForWallet(db, WALLET);
    expect(balanceForWallet(db, WALLET)).toBe(1_000_000n);
    expect(foldBalance(entries)).toBe(1_000_000n);

    // The failure is still in the log. Not counted is not the same as not recorded.
    expect(entries.some((e) => e.status === 'failed' && e.amountBaseUnits === 900_000n)).toBe(true);
  });

  it('does not count a pending entry', () => {
    issue('order-1', 1_000_000n);
    expect(balanceForWallet(db, WALLET)).toBe(0n);

    markConfirmed(db, issue('order-2', 500_000n), '0xdeadtx02');
    // The confirmed order counts; the one still in flight does not, and the pending rows
    // left behind by settlement are not double counted.
    expect(balanceForWallet(db, WALLET)).toBe(500_000n);
  });

  it('books the mirror image against the treasury', () => {
    markConfirmed(db, issue('order-1', 1_000_000n), '0xdeadtx01');
    markConfirmed(db, issue('order-2', 250_000n), '0xdeadtx02');

    // Double entry: what the customers gained is what the treasury paid out.
    expect(balanceForWallet(db, TREASURY)).toBe(-balanceForWallet(db, WALLET));
  });

  it('reports pending and failed alongside the spendable figure', () => {
    markConfirmed(db, issue('order-1', 1_000_000n), '0xdeadtx01');
    markFailed(db, issue('order-2', 900_000n), 'reverted', '0xdeadtx02');
    issue('order-3', 400_000n);

    const view = balanceForEmail(db, EMAIL, entriesForWallet(db, WALLET));
    expect(view.confirmedBaseUnits).toBe(1_000_000n);
    expect(view.failedBaseUnits).toBe(900_000n);
    expect(view.pendingBaseUnits).toBe(2_300_000n); // 1.0 + 0.9 + 0.4, all still on record
    expect(view.walletAddress).toBe(WALLET);
    expect(walletForEmail(db, 'nobody@example.test')).toBeNull();
  });

  it('is zero for a customer with no entries', () => {
    const view = balanceForEmail(db, 'nobody@example.test', []);
    expect(view.confirmedBaseUnits).toBe(0n);
    expect(view.entryCount).toBe(0);
  });
});

describe('formatUsdc', () => {
  it('renders base units without going through a float', () => {
    expect(formatUsdc(1_000_000n)).toBe('1');
    expect(formatUsdc(1_250_007n)).toBe('1.250007');
    expect(formatUsdc(7n)).toBe('0.000007');
    expect(formatUsdc(0n)).toBe('0');
    expect(formatUsdc(-1_000_000n)).toBe('-1');
    expect(formatUsdc(9_007_199_254_740_993n)).toBe('9007199254.740993');
  });
});
