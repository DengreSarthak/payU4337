// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISafe {
    enum Operation { Call, DelegateCall }
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    ) external returns (bool success);
    function isOwner(address owner) external view returns (bool);
}

interface IMembershipSBTReader {
    enum Tier { Bronze, Silver, Gold, Platinum }
    function tierOfHolder(address holder) external view returns (Tier);
}

/// @title TierPayoutModule
/// @notice Safe module: lets an off-chain operator request a payout from the treasury Safe
///         to any address, provided the recipient holds an SBT of the required tier.
contract TierPayoutModule {
    ISafe public immutable safe;
    IMembershipSBTReader public immutable sbt;
    address public operator;

    mapping(IMembershipSBTReader.Tier => uint256) public maxPayoutByTier;
    mapping(address => bool) public whitelistedTargets;
    mapping(address => mapping(bytes4 => bool)) public allowedSelectors;

    event Payout(address indexed to, address indexed token, uint256 amount);
    event TargetWhitelisted(address indexed target, bool whitelisted);
    event SelectorAllowed(address indexed target, bytes4 selector, bool allowed);

    error OnlyOperator();
    error OnlySafe();
    error NotEligible();
    error OverTierMax();
    error CallFailed();
    error UnwhitelistedTarget();
    error DisallowedSelector();

    constructor(ISafe _safe, IMembershipSBTReader _sbt, address _operator) {
        safe = _safe;
        sbt = _sbt;
        operator = _operator;

        maxPayoutByTier[IMembershipSBTReader.Tier.Bronze]   = 100e18;
        maxPayoutByTier[IMembershipSBTReader.Tier.Silver]   = 500e18;
        maxPayoutByTier[IMembershipSBTReader.Tier.Gold]     = 2_000e18;
        maxPayoutByTier[IMembershipSBTReader.Tier.Platinum] = 10_000e18;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    /// @notice Update payout caps. Only the Safe itself can change these.
    function setMaxPayout(IMembershipSBTReader.Tier t, uint256 cap) external {
        if (msg.sender != address(safe)) revert OnlySafe();
        maxPayoutByTier[t] = cap;
    }

    function setOperator(address newOperator) external {
        if (msg.sender != address(safe)) revert OnlySafe();
        operator = newOperator;
    }

    function setWhitelistedTarget(address target, bool allowed) external {
        if (msg.sender != address(safe)) revert OnlySafe();
        whitelistedTargets[target] = allowed;
        emit TargetWhitelisted(target, allowed);
    }

    function setAllowedSelector(address target, bytes4 selector, bool allowed) external {
        if (msg.sender != address(safe)) revert OnlySafe();
        allowedSelectors[target][selector] = allowed;
        emit SelectorAllowed(target, selector, allowed);
    }

    /// @notice Pay `amount` of `token` to `to` from the Safe.
    /// @dev    Operator-gated. Recipient must hold an SBT; amount must not exceed tier max.
    function payout(address token, address to, uint256 amount) external onlyOperator {
        IMembershipSBTReader.Tier tier = sbt.tierOfHolder(to);
        if (amount > maxPayoutByTier[tier]) revert OverTierMax();

        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", to, amount);
        bool ok = safe.execTransactionFromModule(token, 0, data, ISafe.Operation.Call);
        if (!ok) revert CallFailed();

        emit Payout(to, token, amount);
    }

    /// @notice Execute whitelisted Safe call. Target and selector must be pre-approved.
    /// @dev    Operator can only call Safe-whitelisted targets with pre-approved selectors.
    function execFromSafe(address target, uint256 value, bytes calldata data)
        external
        onlyOperator
        returns (bool ok)
    {
        if (!whitelistedTargets[target]) revert UnwhitelistedTarget();
        if (data.length >= 4) {
            bytes4 selector = bytes4(data[:4]);
            if (!allowedSelectors[target][selector]) revert DisallowedSelector();
        }
        ok = safe.execTransactionFromModule(target, value, data, ISafe.Operation.Call);
        if (!ok) revert CallFailed();
    }
}
