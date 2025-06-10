// repo: src/chain.ts
// viem clients for Base + the treasury signer.
//
// v1 -> v2: v1 fired writeContract blind and returned a hash. Added a simulate + gas
// estimate before broadcast (so a doomed transfer fails before it costs anything) and
// confirmation polling that waits for a receipt.

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { config } from './config.js';
import { erc20Abi, usdcAddress, assertPayable } from './usdc.js';
import type { TxStatus } from './types.js';

let publicClientCache: PublicClient | null = null;

export function publicClient(): PublicClient {
  const cfg = config();
  publicClientCache ??= createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  return publicClientCache;
}

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

export interface SendResult {
  txHash: Hex;
  gasLimit: bigint;
}

/**
 * Simulate, pad the gas estimate, broadcast. Simulation catches the common permanent
 * failures (insufficient treasury balance, blocklisted recipient) before a nonce is burnt.
 */
export async function sendTransfer(to: Hex, amountBaseUnits: bigint): Promise<SendResult> {
  assertPayable(amountBaseUnits);
  const cfg = config();
  const account = treasuryAccount();
  const pub = publicClient();
  const recipient = getAddress(to);

  const { request } = await pub.simulateContract({
    account,
    address: usdcAddress(),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, amountBaseUnits],
  });

  const estimate = await pub.estimateContractGas({
    account,
    address: usdcAddress(),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [recipient, amountBaseUnits],
  });
  // 20% headroom: USDC transfers cost more when the recipient balance goes 0 -> nonzero.
  const gasLimit = (estimate * 120n) / 100n;

  const wallet = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
  const txHash = await wallet.writeContract({ ...request, gas: gasLimit });
  return { txHash, gasLimit };
}

export interface ConfirmResult {
  status: TxStatus;
  receipt: TransactionReceipt | null;
}

/** Poll until the receipt shows up or the timeout expires. */
export async function waitForConfirmation(txHash: Hex, timeoutMs = 120_000): Promise<ConfirmResult> {
  const cfg = config();
  try {
    const receipt = await publicClient().waitForTransactionReceipt({
      hash: txHash,
      confirmations: cfg.confirmations,
      timeout: timeoutMs,
    });
    // A receipt means the tx was mined.
    return { status: 'success', receipt };
  } catch {
    // No receipt inside the window: still pending as far as we know, not failed.
    return { status: 'pending', receipt: null };
  }
}

export async function usdcBalance(address: Hex): Promise<bigint> {
  return publicClient().readContract({
    address: usdcAddress(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getAddress(address)],
  });
}
