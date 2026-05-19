import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  JsonRpcProvider,
  Wallet,
  getBytes,
  keccak256,
  AbiCoder,
  getCreate2Address,
  toBeHex,
  concat,
} from "ethers";
import { claimDigest, handleClaim, ClaimReq } from "../claim";
import { SMART_ACCOUNT_BYTECODE } from "../smartAccountBytecode";
import { pool } from "../db";

// ── mock db.ts so handleClaim does not hit a real Postgres pool ──
vi.mock("../db", () => ({
  pool: { query: vi.fn() },
}));

// ── mock userop.ts so handleClaim does not RPC for nonce / build UserOp ──
vi.mock("../userop", () => ({
  buildClaimUserOp: vi.fn().mockResolvedValue({
    sender: "0x1234",
    nonce: 0n,
    initCode: "0x",
    callData: "0x",
    accountGasLimits: "0x",
    preVerificationGas: 0n,
    gasFees: "0x",
    paymasterAndData: "0x",
    signature: "0x",
  }),
}));

const FACTORY = "0xa5195786fC1b02ff6cA34FF7B9d3679258AAEa1C";
const ENTRYPOINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const REWARDS = "0x12fD4F2252FbDB9A56C5Ed85A305B13Bc2370D01";
const PAYMASTER = "0x0000000000000000000000000000000000000000";

function deriveSmartAccount(owner: string, salt: bigint): string {
  const initCode = concat([
    SMART_ACCOUNT_BYTECODE,
    AbiCoder.defaultAbiCoder().encode(["address", "address"], [ENTRYPOINT, owner]),
  ]);
  return getCreate2Address(FACTORY, toBeHex(salt, 32), keccak256(initCode));
}

describe("claimDigest", () => {
  it("produces a deterministic keccak256 of (address,uint256,uint256)", () => {
    const digest = claimDigest("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1", "5");
    const expected = getBytes(
      keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ["address", "uint256", "uint256"],
          ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1n, 5n],
        ),
      ),
    );
    expect(digest).toEqual(expected);
  });

  it("changes when any argument changes", () => {
    const d1 = claimDigest("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1", "5");
    const d2 = claimDigest("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "1", "5");
    const d3 = claimDigest("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "2", "5");
    const d4 = claimDigest("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1", "6");
    expect(d1).not.toEqual(d2);
    expect(d1).not.toEqual(d3);
    expect(d1).not.toEqual(d4);
  });
});

describe("handleClaim", () => {
  const owner = Wallet.createRandom();
  const salt = 42n;
  const smartAccount = deriveSmartAccount(owner.address, salt);
  const provider = {
    getCode: vi.fn().mockResolvedValue("0x1234"),
    getBlockNumber: vi.fn().mockResolvedValue(100),
  } as unknown as JsonRpcProvider;
  const paymasterSigner = Wallet.createRandom();

  const ctx = {
    provider,
    entryPoint: ENTRYPOINT,
    paymaster: PAYMASTER,
    paymasterSigner: paymasterSigner as any,
    rewardsAddress: REWARDS,
    factory: FACTORY,
  };

  const queryMock = pool.query as any;

  beforeEach(() => {
    queryMock.mockReset();
  });

  async function signClaim(signer: { signMessage: (msg: Uint8Array) => Promise<string> }, sa: string, tokenId: string, epoch: string): Promise<string> {
    const digest = claimDigest(sa, tokenId, epoch);
    return signer.signMessage(digest);
  }

  it("rejects when factory is not configured", async () => {
    const result = await handleClaim(
      {
        smartAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        owner: owner.address,
        salt: "0",
        tokenId: "1",
        epoch: "1",
        userSignature: "0x1234",
      } as ClaimReq,
      { ...ctx, factory: "" },
    );
    expect(result).toEqual({ ok: false, reason: "FACTORY_ADDRESS not configured on backend" });
  });

  it("rejects when derived SA does not match requested SA", async () => {
    const result = await handleClaim(
      {
        smartAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        owner: owner.address,
        salt: "0",
        tokenId: "1",
        epoch: "1",
        userSignature: "0x1234",
      } as ClaimReq,
      ctx,
    );
    expect(result.ok).toBe(false);
    expect((result as any).reason).toMatch(/smartAccount mismatch/);
  });

  it("rejects an invalid signature", async () => {
    const wrongSigner = Wallet.createRandom();
    const badSig = await signClaim(wrongSigner, smartAccount, "1", "1");

    const result = await handleClaim(
      {
        smartAccount,
        owner: owner.address,
        salt: salt.toString(),
        tokenId: "1",
        epoch: "1",
        userSignature: badSig,
      },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects when token is not owned by this account (DB miss)", async () => {
    const sig = await signClaim(owner, smartAccount, "1", "1");
    queryMock.mockResolvedValue({ rowCount: 0, rows: [] });

    const result = await handleClaim(
      {
        smartAccount,
        owner: owner.address,
        salt: salt.toString(),
        tokenId: "1",
        epoch: "1",
        userSignature: sig,
      },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: "not a member or token not owned by this account" });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT address FROM members"),
      ["1", smartAccount],
    );
  });

  it("rejects when epoch is not closed", async () => {
    const sig = await signClaim(owner, smartAccount, "1", "1");
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ address: smartAccount }] }) // member check
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // epoch check

    const result = await handleClaim(
      {
        smartAccount,
        owner: owner.address,
        salt: salt.toString(),
        tokenId: "1",
        epoch: "1",
        userSignature: sig,
      },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: "epoch not closed" });
  });

  it("rejects when already claimed", async () => {
    const sig = await signClaim(owner, smartAccount, "1", "1");
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ address: smartAccount }] }) // member check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // epoch closed
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }); // already claimed

    const result = await handleClaim(
      {
        smartAccount,
        owner: owner.address,
        salt: salt.toString(),
        tokenId: "1",
        epoch: "1",
        userSignature: sig,
      },
      ctx,
    );
    expect(result).toEqual({ ok: false, reason: "already claimed" });
  });

  it("returns a built UserOp when all checks pass", async () => {
    const sig = await signClaim(owner, smartAccount, "1", "1");
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ address: smartAccount }] }) // member check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] }) // epoch closed
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }); // not yet claimed

    const result = await handleClaim(
      {
        smartAccount,
        owner: owner.address,
        salt: salt.toString(),
        tokenId: "1",
        epoch: "1",
        userSignature: sig,
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect((result as any).userOp).toBeDefined();
  });
});
