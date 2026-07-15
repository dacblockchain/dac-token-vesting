// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VestingFactory} from "../src/VestingFactory.sol";
import {TokenVesting} from "../src/TokenVesting.sol";

contract MockDACt is ERC20 {
    constructor() ERC20("DAC Token", "DACt") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

contract VestingFactoryTest is Test {
    VestingFactory factory;
    MockDACt token;

    address deployer = makeAddr("deployer");
    address partner = makeAddr("partner");
    address advisor = makeAddr("advisor");

    bytes32 constant PARTNERS = keccak256("PARTNERS");
    bytes32 constant ADVISORS = keccak256("ADVISORS");

    uint64 constant MONTH = 30 days;
    uint64 start;

    function setUp() public {
        start = uint64(block.timestamp);
        vm.startPrank(deployer);
        factory = new VestingFactory(deployer);
        token = new MockDACt();
        token.approve(address(factory), type(uint256).max);
        vm.stopPrank();
    }

    // --- Example partner: 12m cliff + 24m linear = 36m total, 250k DACt ---

    function _deployPartner() internal returns (TokenVesting w) {
        vm.prank(deployer);
        address wallet = factory.createAndFund(
            partner, PARTNERS, start, 36 * MONTH, 12 * MONTH, IERC20(address(token)), 250_000e18
        );
        w = TokenVesting(payable(wallet));
    }

    function test_NothingVestedBeforeCliff() public {
        TokenVesting w = _deployPartner();
        vm.warp(start + 12 * MONTH - 1);
        assertEq(w.releasable(address(token)), 0);
    }

    function test_OneThirdUnlocksAtCliff() public {
        TokenVesting w = _deployPartner();
        vm.warp(start + 12 * MONTH);
        // 12/36 of 250k = ~83,333
        assertApproxEqAbs(w.releasable(address(token)), uint256(250_000e18) / 3, 1e18);
    }

    function test_LinearBetweenCliffAndEnd() public {
        TokenVesting w = _deployPartner();
        vm.warp(start + 24 * MONTH);
        assertApproxEqAbs(w.releasable(address(token)), (uint256(250_000e18) * 2) / 3, 1e18);
    }

    function test_FullyVestedAtEnd_ReleaseToBeneficiary() public {
        TokenVesting w = _deployPartner();
        vm.warp(start + 36 * MONTH);
        w.release(address(token)); // anyone can call
        assertEq(token.balanceOf(partner), 250_000e18);
    }

    // --- Different entity, different conditions ---

    function test_DifferentSchedulesPerEntity() public {
        vm.startPrank(deployer);
        // Partner: 12m cliff / 36m total
        address a = factory.createVesting(partner, PARTNERS, start, 36 * MONTH, 12 * MONTH);
        // Advisor: 6m cliff / 18m total
        address b = factory.createVesting(advisor, ADVISORS, start, 18 * MONTH, 6 * MONTH);
        vm.stopPrank();

        assertTrue(a != b);
        assertEq(TokenVesting(payable(a)).cliff(), start + 12 * MONTH);
        assertEq(TokenVesting(payable(b)).cliff(), start + 6 * MONTH);
        assertEq(TokenVesting(payable(b)).duration(), 18 * MONTH);
    }

    function test_ComputeAddressMatchesDeployment() public {
        address predicted =
            factory.computeAddress(partner, PARTNERS, start, 36 * MONTH, 12 * MONTH);
        vm.prank(deployer);
        address deployed = factory.createVesting(partner, PARTNERS, start, 36 * MONTH, 12 * MONTH);
        assertEq(predicted, deployed);
    }

    function test_RevertOnDuplicateSchedule() public {
        vm.startPrank(deployer);
        factory.createVesting(partner, PARTNERS, start, 36 * MONTH, 12 * MONTH);
        vm.expectRevert(VestingFactory.DuplicateSchedule.selector);
        factory.createVesting(partner, PARTNERS, start, 36 * MONTH, 12 * MONTH);
        vm.stopPrank();
    }

    function test_RevertOnCliffLongerThanDuration() public {
        vm.prank(deployer);
        vm.expectRevert(VestingFactory.InvalidParams.selector);
        factory.createVesting(partner, PARTNERS, start, 12 * MONTH, 24 * MONTH);
    }

    function test_OnlyOwnerCanCreate() public {
        vm.prank(partner);
        vm.expectRevert();
        factory.createVesting(partner, PARTNERS, start, 36 * MONTH, 12 * MONTH);
    }
}
