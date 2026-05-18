import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

import express from "express";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { z } from "zod";
import { handleClaim } from "./claim";
import { Indexer, SBT_ABI, REWARDS_ABI } from "./indexer";
import { runMigrations } from "./migrate";
import { pool } from "./db";

const ClaimReqSchema = z.object({
  smartAccount: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "smartAccount must be a checksummed hex address"),
  tokenId: z.string().min(1, "tokenId is required"),
  epoch: z.string().min(1, "epoch is required"),
  userSignature: z.string().startsWith("0x", "userSignature must be a 0x-prefixed hex string"),
  userOpSignature: z.string().startsWith("0x").optional(),
});

async function main() {
  // Run migrations before starting the server
  await runMigrations();

  const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { batchMaxCount: 1 });
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
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  app.post("/record-mint", async (req, res) => {
    const body = req.body as { owner: string; smartAccount: string };
    if (!body.owner || !body.smartAccount) {
      return res.status(400).json({ ok: false, reason: "Missing owner or smartAccount" });
    }

    try {
      await pool.query(
        "UPDATE members SET owner = $1 WHERE address = $2",
        [body.owner.toLowerCase(), body.smartAccount.toLowerCase()]
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

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

  app.get("/member/owner/:owner", async (req, res) => {
    const { owner } = req.params;
    if (!owner || !owner.match(/^0x[0-9a-fA-F]{40}$/)) {
      return res.status(400).json({ ok: false, reason: "Invalid owner address format" });
    }

    try {
      const result = await pool.query(
        "SELECT address, token_id, tier, minted_block, minted_tx, created_at FROM members WHERE owner = $1 LIMIT 1",
        [owner.toLowerCase()]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, reason: "No membership found for this owner" });
      }
      res.json({ ok: true, member: result.rows[0] });
    } catch (e: any) {
      res.status(500).json({ ok: false, reason: e.message });
    }
  });

  app.get("/member/:address", async (req, res) => {
    const { address } = req.params;
    if (!address || !address.match(/^0x[0-9a-fA-F]{40}$/)) {
      return res.status(400).json({ ok: false, reason: "Invalid address format" });
    }

    try {
      const result = await pool.query(
        "SELECT address, token_id, tier, minted_block, minted_tx, created_at FROM members WHERE address = $1",
        [address.toLowerCase()]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ ok: false, reason: "Member not found" });
      }
      res.json({ ok: true, member: result.rows[0] });
    } catch (e: any) {
      res.status(500).json({ ok: false, reason: e.message });
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
