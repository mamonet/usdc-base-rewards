// repo: src/hmac.ts
// Shopify-style webhook auth: HMAC-SHA256 over the exact raw request body,
// base64-encoded, delivered in X-Shopify-Hmac-Sha256.
//
// fix (v1 -> final): two defects.
//  1. `expected === header` is a short-circuiting compare, so the time it takes leaks
//     how many leading characters an attacker guessed right. Use timingSafeEqual, which
//     needs equal-length buffers, so length is checked first and separately.
//  2. `headerValue ?? ''` turned a *missing* signature into an empty-string comparison.
//     That is still a rejection today, but it makes "unsigned" indistinguishable from
//     "wrong signature" in logs and is one refactor away from being accepted. Absent
//     header is now its own explicit failure.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const HMAC_HEADER = 'x-shopify-hmac-sha256';

export type VerifyFailure = 'missing_signature' | 'malformed_signature' | 'bad_signature';

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

export function computeHmac(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('base64');
}

export function verifyWebhook(
  rawBody: Buffer,
  headerValue: string | string[] | undefined,
  secret: string,
): VerifyResult {
  // A duplicated header is ambiguous; treat it as missing rather than picking one.
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return { ok: false, reason: 'missing_signature' };
  }

  const expected = Buffer.from(computeHmac(rawBody, secret), 'base64');
  const provided = Buffer.from(headerValue, 'base64');

  // SHA-256 is 32 bytes. Base64 decoding is lenient, so pin the length before comparing.
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}

/** Convenience for call sites that only branch on pass/fail. */
export function isValidWebhook(
  rawBody: Buffer,
  headerValue: string | string[] | undefined,
  secret: string,
): boolean {
  return verifyWebhook(rawBody, headerValue, secret).ok;
}
