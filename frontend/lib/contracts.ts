import { Interface, keccak256, toUtf8Bytes } from "ethers";

export const ENTRY_POINT_ABI = ["function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)", "function balanceOf(address account) view returns (uint256)"];

export const SMART_ACCOUNT_ABI = [
  "function owner() view returns (address)",
  "function execute(address to, uint256 value, bytes data)",
];

export const SMART_ACCOUNT_FACTORY_ABI = [
  "function getAddress(address owner, uint256 salt) view returns (address)",
  "function createAccount(address owner, uint256 salt) returns (address)",
];

export const PAYMASTER_ABI = ["function deposit() payable"];

export const MEMBERSHIP_SBT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function mint(address to) returns (uint256)",
  "function tokenIdOf(address holder) view returns (uint256)",
  "function tierOf(uint256 tokenId) view returns (uint8)",
  "function tierOfHolder(address holder) view returns (uint8)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function balanceOf(address owner) view returns (uint256)",
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function setTier(uint256 tokenId, uint8 newTier)",
  "function grantRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function revoke(address holder)",
  "function markClaimed(uint256 tokenId, uint256 epoch)",
  "function lastClaimedEpoch(uint256 tokenId) view returns (uint256)",
];

export const MINTER_ROLE = keccak256(toUtf8Bytes("MINTER_ROLE"));
export const REVOKER_ROLE = keccak256(toUtf8Bytes("REVOKER_ROLE"));
export const DISTRIBUTOR_ROLE = keccak256(toUtf8Bytes("DISTRIBUTOR_ROLE"));

export const REWARDS_ABI = [
  "function currentEpoch() view returns (uint256)",
  "function currentEpochStart() view returns (uint256)",
  "function rewardsPoolAccrued() view returns (uint256)",
  "function reputationOf(uint256 tokenId) view returns (uint256)",
  "function claim(uint256 tokenId, uint256 epoch)",
  "function tierBps(uint8 tier) view returns (uint256)",
  "function claimFeeBps() view returns (uint256)",
  "function rewardsBps() view returns (uint256)",
  "function opsBps() view returns (uint256)",
  "function burnBps() view returns (uint256)",
  "function burnSink() view returns (address)",
  "function sbtIsV2() view returns (bool)",
  "function setReputation(uint256 tokenId, uint256 rep)",
  "function setTierBps(uint8 tier, uint256 bps)",
  "function setTreasurySplit(uint256 rewardsBps, uint256 opsBps, uint256 burnBps)",
  "function setBurnSink(address newSink)",
  "function setSbtIsV2(bool v)",
  "function getTierBpsTotal() view returns (uint256 total, bool valid)",
  "function getEpochTotal(uint256 epochId) view returns (uint256)",
  "function getEpochTierTotal(uint256 epochId, uint8 t) view returns (uint256)",
  "function getEpochTierBps(uint256 epochId, uint8 t) view returns (uint256)",
  "function closeEpoch(uint256[] tokenIds)",
];

export const ENTRY_POINT_IFACE = new Interface(ENTRY_POINT_ABI);
export const SMART_ACCOUNT_IFACE = new Interface(SMART_ACCOUNT_ABI);
export const SMART_ACCOUNT_FACTORY_IFACE = new Interface(SMART_ACCOUNT_FACTORY_ABI);
export const PAYMASTER_IFACE = new Interface(PAYMASTER_ABI);
export const MEMBERSHIP_SBT_IFACE = new Interface(MEMBERSHIP_SBT_ABI);
export const REWARDS_IFACE = new Interface(REWARDS_ABI);

export const TIER_NAMES = ["Bronze", "Silver", "Gold", "Platinum"] as const;

export type TierName = (typeof TIER_NAMES)[number];

export function tierNameFromValue(value: bigint | number): TierName {
  const index = Number(value);
  return TIER_NAMES[index] ?? "Bronze";
}

export function hexToBigInt(value: string | bigint | number): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  return BigInt(value);
}
