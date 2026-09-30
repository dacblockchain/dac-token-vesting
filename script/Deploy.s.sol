// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VestingFactory} from "../src/VestingFactory.sol";

/// Allocations from DACT_Allocation_Cliff_Vesting.xlsx.
///
/// Schedule semantics: "cliff, then vesting". Nothing unlocks during the cliff;
/// afterwards the allocation vests linearly over the vesting period
/// (e.g. Team: 12m cliff + 36m linear = 48m total). Implemented as
/// start = TGE + cliff, duration = vesting, cliff = 0.
///
/// Usage:
///   export PRIVATE_KEY=0x...
///   export FUND=false                # optional: deploy empty wallets; funded later by transfer (default true)
///   export DACT_TOKEN=0x...          # deployed ERC-20 address (only needed when FUND=true)
///   export RENOUNCE_FACTORY=true     # optional: renounce factory ownership at the end (default false)
///   export TGE_TIMESTAMP=1767225600  # vesting start (unix)
///   export MONTH_SECONDS=60          # optional: compress months on testnet (default 30 days)
///   export BENEFICIARY_TEAM=0x...    # per bucket; defaults to the deployer, REQUIRED on mainnet
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract Deploy is Script {
    struct Grant {
        string name;
        address beneficiary;
        uint64 cliffMonths;
        uint64 vestingMonths; // linear period after the cliff
        uint256 amount;
    }

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        bool fund = vm.envOr("FUND", true);
        IERC20 token = fund ? IERC20(vm.envAddress("DACT_TOKEN")) : IERC20(address(0));
        uint64 tge = uint64(vm.envUint("TGE_TIMESTAMP"));
        uint64 month = uint64(vm.envOr("MONTH_SECONDS", uint256(30 days)));
        address owner = vm.addr(pk);

        Grant[] memory grants = _grants(owner, month);

        console2.log("TGE:", tge);
        console2.log("Month (s):", month);
        console2.log("Fund in this run:", fund);

        vm.startBroadcast(pk);

        VestingFactory factory = new VestingFactory(owner);
        console2.log("Factory:", address(factory));

        if (fund) token.approve(address(factory), type(uint256).max);

        for (uint256 i = 0; i < grants.length; i++) {
            _deploy(factory, grants[i], tge, month, token, fund);
        }

        if (fund) token.approve(address(factory), 0); // hygiene: revoke leftover allowance
        if (vm.envOr("RENOUNCE_FACTORY", false)) {
            factory.renounceOwnership(); // no further wallets (e.g. decoys) can ever be created
            console2.log("Factory ownership renounced");
        }
        vm.stopBroadcast();
    }

    function _deploy(VestingFactory factory, Grant memory g, uint64 tge, uint64 month, IERC20 token, bool fund)
        internal
    {
        address wallet = _create(factory, g, tge + g.cliffMonths * month, g.vestingMonths * month, token, fund);
        console2.log(g.name, wallet);
        console2.log("  beneficiary:", g.beneficiary);
        console2.log("  months (cliff/vesting):", g.cliffMonths, g.vestingMonths);
        console2.log(fund ? "  funded (DACT):" : "  TO FUND (DACT):", g.amount / 1e18);
    }

    function _create(VestingFactory factory, Grant memory g, uint64 start, uint64 duration, IERC20 token, bool fund)
        internal
        returns (address)
    {
        bytes32 bucket = keccak256(bytes(g.name));
        if (fund) return factory.createAndFund(g.beneficiary, bucket, start, duration, 0, token, g.amount);
        return factory.createVesting(g.beneficiary, bucket, start, duration, 0);
    }

    /// Allocations per bucket. Mainnet guard: real months only, and every
    /// beneficiary must be explicitly configured and be a deployed Safe multisig.
    function _grants(address owner, uint64 month) internal view returns (Grant[] memory grants) {
        bool mainnet = block.chainid == 1;
        if (mainnet) require(month == 30 days, "MONTH_SECONDS must be 30 days on mainnet");

        grants = new Grant[](7);
        grants[0] = _grant("TEAM", owner, mainnet, 12, 36, 150_000_000e18);
        grants[1] = _grant("MARKETING", owner, mainnet, 2, 36, 85_000_000e18);
        grants[2] = _grant("ENTERPRISE", owner, mainnet, 12, 48, 140_000_000e18);
        grants[3] = _grant("INSTITUTIONAL", owner, mainnet, 3, 36, 150_000_000e18);
        grants[4] = _grant("INSTITUTIONAL_UNICORN", owner, mainnet, 12, 24, 50_000_000e18);
        grants[5] = _grant("GRANT_AIRDROP", owner, mainnet, 0, 24, 75_000_000e18);
        grants[6] = _grant("RESERVE", owner, mainnet, 12, 48, 205_000_000e18);
    }

    function _grant(
        string memory name,
        address fallbackBeneficiary,
        bool mainnet,
        uint64 cliffMonths,
        uint64 vestingMonths,
        uint256 amount
    ) internal view returns (Grant memory) {
        string memory key = string.concat("BENEFICIARY_", name);
        address beneficiary = mainnet ? vm.envAddress(key) : vm.envOr(key, fallbackBeneficiary);
        if (mainnet) _requireMultisig(beneficiary, key);
        return Grant(name, beneficiary, cliffMonths, vestingMonths, amount);
    }

    /// Beneficiary must be a deployed Safe with threshold >= 2. A bare code-length
    /// check is not enough: EIP-7702 delegated EOAs carry 0xef0100-prefixed code.
    function _requireMultisig(address beneficiary, string memory key) internal view {
        bytes memory code = beneficiary.code;
        require(code.length > 0, string.concat(key, " is not a deployed contract"));
        require(
            !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00),
            string.concat(key, " is an EIP-7702 delegated EOA, not a multisig")
        );
        (bool ok, bytes memory ret) = beneficiary.staticcall(abi.encodeWithSignature("getThreshold()"));
        require(ok && ret.length == 32 && abi.decode(ret, (uint256)) >= 2, string.concat(key, " is not a Safe with threshold >= 2"));
    }
}
