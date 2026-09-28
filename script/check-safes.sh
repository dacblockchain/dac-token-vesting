#!/usr/bin/env bash
# Checks every BENEFICIARY_* multisig on Ethereum mainnet through the Etherscan API:
# contract code, Safe version, threshold, owners, enabled modules and guard.
# Usage: set -a; source .env; set +a; ./script/check-safes.sh
set -euo pipefail

: "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY not set}"
API="https://api.etherscan.io/v2/api?chainid=1&apikey=$ETHERSCAN_API_KEY"
GUARD_SLOT=0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8
MODULES_CALL=$(cast calldata 'getModulesPaginated(address,uint256)' 0x0000000000000000000000000000000000000001 20)

q() {
  sleep 0.3 # free-tier rate limit
  curl -s "$API&module=proxy&$1&tag=latest" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("result") or "0x")'
}

for bucket in TEAM MARKETING ENTERPRISE INSTITUTIONAL GRANT_AIRDROP RESERVE; do
  var="BENEFICIARY_$bucket"
  safe="${!var:?$var not set}"
  code=$(q "action=eth_getCode&address=$safe")
  echo "== $bucket $safe"
  if [ "$code" = "0x" ]; then
    echo "   NO CONTRACT CODE ON MAINNET"
    continue
  fi
  echo "   version:   $(cast abi-decode 'f()(string)' "$(q "action=eth_call&to=$safe&data=0xffa1ad74")")"
  echo "   threshold: $(cast to-dec "$(q "action=eth_call&to=$safe&data=0xe75235b8")")"
  echo "   owners:    $(cast abi-decode 'f()(address[])' "$(q "action=eth_call&to=$safe&data=0xa0e67e2b")")"
  echo "   modules:   $(cast abi-decode 'f()(address[],address)' "$(q "action=eth_call&to=$safe&data=$MODULES_CALL")" | head -1)"
  echo "   guard:     $(cast parse-bytes32-address "$(q "action=eth_getStorageAt&address=$safe&position=$GUARD_SLOT")")"
done
