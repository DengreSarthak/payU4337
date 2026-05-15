# Assignment Brief

## Product context

We're building a membership platform. Users hold a **non-transferable Member SBT** (ERC-721 with transfer locks). Each SBT has a **tier** (Bronze / Silver / Gold / Platinum) that grows with on-chain reputation.

Each **epoch** (7 days), the protocol distributes reward tokens from a treasury Safe to members. Distribution is layered:

```
Protocol Revenue → Treasury Safe
    │
    ├─ Layer 1: Treasury split (Safe-governed, bps)
    │     7000 → Rewards Pool   2000 → Operations   1000 → Burn
    │
    ├─ Layer 2: Per-tier allocation of the Rewards Pool (bps)
    │     Bronze 1000   Silver 2000   Gold 3000   Platinum 4000
    │
    ├─ Layer 3: Intra-tier pro-rata by reputation snapshot
    │
    └─ Layer 4: 200 bps protocol fee skimmed on every claim
```

Users mint and claim **gaslessly** via ERC-4337. A paymaster sponsors gas for first-time mints and for claims under a daily cap.

## What you must deliver

### 1. Smart contracts (`contracts/`)

- Audit and fix the existing contracts. Document everything you fix in `FINDINGS.md` with severity (Critical / High / Medium / Low / Informational) and a one-paragraph explanation.
- Implement `RewardsDistributor.distributeEpoch()` correctly. The skeleton compiles but the math is wrong in several places — find them.
- Add an **invariant test** (Foundry `invariant_` or Echidna) for the rewards distribution. The invariant we care about most: across any random sequence of deposits and claims, `sum(amountClaimedByAllHolders) + dust ≤ totalDeposited` and `dust < epochCount`.
- Ship a working **v1 → v2 upgrade**. v2 should add a `lastClaimedEpoch` field per holder. Prove storage layout is preserved (we'll check with `forge inspect`).
- Provide a Tenderly simulation link for: (a) one upgrade transaction, (b) one full UserOp going through the paymaster.

### 2. Backend (`backend/`)

- Finish the indexer so it correctly tracks `Mint`, `TierChanged`, and `RewardClaimed` events.
- Make it **reorg-safe**. The current implementation has a known race — find it.
- Finish the `/claim` endpoint: it takes a user signature, builds the UserOp, asks Tenderly to simulate, and submits to the bundler.
- Review the existing Postgres migrations in `backend/migrations/`. **One of them will break on a populated production database.** Find it, explain why in `FINDINGS.md`, and supply a corrected migration as `backend/migrations/004_fix_<thing>.sql`.

### 3. Documentation

- `FINDINGS.md` — every issue you found in the inherited code, with severity, root cause, and fix. **This is the single most important artifact.** A clean, accurate `FINDINGS.md` will outweigh missing features.
- `ARCHITECTURE.md` — one page on tradeoffs you made (pull vs push rewards, where the reputation snapshot lives, how you handle epoch boundaries).
- A short **Loom (5 min max)** walking us through one design tradeoff you made and one bug you caught that you found particularly interesting.

## Out of scope

- Real bundler infra. You can run `eth-infinitism/bundler` locally or stub the submission step — we care that the UserOp is built correctly, not that you operate a bundler.
- Mainnet deployment. Sepolia or a local Anvil fork is fine.

## Bonus (optional, will visibly boost your score)

Ship the whole thing **end-to-end as a working product** with a minimal frontend, deployed somewhere we can click.

- **Minimal frontend** — a single page that lets a user (1) connect a wallet, (2) mint their SBT gaslessly via the paymaster, (3) view their tier + reputation + claimable epochs, (4) claim rewards via UserOp. React / Next / SvelteKit — your call. Polish is not what we're grading; **the flow must actually work**.
- **Deployment** — contracts on Sepolia (or another public L2 testnet), backend on Fly / Railway / Render / Vercel, frontend on Vercel / Netlify / Cloudflare Pages. Free tiers are fine. We must be able to open the URL and complete the flow without local setup.
- **Include in `FINDINGS.md`:** the deployed URL, the contract addresses + verified block explorer links, one screenshot of the full claim flow, and one Tenderly link from a real on-chain UserOp (not a local simulation).

A working deployed link is worth meaningfully more than a perfect local repo — productionizing the stack is exactly what this role is about. **But:** a broken deployed link is worse than no deployment. If you ship it, make sure the happy path works the moment we open it.

## Stack we expect

- **Solidity 0.8.24+**, Foundry (`forge`, `cast`, `anvil`).
- **OpenZeppelin Contracts Upgradeable v5.x** for UUPS, ERC-721, AccessControl.
- **Safe Contracts v1.4.x** for the multisig + module.
- **Node 20 + TypeScript** for the backend. ethers v6 or viem — your call.
- **Postgres 15+**. `node-pg-migrate` or raw SQL — your call, but migrations must be reversible where reasonable.
- **Tenderly** for simulations. Free tier is fine.

## Time budget

3–5 calendar days. We expect a senior to spend roughly:

- ~25% reading and fixing the existing code
- ~35% writing the rewards distributor + invariant tests
- ~20% backend + migrations
- ~10% the upgrade + Tenderly proofs
- ~10% writing `FINDINGS.md` and the architecture note

If you find yourself rewriting everything from scratch, stop and ask. Reading code well is part of the job.

## Submitting

- Push to a private GitHub repo, add the reviewers we sent in the email.
- Make sure `forge test` and `npm test` (in `backend/`) both pass on a clean clone.
- Include the Tenderly simulation URLs in `FINDINGS.md`.
- Include the Loom link in the PR description.

## Ground rules

- Use any AI tooling you want. We do. **But your name is on the submission** — if you can't defend a line of code in the Loom or follow-up call, it counts against you.
- If something is genuinely ambiguous, make a call, document it in `ARCHITECTURE.md`, and move on. We'd rather see a decisive wrong answer with reasoning than indecision.
- Don't reach out to ask "is X a bug?" — finding out is the assignment.
