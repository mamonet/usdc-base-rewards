# usdc-base-rewards

A small, self-contained demo of the stack a stablecoin loyalty pilot runs on. Early scaffold.

A purchase event comes in over a webhook, the buyer's embedded wallet is created on first reward,
USDC is sent to it on Base from a treasury wallet, and every step is written to an append-only ledger
where the balance is derived, never stored.

Deliberately generic: a mock merchant, testnet USDC, synthetic customers. It demonstrates the
mechanics without touching any client's code or data.

```bash
cp deploy/.env.example .env
docker compose up
./scripts/mock-order.sh --email demo@example.com --subtotal 40.00
```

TypeScript, viem, Base testnet. The treasury key is never committed.
