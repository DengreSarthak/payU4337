import { AbiCoder, Contract, JsonRpcProvider, concat, getBytes, keccak256, toBeHex } from "ethers";

type MessageSigner = {
  signMessage(message: Uint8Array): Promise<string>;
};

const abi = AbiCoder.defaultAbiCoder();

export type UserOperation = {
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

export function pack128(hi: bigint, lo: bigint): string {
  const h = hi.toString(16).padStart(32, "0");
  const l = lo.toString(16).padStart(32, "0");
  return `0x${h}${l}`;
}

export async function signPaymasterApproval(
  signer: MessageSigner,
  sender: string,
  nonce: bigint,
): Promise<string> {
  const msg = abi.encode(["address", "uint256"], [sender, nonce]);
  const digest = getBytes(keccak256(msg));
  return signer.signMessage(digest);
}

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

async function getNonce(provider: JsonRpcProvider, entryPoint: string, sender: string): Promise<bigint> {
  const data =
    "0x35567e1a" + // getNonce(address,uint192)
    sender.slice(2).padStart(64, "0") +
    "".padStart(64, "0");
  const res = await provider.call({ to: entryPoint, data });
  return BigInt(res);
}

export async function buildSponsoredUserOp(args: {
  provider: JsonRpcProvider;
  entryPoint: string;
  sender: string;
  callData: string;
  paymaster: string;
  paymasterSigner: MessageSigner;
  paymasterVerificationGas: bigint;
  paymasterPostOpGas: bigint;
  initCode?: string;
  accountGasLimits?: string;
}): Promise<UserOperation> {
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
    nonce: toBeHex(nonce),
    initCode: args.initCode ?? "0x",
    callData: args.callData,
    accountGasLimits: args.accountGasLimits ?? pack128(200_000n, 200_000n),
    preVerificationGas: toBeHex(50_000n),
    gasFees: pack128(1_500_000_000n, 3_000_000_000n),
    paymasterAndData: pnd,
    signature: "0x",
  };
}

export async function signUserOperation(params: {
  entryPoint: Contract;
  signer: MessageSigner;
  userOp: UserOperation;
}): Promise<string> {
  const tuple = [
    params.userOp.sender,
    BigInt(params.userOp.nonce),
    params.userOp.initCode,
    params.userOp.callData,
    params.userOp.accountGasLimits,
    BigInt(params.userOp.preVerificationGas),
    params.userOp.gasFees,
    params.userOp.paymasterAndData,
    params.userOp.signature,
  ] as const;

  const hash = await params.entryPoint.getUserOpHash(tuple);
  return params.signer.signMessage(getBytes(hash));
}
