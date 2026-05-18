import { NextResponse } from "next/server";

type PackedUserOp = {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  accountGasLimits: string;
  preVerificationGas: string;
  gasFees: string;
  paymasterAndData: string;
  signature: string;
};

type SendBody = {
  entryPoint: string;
  userOp: PackedUserOp;
};

function splitPacked128(value: string) {
  const hex = value.replace(/^0x/, "").padStart(64, "0");
  return {
    hi: `0x${hex.slice(0, 32)}`,
    lo: `0x${hex.slice(32, 64)}`,
  };
}

function toBundlerUserOp(userOp: PackedUserOp) {
  const { hi: verificationGasLimit, lo: callGasLimit } = splitPacked128(userOp.accountGasLimits);
  const { hi: maxPriorityFeePerGas, lo: maxFeePerGas } = splitPacked128(userOp.gasFees);

  const initCode = userOp.initCode ?? "0x";
  const paymasterAndData = userOp.paymasterAndData ?? "0x";

  const hasInitCode = initCode !== "0x";
  const hasPaymaster = paymasterAndData !== "0x";

  const bundlerUserOp: Record<string, string> = {
    sender: userOp.sender,
    nonce: userOp.nonce,
    callData: userOp.callData,
    callGasLimit,
    verificationGasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    preVerificationGas: userOp.preVerificationGas,
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

export async function POST(request: Request) {
  try {
    const bundlerUrl = process.env.BUNDLER_URL;
    if (!bundlerUrl) {
      return NextResponse.json({ ok: false, reason: "BUNDLER_URL is not configured" }, { status: 400 });
    }

    console.log("[send-userop] Request received");
    const body = (await request.json()) as SendBody;
    console.log("[send-userop] Entry point:", body.entryPoint);
    console.log("[send-userop] Sender:", body.userOp.sender);
    console.log("[send-userop] InitCode present:", body.userOp.initCode !== "0x");

    const bundlerUserOp = toBundlerUserOp(body.userOp);
    console.log("[send-userop] Converted to bundler format - factory:", bundlerUserOp.factory ? "yes" : "no");

    console.log("[send-userop] Submitting to bundler:", bundlerUrl);
    const response = await fetch(bundlerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendUserOperation",
        params: [bundlerUserOp, body.entryPoint],
      }),
    });

    const json = (await response.json()) as { result?: unknown; error?: { message?: string } };

    console.log("[send-userop] Bundler response status:", response.status);
    console.log("[send-userop] Bundler response - result:", json.result, "error:", json.error?.message);

    if (!response.ok || json.error) {
      console.error("[send-userop] Bundler error:", json.error?.message ?? `HTTP ${response.status}`);
      return NextResponse.json(
        { ok: false, reason: json.error?.message ?? `bundler request failed (${response.status})` },
        { status: 500 },
      );
    }

    console.log("[send-userop] Success - UserOp hash:", json.result);
    return NextResponse.json({ ok: true, result: json.result });
  } catch (error) {
    console.error("[send-userop]", error);
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "send-userop failed" },
      { status: 500 },
    );
  }
}
