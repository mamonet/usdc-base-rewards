// repo: src/index.ts
// Composition root. Everything is wired here and nowhere else: modules take their
// dependencies as arguments so a test can build the same graph without a server.
//
// Startup order matters. Config is validated first (it is what refuses mainnet), then the
// database, then the wallet provider, then the signer, and only then does the port open.
// A process that cannot issue should fail at boot, not on the first customer's order.

import { config, type AppConfig } from './config.js';
import { openDb, type Db } from './db.js';
import { setWalletProvider, createWalletProvider } from './wallet/index.js';
import { setTreasuryAddress } from './ledger.js';
import { treasuryAddress } from './chain.js';
import { activeRule, upsertRule } from './rules.js';
import { createApp } from './api.js';

function intEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return BigInt(raw.trim());
}

/**
 * Second gate on top of the one in config.ts. Config refuses to build a mainnet config
 * without ALLOW_MAINNET=1; this re-checks after the fact and says so loudly, because the
 * failure mode being prevented is someone copying a .env between environments and finding
 * out from a block explorer.
 */
function assertNetworkIntent(cfg: AppConfig): void {
  if (!cfg.isMainnet) return;
  if (process.env['ALLOW_MAINNET'] !== '1') {
    throw new Error('refusing to start on Base mainnet without ALLOW_MAINNET=1');
  }
  console.warn('[startup] BASE MAINNET. Transfers move real USDC from the treasury.');
}

/** A rule must exist or every order skips. Seeded from env on an empty table only. */
function ensureRule(db: Db): void {
  if (activeRule(db) !== null) return;
  const rateBps = Number.parseInt(process.env['REWARD_RATE_BPS'] ?? '250', 10);
  const rule = upsertRule(db, {
    rateBps,
    maxRewardBaseUnits: intEnv('REWARD_MAX_BASE_UNITS', 5_000_000n),
    minSubtotalBaseUnits: intEnv('REWARD_MIN_SUBTOTAL_BASE_UNITS', 0n),
    active: true,
  });
  console.log(`[startup] seeded reward rule ${rule.id} at ${rule.rateBps}bps`);
}

export function bootstrap(): { cfg: AppConfig; db: Db } {
  // config() caches, so api.ts and chain.ts see this exact object.
  const cfg = config();
  assertNetworkIntent(cfg);

  const db = openDb(cfg.databaseUrl);
  ensureRule(db);

  setWalletProvider(createWalletProvider(db, cfg));

  // Resolving the signer proves the key reference actually points at something before a
  // customer's order depends on it. The address is public; the material stays in chain.ts.
  try {
    const address = treasuryAddress();
    setTreasuryAddress(address);
    console.log(`[startup] treasury ${address} on chain ${cfg.chainId}`);
  } catch (err) {
    // Not fatal for the read API, but issuance will fail closed until it is fixed.
    console.warn(`[startup] treasury signer unresolved: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { cfg, db };
}

function main(): void {
  const { cfg, db } = bootstrap();
  const server = createApp(db).listen(cfg.port, () => {
    console.log(
      `[startup] listening on :${cfg.port} (${cfg.isMainnet ? 'base-mainnet' : 'base-sepolia'}, wallets: ${cfg.walletProvider})`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[shutdown] ${signal}`);
    // Stop accepting connections first; in-flight issuances keep their idempotency claim
    // and are picked up by the reconciler if they do not finish.
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
