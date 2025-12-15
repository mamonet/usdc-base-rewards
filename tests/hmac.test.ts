// repo: tests/hmac.test.ts
// Webhook auth. An unsigned or tampered delivery must never reach the issuance path.

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeHmac, isValidWebhook, verifyWebhook, HMAC_HEADER } from '../src/hmac.js';
import { openDb, type Db } from '../src/db.js';
import { accept, WebhookRejected } from '../src/ingest.js';

const SECRET = 'dev-secret';

const BODY = Buffer.from(
  JSON.stringify({
    id: 'order-1',
    customer: { email: 'buyer@example.test' },
    subtotal_price: '40.00',
    currency: 'USD',
    created_at: '2024-01-01T00:00:00Z',
  }),
);

const sign = (raw: Buffer, secret = SECRET): string => createHmac('sha256', secret).update(raw).digest('base64');

describe('verifyWebhook', () => {
  it('accepts a body signed with the shared secret', () => {
    expect(verifyWebhook(BODY, sign(BODY), SECRET)).toEqual({ ok: true });
    expect(computeHmac(BODY, SECRET)).toBe(sign(BODY));
  });

  it('rejects a tampered body', () => {
    // Signature from the original bytes, body altered after signing: the classic
    // "change the amount in flight" attempt.
    const signature = sign(BODY);
    const tampered = Buffer.from(BODY.toString('utf8').replace('40.00', '4000.00'));

    expect(verifyWebhook(tampered, signature, SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(isValidWebhook(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects a body signed with the wrong secret', () => {
    expect(verifyWebhook(BODY, sign(BODY, 'not-the-secret'), SECRET)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a missing header, distinctly from a wrong one', () => {
    expect(verifyWebhook(BODY, undefined, SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyWebhook(BODY, '', SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
    // A duplicated header is ambiguous, so it is treated as absent rather than guessed at.
    expect(verifyWebhook(BODY, [sign(BODY), sign(BODY)], SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a signature of the wrong length before comparing', () => {
    expect(verifyWebhook(BODY, 'YWJj', SECRET)).toEqual({ ok: false, reason: 'malformed_signature' });
  });
});

describe('ingest.accept', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('records nothing when the signature is absent', () => {
    expect(() => accept(db, { rawBody: BODY, headers: {}, secret: SECRET })).toThrow(WebhookRejected);

    // Verification happens before any write, so a forged delivery cannot even fill the
    // raw_events table.
    const count = db.prepare('SELECT COUNT(*) AS n FROM raw_events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('records nothing when the body was tampered with', () => {
    const signature = sign(BODY);
    const tampered = Buffer.from(BODY.toString('utf8').replace('40.00', '4000.00'));

    expect(() => accept(db, { rawBody: tampered, headers: { [HMAC_HEADER]: signature }, secret: SECRET })).toThrow(
      WebhookRejected,
    );
    const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number };
    expect(orders.n).toBe(0);
  });

  it('accepts and stores a correctly signed delivery', () => {
    const { order, eventId } = accept(db, { rawBody: BODY, headers: { [HMAC_HEADER]: sign(BODY) }, secret: SECRET });

    expect(order.id).toBe('order-1');
    expect(order.subtotalBaseUnits).toBe(40_000_000n);

    // The raw bytes are kept verbatim; the HMAC was computed over exactly these.
    const stored = db.prepare('SELECT body FROM raw_events WHERE id = ?').get(eventId) as { body: string };
    expect(stored.body).toBe(BODY.toString('utf8'));
  });
});
