// repo: src/api.ts
// Read API. No endpoint here writes to the ledger or touches the chain.
//
// Money crosses the wire as a decimal STRING of base units, never a JSON number:
// JSON.parse turns a number into a float, and 6dp of USDC past 2^53 stops round-tripping.
// Every response carries both the base units and a display string, so a client never has
// to do arithmetic on the display form.

import express, { type Express, type Request, type Response } from 'express';
import { config } from './config.js';
import type { Db } from './db.js';
import { balanceForEmail, formatUsdc, walletForEmail } from './balance.js';
import { entriesForWallet } from './ledger.js';
import type { LedgerEntry } from './types.js';

interface SerialisedEntry {
  id: string;
  orderId: string;
  walletAddress: string;
  account: LedgerEntry['account'];
  amountBaseUnits: string;
  amount: string;
  status: LedgerEntry['status'];
  txHash: string | null;
  failureReason: string | null;
  createdAt: string;
  settledAt: string | null;
}

export function serialiseEntry(entry: LedgerEntry): SerialisedEntry {
  return {
    id: entry.id,
    orderId: entry.orderId,
    walletAddress: entry.walletAddress,
    account: entry.account,
    amountBaseUnits: entry.amountBaseUnits.toString(10),
    amount: formatUsdc(entry.amountBaseUnits),
    status: entry.status,
    txHash: entry.txHash,
    failureReason: entry.failureReason,
    createdAt: entry.createdAt,
    settledAt: entry.settledAt,
  };
}

function customerEntries(db: Db, email: string): LedgerEntry[] {
  const address = walletForEmail(db, email);
  return address === null ? [] : entriesForWallet(db, address);
}

export function createApp(db: Db): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req: Request, res: Response) => {
    const cfg = config();
    res.json({
      ok: true,
      chainId: cfg.chainId,
      network: cfg.isMainnet ? 'base-mainnet' : 'base-sepolia',
      walletProvider: cfg.walletProvider,
      confirmations: cfg.confirmations,
    });
  });

  // Derived from the ledger on every request. There is no balance column to read.
  app.get('/balance/:email', (req: Request, res: Response) => {
    const email = String(req.params.email).toLowerCase();
    const entries = customerEntries(db, email);
    const view = balanceForEmail(db, email, entries);
    res.json({
      customerEmail: view.customerEmail,
      walletAddress: view.walletAddress,
      balanceBaseUnits: view.confirmedBaseUnits.toString(10),
      balance: formatUsdc(view.confirmedBaseUnits),
      pendingBaseUnits: view.pendingBaseUnits.toString(10),
      failedBaseUnits: view.failedBaseUnits.toString(10),
      entryCount: view.entryCount,
      currency: 'USDC',
    });
  });

  // Full history including pending and failed rows: a customer asking "where is my
  // reward" is usually asking about one of those two.
  app.get('/entries/:email', (req: Request, res: Response) => {
    const email = String(req.params.email).toLowerCase();
    const entries = customerEntries(db, email);
    res.json({
      customerEmail: email,
      walletAddress: walletForEmail(db, email),
      entries: entries.map(serialiseEntry),
    });
  });

  return app;
}
