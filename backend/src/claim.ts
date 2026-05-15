import { JsonRpcProvider, Wallet, Interface } from "ethers";
import { pool } from "./db";
import { buildClaimUserOp, PackedUserOp } from "./userop";
import { simulate } from "./tenderly";

const REWARDS_IFACE = new Interface([
  "function claim(uint256 tokenId, uint256 epoch)",
]);

const SA_IFACE = new Interface([
  "function execute(address to, uint256 value, bytes data)",
]);

export type ClaimReq = {
  smartAccount: string;
  tokenId: string;
  epoch: string;
  userSignature: string;
};

export type ClaimResp = {
  ok: true;
  userOp: PackedUserOp;
  tenderlyUrl?: string;
} | {
  ok: false;
  reason: string;
};

/**
 * /claim endpoint.
 *  - Verify user owns the SBT (via DB).
 *  - Verify epoch is closed.
 *  - Build the UserOp for the rewards.claim() call.
 *  - Simulate on Tenderly.
 *  - Return the UserOp (the user signs it client-side then we submit to the bundler).
 */
export async function handleClaim(
  req: ClaimReq,
  ctx: {
    provider: JsonRpcProvider;
    entryPoint: string;
    paymaster: string;
    paymasterSigner: Wallet;
    rewardsAddress: string;
  },
): Promise<ClaimResp> {
  // 1. Check the user owns this SBT.
  const memberRow = await pool.query(
    `SELECT address, token_id FROM members WHERE token_id = $1 LIMIT 1`,
    [req.tokenId],
  );
  if (memberRow.rowCount === 0) {
    return { ok: false, reason: "not a member" };
  }

  // 2. Check the epoch is closed.
  const epochRow = await pool.query(`SELECT 1 FROM epochs WHERE epoch = $1`, [req.epoch]);
  if (epochRow.rowCount === 0) {
    return { ok: false, reason: "epoch not closed" };
  }

  // 3. Check it hasn't already been claimed (by the indexer's view).
  const claimRow = await pool.query(
    `SELECT 1 FROM claims WHERE token_id = $1 AND epoch = $2 AND processed = true`,
    [req.tokenId, req.epoch],
  );
  if (claimRow.rowCount > 0) {
    return { ok: false, reason: "already claimed" };
  }

  // 4. Build the inner calldata: rewards.claim(tokenId, epoch)
  const inner = REWARDS_IFACE.encodeFunctionData("claim", [req.tokenId, req.epoch]);

  // 5. Wrap it as SmartAccount.execute(rewards, 0, inner)
  const callData = SA_IFACE.encodeFunctionData("execute", [ctx.rewardsAddress, 0, inner]);

  // 6. Build the UserOp.
  const userOp = await buildClaimUserOp({
    provider: ctx.provider,
    entryPoint: ctx.entryPoint,
    sender: req.smartAccount,
    callData,
    paymaster: ctx.paymaster,
    paymasterSigner: ctx.paymasterSigner,
    paymasterVerificationGas: 100_000n,
    paymasterPostOpGas: 50_000n,
  });

  // 7. Simulate the eventual rewards.claim() call via Tenderly.
  const sim = await simulate({
    network_id: process.env.CHAIN_ID ?? "11155111",
    from: req.smartAccount,
    to: ctx.rewardsAddress,
    input: inner,
  });
  if (!sim.ok) {
    return { ok: false, reason: `tenderly says revert: ${sim.url ?? "no url"}` };
  }

  return { ok: true, userOp, tenderlyUrl: sim.url };
}
