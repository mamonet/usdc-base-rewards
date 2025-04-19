// repo: src/hmac.ts
// Shopify-style webhook auth: HMAC-SHA256 over the exact raw request body,
// base64-encoded, delivered in X-Shopify-Hmac-Sha256.
// The body must be the untouched bytes; re-serialised JSON will not match.

import { createHmac } from 'node:crypto';

export const HMAC_HEADER = 'x-shopify-hmac-sha256';

export function computeHmac(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

export function verifyWebhook(rawBody: Buffer, headerValue: string | undefined, secret: string): boolean {
  const expected = computeHmac(rawBody, secret);
  return expected === (headerValue ?? '');
}
