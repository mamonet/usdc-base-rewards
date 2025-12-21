// repo: tests/retry.test.ts
// Fail closed. A stuck transfer is retried; a permanent failure is recorded and the
// reward is never marked issued.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { backoffMs, withRetry, RetriesExhausted, DEFAULT_POLICY, type RetryPolicy } from '../src/retry.js';
import { appendPending, markConfirmed, markFailed, entriesForOrder, setTreasuryAddress } from '../src/ledger.js';
import { balanceForWallet } from '../src/balance.js';
import { PermanentChainError, RetryableChainError, type Hex } from '../src/types.js';

const TREASURY: Hex = '0xdeadtreasury';
const WALLET: Hex = '0xdeadwallet01';
const TX: Hex = '0xdeadtx01';
const AMOUNT = 1_000_000n;

// Short delays so the suite does not sleep for real. Backoff shape is asserted separately.
const FAST: RetryPolicy = { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 4, jitter: 0 };

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  setTreasuryAddress(TREASURY);
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

function pending(orderId: string): string {
  return appendPending(db, { orderId, walletAddress: WALLET, account: 'customer', amountBaseUnits: AMOUNT }).id;
}

describe('backoff', () => {
  it('grows exponentially and clamps at the ceiling', () => {
    const policy: RetryPolicy = { maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 5_000, jitter: 0 };
    expect(backoffMs(1, policy)).toBe(1_000);
    expect(backoffMs(2, policy)).toBe(2_000);
    expect(backoffMs(3, policy)).toBe(4_000);
    expect(backoffMs(4, policy)).toBe(5_000); // clamped
    expect(backoffMs(9, policy)).toBe(5_000);
  });

  it('keeps jitter inside the band', () => {
    for (let i = 0; i < 50; i++) {
      const delay = backoffMs(2, DEFAULT_POLICY);
      expect(delay).toBeGreaterThanOrEqual(1_500);
      expect(delay).toBeLessThanOrEqual(2_500);
    }
  });
});

describe('a stuck transfer', () => {
  it('is retried and then confirmed, and only then counts', async () => {
    const entryId = pending('order-stuck');
    let attempts = 0;

    // Two polls find no receipt (the tx is sitting in the mempool), the third lands.
    const txHash = await withRetry({ db, ledgerEntryId: entryId, policy: FAST }, () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new RetryableChainError(`tx ${TX} not confirmed yet`, TX));
      return Promise.resolve(TX);
    });

    expect(attempts).toBe(3);
    expect(txHash).toBe(TX);

    // Nothing counted while it was in flight.
    expect(balanceForWallet(db, WALLET)).toBe(0n);

    markConfirmed(db, entryId, TX);
    expect(balanceForWallet(db, WALLET)).toBe(AMOUNT);

    // Every attempt is on the record, and the pending rows were not rewritten.
    const attemptRows = db
      .prepare('SELECT status FROM tx_attempts WHERE ledger_entry_id = ? ORDER BY attempt')
      .all(entryId) as { status: string }[];
    expect(attemptRows.map((r) => r.status)).toEqual(['retrying', 'retrying', 'confirmed']);

    const rows = entriesForOrder(db, 'order-stuck');
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'confirmed')).toHaveLength(2);
  });

  it('gives up after maxAttempts without claiming success', async () => {
    const entryId = pending('order-exhausted');

    await expect(
      withRetry({ db, ledgerEntryId: entryId, policy: FAST }, () =>
        Promise.reject(new RetryableChainError('rpc timeout')),
      ),
    ).rejects.toBeInstanceOf(RetriesExhausted);

    // Outcome unknown, so the entry stays pending: not confirmed, not failed. Pending is
    // not spendable, and the reconciler resolves it later against the chain.
    const rows = entriesForOrder(db, 'order-exhausted');
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(balanceForWallet(db, WALLET)).toBe(0n);

    const last = db
      .prepare('SELECT status FROM tx_attempts WHERE ledger_entry_id = ? ORDER BY attempt DESC LIMIT 1')
      .get(entryId) as { status: string };
    expect(last.status).toBe('exhausted');
  });
});

describe('a permanent failure', () => {
  it('stops immediately, is recorded, and is not marked issued', async () => {
    const entryId = pending('order-reverted');
    const work = vi.fn(() => Promise.reject(new PermanentChainError(`tx ${TX} reverted on chain`, TX)));

    await expect(withRetry({ db, ledgerEntryId: entryId, policy: FAST }, work)).rejects.toBeInstanceOf(
      PermanentChainError,
    );

    // No point burning gas re-running a revert.
    expect(work).toHaveBeenCalledTimes(1);

    const attemptRows = db
      .prepare('SELECT status, error FROM tx_attempts WHERE ledger_entry_id = ?')
      .all(entryId) as { status: string; error: string }[];
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]?.status).toBe('permanent_failure');

    markFailed(db, entryId, 'reverted on chain', TX);

    const rows = entriesForOrder(db, 'order-reverted');
    // The failure is appended, not written over the pending rows.
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'failed')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'confirmed')).toHaveLength(0);

    const failed = rows.find((r) => r.status === 'failed' && r.account === 'customer');
    expect(failed?.failureReason).toBe('reverted on chain');
    expect(failed?.txHash).toBe(TX);

    // Recorded, and worth nothing. Failed money was never the customer's.
    expect(balanceForWallet(db, WALLET)).toBe(0n);
  });

  it('settles once even if the reconciler races the caller', () => {
    const entryId = pending('order-race');
    const first = markConfirmed(db, entryId, TX);
    const second = markConfirmed(db, entryId, TX);

    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
    expect(entriesForOrder(db, 'order-race').filter((r) => r.status === 'confirmed')).toHaveLength(2);
    expect(balanceForWallet(db, WALLET)).toBe(AMOUNT);
  });
});
