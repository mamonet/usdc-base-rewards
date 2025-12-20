// repo: tests/wallet.test.ts
// A wallet is created on the customer's first earn and never again.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import {
  LocalWalletProvider,
  PersistentWalletProvider,
  storedWallet,
  type WalletProvider,
} from '../src/wallet/index.js';
import { assertWalletRef, WalletProviderError } from '../src/wallet/provider.js';
import type { Hex, WalletRef } from '../src/types.js';

const EMAIL = 'buyer@example.test';
const ADDRESS: Hex = '0xdeadwallet01';

/** Counts how many times the provider is actually asked to mint something. */
function countingAdapter(address: Hex = ADDRESS): WalletProvider & { calls: number } {
  const adapter = {
    name: 'local' as const,
    calls: 0,
    getOrCreate(email: string): Promise<WalletRef> {
      adapter.calls += 1;
      return Promise.resolve({
        address,
        provider: 'local',
        providerUserId: `stub:${email}`,
        createdAt: new Date().toISOString(),
      });
    },
  };
  return adapter;
}

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe('wallet creation on first earn', () => {
  it('calls the provider once and reuses the ref after that', async () => {
    const adapter = countingAdapter();
    const provider = new PersistentWalletProvider(db, adapter);

    const first = await provider.getOrCreate(EMAIL);
    const second = await provider.getOrCreate(EMAIL);
    const third = await provider.getOrCreate(EMAIL);

    expect(adapter.calls).toBe(1);
    expect(second).toEqual(first);
    expect(third.address).toBe(first.address);
    expect(third.providerUserId).toBe(first.providerUserId);
  });

  it('persists the wallet so a fresh provider instance does not re-create it', async () => {
    const first = new PersistentWalletProvider(db, countingAdapter());
    const created = await first.getOrCreate(EMAIL);

    // Simulates a restart: new object, same database.
    const adapter = countingAdapter('0xdeadwallet99');
    const afterRestart = new PersistentWalletProvider(db, adapter);
    const reused = await afterRestart.getOrCreate(EMAIL);

    expect(adapter.calls).toBe(0);
    expect(reused.address).toBe(created.address);
  });

  it('writes exactly one wallets row per customer', async () => {
    const provider = new PersistentWalletProvider(db, countingAdapter());
    await provider.getOrCreate(EMAIL);
    await provider.getOrCreate(EMAIL.toUpperCase()); // same customer, different casing

    const rows = db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(storedWallet(db, EMAIL)?.address).toBe(ADDRESS);
  });

  it('gives concurrent first earns the same wallet', async () => {
    const adapter = countingAdapter();
    const provider = new PersistentWalletProvider(db, adapter);

    // Both start before either has written a row: the insert races, one wins, and both
    // callers must come back with the winner's address.
    const [a, b] = await Promise.all([provider.getOrCreate(EMAIL), provider.getOrCreate(EMAIL)]);

    expect(a.address).toBe(b.address);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM wallets').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('keeps different customers on different wallets', async () => {
    const local = new PersistentWalletProvider(db, new LocalWalletProvider());
    const one = await local.getOrCreate('a@example.test');
    const two = await local.getOrCreate('b@example.test');

    expect(one.address).not.toBe(two.address);
    // Deterministic: the stub derives from the email, so a rerun matches.
    expect((await local.getOrCreate('a@example.test')).address).toBe(one.address);
  });
});

describe('adapter contract', () => {
  it('rejects a malformed or zero address before it can be paid', () => {
    const base = { provider: 'local' as const, providerUserId: 'x', createdAt: '2024-01-01T00:00:00Z' };
    // Well formed but plainly not a real wallet: "dead" ten times.
    const wellFormed: Hex = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';

    expect(assertWalletRef('local', { ...base, address: wellFormed }).address).toBe(wellFormed);
    expect(() => assertWalletRef('local', { ...base, address: '0xnope' })).toThrow(WalletProviderError);
    expect(() =>
      assertWalletRef('local', { ...base, address: '0x0000000000000000000000000000000000000000' }),
    ).toThrow(WalletProviderError);
    expect(() => assertWalletRef('local', { ...base, providerUserId: '', address: wellFormed })).toThrow(
      WalletProviderError,
    );
  });
});
