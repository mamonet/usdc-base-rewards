// repo: tests/idempotency.test.ts
// The one that matters: a redelivered webhook must not pay twice.

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const chain = vi.hoisted(() => ({
  sendTransfer: vi.fn(),
  waitForConfirmation: vi.fn(),
}));

// Stand-in for the chain client. Nothing in this suite touches a network or a key.
vi.mock('../src/chain.js', () => ({
  sendTransfer: chain.sendTransfer,
  waitForConfirmation: chain.waitForConfirmation,
  treasuryAddress: () => TREASURY,
}));

import { openDb, type Db } from '../src/db.js';
import { handleWebhook } from '../src/ingest.js';
import { upsertRule } from '../src/rules.js';
import { entriesForOrder, setTreasuryAddress } from '../src/ledger.js';
import { balanceForWallet } from '../src/balance.js';
import { setWalletProvider } from '../src/wallet/index.js';
import type { Hex, WalletRef } from '../src/types.js';

const SECRET = 'dev-secret';
const TREASURY: Hex = '0xdeadtreasury';
const WALLET: Hex = '0xdeadwallet01';
const TX: Hex = '0xdeadtx01';
const EMAIL = 'buyer@example.test';

function body(orderId: string, subtotal = '40.00'): Buffer {
  return Buffer.from(
    JSON.stringify({
      id: orderId,
      customer: { email: EMAIL },
      subtotal_price: subtotal,
      currency: 'USD',
      created_at: '2024-01-01T00:00:00Z',
    }),
  );
}

function signed(raw: Buffer): Record<string, string> {
  return { 'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64') };
}

let db: Db;

beforeEach(() => {
  process.env['COHORT_ROLLOUT_PERCENT'] = '100';
  process.env['COHORT_CURRENCY'] = 'USD';

  db = openDb(':memory:');
  setTreasuryAddress(TREASURY);
  upsertRule(db, { rateBps: 250, maxRewardBaseUnits: 0n, minSubtotalBaseUnits: 0n, active: true });

  const ref: WalletRef = {
    address: WALLET,
    provider: 'local',
    providerUserId: 'stub-user',
    createdAt: '2024-01-01T00:00:00Z',
  };
  setWalletProvider({ name: 'local', getOrCreate: () => Promise.resolve(ref) });

  chain.sendTransfer.mockResolvedValue({ txHash: TX, gasLimit: 60_000n });
  chain.waitForConfirmation.mockResolvedValue({ status: 'success', receipt: null, transferred: 1_000_000n });
});

afterEach(() => {
  db.close();
  setWalletProvider(null);
  vi.clearAllMocks();
});

describe('duplicate webhook', () => {
  it('issues exactly once for one order id', async () => {
    const raw = body('order-1');
    const input = { rawBody: raw, headers: signed(raw), secret: SECRET };

    const first = await handleWebhook(db, input);
    const second = await handleWebhook(db, input);

    expect(first.outcome).toBe('issued');
    expect(first.amountBaseUnits).toBe(1_000_000n); // 250bps of 40.00 USDC

    // The replay returns the stored answer instead of running the pipeline again.
    expect(second.outcome).toBe('duplicate');
    expect(second.amountBaseUnits).toBe(first.amountBaseUnits);
    expect(second.txHash).toBe(first.txHash);
    expect(second.ledgerEntryId).toBe(first.ledgerEntryId);

    // ONE transfer. This is the assertion the whole design exists for.
    expect(chain.sendTransfer).toHaveBeenCalledTimes(1);
    expect(chain.sendTransfer).toHaveBeenCalledWith(WALLET, 1_000_000n);

    // ONE issuance in the ledger. Four rows, because each issuance is double-entry
    // (treasury + customer) and settlement appends rather than mutating:
    // pending pair, then confirmed pair. Never eight.
    const rows = entriesForOrder(db, 'order-1');
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.account === 'customer' && r.status === 'pending')).toHaveLength(1);
    expect(rows.filter((r) => r.account === 'customer' && r.status === 'confirmed')).toHaveLength(1);
    expect(rows.every((r) => r.orderId === 'order-1')).toBe(true);

    // And the customer is credited once.
    expect(balanceForWallet(db, WALLET)).toBe(1_000_000n);
  });

  it('still issues for a different order id from the same customer', async () => {
    const a = body('order-1');
    const b = body('order-2', '10.00');

    await handleWebhook(db, { rawBody: a, headers: signed(a), secret: SECRET });
    chain.waitForConfirmation.mockResolvedValue({ status: 'success', receipt: null, transferred: 250_000n });
    const second = await handleWebhook(db, { rawBody: b, headers: signed(b), secret: SECRET });

    expect(second.outcome).toBe('issued');
    expect(chain.sendTransfer).toHaveBeenCalledTimes(2);
    expect(balanceForWallet(db, WALLET)).toBe(1_250_000n);
  });

  it('replays the stored result without re-entering the chain path', async () => {
    const raw = body('order-3');
    const input = { rawBody: raw, headers: signed(raw), secret: SECRET };

    await handleWebhook(db, input);
    chain.sendTransfer.mockRejectedValue(new Error('must not be called on a replay'));

    const replay = await handleWebhook(db, input);
    expect(replay.outcome).toBe('duplicate');
    expect(chain.sendTransfer).toHaveBeenCalledTimes(1);
  });
});
