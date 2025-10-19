// repo: src/api.ts
// Read API + the webhook endpoint + the event export.
//
// Money crosses the wire as a decimal STRING of base units, never a JSON number:
// JSON.parse turns a number into a float, and 6dp of USDC past 2^53 stops round-tripping.
// Every response carries both the base units and a display string, so a client never has
// to do arithmetic on the display form.
//
// change (v1 -> final): the webhook and the export. The webhook is the only write path in
// this file and it is mounted with a RAW body parser, for the reason below.

import express, { type Express, type Request, type Response } from 'express';
import { config } from './config.js';
import type { Db } from './db.js';
import { balanceForEmail, formatUsdc, walletForEmail } from './balance.js';
import { entriesForWallet, listEntries } from './ledger.js';
import { handleWebhook, WebhookRejected } from './ingest.js';
import { IdempotencyInFlightError } from './idempotency.js';
import type { IssuanceResult, LedgerEntry } from './types.js';

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

function serialiseResult(result: IssuanceResult): Record<string, unknown> {
  return {
    orderId: result.orderId,
    outcome: result.outcome,
    amountBaseUnits: result.amountBaseUnits.toString(10),
    amount: formatUsdc(result.amountBaseUnits),
    txHash: result.txHash,
    ledgerEntryId: result.ledgerEntryId,
    reason: result.reason,
  };
}

function customerEntries(db: Db, email: string): LedgerEntry[] {
  const address = walletForEmail(db, email);
  return address === null ? [] : entriesForWallet(db, address);
}

function intParam(value: unknown, fallback: number, max: number): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function createApp(db: Db): Express {
  const app = express();
  app.disable('x-powered-by');

  // NOTE: there is deliberately no app-wide express.json(). The webhook route below needs
  // the exact bytes the sender signed, and a global JSON parser would consume the stream
  // first. Nothing else here accepts a body.

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

  /**
   * RAW BODY, NOT JSON. The HMAC is computed over the bytes the merchant sent. Parsing to
   * an object and re-serialising with JSON.stringify produces different bytes for the
   * same document: key order can move, whitespace and newlines are dropped, unicode
   * escaping differs, and 1.0 comes back as 1. The signature then fails to match a
   * perfectly valid request, and the usual "fix" is to stop checking it. So the parser is
   * express.raw, scoped to this route, and JSON.parse happens after verification.
   *
   * The wildcard type is because senders are inconsistent about Content-Type, and
   * verification does not care what they claim the body is.
   */
  app.post(
    '/webhooks/orders-paid',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      try {
        const result = await handleWebhook(db, {
          rawBody,
          headers: req.headers,
          secret: config().webhookSecret,
          topic: 'orders/paid',
        });
        res.json(serialiseResult(result));
      } catch (err) {
        if (err instanceof WebhookRejected) {
          // 401 for a bad or absent signature, 400 for a body we cannot parse.
          res.status(err.status).json({ error: err.reason });
          return;
        }
        if (err instanceof IdempotencyInFlightError) {
          // The first delivery is still working. Tell the sender to redeliver rather than
          // running a second issuance beside it.
          res.status(409).json({ error: 'issuance already in flight', orderId: err.key });
          return;
        }
        res.status(500).json({ error: 'issuance failed' });
      }
    },
  );

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

  /**
   * Whole-ledger export for reconciliation: every row, including the pending and failed
   * ones, in append order. `since` is an ISO timestamp for incremental pulls.
   * ndjson because the consumer is usually a pipe, not a browser.
   */
  app.get('/export', (req: Request, res: Response) => {
    const limit = intParam(req.query['limit'], 1000, 10_000);
    const since = typeof req.query['since'] === 'string' ? req.query['since'] : null;
    const entries = listEntries(db, limit, since);

    if (req.query['format'] === 'ndjson') {
      res.type('application/x-ndjson');
      res.send(entries.map((e) => JSON.stringify(serialiseEntry(e))).join('\n'));
      return;
    }
    res.json({ count: entries.length, since, entries: entries.map(serialiseEntry) });
  });

  return app;
}
