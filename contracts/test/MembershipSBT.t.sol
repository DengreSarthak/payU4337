// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {MembershipSBT} from "../src/MembershipSBT.sol";
import {MembershipSBTv2} from "../src/MembershipSBTv2.sol";

// ============================================================
//  v1 tests
// ============================================================
contract MembershipSBTTest is Test {
    MembershipSBT internal sbt;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        MembershipSBT impl = new MembershipSBT();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(MembershipSBT.initialize, (admin, "ipfs://test/"))
        );
        sbt = MembershipSBT(address(proxy));
    }

    // ── Minting ──────────────────────────────────────────────────────────────

    function test_mint_succeeds() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        assertEq(sbt.ownerOf(id), alice);
    }

    function test_mint_assigns_bronze_tier() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        assertEq(uint256(sbt.tierOf(id)), uint256(MembershipSBT.Tier.Bronze));
    }

    function test_mint_records_tokenIdOf() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        assertEq(sbt.tokenIdOf(alice), id);
    }

    function test_mint_increments_nextTokenId() public {
        assertEq(sbt.nextTokenId(), 1);
        vm.prank(admin);
        sbt.mint(alice);
        assertEq(sbt.nextTokenId(), 2);
    }

    function test_mint_emits_event() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit MembershipSBT.Minted(alice, 1, MembershipSBT.Tier.Bronze);
        sbt.mint(alice);
    }

    function test_mint_rejects_duplicate() public {
        vm.startPrank(admin);
        sbt.mint(alice);
        vm.expectRevert(MembershipSBT.AlreadyMember.selector);
        sbt.mint(alice);
        vm.stopPrank();
    }

    function test_mint_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        sbt.mint(bob);
    }

    // ── Tier management ──────────────────────────────────────────────────────

    function test_setTier_succeeds() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(admin);
        sbt.setTier(id, MembershipSBT.Tier.Gold);
        assertEq(uint256(sbt.tierOf(id)), uint256(MembershipSBT.Tier.Gold));
    }

    function test_setTier_emits_event() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(admin);
        vm.expectEmit(true, false, false, true);
        emit MembershipSBT.TierChanged(id, MembershipSBT.Tier.Bronze, MembershipSBT.Tier.Gold);
        sbt.setTier(id, MembershipSBT.Tier.Gold);
    }

    function test_setTier_unauthorized_reverts() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(alice);
        vm.expectRevert();
        sbt.setTier(id, MembershipSBT.Tier.Gold);
    }

    function test_tierOfHolder_returns_current_tier() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(admin);
        sbt.setTier(id, MembershipSBT.Tier.Platinum);
        assertEq(uint256(sbt.tierOfHolder(alice)), uint256(MembershipSBT.Tier.Platinum));
    }

    function test_tierOfHolder_non_member_reverts() public {
        vm.expectRevert(MembershipSBT.NotMember.selector);
        sbt.tierOfHolder(alice);
    }

    // ── Soulbound enforcement ─────────────────────────────────────────────────

    function test_transferFrom_blocked() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(alice);
        vm.expectRevert(MembershipSBT.SoulboundTransferDisabled.selector);
        sbt.transferFrom(alice, bob, id);
    }

    function test_safeTransferFrom_4arg_blocked() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(alice);
        vm.expectRevert(MembershipSBT.SoulboundTransferDisabled.selector);
        sbt.safeTransferFrom(alice, bob, id, "");
    }

    function test_safeTransferFrom_3arg_blocked() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(alice);
        vm.expectRevert(MembershipSBT.SoulboundTransferDisabled.selector);
        sbt.safeTransferFrom(alice, bob, id);
    }

    function test_approve_blocked() public {
        vm.prank(admin);
        sbt.mint(alice);
        vm.prank(alice);
        vm.expectRevert(MembershipSBT.SoulboundTransferDisabled.selector);
        sbt.approve(bob, 1);
    }

    function test_setApprovalForAll_blocked() public {
        vm.prank(alice);
        vm.expectRevert(MembershipSBT.SoulboundTransferDisabled.selector);
        sbt.setApprovalForAll(bob, true);
    }

    // ── UUPS / upgrade guards ─────────────────────────────────────────────────

    function test_implementation_init_blocked() public {
        // Constructor calls _disableInitializers(), so the impl is not initializable.
        MembershipSBT impl = new MembershipSBT();
        vm.expectRevert();
        impl.initialize(admin, "ipfs://");
    }

    function test_upgrade_requires_upgrader_role() public {
        MembershipSBTv2 v2Impl = new MembershipSBTv2();
        vm.prank(alice); // no UPGRADER_ROLE
        vm.expectRevert();
        UUPSUpgradeable(address(sbt)).upgradeToAndCall(
            address(v2Impl),
            abi.encodeCall(MembershipSBTv2.initializeV2, (admin, admin))
        );
    }

    // ── supportsInterface ────────────────────────────────────────────────────

    function test_supportsInterface_erc721() public view {
        assertTrue(sbt.supportsInterface(0x80ac58cd)); // ERC721
    }

    function test_supportsInterface_accessControl() public view {
        assertTrue(sbt.supportsInterface(0x7965db0b)); // AccessControl
    }
}

