// repo: src/issuance.ts
// One order in, one reward out: rule -> wallet -> transfer -> ledger entry.
// Runs inside the idempotency claim, so it is only ever entered once per order id.

import type { Db } from './db.js';
import { activeRule, computeReward } from './rules.js';
import { transfer, treasuryAccount } from './chain.js';
import { appendIssuance } from './ledger.js';
import { walletProvider } from './wallet/index.js';
import type { IssuanceResult, Order } from './types.js';

function skip(order: Order, outcome: IssuanceResult['outcome'], reason: string): IssuanceResult {
  return { orderId: order.id, outcome, amountBaseUnits: 0n, txHash: null, ledgerEntryId: null, reason };
}

export async function issue(db: Db, order: Order): Promise<IssuanceResult> {
  // 1. rule
  const rule = activeRule(db);
  if (rule === null) return skip(order, 'skipped_zero_reward', 'no active reward rule');

  const reward = computeReward(rule, order);
  if (reward.amountBaseUnits <= 0n) {
    const outcome =
      order.subtotalBaseUnits < rule.minSubtotalBaseUnits ? 'skipped_below_minimum' : 'skipped_zero_reward';
    return skip(order, outcome, reward.reason);
  }

  // 2. wallet, created on first earn only
  const wallet = await walletProvider().getOrCreate(order.customerEmail);

  // 3. transfer
  const txHash = await transfer(wallet.address, reward.amountBaseUnits);

  // 4. ledger
  const pair = appendIssuance(db, {
    orderId: order.id,
    walletAddress: wallet.address,
    treasuryAddress: treasuryAccount().address,
    amountBaseUnits: reward.amountBaseUnits,
    txHash,
  });

  return {
    orderId: order.id,
    outcome: 'issued',
    amountBaseUnits: reward.amountBaseUnits,
    txHash,
    ledgerEntryId: pair.customer.id,
    reason: reward.reason,
  };
}
