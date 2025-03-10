// repo: src/config.ts
// All runtime config comes from env. No secret literal ever lands in this file.

import { baseSepolia, base } from 'viem/chains';
import type { Chain } from 'viem';
import type { Hex } from './types.js';

const BASE_SEPOLIA_ID = 84532;
const BASE_MAINNET_ID = 8453;

/** Circle's USDC on Base Sepolia. Public contract address, not a secret. */
const DEFAULT_USDC_BY_CHAIN: Record<number, Hex> = {
  [BASE_SEPOLIA_ID]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export interface AppConfig {
  chain: Chain;
  chainId: number;
  isMainnet: boolean;
  rpcUrl: string;
  usdcAddress: Hex;
  /**
   * A *reference*, not a key: either `env:TREASURY_PRIVATE_KEY` or a KMS URI
   * such as `awskms://alias/rewards-treasury`. chain.ts resolves it at call time.
   */
  treasuryKeyRef: string;
  webhookSecret: string;
  walletProvider: 'privy' | 'coinbase' | 'local';
  privyAppId: string | null;
  privyAppSecret: string | null;
  coinbaseApiKey: string | null;
  databaseUrl: string;
  port: number;
  /** Confirmations required before an entry flips to 'confirmed'. */
  confirmations: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`missing required env ${name} (see deploy/.env.example)`);
  }
  return v.trim();
}

function opt(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = opt(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not an integer: ${raw}`);
  return n;
}

/** Placeholders that must never reach a running process. */
const PLACEHOLDERS = new Set(['REPLACE_ME', '0xTREASURY_KEY_REF', 'changeme', '']);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const chainId = intEnv('CHAIN_ID', BASE_SEPOLIA_ID);
  const isMainnet = chainId === BASE_MAINNET_ID;

  // Testnet is the default. Mainnet moves real money, so it needs a deliberate opt-in
  // that cannot happen by copying a .env around.
  if (isMainnet && env['ALLOW_MAINNET'] !== '1') {
    throw new Error('refusing to start on Base mainnet without ALLOW_MAINNET=1');
  }
  if (chainId !== BASE_MAINNET_ID && chainId !== BASE_SEPOLIA_ID) {
    throw new Error(`unsupported CHAIN_ID ${chainId}; expected ${BASE_SEPOLIA_ID} or ${BASE_MAINNET_ID}`);
  }

  const usdcAddress = (opt('USDC_ADDRESS') ?? DEFAULT_USDC_BY_CHAIN[chainId] ?? '') as Hex;
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdcAddress)) {
    throw new Error('USDC_ADDRESS is unset or malformed; mainnet has no baked-in default');
  }

  const treasuryKeyRef = req('TREASURY_KEY_REF');
  if (PLACEHOLDERS.has(treasuryKeyRef)) {
    throw new Error('TREASURY_KEY_REF is still the placeholder value');
  }

  const webhookSecret = req('WEBHOOK_SECRET');
  if (PLACEHOLDERS.has(webhookSecret)) {
    throw new Error('WEBHOOK_SECRET is still the placeholder value');
  }

  const provider = (opt('WALLET_PROVIDER') ?? 'local') as AppConfig['walletProvider'];
  if (provider !== 'privy' && provider !== 'coinbase' && provider !== 'local') {
    throw new Error(`unknown WALLET_PROVIDER ${provider}`);
  }
  if (provider === 'local' && isMainnet) {
    throw new Error('the local wallet provider is testnet-only');
  }

  return {
    chain: isMainnet ? base : baseSepolia,
    chainId,
    isMainnet,
    rpcUrl: opt('BASE_RPC_URL') ?? (isMainnet ? 'https://mainnet.base.org' : 'https://sepolia.base.org'),
    usdcAddress,
    treasuryKeyRef,
    webhookSecret,
    walletProvider: provider,
    privyAppId: opt('PRIVY_APP_ID'),
    privyAppSecret: opt('PRIVY_APP_SECRET'),
    coinbaseApiKey: opt('COINBASE_API_KEY'),
    databaseUrl: opt('DATABASE_URL') ?? './data/rewards.db',
    port: intEnv('PORT', 3000),
    confirmations: intEnv('CONFIRMATIONS', isMainnet ? 3 : 1),
  };
}

let cached: AppConfig | null = null;

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test hook. */
export function resetConfig(): void {
  cached = null;
}
