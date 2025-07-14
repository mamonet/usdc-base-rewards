// repo: src/wallet/coinbase.ts
// Coinbase Embedded Wallets (CDP) behind the same interface as the Privy adapter.
//
// Credentials: COINBASE_API_KEY, read from config at call time and sent only in the
// Authorization header. Same rule as privy.ts - the key never reaches a log line, an
// error message, a URL or the response we hand back.
//
// Idempotency comes from the per-user create call plus an idempotency key derived from
// the email, so a retried request cannot mint a second wallet for one customer.

import { createHash } from 'node:crypto';
import { config } from '../config.js';
import type { Hex, WalletRef } from '../types.js';
import { assertWalletRef, WalletProviderError, type WalletProvider } from './provider.js';

const API_BASE = process.env['CDP_API_BASE'] ?? 'https://api.cdp.coinbase.com';

interface CdpAccount {
  name?: string;
  address?: string;
  id?: string;
}

function apiKey(): string {
  const key = config().coinbaseApiKey;
  if (key === null) throw new WalletProviderError('coinbase', 'COINBASE_API_KEY is not set');
  return key;
}

/**
 * Account names are opaque to the provider but must be stable per customer, and an email
 * is neither a legal account name nor something to hand a vendor as an identifier. Hash
 * it: same email always yields the same name, and the raw address never leaves here.
 */
function accountName(email: string): string {
  return `rw-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 32)}`;
}

async function request(path: string, init: RequestInit & { idempotencyKey?: string }): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
  };
  if (init.idempotencyKey !== undefined) headers['X-Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

export class CoinbaseWalletProvider implements WalletProvider {
  readonly name = 'coinbase' as const;

  async getOrCreate(email: string): Promise<WalletRef> {
    const name = accountName(email);

    // Look first: the create call below is idempotent, but a plain read is cheaper and
    // keeps a provider-side rate limit from turning into a failed reward.
    const existing = await request(`/platform/v2/evm/accounts/${name}`, { method: 'GET' });
    if (existing.ok) {
      const account = (await existing.json()) as CdpAccount;
      return this.toRef(account, name);
    }
    if (existing.status !== 404) {
      const detail = await existing.text().catch(() => '');
      throw new WalletProviderError('coinbase', `lookup failed: ${detail.slice(0, 200)}`, existing.status);
    }

    const created = await request('/platform/v2/evm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name }),
      // Same email -> same key, so two concurrent first orders create one account.
      idempotencyKey: name,
    });
    if (!created.ok) {
      const detail = await created.text().catch(() => '');
      throw new WalletProviderError('coinbase', `create failed: ${detail.slice(0, 200)}`, created.status);
    }

    return this.toRef((await created.json()) as CdpAccount, name);
  }

  private toRef(account: CdpAccount, name: string): WalletRef {
    if (typeof account.address !== 'string') {
      throw new WalletProviderError('coinbase', `account ${name} has no address`);
    }
    return assertWalletRef('coinbase', {
      address: account.address as Hex,
      provider: 'coinbase',
      providerUserId: account.id ?? name,
      createdAt: new Date().toISOString(),
    });
  }
}
