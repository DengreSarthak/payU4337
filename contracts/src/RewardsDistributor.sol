// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MembershipSBT} from "./MembershipSBT.sol";

/// @title RewardsDistributor
/// @notice Distributes ERC-20 rewards across a layered waterfall:
///         Layer 1 — treasury split (rewards / ops / burn) on deposit
///         Layer 2 — per-tier allocation of the rewards pool, per epoch
///         Layer 3 — intra-tier pro-rata by reputation
///         Layer 4 — protocol fee skimmed on every claim, routed to ops
///
/// @dev This contract is the previous engineer's draft. Math is wrong in places.
///      Finish the implementation, fix what is broken, and write an invariant test.
contract RewardsDistributor is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    using SafeERC20 for IERC20;

    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");
    bytes32 public constant EPOCH_CLOSER_ROLE = keccak256("EPOCH_CLOSER_ROLE");
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint256 public constant BPS = 10_000;

    // ---- Layer 1: treasury split (set by Safe) ----------------------------
    uint256 public rewardsBps; // -> rewards pool
    uint256 public opsBps;     // -> operations wallet
    uint256 public burnBps;    // -> burn sink

    // ---- Layer 2: per-tier allocation -------------------------------------
    /// @dev tierBps[Tier.Bronze] + tierBps[Silver] + tierBps[Gold] + tierBps[Platinum] should be BPS
    mapping(MembershipSBT.Tier => uint256) public tierBps;

    // ---- Layer 4: protocol fee on every claim -----------------------------
    uint256 public claimFeeBps;

    // ---- Wiring -----------------------------------------------------------
    MembershipSBT public sbt;
    IERC20 public rewardToken;
    address public opsWallet;
    address public burnSink;

    // ---- Epoch state ------------------------------------------------------
    uint256 public currentEpoch;
    uint256 public epochDuration;     // seconds
    uint256 public currentEpochStart; // unix
    uint256 public rewardsPoolAccrued; // running total deposited into rewards pool

    struct EpochSnapshot {
        uint256 totalForEpoch;                              // tokens allocated to rewards pool this epoch
        mapping(MembershipSBT.Tier => uint256) tierTotalRep; // reputation total per tier at close
    }
    mapping(uint256 => EpochSnapshot) internal epochs;

    /// @dev reputation maintained off-chain, pushed in by backend via REPUTATION oracle.
    mapping(uint256 => uint256) public reputationOf; // tokenId -> reputation

    /// @dev claimed[tokenId][epoch] = true once claimed.
    mapping(uint256 => mapping(uint256 => bool)) public claimed;

    event Deposited(address indexed from, uint256 amount, uint256 toRewards, uint256 toOps, uint256 toBurn);
    event EpochClosed(uint256 indexed epoch, uint256 totalForEpoch);
    event RewardClaimed(uint256 indexed tokenId, uint256 indexed epoch, uint256 amount);
    event ReputationUpdated(uint256 indexed tokenId, uint256 newReputation);

    error AlreadyClaimed();
    error EpochNotClosed();
    error NotHolder();
    error NothingToClaim();
    error InvalidConfig();

    function initialize(
        address admin,
        MembershipSBT _sbt,
        IERC20 _rewardToken,
        address _opsWallet,
        address _burnSink,
        uint256 _epochDuration
    ) external initializer {
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);
        _grantRole(EPOCH_CLOSER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        sbt = _sbt;
        rewardToken = _rewardToken;
        opsWallet = _opsWallet;
        burnSink = _burnSink;
        epochDuration = _epochDuration;
        currentEpochStart = block.timestamp;
        currentEpoch = 1;

        // Defaults — operator may retune via setTreasurySplit / setTierBps.
        rewardsBps = 7000;
        opsBps = 2000;
        burnBps = 999;

        tierBps[MembershipSBT.Tier.Bronze] = 1000;
        tierBps[MembershipSBT.Tier.Silver] = 2000;
        tierBps[MembershipSBT.Tier.Gold] = 3000;
        tierBps[MembershipSBT.Tier.Platinum] = 4000;

        claimFeeBps = 200;
    }

    // ---- config -----------------------------------------------------------

    function setTreasurySplit(uint256 _rewards, uint256 _ops, uint256 _burn)
        external
        onlyRole(CONFIG_ROLE)
    {
        rewardsBps = _rewards;
        opsBps = _ops;
        burnBps = _burn;
    }

    function setTierBps(MembershipSBT.Tier t, uint256 bps) external onlyRole(CONFIG_ROLE) {
        tierBps[t] = bps;
    }

    function setBurnSink(address newSink) external onlyRole(CONFIG_ROLE) {
        burnSink = newSink;
    }

    function setReputation(uint256 tokenId, uint256 rep) external onlyRole(CONFIG_ROLE) {
        reputationOf[tokenId] = rep;
        emit ReputationUpdated(tokenId, rep);
    }

    // ---- Layer 1: deposit -------------------------------------------------

    function deposit(uint256 amount) external onlyRole(DEPOSITOR_ROLE) {
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 toRewards = (amount * rewardsBps) / BPS;
        uint256 toOps = (amount * opsBps) / BPS;
        uint256 toBurn = (amount * burnBps) / BPS;

        rewardsPoolAccrued += toRewards;
        rewardToken.safeTransfer(opsWallet, toOps);
        rewardToken.safeTransfer(burnSink, toBurn);

        emit Deposited(msg.sender, amount, toRewards, toOps, toBurn);
    }

    // ---- Layer 2: close epoch ---------------------------------------------

    /// @notice Closes the current epoch, snapshots tier reputation totals, advances clock.
    /// @dev anyone may call; intended to be called by a backend cron.
    function closeEpoch(uint256[] calldata tokenIds) external {
        EpochSnapshot storage e = epochs[currentEpoch];
        e.totalForEpoch = rewardsPoolAccrued;
        rewardsPoolAccrued = 0;

        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            MembershipSBT.Tier t = sbt.tierOf(id);
            e.tierTotalRep[t] += reputationOf[id];
        }

        emit EpochClosed(currentEpoch, e.totalForEpoch);
        currentEpoch++;
        currentEpochStart = block.timestamp;
    }

    // ---- Layer 3 + 4: claim -----------------------------------------------

    function claim(uint256 tokenId, uint256 epoch) external {
        if (sbt.ownerOf(tokenId) != msg.sender) revert NotHolder();
        if (epoch >= currentEpoch) revert EpochNotClosed();
        if (claimed[tokenId][epoch]) revert AlreadyClaimed();

        EpochSnapshot storage e = epochs[epoch];

        MembershipSBT.Tier t = sbt.tierOf(tokenId);
        uint256 tierTotal = e.tierTotalRep[t];
        if (tierTotal == 0) revert NothingToClaim();

        uint256 tierAlloc = (e.totalForEpoch * tierBps[t]) / BPS;
        uint256 userShare = (tierAlloc * reputationOf[tokenId] + tierTotal - 1) / tierTotal;
        if (userShare == 0) revert NothingToClaim();

        uint256 fee = (userShare * claimFeeBps) / BPS;
        uint256 payout = userShare - fee;

        claimed[tokenId][epoch] = true;
        rewardToken.safeTransfer(opsWallet, fee);
        rewardToken.safeTransfer(msg.sender, payout);

        emit RewardClaimed(tokenId, epoch, userShare);
    }

    // ---- upgrades ---------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
