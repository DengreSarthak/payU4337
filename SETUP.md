# Setup

## Prerequisites

- Node 20+
- pnpm or npm
- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)
- Postgres 15+ (`brew install postgresql@15` or `docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15`)
- Tenderly account (free tier OK)

## First-run

```bash
# 1. Contracts
cd contracts
forge install foundry-rs/forge-std --no-commit
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-commit
forge install eth-infinitism/account-abstraction --no-commit
forge install safe-global/safe-contracts --no-commit
forge build

# 2. Backend
cd ../backend
npm install
cp ../.env.example ../.env   # fill in values
createdb membership          # or set DATABASE_URL accordingly
npm run migrate

# 3. Run tests
cd ../contracts && forge test -vv
cd ../backend  && npm test
```

## Local end-to-end smoke

```bash
# terminal 1 — anvil
anvil

# terminal 2 — deploy
cd contracts
forge script script/Deploy.s.sol --broadcast --rpc-url http://localhost:8545

# terminal 3 — backend
cd backend
npm run dev
```

## Notes

- The reference EntryPoint v0.7 is canonical at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`. On Anvil you'll need to deploy your own (the AA repo has a fixture).
- We do not require you to operate a bundler — stubbing `eth_sendUserOperation` in tests is fine.
- See `ASSIGNMENT.md` for the full brief and `FINDINGS.template.md` for the deliverable.
