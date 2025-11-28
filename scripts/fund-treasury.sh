#!/usr/bin/env bash
# repo: scripts/fund-treasury.sh
# Testnet only. Prints how to top the treasury up with Base Sepolia ETH (gas) and testnet
# USDC (rewards). It does not move funds and it does not touch a key: funding is a manual
# step on purpose, so nothing automated can ever spend from the treasury.

set -euo pipefail

BASE_SEPOLIA=84532
BASE_MAINNET=8453
CHAIN_ID="${CHAIN_ID:-$BASE_SEPOLIA}"

if [[ "$CHAIN_ID" == "$BASE_MAINNET" ]]; then
  echo "refusing to run: CHAIN_ID=$CHAIN_ID is Base mainnet." >&2
  echo "There is no faucet for mainnet. Fund the treasury deliberately, from a" >&2
  echo "custody process, not from a shell script in a demo repo." >&2
  exit 1
fi

if [[ "$CHAIN_ID" != "$BASE_SEPOLIA" ]]; then
  echo "refusing to run: CHAIN_ID=$CHAIN_ID is not Base Sepolia ($BASE_SEPOLIA)." >&2
  exit 1
fi

ADDR="${TREASURY_ADDRESS:-}"

cat <<'EOF'
Base Sepolia treasury funding
=============================

The treasury needs two things:

  1. Sepolia ETH on Base, for gas.
  2. Testnet USDC, for the rewards themselves.

Faucets (open in a browser, paste the treasury address):

  ETH   Coinbase Developer Platform faucet -> Base Sepolia
        https://portal.cdp.coinbase.com/products/faucet
  ETH   Alchemy / QuickNode Base Sepolia faucets also work.
  USDC  Circle testnet faucet -> select Base Sepolia
        https://faucet.circle.com

Both are rate limited. A pilot-sized demo needs very little of either.

EOF

if [[ -n "$ADDR" ]]; then
  echo "Treasury address (from TREASURY_ADDRESS): $ADDR"
else
  echo "Set TREASURY_ADDRESS to have this script echo the address to paste."
  echo "Derive it from the key reference in your signer/KMS; this script never reads a key."
fi

cat <<'EOF'

Check the balance once the faucet has paid out:

  cast balance  "$TREASURY_ADDRESS" --rpc-url "${BASE_RPC_URL:-https://sepolia.base.org}"
  cast call     "$USDC_ADDRESS" "balanceOf(address)(uint256)" "$TREASURY_ADDRESS" \
                --rpc-url "${BASE_RPC_URL:-https://sepolia.base.org}"

USDC is 6 decimals, so the second command prints base units: 1000000 = 1.00 USDC.
EOF
