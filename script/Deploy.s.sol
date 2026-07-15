// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VestingFactory} from "../src/VestingFactory.sol";

/// Usage:
///   export PRIVATE_KEY=0x...
///   export DACT_TOKEN=0x...          # deployed ERC-20 address
///   export TGE_TIMESTAMP=1767225600  # vesting start (unix)
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    uint64 constant MONTH = 30 days;

    struct Grant {
        address beneficiary;
        bytes32 bucket;
        uint64 durationMonths; // total, cliff included
        uint64 cliffMonths;
        uint256 amount;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        IERC20 token = IERC20(vm.envAddress("DACT_TOKEN"));
        uint64 tge = uint64(vm.envUint("TGE_TIMESTAMP"));
        address owner = vm.addr(pk);

        // === Configure entities here: each with its own conditions ===
        Grant[] memory grants = new Grant[](2);
        grants[0] = Grant({
            beneficiary: 0x0000000000000000000000000000000000000001, // example partner
            bucket: keccak256("PARTNERS"),
            durationMonths: 36, // 12m cliff + 24m linear
            cliffMonths: 12,
            amount: 250_000e18
        });
        grants[1] = Grant({
            beneficiary: 0x0000000000000000000000000000000000000002, // example advisor
            bucket: keccak256("ADVISORS"),
            durationMonths: 18, // 6m cliff + 12m linear
            cliffMonths: 6,
            amount: 50_000e18
        });

        vm.startBroadcast(pk);

        VestingFactory factory = new VestingFactory(owner);
        console2.log("Factory:", address(factory));

        token.approve(address(factory), type(uint256).max);

        for (uint256 i = 0; i < grants.length; i++) {
            Grant memory g = grants[i];
            address wallet = factory.createAndFund(
                g.beneficiary,
                g.bucket,
                tge,
                g.durationMonths * MONTH,
                g.cliffMonths * MONTH,
                token,
                g.amount
            );
            console2.log("Vesting wallet:", wallet);
            console2.log("  beneficiary:", g.beneficiary);
            console2.log("  months (total/cliff):", g.durationMonths, g.cliffMonths);
        }

        token.approve(address(factory), 0); // hygiene: revoke leftover allowance
        vm.stopBroadcast();
    }
}
