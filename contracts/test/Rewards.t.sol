// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MembershipSBT} from "../src/MembershipSBT.sol";
import {MembershipSBTv2} from "../src/MembershipSBTv2.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

// ============================================================
//  Core rewards tests
// ============================================================
contract RewardsTest is Test {
    MembershipSBT internal sbt;
    RewardsDistributor internal rewards;
    MockToken internal token;

    address internal admin    = makeAddr("admin");
    address internal opsWallet = makeAddr("ops");
    address internal burnSink  = makeAddr("burn");
    address internal treasury  = makeAddr("treasury");
    address internal alice     = makeAddr("alice");
    address internal bob       = makeAddr("bob");
    address internal carol     = makeAddr("carol");

    uint256 constant EPOCH = 7 days;

    function setUp() public {
        MembershipSBT sbtImpl = new MembershipSBT();
        sbt = MembershipSBT(address(new ERC1967Proxy(
            address(sbtImpl),
            abi.encodeCall(MembershipSBT.initialize, (admin, ""))
        )));

        token = new MockToken();

        RewardsDistributor rImpl = new RewardsDistributor();
        rewards = RewardsDistributor(address(new ERC1967Proxy(
            address(rImpl),
            abi.encodeCall(RewardsDistributor.initialize,
                (admin, sbt, token, opsWallet, burnSink, EPOCH))
        )));

        vm.startPrank(admin);
        rewards.grantRole(rewards.DEPOSITOR_ROLE(), treasury);
        rewards.grantRole(rewards.EPOCH_CLOSER_ROLE(), admin);
        vm.stopPrank();
    }

    // ── internal helpers ─────────────────────────────────────────────────────

    function _mint(address holder) internal returns (uint256 id) {
        vm.prank(admin);
        id = sbt.mint(holder);
    }

    function _mintWithRep(address holder, uint256 rep) internal returns (uint256 id) {
        id = _mint(holder);
        vm.prank(admin);
        rewards.setReputation(id, rep);
    }

    function _deposit(uint256 amount) internal {
        token.mint(treasury, amount);
        vm.startPrank(treasury);
        token.approve(address(rewards), amount);
        rewards.deposit(amount);
        vm.stopPrank();
    }

    function _closeEpoch(uint256[] memory ids) internal {
        vm.warp(block.timestamp + EPOCH);
        vm.prank(admin);
        rewards.closeEpoch(ids);
    }

    function _sorted(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _sorted(uint256 a, uint256 b) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](2);
        (ids[0], ids[1]) = a < b ? (a, b) : (b, a);
    }

    function _sorted(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory ids) {
        // bubble sort 3 elements
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        ids = new uint256[](3);
        (ids[0], ids[1], ids[2]) = (a, b, c);
    }

    // ── Deposit (Layer 1) ────────────────────────────────────────────────────

    function test_deposit_accrues_rewards_pool() public {
        _deposit(1_000_000e18);
        // rewardsBps = 7000 → 70 %
        assertEq(rewards.rewardsPoolAccrued(), 700_000e18);
        assertEq(token.balanceOf(address(rewards)), 700_000e18);
    }

    function test_deposit_routes_ops() public {
        _deposit(1_000_000e18);
        // opsBps = 2000 → 20 %
        assertEq(token.balanceOf(opsWallet), 200_000e18);
    }

    function test_deposit_routes_burn() public {
        _deposit(1_000_000e18);
        // burnBps = 1000 → 10 %
        assertEq(token.balanceOf(burnSink), 100_000e18);
    }

    function test_deposit_no_residual_in_contract() public {
        _deposit(1_000_000e18);
        // contract balance == rewards pool portion only
        assertEq(token.balanceOf(address(rewards)), rewards.rewardsPoolAccrued());
    }

    function test_deposit_emits_event() public {
        token.mint(treasury, 1_000_000e18);
        vm.startPrank(treasury);
        token.approve(address(rewards), 1_000_000e18);
        vm.expectEmit(true, false, false, true);
        emit RewardsDistributor.Deposited(treasury, 1_000_000e18, 700_000e18, 200_000e18, 100_000e18);
        rewards.deposit(1_000_000e18);
        vm.stopPrank();
    }

    function test_deposit_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        rewards.deposit(1e18);
    }

    // ── CloseEpoch (Layer 2) ─────────────────────────────────────────────────

    function test_closeEpoch_requires_time_elapsed() public {
        uint256[] memory ids = new uint256[](0);
        vm.prank(admin);
        vm.expectRevert(RewardsDistributor.EpochNotElapsed.selector);
        rewards.closeEpoch(ids);
    }

    function test_closeEpoch_snapshots_total_for_epoch() public {
        _deposit(1_000_000e18); // 700k to pool
        _closeEpoch(new uint256[](0));
        assertEq(rewards.getEpochTotal(1), 700_000e18);
    }

    function test_closeEpoch_resets_accrued_pool() public {
        _deposit(1_000_000e18);
        _closeEpoch(new uint256[](0));
        assertEq(rewards.rewardsPoolAccrued(), 0);
    }

    function test_closeEpoch_advances_epoch_counter() public {
        assertEq(rewards.currentEpoch(), 1);
        _closeEpoch(new uint256[](0));
        assertEq(rewards.currentEpoch(), 2);
    }

    function test_closeEpoch_resets_epoch_start() public {
        uint256 before = block.timestamp;
        vm.warp(before + EPOCH);
        vm.prank(admin);
        rewards.closeEpoch(new uint256[](0));
        assertEq(rewards.currentEpochStart(), before + EPOCH);
    }

    function test_closeEpoch_requires_sorted_ascending_ids() public {
        uint256 id1 = _mint(alice);
        uint256 id2 = _mint(bob);

        uint256[] memory ids = new uint256[](2);
        ids[0] = id2; // descending — invalid
        ids[1] = id1;

        vm.warp(block.timestamp + EPOCH);
        vm.prank(admin);
        vm.expectRevert(RewardsDistributor.UnsortedOrDuplicateTokenIds.selector);
        rewards.closeEpoch(ids);
    }

    function test_closeEpoch_rejects_duplicate_ids() public {
        uint256 id1 = _mint(alice);
        uint256[] memory ids = new uint256[](2);
        ids[0] = id1;
        ids[1] = id1; // same id twice

        vm.warp(block.timestamp + EPOCH);
        vm.prank(admin);
        vm.expectRevert(RewardsDistributor.UnsortedOrDuplicateTokenIds.selector);
        rewards.closeEpoch(ids);
    }

    function test_closeEpoch_snapshots_tier_bps() public {
        _closeEpoch(new uint256[](0));
        // defaults: Bronze=1000, Silver=2000, Gold=3000, Platinum=4000
        assertEq(rewards.getEpochTierBps(1, MembershipSBT.Tier.Bronze),   1000);
        assertEq(rewards.getEpochTierBps(1, MembershipSBT.Tier.Silver),   2000);
        assertEq(rewards.getEpochTierBps(1, MembershipSBT.Tier.Gold),     3000);
        assertEq(rewards.getEpochTierBps(1, MembershipSBT.Tier.Platinum), 4000);
    }

    function test_closeEpoch_accumulates_tier_reputation() public {
        uint256 id1 = _mintWithRep(alice, 1_000);
        uint256 id2 = _mintWithRep(bob,   3_000);
        _closeEpoch(_sorted(id1, id2));
        // Both Bronze → tierTotalRep[Bronze] = 4000
        assertEq(rewards.getEpochTierTotal(1, MembershipSBT.Tier.Bronze), 4_000);
    }

    function test_closeEpoch_unauthorized_reverts() public {
        vm.warp(block.timestamp + EPOCH);
        vm.prank(alice);
        vm.expectRevert();
        rewards.closeEpoch(new uint256[](0));
    }

    // ── Claim (Layer 3 + 4) ──────────────────────────────────────────────────

    function test_claim_sole_holder_receives_full_tier_alloc_minus_fee() public {
        // Alice sole Bronze holder, rep=1000
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18); // 7 000e18 to pool

        _closeEpoch(_sorted(id));

        // tierAlloc = 7000e18 * 1000/10000 = 700e18
        // userShare = 700e18 (sole holder)
        // fee       = 700e18 * 200/10000  = 14e18
        // payout    = 686e18
        vm.prank(alice);
        rewards.claim(id, 1);
        assertEq(token.balanceOf(alice), 686e18);
    }

    function test_claim_marks_as_claimed() public {
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));
        vm.prank(alice);
        rewards.claim(id, 1);
        assertTrue(rewards.claimed(id, 1));
    }

    function test_claim_emits_event() public {
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit RewardsDistributor.RewardClaimed(id, 1, 686e18);
        rewards.claim(id, 1);
    }

    function test_claim_fee_routed_to_ops() public {
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));

        uint256 opsBefore = token.balanceOf(opsWallet);
        vm.prank(alice);
        rewards.claim(id, 1);
        // fee = 14e18
        assertEq(token.balanceOf(opsWallet) - opsBefore, 14e18);
    }

    function test_claim_pro_rata_by_reputation() public {
        // Alice 3000, Bob 1000 — both Bronze
        uint256 aliceId = _mintWithRep(alice, 3_000);
        uint256 bobId   = _mintWithRep(bob,   1_000);
        _deposit(10_000e18); // 7000e18 pool

        _closeEpoch(_sorted(aliceId, bobId));

        // tierAlloc = 700e18, tierTotalRep = 4000
        // aliceShare = 700e18 * 3000/4000 = 525e18 → payout = 525e18 * 9800/10000 = 514.5e18
        // bobShare   = 700e18 * 1000/4000 = 175e18 → payout = 175e18 * 9800/10000 = 171.5e18
        uint256 expAlice = (525e18 * (10_000 - 200)) / 10_000;
        uint256 expBob   = (175e18 * (10_000 - 200)) / 10_000;

        vm.prank(alice);
        rewards.claim(aliceId, 1);
        vm.prank(bob);
        rewards.claim(bobId, 1);

        assertEq(token.balanceOf(alice), expAlice);
        assertEq(token.balanceOf(bob),   expBob);
    }

    function test_claim_different_tiers_independent() public {
        uint256 aliceId = _mintWithRep(alice, 1_000); // Bronze
        uint256 bobId   = _mintWithRep(bob,   1_000); // Gold
        vm.prank(admin);
        sbt.setTier(bobId, MembershipSBT.Tier.Gold);

        _deposit(10_000e18); // 7000e18 pool

        _closeEpoch(_sorted(aliceId, bobId));

        // Bronze alloc = 7000e18 * 1000/10000 = 700e18
        // Gold alloc   = 7000e18 * 3000/10000 = 2100e18
        uint256 expAlice = (700e18  * (10_000 - 200)) / 10_000; // 686e18
        uint256 expBob   = (2100e18 * (10_000 - 200)) / 10_000; // 2058e18

        vm.prank(alice);
        rewards.claim(aliceId, 1);
        vm.prank(bob);
        rewards.claim(bobId, 1);

        assertEq(token.balanceOf(alice), expAlice);
        assertEq(token.balanceOf(bob),   expBob);
    }

    function test_claim_not_holder_reverts() public {
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));

        vm.prank(bob); // not alice
        vm.expectRevert(RewardsDistributor.NotHolder.selector);
        rewards.claim(id, 1);
    }

    function test_claim_epoch_not_closed_reverts() public {
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18);
        // epoch 1 still open

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.EpochNotClosed.selector);
        rewards.claim(id, 1);
    }

    function test_claim_already_claimed_reverts() public {
        uint256 id = _mintWithRep(alice, 1_000);
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));

        vm.prank(alice);
        rewards.claim(id, 1);

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.AlreadyClaimed.selector);
        rewards.claim(id, 1);
    }

    function test_claim_nothing_to_claim_zero_tier_rep() public {
        // Alice has rep 0 → tierTotalRep = 0 at close
        uint256 id = _mint(alice); // rep stays 0
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.NothingToClaim.selector);
        rewards.claim(id, 1);
    }

    function test_claim_nothing_to_claim_zero_user_rep() public {
        // Alice rep=0, Bob rep=1000 — tierTotal>0 but alice's share=0
        uint256 aliceId = _mint(alice);           // rep = 0
        uint256 bobId   = _mintWithRep(bob, 1_000);
        _deposit(10_000e18);
        _closeEpoch(_sorted(aliceId, bobId));

        vm.prank(alice);
        vm.expectRevert(RewardsDistributor.NothingToClaim.selector);
        rewards.claim(aliceId, 1);
    }

    // ── Tier bps snapshot isolation ──────────────────────────────────────────

    function test_claim_uses_tier_bps_snapshot_not_live_value() public {
        // Set Gold to 5000 bps BEFORE close
        vm.prank(admin);
        rewards.setTierBps(MembershipSBT.Tier.Gold, 5_000);

        uint256 id = _mintWithRep(alice, 1_000);
        vm.prank(admin);
        sbt.setTier(id, MembershipSBT.Tier.Gold);

        _deposit(10_000e18); // 7000e18 pool
        _closeEpoch(_sorted(id)); // snapshot: Gold=5000

        // Change tier bps AFTER close — claim must ignore this
        vm.prank(admin);
        rewards.setTierBps(MembershipSBT.Tier.Gold, 100);

        // tierAlloc = 7000e18 * 5000/10000 = 3500e18
        // userShare = 3500e18 (sole holder)
        // payout    = 3500e18 * 9800/10000 = 3430e18
        uint256 expected = (3500e18 * (10_000 - 200)) / 10_000;
        vm.prank(alice);
        rewards.claim(id, 1);
        assertEq(token.balanceOf(alice), expected);
    }

    // ── Multi-epoch ──────────────────────────────────────────────────────────

    function test_multi_epoch_claims_are_independent() public {
        uint256 id = _mintWithRep(alice, 1_000);

        // Epoch 1: deposit 10k → 7k pool
        _deposit(10_000e18);
        _closeEpoch(_sorted(id));

        // Epoch 2: deposit 20k → 14k pool
        _deposit(20_000e18);
        _closeEpoch(_sorted(id));

        // Bronze sole holder in both epochs
        // ep1 payout = 700e18 * 9800/10000 = 686e18
        // ep2 payout = 1400e18 * 9800/10000 = 1372e18
        vm.prank(alice);
        rewards.claim(id, 1);
        assertEq(token.balanceOf(alice), 686e18);

        vm.prank(alice);
        rewards.claim(id, 2);
        assertEq(token.balanceOf(alice), 686e18 + 1372e18);
    }

    // ── Config ───────────────────────────────────────────────────────────────

    function test_setTreasurySplit_invalid_sum_reverts() public {
        vm.prank(admin);
        vm.expectRevert(RewardsDistributor.InvalidConfig.selector);
        rewards.setTreasurySplit(5_000, 2_000, 1_000); // 8000 ≠ 10000
    }

    function test_setTreasurySplit_exact_bps_succeeds() public {
        vm.prank(admin);
        rewards.setTreasurySplit(6_000, 3_000, 1_000); // 10000 ✓
        assertEq(rewards.rewardsBps(), 6_000);
    }

    function test_getTierBpsTotal_valid_by_default() public view {
        (uint256 total, bool valid) = rewards.getTierBpsTotal();
        assertEq(total, 10_000); // 1000+2000+3000+4000
        assertTrue(valid);
    }

    function test_getTierBpsTotal_invalid_when_over_bps() public {
        vm.prank(admin);
        rewards.setTierBps(MembershipSBT.Tier.Gold, 9_000);
        (, bool valid) = rewards.getTierBpsTotal();
        assertFalse(valid);
    }

    function test_setReputation_emits_event() public {
        uint256 id = _mint(alice);
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit RewardsDistributor.ReputationUpdated(id, 500);
        rewards.setReputation(id, 500);
    }

    function test_implementation_init_blocked() public {
        RewardsDistributor impl = new RewardsDistributor();
        vm.expectRevert();
        impl.initialize(admin, sbt, token, opsWallet, burnSink, 7 days);
    }
}

