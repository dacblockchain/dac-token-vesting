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
script/         Deploy.s.sol — per-entity grant configuration + deployment
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

1. Copy `.env.example` to `.env` and set `PRIVATE_KEY`, `DACT_TOKEN`, `TGE_TIMESTAMP`, `RPC_URL`, and the comma-separated `GRANT_*` lists. Each grant list must have the same number of entries; the deployment script rejects empty, zero, mismatched, or invalid values.
2. Review every beneficiary address, bucket name, duration, cliff, and amount in `.env` before broadcasting. The script does not contain placeholder recipients.
3. Dry-run first, then broadcast:

```bash
source .env
forge script script/Deploy.s.sol --rpc-url $RPC_URL              # simulation
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
```

Before mainnet, run the full schedule on the testnet (`exptest.dachain.tech`) with compressed durations (e.g. minutes instead of months) and verify the sources on the explorer.

## Operational notes

- **Fund each wallet exactly once with the exact allocation.** Vesting math is computed over the wallet's token balance, so top-ups retroactively shift the curve proportionally.
- **`release(token)` is permissionless** — anyone can call it, but tokens only ever go to the beneficiary.
- **No clawback.** Once funded, no admin can revoke or recover tokens — trustless by design. If an agreement requires revocability, that is custom code and needs its own audit.
- **The beneficiary is the wallet's `Ownable` owner** (OZ v5 semantics) and can transfer beneficiary rights via `transferOwnership`. `TokenVesting.sol` contains a commented-out override to permanently disable that if required.
- **Factory ownership**: the factory owner controls wallet creation only, never funded tokens. Still, use a multisig or hardware key.
- The deploy script revokes the leftover token allowance to the factory after all grants are funded.

## Codebase

The vesting logic (`VestingWallet`, `VestingWalletCliff`, `Ownable`, `SafeERC20`) is unmodified [audited OpenZeppelin v5 code](https://github.com/OpenZeppelin/openzeppelin-contracts/tree/master/audits), pinned at v5.6.1. The custom surface is intentionally minimal: a parameter-forwarding constructor (`TokenVesting`) and the deployment factory (`VestingFactory`). The factory never holds user funds. An independent audit is still recommended before large mainnet allocations.
