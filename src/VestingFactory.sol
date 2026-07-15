// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TokenVesting} from "./TokenVesting.sol";

/// @title VestingFactory
/// @notice Deploys TokenVesting wallets with per-beneficiary schedules.
///         Each deployment can define its own start / duration / cliff,
///         so different entities (team, advisors, partners, ecosystem
///         buckets, ...) get their own economic conditions.
/// @dev    Uses CREATE2 with a salt derived from (beneficiary, bucket, schedule)
///         so addresses are deterministic and auditable off-chain.
contract VestingFactory is Ownable {
    using SafeERC20 for IERC20;

    struct Schedule {
        address wallet;        // deployed TokenVesting address
        address beneficiary;
        uint64 start;
        uint64 duration;       // includes cliff
        uint64 cliff;
        uint256 funded;        // amount funded through the factory (informational)
        bytes32 bucket;        // e.g. keccak256("PARTNERS"), keccak256("TEAM")
    }

    /// @notice All schedules ever created, in creation order.
    Schedule[] public schedules;

    /// @notice beneficiary => indexes into `schedules`.
    mapping(address => uint256[]) public schedulesOf;

    /// @notice Guards against accidental duplicate (beneficiary, bucket, schedule).
    mapping(bytes32 => bool) public saltUsed;

    event VestingCreated(
        address indexed wallet,
        address indexed beneficiary,
        bytes32 indexed bucket,
        uint64 start,
        uint64 duration,
        uint64 cliff
    );

    event VestingFunded(address indexed wallet, address indexed token, uint256 amount);

    error InvalidParams();
    error DuplicateSchedule();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Deploy a vesting wallet with a custom schedule.
    /// @param beneficiary Recipient of vested tokens.
    /// @param bucket      Tokenomics bucket label, e.g. keccak256("PARTNERS").
    /// @param start       Vesting start (unix seconds). Use TGE or agreement date.
    /// @param duration    Total duration in seconds, cliff included.
    /// @param cliff       Cliff in seconds from start. Must be <= duration.
    function createVesting(
        address beneficiary,
        bytes32 bucket,
        uint64 start,
        uint64 duration,
        uint64 cliff
    ) public onlyOwner returns (address wallet) {
        if (beneficiary == address(0) || duration == 0 || cliff > duration) {
            revert InvalidParams();
        }

        bytes32 salt = keccak256(abi.encode(beneficiary, bucket, start, duration, cliff));
        if (saltUsed[salt]) revert DuplicateSchedule();
        saltUsed[salt] = true;

        wallet = address(new TokenVesting{salt: salt}(beneficiary, start, duration, cliff));

        schedules.push(
            Schedule({
                wallet: wallet,
                beneficiary: beneficiary,
                start: start,
                duration: duration,
                cliff: cliff,
                funded: 0,
                bucket: bucket
            })
        );
        schedulesOf[beneficiary].push(schedules.length - 1);

        emit VestingCreated(wallet, beneficiary, bucket, start, duration, cliff);
    }

    /// @notice Deploy and fund in a single transaction (requires prior ERC-20
    ///         approval from the caller to this factory).
    function createAndFund(
        address beneficiary,
        bytes32 bucket,
        uint64 start,
        uint64 duration,
        uint64 cliff,
        IERC20 token,
        uint256 amount
    ) external onlyOwner returns (address wallet) {
        wallet = createVesting(beneficiary, bucket, start, duration, cliff);
        token.safeTransferFrom(msg.sender, wallet, amount);
        schedules[schedules.length - 1].funded = amount;
        emit VestingFunded(wallet, address(token), amount);
    }

    /// @notice Predict the address of a vesting wallet before deploying it.
    function computeAddress(
        address beneficiary,
        bytes32 bucket,
        uint64 start,
        uint64 duration,
        uint64 cliff
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(beneficiary, bucket, start, duration, cliff));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(TokenVesting).creationCode,
                abi.encode(beneficiary, start, duration, cliff)
            )
        );
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }

    function schedulesCount() external view returns (uint256) {
        return schedules.length;
    }

    function schedulesOfBeneficiary(address beneficiary) external view returns (uint256[] memory) {
        return schedulesOf[beneficiary];
    }
}
