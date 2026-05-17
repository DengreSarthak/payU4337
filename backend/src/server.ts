import express from "express";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { z } from "zod";
import { handleClaim } from "./claim";
import { Indexer, SBT_ABI, REWARDS_ABI } from "./indexer";

const ClaimReqSchema = z.object({
  smartAccount: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "smartAccount must be a checksummed hex address"),
  tokenId: z.string().min(1, "tokenId is required"),
  epoch: z.string().min(1, "epoch is required"),
  userSignature: z.string().startsWith("0x", "userSignature must be a 0x-prefixed hex string"),
});

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
    const parsed = ClaimReqSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, reason: parsed.error.issues[0].message });
      return;
    }

    try {
      const result = await handleClaim(parsed.data, {
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
