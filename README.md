# DAC Token Vesting

ERC-20 vesting for DACt built on **audited OpenZeppelin v5 contracts** (`VestingWallet` / `VestingWalletCliff`). Each beneficiary gets their own vesting wallet with a custom schedule — start, total duration, and cliff are all per-deployment parameters.

## Architecture

| Contract | Purpose |
| --- | --- |
| [`src/TokenVesting.sol`](src/TokenVesting.sol) | Thin wrapper over OZ `VestingWalletCliff`. Zero vested before `start + cliff`, then linear from `start` to `start + duration` over the wallet's token balance. |
| [`src/VestingFactory.sol`](src/VestingFactory.sol) | `onlyOwner` factory. Deploys wallets via `CREATE2` (deterministic addresses, predictable with `computeAddress`), keeps an on-chain registry (`schedules`, `schedulesOf`), rejects duplicate schedules, and offers `createAndFund` for atomic deploy + funding. |

Example — a partner grant of 250k DACt with a 12-month cliff + 24-month linear vesting:

```
createAndFund(partner, keccak256("PARTNERS"), TGE, 36 * 30 days, 12 * 30 days, DACt, 250_000e18)
```

At month 12, 1/3 of the allocation (≈83,333 DACt) unlocks at once; the rest vests linearly until month 36.

## Repository layout

```
src/            Contracts (TokenVesting, VestingFactory)
test/           Foundry tests (cliff/linear schedule, multi-entity, access control)
script/         Deploy.s.sol — per-entity grant configuration + deployment; check-safes.sh — mainnet multisig check; etherscan-send.sh — send a tx via the Etherscan API only
lib/            Vendored dependencies (OpenZeppelin v5.6.1, forge-std v1.14.0)
foundry.toml    solc 0.8.24, optimizer 200 runs
```

## Getting started

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation):

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Build and test:

```bash
forge build
forge test -vv
```

The test suite (9 tests) covers: nothing releasable before the cliff, exactly 1/3 unlocking at month 12, linearity between cliff and end, full release to the beneficiary at month 36, per-entity schedule independence, `computeAddress` matching the actual deployment, duplicate-schedule and invalid-parameter reverts, and factory access control.

## Deployment

1. The `Grant[]` array in [`script/Deploy.s.sol`](script/Deploy.s.sol) holds the allocations from `DACT_Allocation_Cliff_Vesting.xlsx` (Team, Marketing, Enterprise, Institutional, Grant/Airdrop, Reserve — 855M DACT). Schedules are **cliff, then vesting**: nothing unlocks during the cliff, then linear over the vesting period (Team: 12m cliff + 36m linear = 48m total).
2. Copy `.env.example` to `.env` and set `PRIVATE_KEY`, `DACT_TOKEN`, `TGE_TIMESTAMP`, `RPC_URL`. Set `BENEFICIARY_<BUCKET>` (e.g. `BENEFICIARY_TEAM`) for each bucket — **unset beneficiaries default to the deployer** (testnets only — on mainnet every one is required, see below). Optionally set `MONTH_SECONDS` to compress months on testnet (default 30 days).
3. Dry-run first, then broadcast:

```bash
source .env
forge script script/Deploy.s.sol --rpc-url $RPC_URL              # simulation
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
```

Before mainnet, run the full schedule on the testnet (`exptest.dachain.tech`) with compressed durations (e.g. minutes instead of months) and verify the sources on the explorer.

### Sepolia rehearsal

Both runs use `MONTH_SECONDS=60` (1 month = 1 minute) and are verified on Etherscan.

