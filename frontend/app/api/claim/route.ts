import { JsonRpcProvider, Wallet } from "ethers";
import { NextResponse } from "next/server";
import { handleClaim } from "../../../../backend/src/claim";

type ClaimBody = {
  smartAccount: string;
  tokenId: string;
  epoch: string;
  userSignature: string;
};

function hexify(value: unknown): unknown {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (Array.isArray(value)) return value.map(hexify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hexify(item)]));
  }
  return value;
}

export async function POST(request: Request) {
  const body = (await request.json()) as ClaimBody;
  const provider = new JsonRpcProvider(process.env.RPC_URL);
  const paymasterSigner = new Wallet(process.env.PAYMASTER_SIGNER_KEY!);

  try {
    const result = await handleClaim(body, {
      provider,
      entryPoint: process.env.ENTRYPOINT_ADDRESS!,
      paymaster: process.env.PAYMASTER_ADDRESS!,
      paymasterSigner,
      rewardsAddress: process.env.REWARDS_ADDRESS!,
    });

    return NextResponse.json(hexify(result));
  } catch (error) {
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "claim build failed" },
      { status: 500 },
    );
  }
}
