// repo: tests/rules.test.ts
// Reward arithmetic. Integer base units only; a float anywhere here is a bug in someone's
// balance.

import { describe, expect, it } from 'vitest';
import { computeReward } from '../src/rules.js';
import { decimalToBaseUnits } from '../src/ingest.js';
import type { Order, RewardRule } from '../src/types.js';

const rule = (over: Partial<RewardRule> = {}): RewardRule => ({
  id: 'rule-test',
  rateBps: 250, // 2.50%
  maxRewardBaseUnits: 0n,
  minSubtotalBaseUnits: 0n,
  active: true,
  ...over,
});

const order = (subtotalBaseUnits: bigint): Order => ({
  id: 'order-1',
  customerEmail: 'buyer@example.test',
  subtotalBaseUnits,
  currency: 'USD',
  createdAt: '2024-01-01T00:00:00Z',
});

describe('computeReward', () => {
  it('is rate x subtotal in base units', () => {
    // 40.00 USDC at 250bps = 1.00 USDC
    const result = computeReward(rule(), order(40_000_000n));
    expect(result.amountBaseUnits).toBe(1_000_000n);
    expect(typeof result.amountBaseUnits).toBe('bigint');
  });

  it('scales linearly without accumulating error', () => {
    const one = computeReward(rule(), order(10_000_000n)).amountBaseUnits;
    const hundred = computeReward(rule(), order(1_000_000_000n)).amountBaseUnits;
    expect(one).toBe(250_000n);
    expect(hundred).toBe(one * 100n);
  });

  describe('rounding at the boundary', () => {
    it('truncates toward zero, never up', () => {
      // 39999999 x 250 / 10000 = 999999.975 base units. The fraction is dropped, so the
      // treasury never pays more than the stated rate.
      expect(computeReward(rule(), order(39_999_999n)).amountBaseUnits).toBe(999_999n);
    });

    it('gives nothing when the reward rounds below one base unit', () => {
      // 3 base units x 250 / 10000 = 0.075 of a base unit: nothing payable on chain.
      const result = computeReward(rule(), order(3n));
      expect(result.amountBaseUnits).toBe(0n);
    });

    it('pays exactly one base unit at the first subtotal that earns one', () => {
      // 40 base units x 250 / 10000 = 1 exactly; 39 gives 0.975 -> 0.
      expect(computeReward(rule(), order(39n)).amountBaseUnits).toBe(0n);
      expect(computeReward(rule(), order(40n)).amountBaseUnits).toBe(1n);
    });

    it('is never more than rate x subtotal', () => {
      for (const subtotal of [1n, 7n, 39n, 999_999n, 12_345_678n, 99_999_999_999n]) {
        const paid = computeReward(rule(), order(subtotal)).amountBaseUnits;
        expect(paid * 10_000n).toBeLessThanOrEqual(subtotal * 250n);
      }
    });
  });

  it('caps at the rule ceiling', () => {
    const capped = computeReward(rule({ maxRewardBaseUnits: 5_000_000n }), order(1_000_000_000n));
    expect(capped.amountBaseUnits).toBe(5_000_000n);
  });

  it('pays nothing below the rule minimum, or when inactive', () => {
    expect(computeReward(rule({ minSubtotalBaseUnits: 50_000_000n }), order(40_000_000n)).amountBaseUnits).toBe(0n);
    expect(computeReward(rule({ active: false }), order(40_000_000n)).amountBaseUnits).toBe(0n);
    expect(computeReward(rule(), order(0n)).amountBaseUnits).toBe(0n);
  });

  it('stays exact past the range a double can represent', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const paid = computeReward(rule({ rateBps: 10_000 }), order(huge)).amountBaseUnits;

    expect(paid).toBe(huge);
    // Same value through a float loses the last digit. That is the bug this avoids.
    expect(BigInt(Number(huge))).not.toBe(huge);
  });
});

describe('decimalToBaseUnits', () => {
  it('parses money as a string, never through Number', () => {
    expect(decimalToBaseUnits('40.00')).toBe(40_000_000n);
    expect(decimalToBaseUnits('0.000001')).toBe(1n);
    // Number('0.07') * 1e6 is 70000.000000000001; the string path is exact.
    expect(decimalToBaseUnits('0.07')).toBe(70_000n);
    expect(decimalToBaseUnits('12345678.123456')).toBe(12_345_678_123_456n);
  });

  it('rejects more precision than USDC has rather than truncating it', () => {
    expect(() => decimalToBaseUnits('1.1234567')).toThrow();
    expect(() => decimalToBaseUnits('not-a-number')).toThrow();
  });
});
