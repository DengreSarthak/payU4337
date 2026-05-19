Critical - Which questions the protocol's core functionality

High - Which make the protocol not work as expected

Meddium - Which make the protocol not work as expected but can be worked around

Low - Which are nice to have but not medium priority


Contracts - RewardDistribution
- uint256 userShare = (tierAlloc * reputationOf[tokenId]) / tierTotal;  ---- Changed to floor - Critical
- fixed calculation mismatch to 1000 and added validateTressury split - High
- fixed closeEpoch function - added onlyrole and a check for 7 days - High
- Design options - 1. add seperate function for validating bps or 2. ask the all 4 teir from user.( just not so user friendly, that's why skiping this. ) - Low
- tierBpsSnapshot for adding snapshot - Low
- Added checks for duplicate tokenids, removing to trust EPOCH_closer_role, design drawback, - Medium
-  Should change config_role to add a reputation_role which can change reputation - Low

MembershipSBT.sol

- Removed UUPSUpgradableInit as it was removed from v5 - Critical
- Added safeTransferFrom to fully restrict the transfers - Critical

MemborshipSBTv2.sol

- Removed UUPSUpgradableInit as it was removed from v5 - Critical
- Improved the ordering of the variable to prevent storage corruption - Critical
- Added distributor role in initializeV2 for markedClaim - Critical
- Improved revoke function for re-minting - Depends on protocol - Critical/High


Backend


- Reorg safety: store block_number and block_hash in cursor; verify hash before each tick; rewind on reorg; wrap entire tick in DB transaction so crash mid-tick rolls back — no partial state - Critical
- Fixed known race: previously events written outside a transaction caused reputation to inflate by +10 on every restart when claim insert was skipped by ON CONFLICT but the UPDATE still ran - High
- Handled chicken-egg problem in claim, claim.ts — Added claimDigest() helper, signature verification via verifyMessage against smart account owner(), and fixed membership query to check LOWER(address) = LOWER($2) - Critical
- indexer.ts — onClaim fetches reputationOf(tokenId, {blockTag: blockNumber}) at exact claim block and stores it in reputation_snapshot; falls back to "0" if node doesn't support archive calls - High
- server.ts — Added Zod ClaimReqSchema (validates address format, tokenId/epoch presence, signature prefix); validates before handleClaim; returns 400 on bad input - High
- migrations/004_fix_reputation_snapshot.sql — Adds reputation_snapshot with IF NOT EXISTS DEFAULT 0 (safe on empty and populated DBs); adds unique index on tier_history(token_id, tx_hash) for idempotent inserts - High
- indexer.ts — Added REORG_BUFFER = 1; indexer targets head - 1 as safe ceiling, never raw tip (raise to 12+ for mainnet) - Medium
- indexer.ts — onTierChange now also inserts into tier_history (idempotent via unique index in migration 004) - Medium
- indexer.ts — Added reputationOf to REWARDS_ABI so contract can be called for reads - Medium
- claim.ts / server.ts — Fixed membership query to use LOWER(address) comparison for case-insensitive matching - Medium
- indexer.ts — Exported SBT_ABI and REWARDS_ABI so server.ts can share definitions without duplication - Low
- userop.ts — Added keccak256 to ethers named import, removed keccak() wrapper that used CommonJS require - Low
- tenderly.ts — Removed import fetch from "node-fetch"; Node 20's global fetch is used automatically - Low
- server.ts — Imports SBT_ABI/REWARDS_ABI from indexer instead of duplicating them - Low


Transaction

Two things i wanted you to tell,

1. I haven't done anything realted to tenderly, it was pretty new to me. I have tested mint, tier, close, reputation, claim, deposit, every function on scroll sepolia network. Pretty sure, it will work on mainnet too.

2. I have changed the epoch window to 5 min instead of 7 days, for you to also test it. My solidity tests are passing with 7 days window also.

Loom video for above transaction - ( forget to give full window access in the video, that's why when i was saying about backend catching events it was still showing the website. Sorry, attached the screenshot of the backend catching events)

https://www.loom.com/share/88e20d469b1f4b87972e488aeb693a95

You have to run backend locally to see the events being caught, and postgress. Trying to deploy vercel giving some ip whilisting error, ipv6 and ipv4 related but fixed it still having some issues.

So, npm i && cd backend && npm run dev

Live link - https://we-see-frontend.vercel.app/. ( event getting caught on locally run backend for now )

if you want to play around, i made a demo account with all the permissions, try minting for another wallet, change tier, and claim. 

It's address - 0x0F2a7B637Cffd69C1142666bCf3671F3304Ee0D0
It's private key - 0x14dc9545564436e346aa4276575caf9b0607ff0ed2a6e33c842d305053f3fc55

minting - https://sepolia.scrollscan.com/op/0x74dc10dbd4d4e8b391afe358ce5e9afa728956abfc4f3cb0f20e5f99db179b35
Claiming - https://sepolia.scrollscan.com/op/0xded40ed63564f029635653c7a95d1186dff50cb75828d550abdfef052b7a49b1

tokenId 1 - minted and claimed on V1
tokendId 2 and 3 - minted and claimed on V2. Preserving everything.

First mint -> tier -> epoch -> claim.  ( 3rd, 11, 21, last 3rd)

<img src="EventsCatchBackend.png" alt="Events Catch Backend" width="800" />

Attaching database entry

<img src="PostgressEntry.png" alt="Events Catch Backend" width="800" />


<img src="forgeTest.png" alt="Events Catch Backend" width="800" />


<img src="backendTest.png" alt="Events Catch Backend" width="800" />
