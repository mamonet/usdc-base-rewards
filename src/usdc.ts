// repo: src/usdc.ts
// ERC-20 subset for USDC plus base-unit helpers. USDC is 6dp on every chain it ships on,
// but decimals() is still read once at startup and asserted rather than assumed.

import { getAddress, parseUnits, formatUnits, type Hex } from 'viem';
import { config } from './config.js';

export const USDC_DECIMALS = 6;

/** transfer / balanceOf / decimals / Transfer. Nothing else is needed. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export function usdcAddress(): Hex {
  return getAddress(config().usdcAddress);
}

/** "1.25" -> 1250000n. Throws on more than 6dp instead of truncating. */
export function toBaseUnits(human: string): bigint {
  const [, frac = ''] = human.split('.');
  if (frac.length > USDC_DECIMALS) throw new Error(`${human} has more than ${USDC_DECIMALS} decimals`);
  return parseUnits(human, USDC_DECIMALS);
}

/** 1250000n -> "1.25". Display only; never feed the result back into math. */
export function toDisplay(baseUnits: bigint): string {
  return formatUnits(baseUnits, USDC_DECIMALS);
}

/** Guard for anything about to be broadcast. */
export function assertPayable(baseUnits: bigint): void {
  if (typeof baseUnits !== 'bigint') throw new Error('amount must be a bigint in base units');
  if (baseUnits <= 0n) throw new Error(`refusing to transfer non-positive amount ${baseUnits}`);
}
