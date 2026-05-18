// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MembershipSBT} from "../src/MembershipSBT.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";

contract InvMockToken is ERC20 {
    constructor() ERC20("Inv", "INV") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

// ============================================================
//  Handler — exposes bounded actions for the fuzzer
// ============================================================
contract RewardsHandler is CommonBase, StdCheats, StdUtils {
    RewardsDistributor public rewards;
    InvMockToken public token;
    address public admin;

    address[3] public users;
    uint256[3] public tokenIds;

    // Ghost accounting
    // ghost_totalToRewards: sum of (amount * rewardsBps / BPS) across all deposits
    uint256 public ghost_totalToRewards;
    // ghost_totalClaimed: sum of tokens that left the rewards contract on each successful claim
    uint256 public ghost_totalClaimed;
    // ghost_epochsClosed: monotonically increasing
    uint256 public ghost_epochsClosed;

    constructor(
        RewardsDistributor _rewards,
        InvMockToken _token,
        address _admin,
        address[3] memory _users,
        uint256[3] memory _tokenIds
    ) {
        rewards  = _rewards;
        token    = _token;
        admin    = _admin;
        users    = _users;
        tokenIds = _tokenIds;
    }

    /// @dev Deposit a random amount into the rewards pool.
    function deposit(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000e18);
        token.mint(address(this), amount);
        token.approve(address(rewards), amount);
        rewards.deposit(amount);
        // Track exactly what the contract retains (amount - toOps - toBurn).
        // Using toRewards alone undercounts by up to 2 wei per deposit due to
        // independent integer truncation of each of the three split amounts.
        uint256 toOps  = (amount * rewards.opsBps())  / rewards.BPS();
        uint256 toBurn = (amount * rewards.burnBps()) / rewards.BPS();
        ghost_totalToRewards += amount - toOps - toBurn;
    }

    /// @dev Advance time by one epoch duration and close the current epoch.
    ///      Always passes all three tokenIds (sorted ascending, guaranteed by setup).
    function advanceAndCloseEpoch() external {
        vm.warp(block.timestamp + rewards.epochDuration());

        uint256[] memory ids = new uint256[](3);
        ids[0] = tokenIds[0]; // minted in order → IDs are 1,2,3 (ascending)
        ids[1] = tokenIds[1];
        ids[2] = tokenIds[2];

        vm.prank(admin);
        try rewards.closeEpoch(ids) {
            ghost_epochsClosed++;
        } catch {}
    }

    /// @dev Try to claim for a randomly chosen user and epoch.
    function claim(uint8 userIdx, uint8 epochOffset) external {
        userIdx = uint8(bound(userIdx, 0, 2));

        uint256 currentEpoch = rewards.currentEpoch();
        if (currentEpoch <= 1) return; // no closed epoch yet

        uint256 epoch = bound(epochOffset, 1, currentEpoch - 1);
        uint256 tokenId = tokenIds[userIdx];
        address user    = users[userIdx];

        if (rewards.claimed(tokenId, epoch)) return;

        uint256 balBefore = token.balanceOf(address(rewards));
        vm.prank(user);
        try rewards.claim(tokenId, epoch) {
            uint256 balAfter = token.balanceOf(address(rewards));
            // balBefore - balAfter = payout + fee = userShare (total drawn from pool)
            ghost_totalClaimed += balBefore - balAfter;
        } catch {}
    }
}

// ============================================================
//  Invariant test
// ============================================================
contract RewardsInvariantTest is Test {
    RewardsDistributor internal rewards;
    InvMockToken internal token;
    MembershipSBT internal sbt;
    RewardsHandler internal handler;

    address internal admin     = makeAddr("admin");
    address internal opsWallet = makeAddr("ops");
    address internal burnSink  = makeAddr("burn");

    address[3] internal users   = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
    uint256[3] internal tokenIds;

    function setUp() public {
        // ── SBT ─────────────────────────────────────────────────────────────
        MembershipSBT sbtImpl = new MembershipSBT();
        sbt = MembershipSBT(address(new ERC1967Proxy(
            address(sbtImpl),
            abi.encodeCall(MembershipSBT.initialize, (admin, ""))
        )));

        // ── Token ────────────────────────────────────────────────────────────
        token = new InvMockToken();

        // ── Rewards (1-day epoch so fuzzer advances quickly) ─────────────────
        RewardsDistributor rImpl = new RewardsDistributor();
        rewards = RewardsDistributor(address(new ERC1967Proxy(
            address(rImpl),
            abi.encodeCall(RewardsDistributor.initialize,
                (admin, sbt, token, opsWallet, burnSink, 1 days))
        )));

        // ── Pre-mint 3 users, assign reputation ──────────────────────────────
        vm.startPrank(admin);
        for (uint256 i = 0; i < 3; i++) {
            tokenIds[i] = sbt.mint(users[i]);
            rewards.setReputation(tokenIds[i], 1_000);
        }
        vm.stopPrank();

        // ── Deploy handler and grant it the necessary roles ───────────────────
        handler = new RewardsHandler(rewards, token, admin, users, tokenIds);

        vm.startPrank(admin);
        rewards.grantRole(rewards.DEPOSITOR_ROLE(),     address(handler));
        rewards.grantRole(rewards.EPOCH_CLOSER_ROLE(),  admin);
        vm.stopPrank();

        // ── Tell Foundry to target only the handler ───────────────────────────
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = RewardsHandler.deposit.selector;
        selectors[1] = RewardsHandler.advanceAndCloseEpoch.selector;
        selectors[2] = RewardsHandler.claim.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ── Invariants ───────────────────────────────────────────────────────────

    /// @notice Total tokens claimed (payout + fee) must never exceed the total
    ///         deposited into the rewards pool across all epochs.
    function invariant_claimsNeverExceedRewardsPool() public view {
        assertLe(
            handler.ghost_totalClaimed(),
            handler.ghost_totalToRewards(),
            "claims exceed rewards pool"
        );
    }

    /// @notice The rewards contract's token balance must not exceed unclaimed pool funds.
    ///         (Rounding dust — at most 1 wei per tier per epoch — may stay in the contract.)
    function invariant_contractBalanceMatchesUnclaimed() public view {
        uint256 contractBalance = token.balanceOf(address(rewards));
        uint256 claimed   = handler.ghost_totalClaimed();
        uint256 deposited = handler.ghost_totalToRewards();

        // Nothing appears out of thin air: contract + claimed ≤ deposited (within rounding dust).
        // Dust tolerance: 4 tiers × epochCount epochs (at most 1 wei lost per tier per epoch).
        uint256 dustTolerance = rewards.currentEpoch() * 4;
        assertLe(
            contractBalance + claimed,
            deposited + dustTolerance,
            "tokens appeared out of thin air"
        );

        // Nothing silently disappears: contract + claimed ≥ deposited - dust.
        uint256 minExpected = deposited > dustTolerance ? deposited - dustTolerance : 0;
        assertGe(
            contractBalance + claimed,
            minExpected,
            "tokens silently disappeared"
        );
    }

    /// @notice The current epoch counter must only ever move forward.
    function invariant_epochMonotonicallyIncreases() public view {
        assertGe(rewards.currentEpoch(), 1);
        assertEq(rewards.currentEpoch(), handler.ghost_epochsClosed() + 1);
    }

    /// @notice rewardsPoolAccrued resets to 0 after every epoch close, then
    ///         accumulates again — it must always be <= contract balance.
    function invariant_accruedNeverExceedsBalance() public view {
        assertLe(
            rewards.rewardsPoolAccrued(),
            token.balanceOf(address(rewards))
        );
    }
}
