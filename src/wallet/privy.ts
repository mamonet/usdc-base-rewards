// repo: src/wallet/privy.ts
// Privy server-side embedded wallets.
//
// Credentials: PRIVY_APP_ID + PRIVY_APP_SECRET, read from config at call time. The app
// secret is the consumer's custody credential. It is sent in an Authorization header and
// nowhere else: not logged, not returned, not attached to an error, not put in a URL
// where it would land in an access log. Errors quote the status and the provider's
// message only.
//
// Privy's create-wallet call is create-or-get when the same linked account is supplied,
// which is what makes rule 1 (idempotent per email) hold across restarts.

import { config } from '../config.js';
import type { Hex, WalletRef } from '../types.js';
import { assertWalletRef, WalletProviderError, type WalletProvider } from './provider.js';

const API_BASE = process.env['PRIVY_API_BASE'] ?? 'https://api.privy.io';

interface PrivyUser {
  id: string;
  wallet?: { address?: string; chain_type?: string };
  linked_accounts?: { type: string; address?: string; chain_type?: string }[];
}

function credentials(): { appId: string; appSecret: string } {
  const cfg = config();
  if (cfg.privyAppId === null || cfg.privyAppSecret === null) {
    throw new WalletProviderError('privy', 'PRIVY_APP_ID / PRIVY_APP_SECRET are not set');
  }
  return { appId: cfg.privyAppId, appSecret: cfg.privyAppSecret };
}

/** Basic auth per Privy's server API. Built per request so nothing holds it. */
function authHeaders(): Record<string, string> {
  const { appId, appSecret } = credentials();
  return {
    Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
    'privy-app-id': appId,
    'Content-Type': 'application/json',
  };
}

function extractAddress(user: PrivyUser): Hex | null {
  const direct = user.wallet?.address;
  if (typeof direct === 'string') return direct as Hex;
  const linked = user.linked_accounts?.find((a) => a.type === 'wallet' && typeof a.address === 'string');
  return linked === undefined ? null : (linked.address as Hex);
}

export class PrivyWalletProvider implements WalletProvider {
  readonly name = 'privy' as const;

  async getOrCreate(email: string): Promise<WalletRef> {
    const address = email.toLowerCase();

    // create_ethereum_wallet against an existing linked email returns that user, so a
    // repeat call is a lookup rather than a second wallet.
    const res = await fetch(`${API_BASE}/v1/users`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        create_ethereum_wallet: true,
        linked_accounts: [{ type: 'email', address }],
      }),
    });

    if (!res.ok) {
      // Body may contain the request echo; the secret is never in the body we sent.
      const detail = await res.text().catch(() => '');
      throw new WalletProviderError('privy', `create/get user failed: ${detail.slice(0, 200)}`, res.status);
    }

    const user = (await res.json()) as PrivyUser;
    const walletAddress = extractAddress(user);
    if (walletAddress === null) {
      throw new WalletProviderError('privy', `user ${user.id} has no ethereum wallet`);
    }

    return assertWalletRef('privy', {
      address: walletAddress,
      provider: 'privy',
      providerUserId: user.id,
      createdAt: new Date().toISOString(),
    });
  }
}
