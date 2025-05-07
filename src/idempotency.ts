// repo: src/idempotency.ts
// Key = merchant order id. The same webhook delivered twice must issue once.
// First call runs the work and stores the result; later calls replay it.

import type { Db } from './db.js';
import type { IssuanceResult } from './types.js';

interface Row {
  key: string;
  state: 'claimed' | 'done';
  result_json: string | null;
}

function encode(r: IssuanceResult): string {
  return JSON.stringify({ ...r, amountBaseUnits: r.amountBaseUnits.toString(10) });
}

function decode(json: string): IssuanceResult {
  const raw = JSON.parse(json) as Omit<IssuanceResult, 'amountBaseUnits'> & { amountBaseUnits: string };
  return { ...raw, amountBaseUnits: BigInt(raw.amountBaseUnits) };
}

export function lookup(db: Db, key: string): IssuanceResult | null {
  const row = db.prepare('SELECT key, state, result_json FROM idempotency_keys WHERE key = ?').get(key) as
    | Row
    | undefined;
  if (row === undefined || row.result_json === null) return null;
  return decode(row.result_json);
}

/** Run `work` once per key; a repeat delivery gets the stored result back. */
export async function once(
  db: Db,
  key: string,
  work: () => Promise<IssuanceResult>,
): Promise<IssuanceResult> {
  const existing = lookup(db, key);
  if (existing !== null) return { ...existing, outcome: 'duplicate' };

  db.prepare('INSERT INTO idempotency_keys (key, state, claimed_at) VALUES (?, ?, ?)').run(
    key,
    'claimed',
    new Date().toISOString(),
  );

  const result = await work();
  db.prepare('UPDATE idempotency_keys SET state = ?, result_json = ?, completed_at = ? WHERE key = ?').run(
    'done',
    encode(result),
    new Date().toISOString(),
    key,
  );
  return result;
}
