// repo: src/chain.ts
// viem clients for Base + the treasury signer. The private key is resolved from a
// reference at call time and is never held in module scope, logged, or serialised.

import { createPublicClient, createWalletClient, http, getAddress, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { config } from './config.js';
import { erc20Abi, usdcAddress, assertPayable } from './usdc.js';

let publicClientCache: PublicClient | null = null;

export function publicClient(): PublicClient {
  const cfg = config();
  publicClientCache ??= createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  return publicClientCache;
}

/**
 * TREASURY_KEY_REF is a pointer, not a secret:
 *   env:NAME            -> read process.env.NAME at call time
 *   awskms://...        -> KMS signer (not wired in the demo)
 * Nothing here ever writes the resolved material anywhere.
 */
export function treasuryAccount(): PrivateKeyAccount {
  const ref = config().treasuryKeyRef;
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const material = process.env[name];
    if (material === undefined || material.trim() === '' || material === 'REPLACE_ME') {
      throw new Error(`treasury key ref ${ref} resolves to nothing; set ${name} in the runtime environment`);
    }
    return privateKeyToAccount(material.trim() as Hex);
  }
  throw new Error(`unsupported TREASURY_KEY_REF scheme: ${ref.split(':')[0] ?? ref}`);
}

export function walletClient(): WalletClient {
  const cfg = config();
  return createWalletClient({ account: treasuryAccount(), chain: cfg.chain, transport: http(cfg.rpcUrl) });
}

/** Broadcast a USDC transfer. Returns the hash; says nothing about it landing. */
export async function transfer(to: Hex, amountBaseUnits: bigint): Promise<Hex> {
  assertPayable(amountBaseUnits);
  const cfg = config();
  const account = treasuryAccount();
  const client = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });

  return client.writeContract({
    account,
    chain: cfg.chain,
    address: usdcAddress(),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(to), amountBaseUnits],
  });
}

export async function usdcBalance(address: Hex): Promise<bigint> {
  return publicClient().readContract({
    address: usdcAddress(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getAddress(address)],
  });
}
