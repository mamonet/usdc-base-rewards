// repo: src/wallet/provider.ts
// The only thing the issuance engine knows about embedded wallets.
//
// Everything below the interface (Privy, Coinbase, the local stub) is swappable by
// config. Nothing outside this directory imports a provider SDK, so switching vendors
// is a new file plus one line in the factory, not a refactor of the money path.

import type { WalletRef } from '../types.js';

/**
 * Contract an adapter must honour. These are not suggestions: the issuance path assumes
 * every one of them, and a violation shows up as a payout to the wrong address.
 *
 * 1. IDEMPOTENT PER EMAIL. Two calls with the same email return the same address,
 *    forever, on this process or any other. The provider's own "create user wallet" call
 *    is usually create-or-get; if it is not, the adapter makes it so. Never generate a
 *    fresh wallet because a lookup failed: that silently strands the customer's earlier
 *    rewards at an address nobody reads.
 * 2. CONCURRENCY SAFE. Two orders for one customer can land at once. Both must end up
 *    with the same address, or the adapter must fail loudly. Never two wallets.
 * 3. NO KEY MATERIAL. The returned WalletRef carries an address and an opaque provider
 *    id. Adapters must not return, log, cache or accept a private key, seed phrase or
 *    signing share. Custody stays with the provider; this service only reads addresses.
 * 4. THROW, DO NOT IMPROVISE. On any error, throw. Returning a placeholder or the zero
 *    address means the engine broadcasts USDC into a hole. There is no partial success.
 * 5. CHAIN-CORRECT ADDRESS. The address must be a valid EVM address usable on the
 *    configured chain. Base Sepolia and Base mainnet share address format, so an adapter
 *    pointed at the wrong environment is silent: keep provider credentials per env.
 * 6. NO SIDE EFFECTS BEYOND WALLET CREATION. No emails, no notifications, no state the
 *    caller cannot roll back. The caller may retry.
 */
export interface WalletProvider {
  /** Identifies the adapter in logs and in the wallets table. */
  readonly name: WalletRef['provider'];

  /**
   * Return the customer's wallet, creating it on first call. Called once per earn; the
   * caller caches the result in the wallets table, so this is not a hot path.
   */
  getOrCreate(email: string): Promise<WalletRef>;
}

/** Thrown by adapters so the engine can tell "provider said no" from a bug. */
export class WalletProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status: number | null = null,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'WalletProviderError';
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Adapters run their result through this before returning it. Rule 5, enforced. */
export function assertWalletRef(provider: string, ref: WalletRef): WalletRef {
  if (!ADDRESS.test(ref.address)) {
    throw new WalletProviderError(provider, `returned a malformed address: ${ref.address}`);
  }
  if (/^0x0+$/.test(ref.address)) {
    throw new WalletProviderError(provider, 'returned the zero address');
  }
  if (ref.providerUserId.length === 0) {
    throw new WalletProviderError(provider, 'returned an empty provider id');
  }
  return ref;
}
