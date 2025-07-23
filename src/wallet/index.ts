// repo: src/wallet/index.ts
// Adapter choice + the wallets table.
//
// Two jobs. The factory picks Privy, Coinbase or the local stub from config. The
// persistence wrapper makes "created on first earn" true regardless of which adapter is
// underneath: the wallets row is checked first, so a provider call only happens the once,
// and every later earn for that customer is a local read. That also means an outage at
// the provider cannot break rewards for existing customers.

import { createHash } from 'node:crypto';
import { config, type AppConfig } from '../config.js';
import { db as defaultDb, type Db } from '../db.js';
import type { Hex, WalletRef } from '../types.js';
import { assertWalletRef, type WalletProvider } from './provider.js';
import { PrivyWalletProvider } from './privy.js';
import { CoinbaseWalletProvider } from './coinbase.js';

export type { WalletProvider } from './provider.js';
export { WalletProviderError } from './provider.js';

interface WalletRow {
  address: string;
  provider: WalletRef['provider'];
  provider_user_id: string;
  created_at: string;
}

export function storedWallet(db: Db, email: string): WalletRef | null {
  const row = db
    .prepare('SELECT address, provider, provider_user_id, created_at FROM wallets WHERE customer_email = ?')
    .get(email.toLowerCase()) as WalletRow | undefined;
  if (row === undefined) return null;
  return {
    address: row.address as Hex,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    createdAt: row.created_at,
  };
}

/**
 * OR IGNORE, then read back. If two first orders for one customer race, one insert wins
 * and both callers return the winner's wallet. Never two wallets for one email.
 */
function rememberWallet(db: Db, email: string, ref: WalletRef): WalletRef {
  db.prepare(
    `INSERT OR IGNORE INTO wallets (customer_email, address, provider, provider_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(email.toLowerCase(), ref.address, ref.provider, ref.providerUserId, ref.createdAt);
  return storedWallet(db, email) ?? ref;
}

/** Caches the adapter's answer in the wallets table. Wraps every real provider. */
export class PersistentWalletProvider implements WalletProvider {
  constructor(
    private readonly db: Db,
    private readonly inner: WalletProvider,
  ) {}

  get name(): WalletRef['provider'] {
    return this.inner.name;
  }

  async getOrCreate(email: string): Promise<WalletRef> {
    const known = storedWallet(this.db, email);
    if (known !== null) return known;

    // First earn for this customer: this is the only call that reaches the provider.
    const created = await this.inner.getOrCreate(email);
    return rememberWallet(this.db, email, created);
  }
}

/**
 * Offline stub for tests and demos with no provider account. Derives a deterministic
 * address from the email; the 0xdead prefix makes it obvious in a log that this is not a
 * real wallet. No key exists anywhere, for this address or otherwise, so testnet USDC
 * sent here is unspendable. That is the point: the stub proves the plumbing, not custody.
 * config.ts refuses to pair it with mainnet.
 */
export class LocalWalletProvider implements WalletProvider {
  readonly name = 'local' as const;

  getOrCreate(email: string): Promise<WalletRef> {
    const digest = createHash('sha256').update(email.toLowerCase()).digest('hex');
    return Promise.resolve(
      assertWalletRef('local', {
        address: `0xdead${digest.slice(0, 36)}` as Hex,
        provider: 'local',
        providerUserId: `local:${digest.slice(0, 16)}`,
        createdAt: new Date().toISOString(),
      }),
    );
  }
}

export function createWalletProvider(db: Db, cfg: AppConfig = config()): WalletProvider {
  const inner: WalletProvider =
    cfg.walletProvider === 'privy'
      ? new PrivyWalletProvider()
      : cfg.walletProvider === 'coinbase'
        ? new CoinbaseWalletProvider()
        : new LocalWalletProvider();
  return new PersistentWalletProvider(db, inner);
}

let instance: WalletProvider | null = null;

/** Process-wide provider. issuance.ts calls this and nothing else from wallet/. */
export function walletProvider(): WalletProvider {
  instance ??= createWalletProvider(defaultDb());
  return instance;
}

/** Injection point for index.ts and for tests. */
export function setWalletProvider(provider: WalletProvider | null): void {
  instance = provider;
}
