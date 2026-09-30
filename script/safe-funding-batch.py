#!/usr/bin/env python3
"""Independently verify a deployed (unfunded) VestingFactory and write a Safe
Transaction Builder batch that funds every vesting wallet with their exact allocations.

Every check reads the chain directly and never trusts the deployer's logs:
  - the factory holds exactly one schedule per bucket (no decoys);
  - each wallet address equals factory.computeAddress(...), i.e. it is the
    factory's CREATE2 deployment of the unmodified TokenVesting code with these
    exact parameters;
  - beneficiary == the configured Safe, start == TGE + cliff, duration == vesting;
  - the wallet's owner()/start()/duration() agree, and it holds no DACT yet.

The script stops at the first failed check, before writing any batch.

Usage:
  set -a; source .env; set +a
  FACTORY=0x... ./script/safe-funding-batch.py [out.json]
Env: FACTORY, DACT_TOKEN, TGE_TIMESTAMP, BENEFICIARY_<BUCKET>, CHAIN_ID (default 1),
     MONTH_SECONDS (default 30 days), and RPC_URL or ETHERSCAN_API_KEY for chain access.
"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request

# Must match script/Deploy.s.sol: (bucket, cliff months, vesting months, DACT)
GRANTS = [
    ("TEAM", 12, 36, 150_000_000),
    ("MARKETING", 2, 36, 85_000_000),
    ("ENTERPRISE", 12, 48, 140_000_000),
    ("INSTITUTIONAL", 3, 36, 150_000_000),
    ("INSTITUTIONAL_UNICORN", 12, 24, 50_000_000),
    ("GRANT_AIRDROP", 0, 24, 75_000_000),
    ("RESERVE", 12, 48, 205_000_000),
]

env = os.environ
CHAIN_ID = int(env.get("CHAIN_ID", "1"))
FACTORY = env["FACTORY"]
TOKEN = env["DACT_TOKEN"]
TGE = int(env["TGE_TIMESTAMP"])
MONTH = int(env.get("MONTH_SECONDS", 30 * 86400))
if CHAIN_ID == 1 and MONTH != 30 * 86400:
    sys.exit("MONTH_SECONDS must be 30 days on mainnet")


def rpc(method, params):
    if env.get("RPC_URL"):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        req = urllib.request.Request(env["RPC_URL"], body, {"content-type": "application/json"})
        res = json.load(urllib.request.urlopen(req))
        if "error" in res:
            raise RuntimeError(res["error"])
        return res["result"]
    time.sleep(0.25)  # Etherscan free-tier rate limit
    q = {"chainid": CHAIN_ID, "module": "proxy", "action": method, "tag": "latest", "apikey": env["ETHERSCAN_API_KEY"]}
    if method == "eth_call":
        q.update(to=params[0]["to"], data=params[0]["data"])
    else:  # eth_getCode
        q.update(address=params[0])
    res = json.load(urllib.request.urlopen("https://api.etherscan.io/v2/api?" + urllib.parse.urlencode(q)))
    if "error" in res:
        raise RuntimeError(res["error"])
    return res["result"]


def cast(*args):
    return subprocess.check_output(["cast", *args], text=True).strip()


def call(to, sig, *args):
    """sig like 'owner()(address)'; returns decoded outputs as a list of strings."""
    inputs, outputs = sig.split(")(", 1)
    data = cast("calldata", inputs + ")", *args)
    out = rpc("eth_call", [{"to": to, "data": data}, "latest"])
    return [line.split(" ")[0] for line in cast("abi-decode", "f()(" + outputs, out).splitlines()]


def check(cond, msg):
    if not cond:
        sys.exit(f"FAIL: {msg}")


check(len(rpc("eth_getCode", [FACTORY, "latest"])) > 2, f"no contract at FACTORY {FACTORY}")
count = int(call(FACTORY, "schedulesCount()(uint256)")[0])
check(count == len(GRANTS), f"factory has {count} schedules, expected {len(GRANTS)} (decoys or incomplete deploy?)")

by_hash = {cast("keccak", name).lower(): g for g in GRANTS for name in [g[0]]}
seen, rows = set(), []
for i in range(count):
    wallet, beneficiary, start, duration, cliff, funded, bucket = call(
        FACTORY, "schedules(uint256)(address,address,uint64,uint64,uint64,uint256,bytes32)", str(i)
    )
    g = by_hash.get(bucket.lower())
    check(g is not None, f"schedule {i}: unknown bucket {bucket}")
    name, cliff_m, vest_m, amount = g
    check(name not in seen, f"duplicate bucket {name}")
    seen.add(name)

    exp_benef = env[f"BENEFICIARY_{name}"]
    exp_start, exp_dur = TGE + cliff_m * MONTH, vest_m * MONTH
    check(beneficiary.lower() == exp_benef.lower(), f"{name}: beneficiary {beneficiary} != {exp_benef}")
    check((int(start), int(duration), int(cliff)) == (exp_start, exp_dur, 0),
          f"{name}: schedule {start}/{duration}/{cliff} != {exp_start}/{exp_dur}/0")

    predicted = call(FACTORY, "computeAddress(address,bytes32,uint64,uint64,uint64)(address)",
                     beneficiary, bucket, start, duration, cliff)[0]
    check(predicted.lower() == wallet.lower(), f"{name}: wallet {wallet} is not the factory's CREATE2 deployment")
    check(call(wallet, "owner()(address)")[0].lower() == exp_benef.lower(), f"{name}: wallet owner mismatch")
    check(int(call(wallet, "start()(uint256)")[0]) == exp_start, f"{name}: wallet start mismatch")
    check(int(call(wallet, "duration()(uint256)")[0]) == exp_dur, f"{name}: wallet duration mismatch")
    bal = int(call(TOKEN, "balanceOf(address)(uint256)", wallet)[0])
    check(bal == 0 and int(funded) == 0, f"{name}: wallet already holds {bal} DACT")
    rows.append((name, wallet, beneficiary, amount))

total = sum(r[3] for r in rows)
check(total == 855_000_000, f"total {total} != 855,000,000")

batch = {
    "version": "1.0",
    "chainId": str(CHAIN_ID),
    "createdAt": int(time.time() * 1000),
    "meta": {
        "name": "DACT vesting funding",
        "description": f"Fund {len(rows)} DACT vesting wallets from factory {FACTORY}, total {total:,} DACT",
    },
    "transactions": [
        {
            "to": TOKEN,
            "value": "0",
            "data": None,
            "contractMethod": {
                "inputs": [{"name": "to", "type": "address"}, {"name": "value", "type": "uint256"}],
                "name": "transfer",
                "payable": False,
            },
            "contractInputsValues": {"to": wallet, "value": str(amount * 10**18)},
        }
        for _, wallet, _, amount in rows
    ],
}
out = sys.argv[1] if len(sys.argv) > 1 else f"funding-batch-{CHAIN_ID}.json"
with open(out, "w") as f:
    json.dump(batch, f, indent=2)

print(f"All checks passed for factory {FACTORY} on chain {CHAIN_ID}\n")
print(f"{'Bucket':22} {'Wallet':42}  {'DACT':>13}  Beneficiary")
for name, wallet, beneficiary, amount in rows:
    print(f"{name:22} {wallet}  {amount:>13,}  {beneficiary}")
print(f"{'TOTAL':22} {'':42}  {total:>13,}")
print(f"\nSafe Transaction Builder batch written to {out}")
