#!/usr/bin/env bash
# repo: scripts/mock-order.sh
# Build a Shopify-style orders/paid payload, sign it the way Shopify would, and POST it.
#
# The signature is HMAC-SHA256 over the exact request body, base64, in
# X-Shopify-Hmac-Sha256. The body is written once and both signed and sent verbatim: if
# this script rebuilt the JSON between signing and sending, the bytes would differ and the
# server would reject it. That is the same reason api.ts uses a raw body parser.
#
#   ./scripts/mock-order.sh --email demo@example.com --subtotal 40.00
#   ./scripts/mock-order.sh --order-id 1001 --subtotal 12.50   # resend to test idempotency

set -euo pipefail

EMAIL="demo@example.com"
SUBTOTAL="40.00"
ORDER_ID=""
CURRENCY="${CURRENCY:-USD}"
API_URL="${API_URL:-http://localhost:3000}"

usage() {
  cat <<'USAGE'
usage: mock-order.sh [--email ADDR] [--subtotal AMOUNT] [--order-id ID]

  --email     buyer email, keys the embedded wallet   (default demo@example.com)
  --subtotal  decimal amount, max 6dp                 (default 40.00)
  --order-id  merchant order id, the idempotency key  (default: generated)

env: WEBHOOK_SECRET (required), API_URL, CURRENCY
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)    EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --subtotal) SUBTOTAL="${2:?--subtotal needs a value}"; shift 2 ;;
    --order-id) ORDER_ID="${2:?--order-id needs a value}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *)          echo "unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -z "${WEBHOOK_SECRET:-}" ]]; then
  echo "WEBHOOK_SECRET is not set. Use the same dev secret the server is running with:" >&2
  echo "  export WEBHOOK_SECRET=\"\$(grep '^WEBHOOK_SECRET=' deploy/.env | cut -d= -f2-)\"" >&2
  exit 1
fi

# The server rejects more than 6 decimal places rather than truncating, so catch it here.
if ! [[ "$SUBTOTAL" =~ ^[0-9]+(\.[0-9]{1,6})?$ ]]; then
  echo "--subtotal must be a positive decimal with at most 6 places: got '$SUBTOTAL'" >&2
  exit 2
fi

if [[ -z "$ORDER_ID" ]]; then
  ORDER_ID="mock-$(date +%s)-$RANDOM"
fi

CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Written once. Signed and sent as-is, byte for byte.
BODY=$(cat <<EOF
{"id":"${ORDER_ID}","email":"${EMAIL}","customer":{"email":"${EMAIL}"},"subtotal_price":"${SUBTOTAL}","currency":"${CURRENCY}","created_at":"${CREATED_AT}","financial_status":"paid","test":true}
EOF
)

SIGNATURE=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -binary | openssl base64 -A)

echo "POST ${API_URL}/webhooks/orders-paid  order=${ORDER_ID} subtotal=${SUBTOTAL} ${CURRENCY}"

curl -sS -X POST "${API_URL}/webhooks/orders-paid" \
  -H 'Content-Type: application/json' \
  -H "X-Shopify-Topic: orders/paid" \
  -H "X-Shopify-Hmac-Sha256: ${SIGNATURE}" \
  --data-binary "$BODY" \
  -w '\nHTTP %{http_code}\n'

echo
echo "balance:  curl -s ${API_URL}/balance/${EMAIL}"
echo "entries:  curl -s ${API_URL}/entries/${EMAIL}"
echo "resend the same --order-id to check idempotency: it must not issue twice."
