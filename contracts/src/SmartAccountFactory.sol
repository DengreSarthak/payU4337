// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {SmartAccount} from "./SmartAccount.sol";
import {IEntryPoint} from "./interfaces/IEntryPoint.sol";

/// @title SmartAccountFactory
/// @notice CREATE2 factory for SmartAccount. Deterministic by owner + salt.
contract SmartAccountFactory {
    IEntryPoint public immutable entryPoint;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint _entryPoint) {
        entryPoint = _entryPoint;
    }

    function createAccount(address owner, uint256 salt) external returns (address account) {
        account = getAddress(owner, salt);
        if (account.code.length > 0) return account;

        account = address(new SmartAccount{salt: bytes32(salt)}(entryPoint, owner));
        emit AccountCreated(account, owner, salt);
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        bytes memory bytecode = abi.encodePacked(
            type(SmartAccount).creationCode,
            abi.encode(entryPoint, owner)
        );
        return Create2.computeAddress(bytes32(salt), keccak256(bytecode));
    }
}
