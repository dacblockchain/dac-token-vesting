// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {VestingWalletCliff} from "@openzeppelin/contracts/finance/VestingWalletCliff.sol";

/// @title TokenVesting
/// @notice Audited OZ vesting wallet with cliff. All schedule parameters
///         (start, duration, cliff) are set per-deployment, so each entity
///         can have its own economic conditions.
/// @dev    Vested amount = 0 before start+cliff, then linear from start to
///         start+duration over the wallet's token balance. Fund once with
///         the exact allocation for a fixed schedule.
contract TokenVesting is VestingWalletCliff {
    /// @param beneficiary       Address that receives released tokens (also owner).
    /// @param startTimestamp    Vesting start (e.g. TGE), unix seconds.
    /// @param durationSeconds   Total vesting duration INCLUDING the cliff.
    /// @param cliffSeconds      Cliff length from start; must be <= duration.
    constructor(
        address beneficiary,
        uint64 startTimestamp,
        uint64 durationSeconds,
        uint64 cliffSeconds
    )
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
        VestingWalletCliff(cliffSeconds)
    {}

    /// @dev OZ v5 makes the beneficiary the Ownable owner, which allows
    ///      transferring beneficiary rights. Uncomment to make it fixed:
    // function transferOwnership(address) public pure override {
    //     revert("Beneficiary is not transferable");
    // }
}
