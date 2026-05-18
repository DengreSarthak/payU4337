// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint, PackedUserOperation} from "./interfaces/IEntryPoint.sol";

/// @title SmartAccount
/// @notice Minimal ERC-4337 smart account. Single owner, ECDSA signature.
contract SmartAccount {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    IEntryPoint public immutable entryPoint;
    address public owner;
    uint256 public nonce;

    event Executed(address indexed to, uint256 value, bytes data);

    error OnlyEntryPoint();
    error BadSignature();
    error CallFailed();

    constructor(IEntryPoint _entryPoint, address _owner) {
        entryPoint = _entryPoint;
        owner = _owner;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external onlyEntryPoint returns (uint256 validationData) {
        bytes32 digest = userOpHash.toEthSignedMessageHash();
        (address recovered, ECDSA.RecoverError error, ) = digest.tryRecover(userOp.signature);
        if (error != ECDSA.RecoverError.NoError || recovered != owner) {
            return 1;
        }

        if (missingAccountFunds > 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok); // ignore — EntryPoint will revert if insufficient
        }
        return 0;
    }

    function execute(address to, uint256 value, bytes calldata data) external onlyEntryPoint {
        nonce++;
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert CallFailed();
        }
        emit Executed(to, value, data);
    }

    receive() external payable {}
}
