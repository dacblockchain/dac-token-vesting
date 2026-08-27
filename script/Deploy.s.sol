// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VestingFactory} from "../src/VestingFactory.sol";

/// Usage:
///   export PRIVATE_KEY=0x...
///   export DACT_TOKEN=0x...          # deployed ERC-20 address
///   export TGE_TIMESTAMP=1767225600  # vesting start (unix)
///   export GRANT_BENEFICIARIES=0x...,0x...
///   export GRANT_BUCKET_NAMES=PARTNERS,ADVISORS
///   export GRANT_DURATION_MONTHS=36,18
///   export GRANT_CLIFF_MONTHS=12,6
///   export GRANT_AMOUNTS=250000000000000000000000,50000000000000000000000
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    using SafeERC20 for IERC20;

    uint64 constant MONTH = 30 days;

    struct Grant {
        address beneficiary;
        bytes32 bucket;
        uint64 durationMonths;
        uint64 cliffMonths;
        uint256 amount;
    }

    error InvalidGrantConfiguration();

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        IERC20 token = IERC20(vm.envAddress("DACT_TOKEN"));
        uint64 tge = uint64(vm.envUint("TGE_TIMESTAMP"));
        address owner = vm.addr(pk);
        Grant[] memory grants = _loadGrants();

        vm.startBroadcast(pk);

        VestingFactory factory = new VestingFactory(owner);
        console2.log("Factory:", address(factory));

        token.forceApprove(address(factory), type(uint256).max);

        for (uint256 i = 0; i < grants.length; i++) {
            Grant memory grant = grants[i];
            uint256 durationSeconds = uint256(grant.durationMonths) * MONTH;
            uint256 cliffSeconds = uint256(grant.cliffMonths) * MONTH;
            if (durationSeconds > type(uint64).max || cliffSeconds > type(uint64).max) {
                revert InvalidGrantConfiguration();
            }

            address wallet = factory.createAndFund(
                grant.beneficiary,
                grant.bucket,
                tge,
                uint64(durationSeconds),
                uint64(cliffSeconds),
                token,
                grant.amount
            );
            console2.log("Vesting wallet:", wallet);
            console2.log("  beneficiary:", grant.beneficiary);
            console2.log("  months (total/cliff):", grant.durationMonths, grant.cliffMonths);
        }

        token.forceApprove(address(factory), 0);
        vm.stopBroadcast();
    }

    function _loadGrants() internal view returns (Grant[] memory grants) {
        address[] memory beneficiaries = vm.envAddress("GRANT_BENEFICIARIES", ",");
        string[] memory bucketNames = vm.envString("GRANT_BUCKET_NAMES", ",");
        uint256[] memory durations = vm.envUint("GRANT_DURATION_MONTHS", ",");
        uint256[] memory cliffs = vm.envUint("GRANT_CLIFF_MONTHS", ",");
        uint256[] memory amounts = vm.envUint("GRANT_AMOUNTS", ",");

        uint256 count = beneficiaries.length;
        if (
            count == 0 ||
            bucketNames.length != count ||
            durations.length != count ||
            cliffs.length != count ||
            amounts.length != count
        ) {
            revert InvalidGrantConfiguration();
        }

        grants = new Grant[](count);
        for (uint256 i = 0; i < count; i++) {
            if (
                beneficiaries[i] == address(0) ||
                bytes(bucketNames[i]).length == 0 ||
                durations[i] == 0 ||
                cliffs[i] > durations[i] ||
                durations[i] > type(uint64).max ||
                cliffs[i] > type(uint64).max ||
                amounts[i] == 0
            ) {
                revert InvalidGrantConfiguration();
            }

            grants[i] = Grant({
                beneficiary: beneficiaries[i],
                bucket: keccak256(bytes(bucketNames[i])),
                durationMonths: uint64(durations[i]),
                cliffMonths: uint64(cliffs[i]),
                amount: amounts[i]
            });
        }
    }
}
