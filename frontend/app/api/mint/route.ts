import { AbiCoder, Contract, JsonRpcProvider, Wallet, concat, getAddress, getCreate2Address, keccak256, toBeHex } from "ethers";
import { NextResponse } from "next/server";
import { buildSponsoredUserOp } from "../../../lib/userop";
import {
  MEMBERSHIP_SBT_ABI,
  MEMBERSHIP_SBT_IFACE,
  SMART_ACCOUNT_FACTORY_IFACE,
  SMART_ACCOUNT_IFACE,
  MINTER_ROLE,
} from "../../../lib/contracts";
import { SMART_ACCOUNT_BYTECODE } from "../../../lib/smartAccountBytecode";

type MintBody = {
  owner: string;      // connected wallet EOA — used to derive SA (must have MINTER_ROLE)
  recipient: string;  // address to receive the SBT mint
  salt: string;
};

const abi = AbiCoder.defaultAbiCoder();

function hexify(value: unknown): unknown {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (Array.isArray(value)) return value.map(hexify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, hexify(item)]));
  }
  return value;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as MintBody;
    const owner = getAddress(body.owner);
    console.log("[mint-api] Request received - caller:", owner);

    const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { batchMaxCount: 1 });
    const paymasterSigner = new Wallet(process.env.PAYMASTER_SIGNER_KEY!);

    const factoryAddress = process.env.FACTORY_ADDRESS!;
    const entryPointAddress = process.env.ENTRYPOINT_ADDRESS!;
    const sbtAddress = process.env.SBT_ADDRESS!;

    // 2. Derive the caller's SmartAccount address (owner + salt).
    const salt = BigInt(body.salt ?? "0");
    const initCode = concat([
      SMART_ACCOUNT_ARTIFACT.bytecode.object,
      abi.encode(["address", "address"], [entryPointAddress, owner]),
    ]);
    const sender = getCreate2Address(factoryAddress, toBeHex(salt, 32), keccak256(initCode));

    // 1. Verify the sender SmartAccount has MINTER_ROLE on the SBT contract.
    const sbt = new Contract(sbtAddress, MEMBERSHIP_SBT_ABI, provider);
    const hasMinterRole = await sbt.hasRole(MINTER_ROLE, sender);
    if (!hasMinterRole) {
      return NextResponse.json(
        { ok: false, reason: "SmartAccount does not have MINTER_ROLE" },
        { status: 403 },
      );
    }

    const deployedCode = await provider.getCode(sender);
    const saDeployed = deployedCode !== "0x";

    // callData: sender.execute(SBT.mint(recipient))
    const recipient = getAddress(body.recipient);
    const innerMintCallData = MEMBERSHIP_SBT_IFACE.encodeFunctionData("mint", [recipient]);
    const callData = SMART_ACCOUNT_IFACE.encodeFunctionData("execute", [sbtAddress, 0, innerMintCallData]);

    // initCode if SA not yet deployed
    const createAccountData = SMART_ACCOUNT_FACTORY_IFACE.encodeFunctionData("createAccount", [owner, salt]);
    const initCodeParam = !saDeployed
      ? `0x${factoryAddress.replace(/^0x/, "")}${createAccountData.replace(/^0x/, "")}`
      : "0x";

    const verificationGasLimit = initCodeParam !== "0x" ? 2_000_000n : 500_000n;
    const callGasLimit = 300_000n;

    // 3. Build unsigned UserOp (backend signs paymaster approval only, NOT the UserOp hash).
    const userOp = await buildSponsoredUserOp({
      provider,
      entryPoint: entryPointAddress,
      sender,
      callData,
      paymaster: process.env.PAYMASTER_ADDRESS!,
      paymasterSigner,
      paymasterVerificationGas: 200_000n,
      paymasterPostOpGas: 60_000n,
      initCode: initCodeParam,
      accountGasLimits: `0x${verificationGasLimit.toString(16).padStart(32, "0")}${callGasLimit.toString(16).padStart(32, "0")}`,
    });

    console.log("[mint-api] Unsigned UserOp built for sender:", sender);

    return NextResponse.json(hexify({
      ok: true,
      userWallet: recipient,
      sender,
      saDeployed,
      userOp,
    }));
  } catch (error) {
    console.error("[mint-api]", error);
    return NextResponse.json(
      { ok: false, reason: error instanceof Error ? error.message : "mint build failed" },
      { status: 500 },
    );
  }
}