// ============================================================
//  v1 → v2 upgrade tests
// ============================================================
contract MembershipSBTUpgradeTest is Test {
    MembershipSBT internal sbtV1;
    MembershipSBTv2 internal sbtV2;

    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    uint256 internal aliceId;
    uint256 internal bobId;

    function setUp() public {
        // ── Deploy & initialise v1 ───────────────────────────────────────────
        MembershipSBT impl1 = new MembershipSBT();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl1),
            abi.encodeCall(MembershipSBT.initialize, (admin, "ipfs://v1/"))
        );
        sbtV1 = MembershipSBT(address(proxy));

        // ── Pre-upgrade state ────────────────────────────────────────────────
        vm.startPrank(admin);
        aliceId = sbtV1.mint(alice);
        bobId = sbtV1.mint(bob);
        sbtV1.setTier(aliceId, MembershipSBT.Tier.Gold);
        sbtV1.setTier(bobId, MembershipSBT.Tier.Silver);
        vm.stopPrank();

        // ── Upgrade to v2 ───────────────────────────────────────────────────
        MembershipSBTv2 impl2 = new MembershipSBTv2();
        vm.prank(admin);
        UUPSUpgradeable(address(proxy)).upgradeToAndCall(
            address(impl2),
            abi.encodeCall(MembershipSBTv2.initializeV2, (admin, admin))
        );
        sbtV2 = MembershipSBTv2(address(proxy));
    }

    // ── Storage layout preserved ─────────────────────────────────────────────

    function test_tokenIds_preserved_after_upgrade() public view {
        assertEq(sbtV2.tokenIdOf(alice), aliceId);
        assertEq(sbtV2.tokenIdOf(bob), bobId);
    }

    function test_tiers_preserved_after_upgrade() public view {
        assertEq(uint256(sbtV2.tierOf(aliceId)), uint256(MembershipSBTv2.Tier.Gold));
        assertEq(uint256(sbtV2.tierOf(bobId)), uint256(MembershipSBTv2.Tier.Silver));
    }

    function test_ownership_preserved_after_upgrade() public view {
        assertEq(sbtV2.ownerOf(aliceId), alice);
        assertEq(sbtV2.ownerOf(bobId), bob);
    }

    function test_nextTokenId_preserved_after_upgrade() public view {
        // Two tokens minted pre-upgrade, so nextTokenId == 3
        assertEq(sbtV2.nextTokenId(), 3);
    }

    function test_lastClaimedEpoch_initialises_to_zero() public view {
        assertEq(sbtV2.lastClaimedEpoch(aliceId), 0);
    }

    // ── Post-upgrade mint still works ────────────────────────────────────────

    function test_mint_after_upgrade() public {
        vm.prank(admin);
        uint256 id = sbtV2.mint(carol);
        assertEq(sbtV2.ownerOf(id), carol);
        assertEq(id, 3); // sequential from where v1 left off
    }

    // ── v2: revoke ───────────────────────────────────────────────────────────

    function test_revoke_burns_token() public {
        vm.prank(admin);
        sbtV2.revoke(alice);
        vm.expectRevert(); // ERC721: ownerOf on burned token
        sbtV2.ownerOf(aliceId);
    }

    function test_revoke_clears_tokenIdOf() public {
        vm.prank(admin);
        sbtV2.revoke(alice);
        assertEq(sbtV2.tokenIdOf(alice), 0);
    }

    function test_revoke_allows_remint() public {
        vm.prank(admin);
        sbtV2.revoke(alice);
        vm.prank(admin);
        uint256 newId = sbtV2.mint(alice); // must NOT revert AlreadyMember
        assertEq(sbtV2.ownerOf(newId), alice);
    }

    function test_revoke_non_member_reverts() public {
        vm.prank(admin);
        vm.expectRevert(MembershipSBTv2.NotMember.selector);
        sbtV2.revoke(carol);
    }

    function test_revoke_emits_event() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit MembershipSBTv2.Revoked(alice, aliceId);
        sbtV2.revoke(alice);
    }

    function test_revoke_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        sbtV2.revoke(bob);
    }

    // ── v2: markClaimed ──────────────────────────────────────────────────────

    function test_markClaimed_updates_lastClaimedEpoch() public {
        vm.prank(admin); // admin received DISTRIBUTOR_ROLE in initializeV2
        sbtV2.markClaimed(aliceId, 7);
        assertEq(sbtV2.lastClaimedEpoch(aliceId), 7);
    }

    function test_markClaimed_emits_event() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit MembershipSBTv2.Claimed(aliceId, 7);
        sbtV2.markClaimed(aliceId, 7);
    }

    function test_markClaimed_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        sbtV2.markClaimed(aliceId, 7);
    }

    // ── v2: soulbound still enforced ─────────────────────────────────────────

    function test_v2_transferFrom_blocked() public {
        vm.prank(alice);
        vm.expectRevert(MembershipSBTv2.SoulboundTransferDisabled.selector);
        sbtV2.transferFrom(alice, bob, aliceId);
    }

    function test_v2_safeTransferFrom_4arg_blocked() public {
        vm.prank(alice);
        vm.expectRevert(MembershipSBTv2.SoulboundTransferDisabled.selector);
        sbtV2.safeTransferFrom(alice, bob, aliceId, "");
    }

    function test_v2_safeTransferFrom_3arg_blocked() public {
        vm.prank(alice);
        vm.expectRevert(MembershipSBTv2.SoulboundTransferDisabled.selector);
        sbtV2.safeTransferFrom(alice, bob, aliceId);
    }

    function test_v2_approve_blocked() public {
        vm.prank(alice);
        vm.expectRevert(MembershipSBTv2.SoulboundTransferDisabled.selector);
        sbtV2.approve(bob, aliceId);
    }
}
