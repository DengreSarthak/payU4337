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
  userOpSignature?: string; // UserOp hash signature; when present the backend submits directly to the bundler
};

export type ClaimResp = {
  ok: true;
  userOp: PackedUserOp;
  tenderlyUrl?: string;
  bundlerResult?: unknown;
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

  // 9. If the client provided the user's UserOp signature, submit directly to the bundler.
  let bundlerResult: unknown | undefined;
  if (req.userOpSignature) {
    const signedUserOp: PackedUserOp = { ...userOp, signature: req.userOpSignature };
    const bundlerUrl = process.env.BUNDLER_URL;
    if (!bundlerUrl) {
      return { ok: false, reason: "BUNDLER_URL is not configured on backend" };
    }
    bundlerResult = await submitToBundler(bundlerUrl, signedUserOp, ctx.entryPoint);
  }

  return { ok: true, userOp, tenderlyUrl: sim.url, bundlerResult };
}

function splitPacked128(value: string) {
  const hex = value.replace(/^0x/, "").padStart(64, "0");
  return {
    hi: `0x${hex.slice(0, 32)}`,
    lo: `0x${hex.slice(32, 64)}`,
  };
}

function toBundlerUserOp(userOp: PackedUserOp): Record<string, string> {
  const { hi: verificationGasLimit, lo: callGasLimit } = splitPacked128(userOp.accountGasLimits);
  const { hi: maxPriorityFeePerGas, lo: maxFeePerGas } = splitPacked128(userOp.gasFees);

  const initCode = userOp.initCode ?? "0x";
  const paymasterAndData = userOp.paymasterAndData ?? "0x";

  const hasInitCode = initCode !== "0x";
  const hasPaymaster = paymasterAndData !== "0x";

  const bundlerUserOp: Record<string, string> = {
    sender: userOp.sender,
    nonce: userOp.nonce.toString(),
    callData: userOp.callData,
    callGasLimit,
    verificationGasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    preVerificationGas: userOp.preVerificationGas.toString(),
    signature: userOp.signature,
  };

  if (hasInitCode) {
    bundlerUserOp.factory = `0x${initCode.slice(2, 42)}`;
    bundlerUserOp.factoryData = `0x${initCode.slice(42)}`;
  }

  if (hasPaymaster) {
    const paymasterHex = paymasterAndData.slice(2);
    bundlerUserOp.paymaster = `0x${paymasterHex.slice(0, 40)}`;
    bundlerUserOp.paymasterVerificationGasLimit = `0x${paymasterHex.slice(40, 72)}`;
    bundlerUserOp.paymasterPostOpGasLimit = `0x${paymasterHex.slice(72, 104)}`;
    const paymasterData = `0x${paymasterHex.slice(104)}`;
    if (paymasterData !== "0x") bundlerUserOp.paymasterData = paymasterData;
  }

  return bundlerUserOp;
}

async function submitToBundler(bundlerUrl: string, userOp: PackedUserOp, entryPoint: string): Promise<unknown> {
  const bundlerUserOp = toBundlerUserOp(userOp);
  const response = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendUserOperation",
      params: [bundlerUserOp, entryPoint],
    }),
  });
  const json = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (!response.ok || json.error) {
    throw new Error(json.error?.message ?? `bundler request failed (${response.status})`);
  }
  return json.result;
}
