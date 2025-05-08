// repo: src/idempotency.ts
// Key = merchant order id. The same webhook delivered twice must issue once.
//
// fix (v1 -> final): v1 did SELECT, then INSERT, then work. Two deliveries that arrive
// close together both saw an empty SELECT and both ran the transfer: one order, two
// payouts. The check and the claim are now a single atomic
// `INSERT ... ON CONFLICT DO NOTHING`; whoever inserts a row owns the work, and the
// loser (changes === 0) reads the winner's row instead of doing anything itself.
// While the winner is still mid-flight the loser refuses rather than guessing, so the
// duplicate can never overtake the original.

import type { Db } from './db.js';
import type { IssuanceResult } from './types.js';

interface Row {
  state: 'claimed' | 'done';
  result_json: string | null;
}

/** Winner is still working. Caller should reply 409/425 and let the sender retry. */
export class IdempotencyInFlightError extends Error {
  constructor(readonly key: string) {
    super(`issuance for ${key} is already in flight`);
    this.name = 'IdempotencyInFlightError';
  }
}

function encode(r: IssuanceResult): string {
  return JSON.stringify({ ...r, amountBaseUnits: r.amountBaseUnits.toString(10) });
}

function decode(json: string): IssuanceResult {
  const raw = JSON.parse(json) as Omit<IssuanceResult, 'amountBaseUnits'> & { amountBaseUnits: string };
  return { ...raw, amountBaseUnits: BigInt(raw.amountBaseUnits) };
}

function read(db: Db, key: string): Row | undefined {
  return db.prepare('SELECT state, result_json FROM idempotency_keys WHERE key = ?').get(key) as Row | undefined;
}

export function lookup(db: Db, key: string): IssuanceResult | null {
  const row = read(db, key);
  if (row === undefined || row.result_json === null) return null;
  return decode(row.result_json);
}

/** Atomic claim. true = this caller owns the work, false = someone else already does. */
function claim(db: Db, key: string): boolean {
  const info = db
    .prepare(
      `INSERT INTO idempotency_keys (key, state, claimed_at)
       VALUES (?, 'claimed', ?)
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(key, new Date().toISOString());
  return info.changes === 1;
}

function finish(db: Db, key: string, result: IssuanceResult): void {
  db.prepare(
    `UPDATE idempotency_keys SET state = 'done', result_json = ?, completed_at = ?
     WHERE key = ? AND state = 'claimed'`,
  ).run(encode(result), new Date().toISOString(), key);
}

/** Release the claim so a retry can pick it up; only safe when nothing was broadcast. */
function release(db: Db, key: string): void {
  db.prepare(`DELETE FROM idempotency_keys WHERE key = ? AND state = 'claimed'`).run(key);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface OnceOptions {
  /** How long a loser waits for the winner's result before giving up. */
  waitMs?: number;
  pollMs?: number;
}

export async function once(
  db: Db,
  key: string,
  work: () => Promise<IssuanceResult>,
  opts: OnceOptions = {},
): Promise<IssuanceResult> {
  const waitMs = opts.waitMs ?? 2000;
  const pollMs = opts.pollMs ?? 100;

  if (!claim(db, key)) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const row = read(db, key);
      if (row?.result_json != null) return { ...decode(row.result_json), outcome: 'duplicate' };
      if (Date.now() >= deadline) throw new IdempotencyInFlightError(key);
      await sleep(pollMs);
    }
  }

  try {
    const result = await work();
    finish(db, key, result);
    return result;
  } catch (err) {
    // work() is fail-closed: once a transfer is broadcast it RETURNS a result
    // ('failed' or 'pending_unconfirmed') and never throws, so reaching here means
    // nothing was sent. Releasing the claim is therefore safe and necessary: without
    // it a transient wallet-provider or DB error would wedge the order forever.
    release(db, key);
    throw err;
  }
}
