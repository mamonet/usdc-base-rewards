// repo: src/ingest.ts
// Webhook entry point: verify signature -> persist the raw event -> parse an Order.
// Nothing downstream sees a request that failed verification.

import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { money } from './db.js';
import { HMAC_HEADER, verifyWebhook } from './hmac.js';
import type { Order } from './types.js';

export class WebhookRejected extends Error {
  constructor(
    readonly reason: string,
    readonly status = 401,
  ) {
    super(reason);
    this.name = 'WebhookRejected';
  }
}

/** Merchant payload subset we depend on. Amounts arrive as decimal strings. */
interface ShopifyOrderPayload {
  id: number | string;
  email?: string;
  customer?: { email?: string };
  subtotal_price: string;
  currency: string;
  created_at: string;
}

/**
 * "12.34" -> 12340000n. String math only: Number('0.07') * 1e6 is 70000.00000000001.
 */
export function decimalToBaseUnits(value: string, decimals = 6): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new WebhookRejected(`bad amount ${value}`, 400);
  const negative = value.startsWith('-');
  const [whole = '0', frac = ''] = value.replace('-', '').split('.');
  if (frac.length > decimals) throw new WebhookRejected(`amount ${value} exceeds ${decimals}dp`, 400);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return negative ? -units : units;
}

export function parseOrder(body: string): Order {
  const p = JSON.parse(body) as ShopifyOrderPayload;
  const email = p.customer?.email ?? p.email;
  if (typeof email !== 'string' || email.length === 0) throw new WebhookRejected('order has no customer email', 400);
  if (p.id === undefined || p.id === null) throw new WebhookRejected('order has no id', 400);
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

export function ingest(db: Db, input: IngestInput): Order {
  const signature = input.headers[HMAC_HEADER];
  if (!verifyWebhook(input.rawBody, typeof signature === 'string' ? signature : undefined, input.secret)) {
    throw new WebhookRejected('signature verification failed');
  }

  const body = input.rawBody.toString('utf8');
  const order = parseOrder(body);
  const eventId = randomUUID();

  db.transaction(() => {
    db.prepare(
      'INSERT INTO raw_events (id, source, topic, signature, body, received_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(eventId, 'merchant', input.topic ?? 'orders/paid', typeof signature === 'string' ? signature : null, body, new Date().toISOString());

    db.prepare(
      `INSERT INTO orders (id, customer_email, subtotal_base_units, currency, created_at, raw_event_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      order.id,
      order.customerEmail,
      money.toDb(order.subtotalBaseUnits),
      order.currency,
      order.createdAt,
      eventId,
    );
  })();

  return order;
}