// ============================================================
//  v2 SBT integration — markClaimed called on claim
// ============================================================
contract RewardsV2IntegrationTest is Test {
    MembershipSBTv2 internal sbt;
    RewardsDistributor internal rewards;
    MockToken internal token;

    address internal admin    = makeAddr("admin");
    address internal opsWallet = makeAddr("ops");
    address internal burnSink  = makeAddr("burn");
    address internal treasury  = makeAddr("treasury");
    address internal alice     = makeAddr("alice");

    function setUp() public {
        token = new MockToken();

        // ── Deploy v1 SBT ────────────────────────────────────────────────────
        MembershipSBT sbtImpl = new MembershipSBT();
        ERC1967Proxy sbtProxy = new ERC1967Proxy(
            address(sbtImpl),
            abi.encodeCall(MembershipSBT.initialize, (admin, ""))
        );

        // ── Deploy rewards (points at v1 SBT for now) ────────────────────────
        RewardsDistributor rImpl = new RewardsDistributor();
        rewards = RewardsDistributor(address(new ERC1967Proxy(
            address(rImpl),
            abi.encodeCall(RewardsDistributor.initialize,
                (admin, MembershipSBT(address(sbtProxy)), token, opsWallet, burnSink, 1 days))
        )));

        // ── Upgrade SBT to v2, granting DISTRIBUTOR_ROLE to rewards ─────────
        MembershipSBTv2 v2Impl = new MembershipSBTv2();
        vm.prank(admin);
        UUPSUpgradeable(address(sbtProxy)).upgradeToAndCall(
            address(v2Impl),
            abi.encodeCall(MembershipSBTv2.initializeV2, (admin, address(rewards)))
        );
        sbt = MembershipSBTv2(address(sbtProxy));

        // ── Wire rewards to use v2 features ─────────────────────────────────
        vm.startPrank(admin);
        rewards.grantRole(rewards.DEPOSITOR_ROLE(), treasury);
        rewards.grantRole(rewards.EPOCH_CLOSER_ROLE(), admin);
        rewards.setSbtIsV2(true);
        vm.stopPrank();
    }

    function test_claim_calls_markClaimed_on_sbt_v2() public {
        // Mint alice via upgraded v2 (admin still has MINTER_ROLE from v1 storage)
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(admin);
        rewards.setReputation(id, 1_000);

        token.mint(treasury, 10_000e18);
        vm.startPrank(treasury);
        token.approve(address(rewards), 10_000e18);
        rewards.deposit(10_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(admin);
        rewards.closeEpoch(ids);

        assertEq(sbt.lastClaimedEpoch(id), 0); // not yet claimed

        vm.prank(alice);
        rewards.claim(id, 1);

        assertEq(sbt.lastClaimedEpoch(id), 1); // updated by markClaimed
    }

    function test_claim_without_v2_flag_does_not_call_markClaimed() public {
        // Disable v2 mode — markClaimed should NOT be called
        vm.prank(admin);
        rewards.setSbtIsV2(false);

        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(admin);
        rewards.setReputation(id, 1_000);

        token.mint(treasury, 10_000e18);
        vm.startPrank(treasury);
        token.approve(address(rewards), 10_000e18);
        rewards.deposit(10_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(admin);
        rewards.closeEpoch(ids);

        vm.prank(alice);
        rewards.claim(id, 1);

        // lastClaimedEpoch stays 0 because markClaimed was not called
        assertEq(sbt.lastClaimedEpoch(id), 0);
    }
}
