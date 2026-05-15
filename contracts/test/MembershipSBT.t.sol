// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MembershipSBT} from "../src/MembershipSBT.sol";

contract MembershipSBTTest is Test {
    MembershipSBT internal sbt;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        MembershipSBT impl = new MembershipSBT();
        bytes memory data = abi.encodeCall(MembershipSBT.initialize, (admin, "ipfs://"));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), data);
        sbt = MembershipSBT(address(proxy));
    }

    function test_mint_succeeds() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        assertEq(sbt.ownerOf(id), alice);
        assertEq(uint256(sbt.tierOf(id)), uint256(MembershipSBT.Tier.Bronze));
    }

    function test_mint_rejects_duplicate() public {
        vm.startPrank(admin);
        sbt.mint(alice);
        vm.expectRevert(MembershipSBT.AlreadyMember.selector);
        sbt.mint(alice);
        vm.stopPrank();
    }

    function test_transferFrom_is_blocked() public {
        vm.prank(admin);
        uint256 id = sbt.mint(alice);
        vm.prank(alice);
        vm.expectRevert(MembershipSBT.SoulboundTransferDisabled.selector);
        sbt.transferFrom(alice, bob, id);
    }

    // TODO(candidate): write a test that proves safeTransferFrom is ALSO blocked.
    // TODO(candidate): write a test that proves the *implementation* contract cannot be initialized directly.
    // TODO(candidate): write an upgrade test (v1 -> v2) and assert tokenId / tier of pre-existing holders survive.
}
