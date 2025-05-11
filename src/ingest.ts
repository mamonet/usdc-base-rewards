// repo: src/ingest.ts
// Webhook entry point: verify -> persist the raw event -> parse -> idempotency -> cohort gate.
//
// change (v1 -> final): v1 stopped at a parsed Order and left the caller to decide what
// to do next, which is where a duplicate delivery would have slipped past. The pipeline
// now runs under the order-id idempotency claim, so a replay short-circuits on the
// stored result and never reaches the cohort gate or a transfer.
//
// Raw events are recorded even for a replay: the audit trail is per delivery, the
// issuance is per order.

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { money } from './db.js';
import { HMAC_HEADER, verifyWebhook } from './hmac.js';
import { once } from './idempotency.js';
import { gate } from './cohort.js';
import { issue } from './issuance.js';
import type { IssuanceResult, Order } from './types.js';

export class WebhookRejected extends Error {
  constructor(
    readonly reason: string,
    readonly status = 401,
  ) {
    super(reason);
    this.name = 'WebhookRejected';
  }
}

interface ShopifyOrderPayload {
  id: number | string;
  email?: string;
  customer?: { email?: string };
  subtotal_price: string;
  currency: string;
  created_at: string;
}

/** "12.34" -> 12340000n. String math only: Number('0.07') * 1e6 is 70000.00000000001. */
export function decimalToBaseUnits(value: string, decimals = 6): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new WebhookRejected(`bad amount ${value}`, 400);
  const negative = value.startsWith('-');
  const [whole = '0', frac = ''] = value.replace('-', '').split('.');
  if (frac.length > decimals) throw new WebhookRejected(`amount ${value} exceeds ${decimals}dp`, 400);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return negative ? -units : units;
}

export function parseOrder(body: string): Order {
  let p: ShopifyOrderPayload;
  try {
    p = JSON.parse(body) as ShopifyOrderPayload;
  } catch {
    throw new WebhookRejected('body is not JSON', 400);
  }
  const email = p.customer?.email ?? p.email;
  if (typeof email !== 'string' || email.length === 0) throw new WebhookRejected('order has no customer email', 400);
  if (p.id === undefined || p.id === null) throw new WebhookRejected('order has no id', 400);
  if (typeof p.subtotal_price !== 'string') throw new WebhookRejected('order has no subtotal_price', 400);
  return {
    id: String(p.id),
    customerEmail: email.toLowerCase(),
    subtotalBaseUnits: decimalToBaseUnits(p.subtotal_price),
    currency: p.currency,
    createdAt: p.created_at,
  };
}

export interface IngestInput {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  topic?: string;
}

/** Verify + record. Throws WebhookRejected before anything is persisted. */
export function accept(db: Db, input: IngestInput): { order: Order; eventId: string } {
  const signature = input.headers[HMAC_HEADER];
  const verified = verifyWebhook(input.rawBody, signature, input.secret);
  if (!verified.ok) throw new WebhookRejected(verified.reason);

  const body = input.rawBody.toString('utf8');
  const order = parseOrder(body);
  const eventId = randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(
      'INSERT INTO raw_events (id, source, topic, signature, body, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(eventId, 'merchant', input.topic ?? 'orders/paid', typeof signature === 'string' ? signature : null, body, now);

    // OR IGNORE: a redelivery of the same order is expected and must not error here.
    // Idempotency is enforced below by the claim, not by this insert.
    db.prepare(
      `INSERT OR IGNORE INTO orders (id, customer_email, subtotal_base_units, currency, created_at, raw_event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(order.id, order.customerEmail, money.toDb(order.subtotalBaseUnits), order.currency, order.createdAt, eventId);
  })();

  return { order, eventId };
}

/**
 * Full path for a delivery. Returns the original result on a replay
 * (outcome 'duplicate'), and never issues twice for one order id.
 */
export async function handleWebhook(db: Db, input: IngestInput): Promise<IssuanceResult> {
  const { order } = accept(db, input);

  return once(db, order.id, async () => {
    const decision = gate(db, order);
    if (!decision.inTreatment) {
      return {
        orderId: order.id,
        outcome: 'skipped_not_in_cohort',
        amountBaseUnits: 0n,
        txHash: null,
        ledgerEntryId: null,
        reason: decision.reason,
      };
    }
    return issue(db, order);
  });
}
