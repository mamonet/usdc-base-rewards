// repo: src/types.ts
// Shared shapes. Every money field is a bigint in USDC base units (6dp). No floats anywhere.

export type Hex = `0x${string}`;

/** Normalised purchase event from the merchant webhook. */
export interface Order {
  /** Merchant order id. Also the idempotency key. */
  id: string;
  /** Buyer identity used to look up or create an embedded wallet. */
  customerEmail: string;
  /** Order subtotal in USDC base units, excluding tax and shipping. */
  subtotalBaseUnits: bigint;
  /** ISO 4217 code of the merchant's order currency. Non-USD orders are converted upstream. */
  currency: string;
  /** Merchant-side creation time, ISO 8601. */
  createdAt: string;
}

/** Stored reward policy. Rate is basis points so the math stays integral. */
export interface RewardRule {
  id: string;
  /** e.g. 250 = 2.50% of subtotal. */
  rateBps: number;
  /** Hard ceiling per order in base units. 0n = no cap. */
  maxRewardBaseUnits: bigint;
  /** Orders below this subtotal earn nothing. */
  minSubtotalBaseUnits: bigint;
  active: boolean;
}

export type LedgerAccount = 'treasury' | 'customer';
export type LedgerStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Append-only double-entry row. Never updated in place except the single
 * pending -> confirmed|failed transition, which is guarded in ledger.ts.
 * Balance is a fold over confirmed entries; there is no balance column.
 */
export interface LedgerEntry {
  id: string;
  orderId: string;
  walletAddress: Hex;
  account: LedgerAccount;
  /** Signed: credit to the customer is positive, debit from treasury negative. */
  amountBaseUnits: bigint;
  status: LedgerStatus;
  txHash: Hex | null;
  /** Set when status is 'failed'. */
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export type TxStatus = 'unknown' | 'pending' | 'success' | 'reverted';

/** Wallet handle returned by an embedded-wallet provider. */
export interface WalletRef {
  address: Hex;
  provider: 'privy' | 'coinbase' | 'local';
  /** Opaque provider-side id, never a key. */
  providerUserId: string;
  createdAt: string;
}

export type IssuanceOutcome =
  | 'issued'
  /** Broadcast but not proven landed. Not spendable; the reconciler settles it. */
  | 'pending_unconfirmed'
  | 'duplicate'
  | 'skipped_not_in_cohort'
  | 'skipped_below_minimum'
  | 'skipped_zero_reward'
  | 'failed';

/** Result of a single issuance attempt. Stored verbatim under the idempotency key. */
export interface IssuanceResult {
  orderId: string;
  outcome: IssuanceOutcome;
  amountBaseUnits: bigint;
  txHash: Hex | null;
  ledgerEntryId: string | null;
  /** Human-readable decision trail, one line per gate. */
  reason: string;
}

/** Thrown/returned when the chain says no in a way retrying cannot fix. */
export class PermanentChainError extends Error {
  readonly permanent = true as const;
  constructor(
    message: string,
    readonly txHash: Hex | null = null,
  ) {
    super(message);
    this.name = 'PermanentChainError';
  }
}

/** Transient: RPC flake, nonce race, underpriced gas. Safe to retry. */
export class RetryableChainError extends Error {
  readonly permanent = false as const;
  constructor(
    message: string,
    readonly txHash: Hex | null = null,
  ) {
    super(message);
    this.name = 'RetryableChainError';
  }
}