| Run | Beneficiaries | Factory |
| --- | --- | --- |
| 1 (2026-09-24) | deployer, all buckets. Fully released back to the deployer. | [`0xA42953CDea096e7b916d688cC2912a5d3b4E9130`](https://sepolia.etherscan.io/address/0xa42953cdea096e7b916d688cc2912a5d3b4e9130#code) |
| 2 (2026-09-28) | the mainnet multisig addresses | [`0x2e89F582789bc3347fAa844b1B2d3B5b63f1e582`](https://sepolia.etherscan.io/address/0x2e89f582789bc3347faa844b1b2d3b5b63f1e582#code) |

The multisigs are not deployed on Sepolia, so DACT released in run 2 sits at those addresses there.

The exact mainnet configuration (real months, TGE `1790899200`, the real Safes) can also be rehearsed on a local mainnet fork with a mock token:

```bash
anvil --fork-url <MAINNET_RPC> --compute-units-per-second 20 --retries 20   # port 8545
forge create test/VestingFactory.t.sol:MockDACt --broadcast --rpc-url http://127.0.0.1:8545 --private-key <ANVIL_KEY>
DACT_TOKEN=<mock> PRIVATE_KEY=<ANVIL_KEY> forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

## Ethereum mainnet deployment

### Beneficiary multisigs

Each bucket's vesting wallet releases to the multisig responsible for it. The multisig is the wallet's `release` recipient and `Ownable` owner.

| Bucket | Env var | Multisig | DACT | Cliff | Vesting | Vesting starts | Fully vested |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| Team | `BENEFICIARY_TEAM` | DAC team `0x11e422578aD6517CEe36e0eda36089Ce9022761f` | 150,000,000 | 12m | 36m | 2027-09-27 | 2030-09-11 |
| Marketing | `BENEFICIARY_MARKETING` | DAC Marketing `0x54B221aEA99e79904a57E183Fe502dbCc428f7d8` | 85,000,000 | 2m | 36m | 2026-12-01 | 2029-11-15 |
| Enterprise | `BENEFICIARY_ENTERPRISE` | DAC Enterprise `0xa798eDf8165acf633a05741B20Be67a664367aC6` | 140,000,000 | 12m | 48m | 2027-09-27 | 2031-09-06 |
| Institutional | `BENEFICIARY_INSTITUTIONAL` | DAC Institutional `0x1BE7EcC13FeB29A8a2F15C266EA20c92Fe937F8F` | 200,000,000 | 3m | 36m | 2026-12-31 | 2029-12-15 |
| Grant / Airdrop | `BENEFICIARY_GRANT_AIRDROP` | DAC Grants `0x656796B89d2a7C0Ec11BCF53F686a8DDD05fa5fb` | 75,000,000 | 0 | 24m | 2026-10-02 | 2028-09-21 |
| Reserve | `BENEFICIARY_RESERVE` | DAC Reserve `0xC8a553dfC0387Dc1d83F2Ca3B2E1bf27DC7EF720` | 205,000,000 | 12m | 48m | 2027-09-27 | 2031-09-06 |

**Multisig check (Etherscan API, 2026-09-28):** all six are Safes deployed on Ethereum mainnet. Every one has threshold **3-of-5**, no modules and no guard, and they share the same five owners:

```
0xdAcD631f9CE026a146EbEE4256927BfDF084062b
0x69748822EeCb2FC2e3FFe9cdE897BA6c7e0a8E1C
0xf93bDb580A63E0a0dF6c44fA14CfdB0C85767762
0xb1eaaB1590598F036a6f0331792C6eA8FE9CB49f
0xCc481eDC312fea3845029b1C1502196646d02467
```

The Team Safe runs v1.4.1 and the others run v1.5.0. Safe owners can change at any time, so re-run the check right before deploying (checklist step 1).

**TGE: 2 October 2026, 00:00 UTC** → `TGE_TIMESTAMP=1790899200`. Dates above use the contract's 30-day months: a 12-month cliff is 360 days, so it ends 2027-09-27 rather than 2027-10-02.

### Safety guards (chain id 1)

On mainnet, `Deploy.s.sol` refuses to run unless:

- `MONTH_SECONDS` is unset or exactly 30 days (no compressed schedules);
- every `BENEFICIARY_<BUCKET>` is set explicitly (no silent fallback to the deployer);
- every beneficiary is a deployed Safe with threshold ≥ 2 (`getThreshold()`). Plain EOAs, undeployed Safes, EIP-7702 delegated EOAs and other contracts are all rejected.

### Checklist

1. **Re-check the multisigs** with the values from step 3 loaded. The script prints each Safe's version, threshold, owners, modules and guard via the Etherscan API. Compare the output with the multisig check above:
   ```bash
   set -a; source .env; set +a
   ./script/check-safes.sh
   ```
2. **Deployer key.** Use a fresh key on a hardware wallet. Never reuse a testnet key or anything that has been in `.env.example`. The deployer must hold:
   - **855,000,000 DACT** on mainnet (the tokens are pulled from it by `createAndFund`);
   - enough ETH for about 8.8M gas: factory plus 6 wallets plus approvals. At 2 gwei that's about 0.02 ETH, so budget extra for gas spikes.
3. **`.env`:**
   ```bash
   PRIVATE_KEY=<mainnet deployer key>
   DACT_TOKEN=<mainnet DACT address>
   TGE_TIMESTAMP=1790899200
   RPC_URL=https://mainnet.infura.io/v3/<INFURA_PROJECT_ID>   # keyed provider, not a public RPC
   ETHERSCAN_API_KEY=<key>
   BENEFICIARY_TEAM=0x11e422578aD6517CEe36e0eda36089Ce9022761f
   BENEFICIARY_MARKETING=0x54B221aEA99e79904a57E183Fe502dbCc428f7d8
   BENEFICIARY_ENTERPRISE=0xa798eDf8165acf633a05741B20Be67a664367aC6
   BENEFICIARY_INSTITUTIONAL=0x1BE7EcC13FeB29A8a2F15C266EA20c92Fe937F8F
   BENEFICIARY_GRANT_AIRDROP=0x656796B89d2a7C0Ec11BCF53F686a8DDD05fa5fb
   BENEFICIARY_RESERVE=0xC8a553dfC0387Dc1d83F2Ca3B2E1bf27DC7EF720
   # MONTH_SECONDS must NOT be set
   ```
4. **Simulate** and read the logged addresses, beneficiaries, months and amounts line by line against the table above:
   ```bash
   set -a; source .env; set +a
   forge script script/Deploy.s.sol --rpc-url $RPC_URL
   ```
5. **Broadcast and verify.** Use a keyed provider (Infura) for `RPC_URL`: public RPCs rate-limit `forge script` and can drop transactions partway through.
   ```bash
   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify --slow
   ```
   If a transaction fails partway, **don't re-run the script blindly**: it would deploy a second factory. Check `broadcast/Deploy.s.sol/1/run-latest.json`, then fund any remaining schedules by hand (see [Interacting with the contracts](#interacting-with-the-contracts)).
6. **Post-deploy checks:** for each wallet, confirm that `DACT.balanceOf(wallet)` equals the allocation, `owner()` is the bucket's multisig, `start()` and `duration()` match the table, and `DACT.allowance(deployer, factory)` is 0.
7. **Factory ownership (optional):** the factory only controls creation of *new* wallets, never funded tokens. After deployment you can move it to a multisig with `transferOwnership`, or to `address(0)` via `renounceOwnership` to freeze it.

Funding is **irreversible**. There's no clawback, and 855M of the 1B supply is locked once the script runs.

## Interacting with the contracts

There are three roles. The **deployer** owns the factory, a **beneficiary multisig** owns each vesting wallet, and **anyone** can read state or trigger releases.

| Action | Deployer | Beneficiary Safe | Anyone |
| --- | :---: | :---: | :---: |
| Read schedules, balances, vested and releasable amounts | ✅ | ✅ | ✅ |
| `release(token)`: pay vested DACT out to the beneficiary | ✅ | ✅ | ✅ |
| Create or fund new vesting wallets via the factory | ✅ | — | — |
| Change a beneficiary (`transferOwnership` on the wallet) | — | ✅ | — |
| Change, pause, revoke or withdraw a funded schedule | — | — | — |

The deployer can **never** move tokens out of a vesting wallet or change a schedule. `release` only ever pays the wallet's owner.

### Reading state

All reads are free. In the commands below, `$FACTORY` is the factory address and `$WALLET` is one vesting wallet, both logged by the deploy script. `$DACT_TOKEN` and `$RPC_URL` come from `.env`.

```bash
# Factory registry
cast call $FACTORY "schedulesCount()(uint256)" --rpc-url $RPC_URL
cast call $FACTORY "schedules(uint256)(address,address,uint64,uint64,uint64,uint256,bytes32)" 0 --rpc-url $RPC_URL
#   -> wallet, beneficiary, start, duration, cliff, funded, keccak256(bucket name)
cast call $FACTORY "schedulesOfBeneficiary(address)(uint256[])" <SAFE> --rpc-url $RPC_URL

# One vesting wallet
cast call $WALLET "owner()(address)" --rpc-url $RPC_URL                             # beneficiary
cast call $WALLET "start()(uint256)" --rpc-url $RPC_URL                             # = TGE + cliff
cast call $WALLET "end()(uint256)" --rpc-url $RPC_URL
cast call $WALLET "releasable(address)(uint256)" $DACT_TOKEN --rpc-url $RPC_URL      # claimable now
cast call $WALLET "released(address)(uint256)" $DACT_TOKEN --rpc-url $RPC_URL        # already paid out
cast call $WALLET "vestedAmount(address,uint64)(uint256)" $DACT_TOKEN <UNIX_TS> --rpc-url $RPC_URL
```

The same functions are on each contract's Etherscan page under **Read Contract**.

### Releasing vested tokens

`release` is permissionless. The deployer, a bot or anyone else can call it, and the tokens always go to the beneficiary Safe:

```bash
cast send $WALLET "release(address)" $DACT_TOKEN --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

If no RPC is available (blocked or rate-limited), [`script/etherscan-send.sh`](script/etherscan-send.sh) sends the same transaction using only the Etherscan API. It reads the nonce and gas price from Etherscan, signs locally with `cast mktx`, then broadcasts through `eth_sendRawTransaction` and waits for the receipt:

```bash
CHAIN_ID=1 ./script/etherscan-send.sh $WALLET "release(address)" $DACT_TOKEN
```

Use the `release(address token)` overload. The zero-argument `release()` releases ETH, not DACT. The Safe signers can instead call it from the Safe app, either with the Transaction Builder or through the wallet's Etherscan **Write Contract** tab. Before the cliff ends, `releasable` is 0 and `release` succeeds but transfers nothing.

### Creating additional grants (deployer / factory owner)

The factory owner can add new schedules at any time, for example a new partner. The tokens come from the owner's own balance and need an approval first:

```bash
cast send $DACT_TOKEN "approve(address,uint256)" $FACTORY <AMOUNT_WEI> --private-key $PRIVATE_KEY --rpc-url $RPC_URL
cast send $FACTORY "createAndFund(address,bytes32,uint64,uint64,uint64,address,uint256)" \
  <BENEFICIARY> $(cast keccak "PARTNERS") <START> <DURATION_S> <CLIFF_S> $DACT_TOKEN <AMOUNT_WEI> \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

`computeAddress(...)` with the same arguments predicts the wallet address before you send. To use the script's "cliff, then vesting" semantics, pass `START = TGE + cliff`, `DURATION_S = vesting` and `CLIFF_S = 0`.

Other factory-owner actions:
- `transferOwnership(<SAFE>)` hands factory control to a multisig.
- `renounceOwnership()` permanently freezes the factory so no new grants can ever be created. Existing wallets are unaffected.

### Beneficiary Safe actions

- `transferOwnership(newBeneficiary)` on the vesting wallet moves all future releases to a new address.
- **Never call `renounceOwnership()` on a vesting wallet.** It sets the beneficiary to `address(0)`, the DACT transfer in `release` then reverts, and the remaining allocation is locked forever.

## Operational notes

- **Fund each wallet exactly once with the exact allocation.** Vesting math is computed over the wallet's token balance, so top-ups retroactively shift the curve proportionally.
- **`release(token)` is permissionless** — anyone can call it, but tokens only ever go to the beneficiary.
- **No clawback.** Once funded, no admin can revoke or recover tokens — trustless by design. If an agreement requires revocability, that is custom code and needs its own audit.
- **The beneficiary is the wallet's `Ownable` owner** (OZ v5 semantics) and can transfer beneficiary rights via `transferOwnership`. `TokenVesting.sol` contains a commented-out override to permanently disable that if required.
- **Factory ownership**: the factory owner controls wallet creation only, never funded tokens. Still, use a multisig or hardware key.
- The deploy script revokes the leftover token allowance to the factory after all grants are funded.

## Codebase

The vesting logic (`VestingWallet`, `VestingWalletCliff`, `Ownable`, `SafeERC20`) is unmodified [audited OpenZeppelin v5 code](https://github.com/OpenZeppelin/openzeppelin-contracts/tree/master/audits), pinned at v5.6.1. The custom surface is intentionally minimal: a parameter-forwarding constructor (`TokenVesting`) and the deployment factory (`VestingFactory`). The factory never holds user funds. An independent audit is still recommended before large mainnet allocations.
