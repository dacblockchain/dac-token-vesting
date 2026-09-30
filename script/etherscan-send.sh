#!/usr/bin/env bash
# Sends a transaction using only the Etherscan API v2 (no JSON-RPC provider):
# nonce and gas price are read from Etherscan, the tx is signed locally with
# `cast mktx` and broadcast via eth_sendRawTransaction, then the receipt is polled.
# Useful when public RPCs are blocked or rate-limited.
#
# Usage: CHAIN_ID=11155111 ./script/etherscan-send.sh <to> <sig> [args...]
#        CHAIN_ID=11155111 ./script/etherscan-send.sh --create <bytecode> [<constructor sig> args...]
# Needs PRIVATE_KEY and ETHERSCAN_API_KEY in the environment. Optional GAS_LIMIT (default 300000).
set -euo pipefail

: "${PRIVATE_KEY:?}" "${ETHERSCAN_API_KEY:?}" "${CHAIN_ID:?}"
API="https://api.etherscan.io/v2/api?chainid=$CHAIN_ID&apikey=$ETHERSCAN_API_KEY"
if [ "$1" = "--create" ]; then target=(--create "$2"); shift 2; else target=("$1"); shift; fi

result() { python3 -c 'import sys,json; j=json.load(sys.stdin); r=j.get("result"); e=j.get("error"); print(r if r is not None else "", end=""); sys.exit(1 if e else 0)'; }

from=$(cast wallet address "$PRIVATE_KEY")
nonce=$(cast to-dec "$(curl -s "$API&module=proxy&action=eth_getTransactionCount&address=$from&tag=pending" | result)")
gas_price=$(( $(cast to-dec "$(curl -s "$API&module=proxy&action=eth_gasPrice" | result)") * 12 / 10 ))

# Flags first: with --create, cast treats everything after the bytecode as constructor args.
raw=$(cast mktx --private-key "$PRIVATE_KEY" --chain "$CHAIN_ID" --nonce "$nonce" \
  --gas-limit "${GAS_LIMIT:-300000}" --gas-price "$gas_price" --legacy "${target[@]}" "$@")
hash=$(curl -s -X POST --data "module=proxy&action=eth_sendRawTransaction&hex=$raw" "$API" | result) \
  || { echo "broadcast failed: $hash" >&2; exit 1; }

for _ in $(seq 1 60); do
  sleep 3
  receipt=$(curl -s "$API&module=proxy&action=eth_getTransactionReceipt&txhash=$hash" \
    | python3 -c '
import sys, json
r = json.load(sys.stdin).get("result")
if isinstance(r, dict):
    print(r["status"], r.get("contractAddress") or "")' 2>/dev/null || true)
  if [ -n "$receipt" ]; then
    read -r status created <<<"$receipt"
    echo "$hash $status${created:+ $created}"; [ "$status" = "0x1" ]; exit
  fi
done
echo "$hash TIMEOUT"; exit 1
