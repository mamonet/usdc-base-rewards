// repo: src/retry.ts
// Backoff for a stuck or transiently failed transfer.
//
// Two rules, both about not losing money:
//  - retryable (RPC flake, no receipt in the window, nonce race) -> back off and try again
//  - permanent (revert, insufficient treasury balance, mined-without-Transfer) -> stop
//    immediately and RECORD it. A permanent failure is never swallowed; it lands in
//    tx_attempts and the caller writes a failed ledger row.

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { PermanentChainError, RetryableChainError, type Hex } from './types.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Jitter fraction, 0-1. Spreads out a thundering herd after an RPC outage. */
  jitter: number;
}

export const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.25,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function backoffMs(attempt: number, policy: RetryPolicy = DEFAULT_POLICY): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const spread = exponential * policy.jitter;
  return Math.round(exponential - spread + Math.random() * 2 * spread);
}

export function isPermanent(err: unknown): err is PermanentChainError {
  return err instanceof PermanentChainError;
}

export function isRetryable(err: unknown): boolean {
  if (isPermanent(err)) return false;
  if (err instanceof RetryableChainError) return true;
  // Unknown error shape: treat as retryable but bounded by maxAttempts. Never treat
  // an unknown failure as success.
  return true;
}

export interface AttemptRecord {
  ledgerEntryId: string;
  attempt: number;
  txHash: Hex | null;
  status: 'sent' | 'confirmed' | 'retrying' | 'permanent_failure' | 'exhausted';
  error: string | null;
}

export function recordAttempt(db: Db, rec: AttemptRecord): void {
  db.prepare(
    `INSERT INTO tx_attempts (id, ledger_entry_id, attempt, tx_hash, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), rec.ledgerEntryId, rec.attempt, rec.txHash, rec.status, rec.error, new Date().toISOString());
}

/** Raised when the policy runs out. Distinct from permanent: the truth is unknown. */
export class RetriesExhausted extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
    readonly txHash: Hex | null = null,
  ) {
    super(`gave up after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    this.name = 'RetriesExhausted';
  }
}

export interface RunOptions {
  db: Db;
  ledgerEntryId: string;
  policy?: RetryPolicy;
  /** Called with the attempt number; returns the tx hash it broadcast, if any. */
  onAttempt?: (attempt: number) => void;
}

/**
 * Run `work` under the policy. `work` must be safe to call again, which for a transfer
 * means the caller checks for an already-broadcast hash before sending a new one.
 */
export async function withRetry<T>(
  opts: RunOptions,
  work: (attempt: number) => Promise<T>,
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    opts.onAttempt?.(attempt);
    try {
      const result = await work(attempt);
      recordAttempt(opts.db, { ledgerEntryId: opts.ledgerEntryId, attempt, txHash: null, status: 'confirmed', error: null });
      return result;
    } catch (err) {
      lastError = err;

      if (isPermanent(err)) {
        recordAttempt(opts.db, {
          ledgerEntryId: opts.ledgerEntryId,
          attempt,
          txHash: err.txHash,
          status: 'permanent_failure',
          error: err.message,
        });
        throw err;
      }

      const txHash = err instanceof RetryableChainError ? err.txHash : null;
      const message = err instanceof Error ? err.message : String(err);
      const last = attempt === policy.maxAttempts;

      recordAttempt(opts.db, {
        ledgerEntryId: opts.ledgerEntryId,
        attempt,
        txHash,
        status: last ? 'exhausted' : 'retrying',
        error: message,
      });

      if (last) break;
      await sleep(backoffMs(attempt, policy));
    }
  }

  throw new RetriesExhausted(policy.maxAttempts, lastError);
}
