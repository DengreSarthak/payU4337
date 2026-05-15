// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MembershipSBT} from "../src/MembershipSBT.sol";
import {RewardsDistributor} from "../src/RewardsDistributor.sol";
import {SmartAccountFactory} from "../src/SmartAccountFactory.sol";
import {MembershipPaymaster} from "../src/MembershipPaymaster.sol";
import {IEntryPoint} from "../src/interfaces/IEntryPoint.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Reference deployment script. Wire it up — the previous engineer did not finish.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_KEY");
        address admin = vm.envAddress("ADMIN");
        address entryPoint = vm.envAddress("ENTRYPOINT");
        address rewardToken = vm.envAddress("REWARD_TOKEN");
        address opsWallet = vm.envAddress("OPS_WALLET");
        address burnSink = vm.envAddress("BURN_SINK");
        address paymasterSigner = vm.envAddress("PAYMASTER_SIGNER");

        vm.startBroadcast(pk);

        // 1. MembershipSBT (UUPS)
        MembershipSBT sbtImpl = new MembershipSBT();
        bytes memory sbtInit = abi.encodeCall(
            MembershipSBT.initialize, (admin, "https://api.example.com/sbt/")
        );
        ERC1967Proxy sbtProxy = new ERC1967Proxy(address(sbtImpl), sbtInit);
        MembershipSBT sbt = MembershipSBT(address(sbtProxy));

        // 2. RewardsDistributor (UUPS)
        RewardsDistributor rdImpl = new RewardsDistributor();
        bytes memory rdInit = abi.encodeCall(
            RewardsDistributor.initialize,
            (admin, sbt, IERC20(rewardToken), opsWallet, burnSink, 7 days)
        );
        ERC1967Proxy rdProxy = new ERC1967Proxy(address(rdImpl), rdInit);
        RewardsDistributor rd = RewardsDistributor(address(rdProxy));

        // 3. Account abstraction
        SmartAccountFactory factory = new SmartAccountFactory(IEntryPoint(entryPoint));
        uint256 paymasterDailyCap = vm.envOr("PAYMASTER_DAILY_CAP_WEI", uint256(0.5 ether));
        MembershipPaymaster paymaster =
            new MembershipPaymaster(IEntryPoint(entryPoint), paymasterSigner, paymasterDailyCap);

        vm.stopBroadcast();

        console2.log("SBT proxy:           ", address(sbt));
        console2.log("RewardsDistributor:  ", address(rd));
        console2.log("Factory:             ", address(factory));
        console2.log("Paymaster:           ", address(paymaster));
    }
}
