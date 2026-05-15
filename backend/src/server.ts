import express from "express";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { handleClaim } from "./claim";
import { Indexer } from "./indexer";

const SBT_ABI = [
  "event Minted(address indexed to, uint256 indexed tokenId, uint8 tier)",
  "event TierChanged(uint256 indexed tokenId, uint8 oldTier, uint8 newTier)",
];

const REWARDS_ABI = [
  "event RewardClaimed(uint256 indexed tokenId, uint256 indexed epoch, uint256 amount)",
  "event EpochClosed(uint256 indexed epoch, uint256 totalForEpoch)",
];

async function main() {
  const provider = new JsonRpcProvider(process.env.RPC_URL);
  const paymasterSigner = new Wallet(process.env.PAYMASTER_SIGNER_KEY!);

  const sbt = new Contract(process.env.SBT_ADDRESS!, SBT_ABI, provider);
  const rewards = new Contract(process.env.REWARDS_ADDRESS!, REWARDS_ABI, provider);

  // start indexer
  new Indexer(provider, sbt, rewards).start().catch((e) => {
    console.error("[indexer] crashed", e);
    process.exit(1);
  });

  const app = express();
  app.use(express.json());

  app.post("/claim", async (req, res) => {
    try {
      const result = await handleClaim(req.body, {
        provider,
        entryPoint: process.env.ENTRYPOINT_ADDRESS!,
        paymaster: process.env.PAYMASTER_ADDRESS!,
        paymasterSigner,
        rewardsAddress: process.env.REWARDS_ADDRESS!,
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => console.log(`[server] listening on :${port}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
