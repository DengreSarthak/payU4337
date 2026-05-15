// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MembershipSBT} from "../src/MembershipSBT.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

contract RewardsTest is Test {
    MembershipSBT internal sbt;
    RewardsDistributor internal rewards;
    MockToken internal token;

    address internal admin = makeAddr("admin");
    address internal opsWallet = makeAddr("ops");
    address internal burnSink = makeAddr("burn");
    address internal treasury = makeAddr("treasury");

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        // SBT
        MembershipSBT sbtImpl = new MembershipSBT();
        sbt = MembershipSBT(
            address(new ERC1967Proxy(address(sbtImpl), abi.encodeCall(MembershipSBT.initialize, (admin, ""))))
        );

        // Token
        token = new MockToken();

        // Rewards
        RewardsDistributor rImpl = new RewardsDistributor();
        rewards = RewardsDistributor(
            address(new ERC1967Proxy(
                address(rImpl),
                abi.encodeCall(
                    RewardsDistributor.initialize,
                    (admin, sbt, token, opsWallet, burnSink, 7 days)
                )
            ))
        );

        vm.prank(admin);
        rewards.grantRole(rewards.DEPOSITOR_ROLE(), treasury);
    }

    function test_deposit_splits_per_layer_1() public {
        token.mint(treasury, 1_000_000e18);
        vm.startPrank(treasury);
        token.approve(address(rewards), 1_000_000e18);
        rewards.deposit(1_000_000e18);
        vm.stopPrank();

        // TODO(candidate): assert the layer-1 split is correct AND the contract holds nothing extra.
        // (hint: check the contract balance is exactly the rewards-pool portion. Is it?)
    }

    // TODO(candidate): write an invariant test for the rewards distributor:
    //   forall random sequences of deposit / closeEpoch / claim:
    //     sum(amountPaidToHolders) + sum(amountPaidToOps) + sum(amountPaidToBurn) + dust == sum(amountDeposited)
    //     dust < epochCount
    // Tip: use Foundry's invariant testing or Echidna. Read the rewards math carefully first.
}
