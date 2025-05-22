// repo: src/cohort.ts
// Pilot gating. Only reason this module exists is the rollout: when the pilot ends,
// delete the file and the single call in ingest.ts. Nothing else imports it and
// nothing here touches money or chain state.
//
// Assignment is a deterministic hash of the email, so a customer stays in the same
// group across orders and across restarts without a stored assignment table.

import { createHash, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { Order } from './types.js';

export interface CohortDecision {
  inTreatment: boolean;
  /** 0-99 bucket the customer landed in. */
  bucket: number;
  reason: string;
}

export interface CohortPolicy {
  /** Percentage of customers in treatment, 0-100. 0 disables the pilot. */
  rolloutPercent: number;
  /** Always in treatment regardless of bucket, lowercase emails. */
  allowlist: ReadonlySet<string>;
  /** Never in treatment. Wins over the allowlist. */
  denylist: ReadonlySet<string>;
  /** Orders in another currency are out of scope for the pilot. */
  currency: string;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): CohortPolicy {
  const list = (v: string | undefined): ReadonlySet<string> =>
    new Set((v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0));
  const pct = Number.parseInt(env['COHORT_ROLLOUT_PERCENT'] ?? '100', 10);
  return {
    rolloutPercent: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0,
    allowlist: list(env['COHORT_ALLOWLIST']),
    denylist: list(env['COHORT_DENYLIST']),
    currency: env['COHORT_CURRENCY'] ?? 'USD',
  };
}

/** Stable 0-99 bucket. Salted so the split is not guessable from the email alone. */
export function bucketFor(email: string, salt = 'usdc-base-rewards'): number {
  const digest = createHash('sha256').update(`${salt}:${email.toLowerCase()}`).digest();
  return digest.readUInt16BE(0) % 100;
}

function decide(order: Order, policy: CohortPolicy): CohortDecision {
  const email = order.customerEmail.toLowerCase();
  const bucket = bucketFor(email);

  if (policy.denylist.has(email)) return { inTreatment: false, bucket, reason: 'denylist' };
  if (order.currency !== policy.currency) {
    return { inTreatment: false, bucket, reason: `currency ${order.currency} outside pilot scope` };
  }
  if (policy.allowlist.has(email)) return { inTreatment: true, bucket, reason: 'allowlist' };
  if (policy.rolloutPercent <= 0) return { inTreatment: false, bucket, reason: 'rollout disabled' };

  const inTreatment = bucket < policy.rolloutPercent;
  return {
    inTreatment,
    bucket,
    reason: `bucket ${bucket} ${inTreatment ? '<' : '>='} rollout ${policy.rolloutPercent}%`,
  };
}

/**
 * Gate one order. Every decision, include and exclude, is written to
 * cohort_decisions so the pilot's denominator is reconstructable later.
 */
export function gate(db: Db, order: Order, policy: CohortPolicy = policyFromEnv()): CohortDecision {
  const decision = decide(order, policy);
  db.prepare(
    `INSERT INTO cohort_decisions (id, order_id, customer_email, in_treatment, reason, decided_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    order.id,
    order.customerEmail,
    decision.inTreatment ? 1 : 0,
    decision.reason,
    new Date().toISOString(),
  );
  return decision;
}
