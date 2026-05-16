// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MembershipSBT} from "./MembershipSBT.sol";

interface IMembershipSBTV2 {
    function markClaimed(uint256 tokenId, uint256 epoch) external;
}

/// @title RewardsDistributor
/// @notice Distributes ERC-20 rewards across a layered waterfall:
///         Layer 1 — treasury split (rewards / ops / burn) on deposit
///         Layer 2 — per-tier allocation of the rewards pool, per epoch
///         Layer 3 — intra-tier pro-rata by reputation
///         Layer 4 — protocol fee skimmed on every claim, routed to ops
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
    /// @dev tierBps[Tier.Bronze] + tierBps[Silver] + tierBps[Gold] + tierBps[Platinum] must be <= BPS.
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
    uint256 public rewardsPoolAccrued; // running total deposited into rewards pool this epoch

    struct EpochSnapshot {
        uint256 totalForEpoch;                              // tokens allocated to rewards pool this epoch
        mapping(MembershipSBT.Tier => uint256) tierTotalRep; // reputation total per tier at close
        mapping(MembershipSBT.Tier => uint256) tierBpsSnapshot; // tier allocations frozen at close
    }
    mapping(uint256 => EpochSnapshot) internal epochs;

    /// @dev reputation maintained off-chain, pushed in by backend via CONFIG_ROLE.
    mapping(uint256 => uint256) public reputationOf; // tokenId -> reputation

    /// @dev claimed[tokenId][epoch] = true once claimed.
    mapping(uint256 => mapping(uint256 => bool)) public claimed;

    // ---- v2 SBT integration -----------------------------------------------
    /// @dev When true, claim() calls markClaimed() on the SBT to track lastClaimedEpoch.
    bool public sbtIsV2;

    // ---- events -----------------------------------------------------------
    event Deposited(address indexed from, uint256 amount, uint256 toRewards, uint256 toOps, uint256 toBurn);
    event EpochClosed(uint256 indexed epoch, uint256 totalForEpoch);
    event RewardClaimed(uint256 indexed tokenId, uint256 indexed epoch, uint256 amount);
    event ReputationUpdated(uint256 indexed tokenId, uint256 newReputation);

    // ---- errors -----------------------------------------------------------
    error AlreadyClaimed();
    error EpochNotClosed();
    error EpochNotElapsed();
    error NotHolder();
    error NothingToClaim();
    error InvalidConfig();
    error UnsortedOrDuplicateTokenIds();

    // ---- internal ---------------------------------------------------------
    function _validateTreasurySplit(uint256 _rewards, uint256 _ops, uint256 _burn) internal pure {
        if (_rewards + _ops + _burn != BPS) revert InvalidConfig();
    }

    function initialize(
        address admin,
        MembershipSBT _sbt,
        IERC20 _rewardToken,
        address _opsWallet,
        address _burnSink,
        uint256 _epochDuration
    ) external initializer {
        __AccessControl_init();

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
        burnBps = 1000;

        tierBps[MembershipSBT.Tier.Bronze] = 1000;
        tierBps[MembershipSBT.Tier.Silver] = 2000;
        tierBps[MembershipSBT.Tier.Gold] = 3000;
        tierBps[MembershipSBT.Tier.Platinum] = 4000;

        claimFeeBps = 200;
    }

    function setTreasurySplit(uint256 _rewards, uint256 _ops, uint256 _burn)
        external
        onlyRole(CONFIG_ROLE)
    {
        _validateTreasurySplit(_rewards, _ops, _burn);
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

    function setSbtIsV2(bool v) external onlyRole(CONFIG_ROLE) {
        sbtIsV2 = v;
    }

    /// @notice Returns the sum of all four tier allocations and whether it is within BPS.
    function getTierBpsTotal() external view returns (uint256 total, bool valid) {
        total = tierBps[MembershipSBT.Tier.Bronze] + tierBps[MembershipSBT.Tier.Silver] + tierBps[MembershipSBT.Tier.Gold] + tierBps[MembershipSBT.Tier.Platinum];
        valid = total <= BPS;
    }

    function getEpochTotal(uint256 epochId) external view returns (uint256) {
        return epochs[epochId].totalForEpoch;
    }

    function getEpochTierTotal(uint256 epochId, MembershipSBT.Tier t) external view returns (uint256) {
        return epochs[epochId].tierTotalRep[t];
    }

    function getEpochTierBps(uint256 epochId, MembershipSBT.Tier t) external view returns (uint256) {
        return epochs[epochId].tierBpsSnapshot[t];
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

    /// @notice Closes the current epoch, snapshots tier reputation totals and tier bps, advances clock.
    /// @dev tokenIds must be sorted strictly ascending — enforced to prevent duplicate reputation counting.
    function closeEpoch(uint256[] calldata tokenIds) external onlyRole(EPOCH_CLOSER_ROLE) {
        if (block.timestamp < currentEpochStart + epochDuration) revert EpochNotElapsed();

        EpochSnapshot storage e = epochs[currentEpoch];
        e.totalForEpoch = rewardsPoolAccrued;
        rewardsPoolAccrued = 0;

        // Freeze tier allocations so future setTierBps calls cannot alter past-epoch claims.
        e.tierBpsSnapshot[MembershipSBT.Tier.Bronze]   = tierBps[MembershipSBT.Tier.Bronze];
        e.tierBpsSnapshot[MembershipSBT.Tier.Silver]   = tierBps[MembershipSBT.Tier.Silver];
        e.tierBpsSnapshot[MembershipSBT.Tier.Gold]     = tierBps[MembershipSBT.Tier.Gold];
        e.tierBpsSnapshot[MembershipSBT.Tier.Platinum] = tierBps[MembershipSBT.Tier.Platinum];

        uint256 prev;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            uint256 id = tokenIds[i];
            if (i != 0 && id <= prev) revert UnsortedOrDuplicateTokenIds();
            prev = id;
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

        // Use the tier bps frozen at epoch close, not the current live value.
        uint256 tierAlloc = (e.totalForEpoch * e.tierBpsSnapshot[t]) / BPS;
        uint256 userShare = (tierAlloc * reputationOf[tokenId]) / tierTotal;
        if (userShare == 0) revert NothingToClaim();

        uint256 fee = (userShare * claimFeeBps) / BPS;
        uint256 payout = userShare - fee;

        claimed[tokenId][epoch] = true;

        if (sbtIsV2) {
            IMembershipSBTV2(address(sbt)).markClaimed(tokenId, epoch);
        }

        rewardToken.safeTransfer(opsWallet, fee);
        rewardToken.safeTransfer(msg.sender, payout);

        emit RewardClaimed(tokenId, epoch, payout);
    }

    // ---- upgrades ---------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
