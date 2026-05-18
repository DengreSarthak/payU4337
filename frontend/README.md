# Frontend

Minimal Next.js one-page dashboard for the membership protocol.

## What it does

- Connects a wallet
- Derives the deterministic smart account from the factory
- Reads SBT tier, reputation, current epoch, and rewards pool data
- Builds a gasless mint UserOp through the paymaster flow
- Signs and submits a claim UserOp after calling the backend claim builder
- Shows the latest bundler result and Tenderly link

## Environment

Copy `.env.example` to `.env.local` and fill in the contract addresses, RPC URL, bundler URL, backend URL, and paymaster signer key.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.
