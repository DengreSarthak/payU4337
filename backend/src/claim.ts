import {
  JsonRpcProvider,
  Wallet,
  Interface,
  Contract,
  AbiCoder,
  keccak256,
  getBytes,
  verifyMessage,
} from "ethers";
import { pool } from "./db";
import { buildClaimUserOp, PackedUserOp } from "./userop";
import { simulate } from "./tenderly";

const REWARDS_IFACE = new Interface([
  "function claim(uint256 tokenId, uint256 epoch)",
]);

const SA_IFACE = new Interface([
  "function execute(address to, uint256 value, bytes data)",
]);

const SA_OWNER_ABI = ["function owner() view returns (address)"];

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
 * Canonical message the client must sign to authorise a claim request.
 * Ties the signature to one specific (smartAccount, tokenId, epoch) triple — not replayable.
 */
function claimDigest(smartAccount: string, tokenId: string, epoch: string): Uint8Array {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256"],
    [smartAccount, BigInt(tokenId), BigInt(epoch)],
  );
  return getBytes(keccak256(encoded));
}

/**
 * /claim endpoint.
 *  - Verify the signature proves caller controls the smart account.
 *  - Verify caller owns the SBT (token_id + address match in DB).
 *  - Verify epoch is closed.
 *  - Build the UserOp for the rewards.claim() call.
 *  - Simulate on Tenderly.
 *  - Return the UserOp (the user signs it client-side then submits to the bundler).
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
  // 1. Verify the userSignature proves the caller controls req.smartAccount.
  //    The EOA owner is fetched from the smart account contract on-chain.
  let owner: string;
  try {
    const sa = new Contract(req.smartAccount, SA_OWNER_ABI, ctx.provider);
    owner = (await sa.owner()) as string;
  } catch {
    return { ok: false, reason: "could not fetch smart account owner" };
  }

  const recovered = verifyMessage(claimDigest(req.smartAccount, req.tokenId, req.epoch), req.userSignature);
  if (recovered.toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, reason: "invalid signature" };
  }

  // 2. Check the caller's smart account owns this SBT token.
  const memberRow = await pool.query(
    `SELECT address FROM members WHERE token_id = $1 AND LOWER(address) = LOWER($2) LIMIT 1`,
    [req.tokenId, req.smartAccount],
  );
  if (memberRow.rowCount === 0) {
    return { ok: false, reason: "not a member or token not owned by this account" };
  }

  // 3. Check the epoch is closed.
  const epochRow = await pool.query(`SELECT 1 FROM epochs WHERE epoch = $1`, [req.epoch]);
  if (epochRow.rowCount === 0) {
    return { ok: false, reason: "epoch not closed" };
  }

  // 4. Check it hasn't already been claimed (by the indexer's view).
  const claimRow = await pool.query(
    `SELECT 1 FROM claims WHERE token_id = $1 AND epoch = $2 AND processed = true`,
    [req.tokenId, req.epoch],
  );
  if (claimRow.rowCount! > 0) {
    return { ok: false, reason: "already claimed" };
  }

  // 5. Build the inner calldata: rewards.claim(tokenId, epoch)
  const inner = REWARDS_IFACE.encodeFunctionData("claim", [req.tokenId, req.epoch]);

  // 6. Wrap it as SmartAccount.execute(rewards, 0, inner)
  const callData = SA_IFACE.encodeFunctionData("execute", [ctx.rewardsAddress, 0, inner]);

  // 7. Build the UserOp.
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

  // 8. Simulate the eventual rewards.claim() call via Tenderly.
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
