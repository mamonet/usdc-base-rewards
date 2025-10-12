// repo: src/issuance.ts
// One order in, one reward out. Runs inside the idempotency claim, so it is only ever
// entered once per order id.
//
// fix (v1 -> final): v1 broadcast the transfer and then appended the ledger legs and
// returned outcome 'issued' on the strength of a tx hash. A hash means "a node accepted
// it", not "the tokens moved". A reverted or dropped tx was therefore reported as a paid
// reward, and support saw an issued order with nothing behind it.
//
// Ordering now, and why:
//   1. compute the reward           - no side effects, cheap to bail out of
//   2. ensure the wallet            - need an address before anything can be sent
//   3. append the PENDING legs      - BEFORE broadcast, so a crash between send and
//                                     confirm leaves a visible claim to reconcile
//                                     against the chain instead of an orphan transfer
//   4. broadcast, then confirm      - confirmation requires a success receipt AND the
//                                     matching Transfer log (chain.ts)
//   5. settle                       - confirmIssuance only on proof, failIssuance on a
//                                     permanent error, neither while the outcome is
//                                     unknown
//
// Pending is not spendable: balance.ts folds confirmed rows only. Fail closed means the
// two bad states are "still pending" and "explicitly failed", never "issued".

import type { Db } from './db.js';
import { activeRule, computeReward } from './rules.js';
import { sendTransfer, waitForConfirmation, treasuryAddress } from './chain.js';
import { withRetry, isPermanent, recordAttempt, RetriesExhausted } from './retry.js';
import { appendIssuance, confirmIssuance, failIssuance } from './ledger.js';
import { walletProvider } from './wallet/index.js';
import type { Hex, IssuanceResult, Order } from './types.js';

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

  // 3. pending legs first, with no hash yet. This row is the record that we are about
  // to move money, written before we can lose the ability to write it.
  const pending = appendIssuance(db, {
    orderId: order.id,
    walletAddress: wallet.address,
    treasuryAddress: treasuryAddress(),
    amountBaseUnits: reward.amountBaseUnits,
    txHash: null,
  });
  const entryId = pending.customer.id;

  // Held across attempts: if attempt 1 broadcast and then timed out waiting, attempt 2
  // waits on that same hash. It never sends a second transfer for one order.
  let broadcast: Hex | null = null;

  try {
    // 4. send + confirm under backoff
    const txHash = await withRetry({ db, ledgerEntryId: entryId }, async (attempt) => {
      if (broadcast === null) {
        const sent = await sendTransfer(wallet.address, reward.amountBaseUnits);
        broadcast = sent.txHash;
        recordAttempt(db, { ledgerEntryId: entryId, attempt, txHash: broadcast, status: 'sent', error: null });
      }
      const confirmed = await waitForConfirmation(broadcast, wallet.address, reward.amountBaseUnits);
      if (confirmed.status !== 'success') {
        // No receipt inside the window. Throwing keeps the legs pending and lets the
        // policy back off; it does not re-broadcast, because `broadcast` is set.
        throw new Error(`tx ${broadcast} not confirmed yet`);
      }
      return broadcast;
    });

    // 5a. settle on proof. Appends the confirmed pair; the pending pair is untouched.
    confirmIssuance(db, order.id, txHash);
    return {
      orderId: order.id,
      outcome: 'issued',
      amountBaseUnits: reward.amountBaseUnits,
      txHash,
      ledgerEntryId: entryId,
      reason: reward.reason,
    };
  } catch (err) {
    // 5b. permanent failure is recorded, never dropped.
    if (isPermanent(err)) {
      const hash = err.txHash ?? broadcast;
      failIssuance(db, order.id, err.message, hash);
      return {
        orderId: order.id,
        outcome: 'failed',
        amountBaseUnits: reward.amountBaseUnits,
        txHash: hash,
        ledgerEntryId: entryId,
        reason: `permanent chain failure: ${err.message}`,
      };
    }

    // Outcome genuinely unknown: the tx may still land. Do NOT settle either way.
    //
    // This RETURNS rather than throws on purpose. Throwing would release the
    // idempotency claim, and a redelivery would then broadcast a second transfer for
    // one that may be seconds from confirming. Storing 'pending_unconfirmed' under the
    // key makes a redelivery replay this answer, and only the reconciler (which reads
    // unsettledEntries and re-polls the chain) ever resolves it. Pending contributes
    // nothing to the balance, so nothing is credited on a guess.
    const detail = err instanceof RetriesExhausted ? err.message : err instanceof Error ? err.message : String(err);
    recordAttempt(db, { ledgerEntryId: entryId, attempt: 0, txHash: broadcast, status: 'exhausted', error: detail });
    return {
      orderId: order.id,
      outcome: 'pending_unconfirmed',
      amountBaseUnits: reward.amountBaseUnits,
      txHash: broadcast,
      ledgerEntryId: entryId,
      reason: `unconfirmed: ${detail}`,
    };
  }
}
