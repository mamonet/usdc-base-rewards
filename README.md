# usdc-base-rewards

A small, self-contained demo of the exact stack a stablecoin loyalty pilot runs on: a purchase event
comes in over a webhook, the buyer's embedded wallet is created on first reward, USDC is sent to it on
Base from a treasury wallet, and every step is written to an append-only ledger where the balance is
derived, never stored.

It is deliberately generic (a mock merchant, testnet USDC, synthetic customers), so it demonstrates
the mechanics without touching any client's code or data. The point is to show the plumbing working
end to end: webhook to gate to on-chain transfer to ledger, with the safety properties that matter for
money.

## What it shows

- **Server-side USDC on Base.** An ERC-20 transfer of native USDC on Base (testnet), signed
  server-side from a treasury wallet, with gas estimation, confirmation polling, and a retry path for
  a stuck or failed transaction. The consumer never sees a key or a seed phrase.
- **Embedded wallet on first reward.** On a customer's first qualifying event, an embedded wallet is
  created programmatically through the provider (Privy or Coinbase Embedded Wallets, behind one
  interface), keyed to their email; subsequent rewards go to the same wallet.
- **Webhook ingestion, done safely.** A Shopify-style `orders/paid` webhook with HMAC verification and
  idempotency on the order ID, so a redelivered webhook never issues twice.
- **Cohort gate.** A treatment-group list decides whether an event earns; every gating decision is
  logged; the module is isolated so it can be removed later.
- **Rule-driven issuance.** Reward is a stored rule (rate x subtotal), configurable, not a constant.
- **Append-only ledger.** Every earn (and, in the demo, spend/withdraw) is an immutable double-entry
  record; balance is computed from the log. Idempotency key per order ties the ledger entry, the
  on-chain tx, and the webhook together.

## Architecture

```
 Shopify-style webhook (HMAC)                treasury wallet (server-signed)
        |                                              |
        v                                              v
  ingest (idempotent on order id) --> cohort gate --> issuance engine --> USDC transfer on Base
        |                                                     |                    |
        +--> raw event store                                  +--> embedded wallet create (first earn)
                                                              |
                                                              v
                                       append-only ledger (double-entry, balance derived)
                                                              |
                                                              v
                                                    FastAPI/Express read API + event export
```

Provider and chain access sit behind small interfaces (`WalletProvider`, `Chain`), so Privy vs
Coinbase, or Base testnet vs mainnet, is a config choice, not a rewrite.

## Stack

TypeScript / Node.js, `viem` (or `ethers`) for Base and the USDC ERC-20 contract, a wallet-provider SDK
(Privy or Coinbase Embedded Wallets), PostgreSQL or SQLite for the ledger and raw events, Docker.
Treasury key is read from a KMS/HSM reference or env in the demo (never committed).

## Run

```bash
cp .env.example .env      # set BASE_RPC_URL, USDC_ADDRESS (Base testnet), treasury key ref, provider keys
docker compose up
# simulate a purchase webhook for a treatment-group customer
./scripts/mock-order.sh --email demo@example.com --subtotal 40.00
# -> gate passes -> wallet created -> USDC sent on Base testnet -> ledger entry written
```

The service refuses to start against mainnet unless an explicit opt-in flag is set. The default chain
is Base Sepolia, which keeps a demo free to run and safe to share.

## Safety properties (the reason this exists)

- **Idempotent:** the same order id, delivered twice, issues once. Proven by a test that fires a
  duplicate webhook and asserts one on-chain transfer and one ledger entry.
- **Derived balance:** balance is a fold over ledger entries; there is no mutable balance column to
  drift.
- **Fail-closed on chain errors:** a failed/stuck transfer is retried with backoff and never marked
  issued until confirmed; a permanent failure is recorded, not silently dropped.
- **No key exposure:** the treasury key never reaches source, config, or the client; the consumer key
  is held by the provider and never surfaced.

## Money is integers

USDC has six decimals and every amount in this codebase is a `bigint` in base units. There is no
floating-point arithmetic anywhere on the money path, because a rounding error here is a rounding
error in someone's balance.

## Tests

Duplicate-webhook idempotency (one transfer, one entry); rule computation; wallet auto-create only on
first earn; confirmation + retry on a simulated stuck tx; ledger balance equals the fold of entries;
HMAC rejection of an unsigned webhook.

## Evidence (to be filled with real captured output)

> Filled by running against Base testnet. Real tx hashes and output, not edited.
> Nothing in this table is filled in yet.

| Item | Result |
|------|--------|
| USDC transfer on Base testnet | _(fill: tx hash + BaseScan link)_ |
| Embedded wallet created on first earn | _(fill: provider wallet id / address)_ |
| Duplicate webhook -> single issue | _(fill: log showing one transfer)_ |
| Ledger balance = fold of entries | _(fill: export snippet)_ |
| Stuck-tx retry then confirm | _(fill: retry log + final hash)_ |

## Repository layout

```
usdc-base-rewards/
  src/
    ingest.ts         webhook verify + idempotency + raw store
    cohort.ts         treatment-group gate (isolated)
    issuance.ts       rule -> USDC transfer -> ledger entry
    chain.ts          Base + USDC ERC-20 (viem), gas/confirm/retry
    wallet/           WalletProvider interface + privy/ + coinbase/ adapters
    ledger.ts         append-only double-entry, derived balance
    api.ts            read API + event export
  scripts/            mock-order, fund-treasury (testnet)
  deploy/             Dockerfile, compose, env example
  tests/
```

## Notes

- Generic and synthetic only: mock merchant, testnet USDC, made-up customers. No client code or data.
- Not a full product: no consumer UI, no off-ramp, no admin dashboard. It exists to prove the
  issuance path and its safety properties, which is the risky, must-be-right part of a pilot like this.
- Base testnet keeps it free to run and safe to share; the same code points at mainnet by config.

MIT licensed.
