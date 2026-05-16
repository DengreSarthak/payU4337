// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/// @title MembershipSBT v2 — adds per-holder lastClaimedEpoch tracking + admin revoke
/// @dev Upgrade target for v1. Candidate must verify storage layout safety before deploying.
contract MembershipSBTv2 is
    Initializable,
    ERC721Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant TIER_MANAGER_ROLE = keccak256("TIER_MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    enum Tier {
        Bronze,
        Silver,
        Gold,
        Platinum
    }

    // ---- storage ----------------------------------------------------------
    /// @dev Layout is identical to v1 for existing vars, with new lastClaimedEpoch mapping added at the end to preserve layout safety.
    uint256 public nextTokenId;
    mapping(uint256 => Tier) public tierOf;
    mapping(address => uint256) public tokenIdOf;
    string private _baseTokenURI;
    mapping(uint256 => uint256) public lastClaimedEpoch; // slot 4, Added in v2

    uint256[45] private __gap;
    // -----------------------------------------------------------------------

    event Minted(address indexed to, uint256 indexed tokenId, Tier tier);
    event TierChanged(uint256 indexed tokenId, Tier oldTier, Tier newTier);
    event Revoked(address indexed holder, uint256 indexed tokenId);
    event Claimed(uint256 indexed tokenId, uint256 indexed epoch);

    error AlreadyMember();
    error SoulboundTransferDisabled();
    error NotMember();

    /// @notice Called once on upgrade to initialize v2-only state.
    function initializeV2(address revoker, address distributor) external reinitializer(2) {
        _grantRole(REVOKER_ROLE, revoker);
        _grantRole(DISTRIBUTOR_ROLE, distributor);
    }

    function mint(address to) external onlyRole(MINTER_ROLE) returns (uint256 id) {
        if (tokenIdOf[to] != 0) revert AlreadyMember();
        id = nextTokenId++;
        tokenIdOf[to] = id;
        tierOf[id] = Tier.Bronze;
        _safeMint(to, id);
        emit Minted(to, id, Tier.Bronze);
    }

    function setTier(uint256 tokenId, Tier newTier) external onlyRole(TIER_MANAGER_ROLE) {
        Tier oldTier = tierOf[tokenId];
        tierOf[tokenId] = newTier;
        emit TierChanged(tokenId, oldTier, newTier);
    }

    /// @notice Admin revoke. Burns the SBT and clears membership so the address can re-mint.
    function revoke(address holder) external onlyRole(REVOKER_ROLE) {
        uint256 id = tokenIdOf[holder];
        if (id == 0) revert NotMember();
        delete tokenIdOf[holder];
        _burn(id);
        emit Revoked(holder, id);
    }

    /// @notice Called by RewardsDistributor when a holder claims an epoch.
    function markClaimed(uint256 tokenId, uint256 epoch) external onlyRole(DISTRIBUTOR_ROLE) {
        lastClaimedEpoch[tokenId] = epoch;
        emit Claimed(tokenId, epoch);
    }

    function tierOfHolder(address holder) external view returns (Tier) {
        uint256 id = tokenIdOf[holder];
        if (id == 0) revert NotMember();
        return tierOf[id];
    }

    // ---- soulbound enforcement --------------------------------------------

    function transferFrom(address, address, uint256) public pure override {
        revert SoulboundTransferDisabled();
    }

    function approve(address, uint256) public pure override {
        revert SoulboundTransferDisabled();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert SoulboundTransferDisabled();
    }

    // ---- upgrades ---------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function supportsInterface(bytes4 id)
        public
        view
        override(ERC721Upgradeable, AccessControlUpgradeable)
        returns (bool)
    {
        return super.supportsInterface(id);
    }
}
