import { AbiCoder, getBytes, JsonRpcProvider, Wallet, ZeroAddress, concat, toBeHex } from "ethers";

const abi = AbiCoder.defaultAbiCoder();

export type PackedUserOp = {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  accountGasLimits: string; // bytes32 = verificationGasLimit (16) | callGasLimit (16)
  preVerificationGas: bigint;
  gasFees: string; // bytes32 = maxPriorityFeePerGas (16) | maxFeePerGas (16)
  paymasterAndData: string;
  signature: string;
};

export function pack128(hi: bigint, lo: bigint): string {
  // pack two uint128 into one bytes32
  const h = hi.toString(16).padStart(32, "0");
  const l = lo.toString(16).padStart(32, "0");
  return "0x" + h + l;
}

/**
 * Build a paymaster sponsorship signature.
 *
 * The paymaster verifies the signature recovered from this digest matches its configured signer.
 */
export async function signPaymasterApproval(
  signer: Wallet,
  sender: string,
  nonce: bigint,
): Promise<string> {
  const msg = abi.encode(["address", "uint256"], [sender, nonce]);
  const digest = getBytes(keccak(msg));
  return signer.signMessage(digest);
}

function keccak(s: string): string {
  return require("ethers").keccak256(s);
}

/**
 * Build the paymasterAndData bytes the EntryPoint will hand to the paymaster.
 *
 * Layout:
 *   [paymaster (20)] [paymasterVerificationGasLimit (16)] [paymasterPostOpGasLimit (16)] [signature (65)]
 */
export function buildPaymasterAndData(
  paymaster: string,
  paymasterVerificationGas: bigint,
  paymasterPostOpGas: bigint,
  signature: string,
): string {
  return concat([
    paymaster,
    toBeHex(paymasterVerificationGas, 16),
    toBeHex(paymasterPostOpGas, 16),
    signature,
  ]);
}

/**
 * Build a UserOp for a SmartAccount `execute(to, value, data)` call.
 */
export async function buildClaimUserOp(args: {
  provider: JsonRpcProvider;
  entryPoint: string;
  sender: string;
  callData: string;
  paymaster: string;
  paymasterSigner: Wallet;
  paymasterVerificationGas: bigint;
  paymasterPostOpGas: bigint;
}): Promise<PackedUserOp> {
  const nonce = await getNonce(args.provider, args.entryPoint, args.sender);
  const sig = await signPaymasterApproval(args.paymasterSigner, args.sender, nonce);
  const pnd = buildPaymasterAndData(
    args.paymaster,
    args.paymasterVerificationGas,
    args.paymasterPostOpGas,
    sig,
  );

  return {
    sender: args.sender,
    nonce,
    initCode: "0x",
    callData: args.callData,
    accountGasLimits: pack128(200_000n, 200_000n),
    preVerificationGas: 50_000n,
    gasFees: pack128(1_500_000_000n, 3_000_000_000n),
    paymasterAndData: pnd,
    signature: "0x", // will be filled in by the user
  };
}

async function getNonce(provider: JsonRpcProvider, entryPoint: string, sender: string): Promise<bigint> {
  const data =
    "0x35567e1a" + // getNonce(address,uint192)
    sender.slice(2).padStart(64, "0") +
    "".padStart(64, "0");
  const res = await provider.call({ to: entryPoint, data });
  return BigInt(res);
}
