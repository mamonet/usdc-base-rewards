// repo: src/chain.ts
// viem clients for Base + the treasury signer.
//
// fix (v2 -> final): waitForConfirmation returned status 'success' for any receipt.
// An EVM tx that reverts still gets a receipt (with status 'reverted'), so a failed
// transfer was reported as a completed payout and the ledger marked it issued.
// Confirmation now requires BOTH:
//   1. receipt.status === 'success', and
//   2. a Transfer log from the USDC contract to the expected recipient for the exact
//      amount - a receipt alone does not prove the tokens moved (a non-reverting
//      token can return false, and a proxy upgrade can change behaviour under us).
// A revert is permanent, so it surfaces as PermanentChainError instead of being
// handed to the retry loop, which would only burn gas re-running the same failure.

import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  decodeEventLog,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { config } from './config.js';
import { erc20Abi, usdcAddress, assertPayable } from './usdc.js';
import { PermanentChainError, RetryableChainError, type TxStatus } from './types.js';

let publicClientCache: PublicClient | null = null;

export function publicClient(): PublicClient {
  const cfg = config();
  publicClientCache ??= createPublicClient({ chain: cfg.chain, transport: http(cfg.rpcUrl) });
  return publicClientCache;
}

/**
 * TREASURY_KEY_REF is a pointer, not a secret:
 *   env:NAME     -> read process.env.NAME at call time
 *   awskms://... -> KMS signer (not wired in the demo)
 * The resolved material stays in this function's frame: never cached, logged, or returned.
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

export function treasuryAddress(): Hex {
  return treasuryAccount().address;
}

/** Revert reasons that will never succeed on retry. */
const PERMANENT_MARKERS = [
  'transfer amount exceeds balance',
  'insufficient funds',
  'blacklisted',
  'execution reverted',
  'invalid address',
];

function classify(err: unknown, txHash: Hex | null): never {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (PERMANENT_MARKERS.some((m) => lower.includes(m))) {
    throw new PermanentChainError(message, txHash);
  }
  // Timeouts, nonce races, underpriced replacements, RPC 5xx: worth another go.
  throw new RetryableChainError(message, txHash);
}

export interface SendResult {
  txHash: Hex;
  gasLimit: bigint;
}

/** Simulate, pad the gas estimate, broadcast. Returns a hash only, never "issued". */
export async function sendTransfer(to: Hex, amountBaseUnits: bigint): Promise<SendResult> {
  assertPayable(amountBaseUnits);
  const cfg = config();
  const account = treasuryAccount();
  const pub = publicClient();
  const recipient = getAddress(to);

  try {
    // Simulation catches the permanent failures before a nonce is burnt.
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
    // 20% headroom: a USDC transfer costs more when the recipient goes 0 -> nonzero.
    const gasLimit = (estimate * 120n) / 100n;

    const wallet = createWalletClient({ account, chain: cfg.chain, transport: http(cfg.rpcUrl) });
    const txHash = await wallet.writeContract({ ...request, gas: gasLimit });
    return { txHash, gasLimit };
  } catch (err) {
    classify(err, null);
  }
}

export interface ConfirmResult {
  status: TxStatus;
  receipt: TransactionReceipt | null;
  /** Amount proved moved by the Transfer log, when status is 'success'. */
  transferred: bigint | null;
}

/** Does this receipt contain a USDC Transfer to `to` for exactly `amount`? */
export function hasTransferLog(receipt: TransactionReceipt, to: Hex, amount: bigint): bigint | null {
  const token = usdcAddress().toLowerCase();
  const recipient = getAddress(to).toLowerCase();

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue;
    try {
      const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Transfer') continue;
      const args = decoded.args as unknown as { to: Hex; value: bigint };
      if (args.to.toLowerCase() === recipient && args.value === amount) return args.value;
    } catch {
      // Not one of ours; skip.
      continue;
    }
  }
  return null;
}

/**
 * Wait for the tx to land and prove it did what we asked.
 * - reverted receipt -> PermanentChainError
 * - mined but no matching Transfer log -> PermanentChainError (do not retry a lie)
 * - no receipt in the window -> 'pending', the retry loop decides what to do
 */
export async function waitForConfirmation(
  txHash: Hex,
  to: Hex,
  amountBaseUnits: bigint,
  timeoutMs = 120_000,
): Promise<ConfirmResult> {
  const cfg = config();
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient().waitForTransactionReceipt({
      hash: txHash,
      confirmations: cfg.confirmations,
      timeout: timeoutMs,
    });
  } catch {
    // No receipt yet. Unknown, not failed: the tx may still be in the mempool and
    // treating it as failed here is how you double-pay.
    return { status: 'pending', receipt: null, transferred: null };
  }

  if (receipt.status !== 'success') {
    throw new PermanentChainError(`tx ${txHash} reverted on chain`, txHash);
  }

  const transferred = hasTransferLog(receipt, to, amountBaseUnits);
  if (transferred === null) {
    throw new PermanentChainError(
      `tx ${txHash} mined with status success but no USDC Transfer of ${amountBaseUnits} to ${to}`,
      txHash,
    );
  }

  return { status: 'success', receipt, transferred };
}

export async function usdcBalance(address: Hex): Promise<bigint> {
  return publicClient().readContract({
    address: usdcAddress(),
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [getAddress(address)],
  });
}
