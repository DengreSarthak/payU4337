// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint, IPaymaster, PackedUserOperation} from "./interfaces/IEntryPoint.sol";

/// @title MembershipPaymaster
/// @notice Sponsors gas for first-time mints + claims under a daily cap.
/// @dev    Signer is an off-chain service that approves a UserOp by signing
///         (sender, nonce) — the paymaster verifies the signature.
contract MembershipPaymaster is IPaymaster, Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    IEntryPoint public immutable entryPoint;
    address public signer;

    uint256 public dailyCapWei;
    mapping(address => mapping(uint256 => uint256)) public spentOnDay; // sender => day => wei

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event DailyCapUpdated(uint256 newCap);

    error OnlyEntryPoint();
    error BadSignature();
    error OverDailyCap();

    constructor(IEntryPoint _entryPoint, address _signer, uint256 _dailyCap) Ownable(msg.sender) {
        entryPoint = _entryPoint;
        signer = _signer;
        dailyCapWei = _dailyCap;
    }

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert OnlyEntryPoint();
        _;
    }

    function setSigner(address newSigner) external onlyOwner {
        emit SignerUpdated(signer, newSigner);
        signer = newSigner;
    }

    function setDailyCap(uint256 newCap) external onlyOwner {
        dailyCapWei = newCap;
        emit DailyCapUpdated(newCap);
    }

    /// @notice EntryPoint hook. Validates the off-chain sponsorship signature.
    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 maxCost
    ) external view onlyEntryPoint returns (bytes memory context, uint256 validationData) {
        // paymasterAndData layout: [paymaster (20)] [paymasterVerificationGasLimit (16)]
        //                          [paymasterPostOpGasLimit (16)] [signature (65)]
        bytes calldata sig = userOp.paymasterAndData[52:];

        bytes32 digest = keccak256(abi.encode(userOp.sender, userOp.nonce)).toEthSignedMessageHash();
        address recovered = digest.recover(sig);
        if (recovered != signer) revert BadSignature();

        uint256 day = block.timestamp / 1 days;
        if (spentOnDay[userOp.sender][day] + maxCost > dailyCapWei) revert OverDailyCap();

        context = abi.encode(userOp.sender, maxCost, day);
        validationData = 0;
    }

    function postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /* actualUserOpFeePerGas */
    ) external onlyEntryPoint {
        (address sender, /* uint256 maxCost */, uint256 day) = abi.decode(context, (address, uint256, uint256));
        spentOnDay[sender][day] += actualGasCost;
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    receive() external payable {}
}
