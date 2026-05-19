# Architecture

## Protocol Pipeline

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│     EOA Wallet       │     │    SmartAccount      │     │  EntryPoint v0.7     │
│ ──────────────────── │     │ ──────────────────── │     │  + Paymaster         │
│ • Signs UserOps      │ ──▶ │ • CREATE2 from EOA   │ ──▶ │ ──────────────────── │
│ • Signs claim digest │     │ • execute() calls    │     │ • Validates sigs     │
│ • Pays zero gas      │     │ • Deployed on-demand │     │ • Sponsors gas       │
└──────────────────────┘     └──────────────────────┘     └──────────┬───────────┘
                                                                     │
                                                                     ▼
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│     Frontend         │     │  Backend + Indexer   │     │  RewardsDistributor  │
│ ──────────────────── │     │ ──────────────────── │     │  + MembershipSBT     │
│ • Connect / Mint     │ ◀── │ • Indexes events     │ ◀── │ ──────────────────── │
│ • Claim / Dashboard  │     │ • Builds UserOps     │     │ • deposit → split    │
│ • Polls until done   │     │ • DB: members,epochs │     │ • closeEpoch         │
│                        │     │ • Verifies ownership│     │ • claim(token,epoch) │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

## Mint Flow

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│     Frontend         │     │   /api/mint (Next)   │     │     Bundler          │
│ ──────────────────── │     │ ──────────────────── │     │ ──────────────────── │
│ • User clicks mint   │ ──▶ │ • Checks SA has      │ ──▶ │ • EntryPoint deploys │
│ • Sends owner+salt   │     │   MINTER_ROLE        │     │   SA if needed       │
│                        │     │ • Builds sponsored  │     │ • SA.mint(recipient) │
│                        │     │   UserOp            │     │ • Paymaster pays gas │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

The mint API derives the user's smart account from their EOA + salt, verifies it has `MINTER_ROLE` on the SBT contract, then builds a paymaster-sponsored UserOp. The frontend signs the UserOp hash and submits to the bundler. The EntryPoint deploys the SA (if not yet on-chain) and executes `mint(recipient)` — all gasless for the user.

## Claim Flow

```
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│     Frontend         │     │   Backend /claim      │     │     Bundler          │
│ ──────────────────── │     │ ──────────────────── │     │ ──────────────────── │
│ • User signs digest  │ ──▶ │ • Verifies EOA sig    │ ──▶ │ • EntryPoint deploys │
│   (sa,tokenId,epoch) │     │ • Checks DB: owns SBT │     │   SA if needed       │
│ • Sends to backend   │     │ • Checks epoch closed │     │ • SA.claim(id,epoch) │
│                        │     │ • Builds sponsored   │     │ • Paymaster pays gas │
│                        │     │   UserOp             │     │ • Rewards → SA       │
└──────────────────────┘     └──────────────────────┘     └──────────────────────┘
```

The user signs a `claimDigest(smartAccount, tokenId, epoch)` with their EOA to prove SA ownership. The backend verifies the signature, checks the DB for SBT ownership, epoch closure, and prior claims, then returns a sponsored UserOp. The frontend signs and submits. Rewards land in the SA's token balance — the user can sweep them out with another gasless `execute()` call.
