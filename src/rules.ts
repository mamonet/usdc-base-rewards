// repo: src/rules.ts
// Reward = rate x subtotal, where the rate comes from a stored rule row, not a constant.
// All arithmetic is bigint base units.

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { money } from './db.js';
import type { Order, RewardRule } from './types.js';

const BPS_DENOMINATOR = 10_000n;

interface RuleRow {
  id: string;
  rate_bps: number;
  max_reward_base_units: string;
  min_subtotal_base_units: string;
  active: number;
}

function toRule(row: RuleRow): RewardRule {
  return {
    id: row.id,
    rateBps: row.rate_bps,
    maxRewardBaseUnits: money.fromDb(row.max_reward_base_units),
    minSubtotalBaseUnits: money.fromDb(row.min_subtotal_base_units),
    active: row.active === 1,
  };
}

export function activeRule(db: Db): RewardRule | null {
  const row = db
    .prepare('SELECT id, rate_bps, max_reward_base_units, min_subtotal_base_units, active FROM reward_rules WHERE active = 1 ORDER BY created_at DESC LIMIT 1')
    .get() as RuleRow | undefined;
  return row === undefined ? null : toRule(row);
}

export function upsertRule(db: Db, rule: Omit<RewardRule, 'id'> & { id?: string }): RewardRule {
  const id = rule.id ?? randomUUID();
  if (rule.active) db.prepare('UPDATE reward_rules SET active = 0').run();
  db.prepare(
    `INSERT INTO reward_rules (id, rate_bps, max_reward_base_units, min_subtotal_base_units, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       rate_bps = excluded.rate_bps,
       max_reward_base_units = excluded.max_reward_base_units,
       min_subtotal_base_units = excluded.min_subtotal_base_units,
       active = excluded.active`,
  ).run(
    id,
    rule.rateBps,
    money.toDb(rule.maxRewardBaseUnits),
    money.toDb(rule.minSubtotalBaseUnits),
    rule.active ? 1 : 0,
    new Date().toISOString(),
  );
  return { ...rule, id };
}

export interface RewardComputation {
  amountBaseUnits: bigint;
  ruleId: string;
  reason: string;
}

/**
 * subtotal * rateBps / 10000, truncated.
 *
 * Rounding: integer division in bigint truncates toward zero, so the customer is
 * short by at most 1 base unit (0.000001 USDC) per order. Chosen over rounding up
 * because the treasury must never pay out more than the stated rate, and over
 * banker's rounding because "never exceeds rate x subtotal" is a property that is
 * trivial to state, test, and audit. Fractions below a base unit are not payable
 * on-chain anyway.
 */
export function computeReward(rule: RewardRule, order: Order): RewardComputation {
  if (!rule.active) {
    return { amountBaseUnits: 0n, ruleId: rule.id, reason: 'rule inactive' };
  }
  if (order.subtotalBaseUnits <= 0n) {
    return { amountBaseUnits: 0n, ruleId: rule.id, reason: 'non-positive subtotal' };
  }
  if (order.subtotalBaseUnits < rule.minSubtotalBaseUnits) {
    return {
      amountBaseUnits: 0n,
      ruleId: rule.id,
      reason: `subtotal ${order.subtotalBaseUnits} below minimum ${rule.minSubtotalBaseUnits}`,
    };
  }

  const raw = (order.subtotalBaseUnits * BigInt(rule.rateBps)) / BPS_DENOMINATOR;

  if (rule.maxRewardBaseUnits > 0n && raw > rule.maxRewardBaseUnits) {
    return {
      amountBaseUnits: rule.maxRewardBaseUnits,
      ruleId: rule.id,
      reason: `capped at ${rule.maxRewardBaseUnits} (uncapped ${raw})`,
    };
  }
  return {
    amountBaseUnits: raw,
    ruleId: rule.id,
    reason: `${rule.rateBps}bps of ${order.subtotalBaseUnits} = ${raw}`,
  };
}
