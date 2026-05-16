// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/// @title MembershipSBT — non-transferable membership token
/// @notice Each address can hold at most one SBT. Tier is mutable; ownership is not.
contract MembershipSBT is
    Initializable,
    ERC721Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant TIER_MANAGER_ROLE = keccak256("TIER_MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    enum Tier {
        Bronze,
        Silver,
        Gold,
        Platinum
    }

    // ---- storage (DO NOT REORDER) -----------------------------------------
    uint256 public nextTokenId;                       // slot 0
    mapping(uint256 => Tier) public tierOf;           // slot 1
    mapping(address => uint256) public tokenIdOf;     // slot 2
    string private _baseTokenURI;                     // slot 3

    uint256[46] private __gap;
    // -----------------------------------------------------------------------

    event Minted(address indexed to, uint256 indexed tokenId, Tier tier);
    event TierChanged(uint256 indexed tokenId, Tier oldTier, Tier newTier);

    error AlreadyMember();
    error SoulboundTransferDisabled();
    error NotMember();

    function initialize(address admin, string memory baseURI) external initializer {
        __ERC721_init("Member SBT", "MSBT");
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(TIER_MANAGER_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        _baseTokenURI = baseURI;
        nextTokenId = 1;
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

    function tierOfHolder(address holder) external view returns (Tier) {
        uint256 id = tokenIdOf[holder];
        if (id == 0) revert NotMember();
        return tierOf[id];
    }

    // ---- soulbound enforcement --------------------------------------------

    function transferFrom(address, address, uint256) public pure override {
        revert SoulboundTransferDisabled();
    }

    function safeTransferFrom(address, address, uint256, bytes memory) public pure override {
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
