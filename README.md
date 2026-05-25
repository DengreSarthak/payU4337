# WeSee

A gasless soulbound membership platform built on ERC-4337. Users mint non-transferable membership SBTs, earn reputation across tiers, and claim pro-rata reward distributions — all without paying gas.

## What it does

- **Soulbound Membership (SBT)** — Each wallet holds one non-transferable ERC-721 membership token with a tier (Bronze, Silver, Gold, Platinum).
- **Reputation & Tiers** — Admin-managed reputation scores and tier upgrades determine reward eligibility.
- **Epoch-Based Rewards** — Every 7 days, the protocol distributes reward tokens through a 4-layer waterfall: treasury split → tier allocation → pro-rata by reputation → protocol fee.
- **Gasless UX** — All mints and claims are sponsored via an ERC-4337 paymaster. Users sign UserOperations; gas is paid from a shared deposit.

## Architecture

```
User Wallet (EOA)
    │
    │  signs UserOp or claim digest
    ▼
EntryPoint v0.7
    │
    ├─► SmartAccount (CREATE2, per user via SmartAccountFactory)
    │       validates ECDSA signature, executes calls
    │
    └─► MembershipPaymaster
            off-chain signer approves gas sponsorship
            per-user daily cap

Treasury Safe (multisig)
    │
    ▼
TierPayoutModule (Safe module)
    │  operator requests tier-gated payouts
    ▼
RewardsDistributor
    deposit()    → Layer 1 split (rewards / ops / burn)
    closeEpoch() → snapshot per-tier reputation totals
    claim()      → pro-rata payout per user
```

## Repository layout

```
contracts/
  src/
    MembershipSBT.sol        — ERC-721 SBT v1 (mint, tier, transfer lock)
    MembershipSBTv2.sol      — upgrade target (lastClaimedEpoch, revoke)
    RewardsDistributor.sol   — reward logic: deposit, closeEpoch, claim
    MembershipPaymaster.sol  — ERC-4337 paymaster (gas sponsorship)
    SmartAccount.sol         — minimal ERC-4337 smart account
    SmartAccountFactory.sol  — CREATE2 factory
    TierPayoutModule.sol     — Safe module for treasury payouts
    interfaces/IEntryPoint.sol
  test/
    MembershipSBT.t.sol
    Rewards.t.sol
  script/
    Deploy.s.sol
  foundry.toml

backend/
  src/
    server.ts     — Express HTTP API
    indexer.ts    — RPC event poller → Postgres
    claim.ts      — builds & simulates gasless claim UserOps
    userop.ts     — PackedUserOperation construction
    tenderly.ts   — Tenderly simulation wrapper
    db.ts         — Postgres pool + transaction helper
    migrate.ts    — SQL migration runner
  migrations/
    001_init.sql
    002_add_referrer.sql
    003_add_tier_history.sql
    004_fix_reputation_snapshot.sql
  package.json

frontend/
  app/           — Next.js routes
  lib/           — contract ABIs, helpers
  package.json
```

## Setup

### Prerequisites

- Node 20+
- Foundry (`forge`, `cast`, `anvil`)
- Postgres 15+
- A Tenderly account (free tier)

### Contracts

```bash
cd contracts
forge install
forge test
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

### Backend

```bash
cd backend
npm install

# 1. Create a Postgres database
# 2. Copy environment variables
cp .env.example .env
# 3. Run migrations
npm run migrate
# 4. Start server + indexer (in separate terminals)
npm run dev      # API server
npm run indexer  # Event indexer
```

Required backend environment variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Postgres connection string |
| `RPC_URL` | Scroll Sepolia (or local Anvil) RPC |
| `ENTRYPOINT` | EntryPoint v0.7 address |
| `SBT_ADDRESS` | MembershipSBT proxy |
| `REWARDS_ADDRESS` | RewardsDistributor proxy |
| `PAYMASTER_ADDRESS` | MembershipPaymaster |
| `DEPLOYER_KEY` | Admin EOA private key (signs UserOps) |
| `TENDERLY_API_KEY` | Tenderly simulation API |
| `BUNDLER_RPC` | Bundler endpoint for `eth_sendUserOperation` |

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Key flows

### Gasless Mint

1. User connects wallet and clicks **Mint**.
2. Frontend calls `/api/mint` with the user's EOA address.
3. Backend derives the user's SmartAccount (owner + salt), checks it has `MINTER_ROLE`, and builds a paymaster-sponsored UserOp.
4. Frontend signs the UserOp hash and submits to the bundler.
5. EntryPoint deploys the SA (if new) and executes `mint(recipient)` — gas paid by the paymaster.

### Gasless Claim

1. User signs a `claimDigest(smartAccount, tokenId, epoch)` with their EOA.
2. Backend verifies the signature, checks DB for SBT ownership, epoch closure, and prior claims.
3. Backend builds a sponsored claim UserOp, simulates it on Tenderly, and submits to the bundler.
4. EntryPoint executes `RewardsDistributor.claim(tokenId, epoch)` — rewards land in the user's SA.

### Reward Distribution (4-Layer Waterfall)

```
Layer 1: Treasury Split (bps)
  7000 → rewardsPool
  2000 → opsWallet
  1000 → burnSink

Layer 2: Tier Allocation of rewardsPool (bps)
  Bronze   1000
  Silver   2000
  Gold     3000
  Platinum 4000

Layer 3: Pro-rata by reputation snapshot within each tier
  userShare = (tierPool * userReputation) / tierTotalReputation

Layer 4: Protocol fee on claim
  200 bps skimmed from each claim
```

## Testing

**Contracts:**
```bash
cd contracts
forge test
```

**Backend:**
```bash
cd backend
npm test
```

## Important notes

- **UUPS Upgradeable:** `MembershipSBT` uses OpenZeppelin UUPS. Upgrades must go through the proxy and preserve storage layout.
- **Reorg Safety:** The backend indexer uses a `REORG_BUFFER` (default 1 block; raise to 12+ for mainnet). It stores both `block_number` and `block_hash` in the cursor and rewinds on hash mismatch.
- **Gas Estimates:** UserOp gas limits are conservative (2M verification, 300K call). Dynamic estimation can save gas but risks out-of-gas failures.
- **Admin Key:** The backend holds the admin private key to sign mint UserOps. In production, consider a multi-sig or encrypted envelope.

## Related docs

- `ARCHITECTURE.md` — design tradeoffs (pull vs push rewards, reputation snapshot placement, epoch boundaries)
- `FINDINGS.md` — audit findings with severity, root causes, and fixes
