import { describe, it, expect } from "vitest";
import { Wallet, AbiCoder, keccak256, getBytes, verifyMessage } from "ethers";
import { pack128, buildPaymasterAndData, signPaymasterApproval } from "../userop";

describe("pack128", () => {
  it("packs two uint128 into one bytes32", () => {
    const packed = pack128(0x12345678n, 0xabcdefn);
    expect(packed).toMatch(/^0x/);
    expect(packed.length).toBe(66); // 0x + 64 hex chars
  });

  it("is symmetric: hi in first half, lo in second half", () => {
    const packed = pack128(0x1111n, 0x2222n);
    const hex = packed.slice(2);
    expect(hex.slice(0, 32)).toBe("00000000000000000000000000001111");
    expect(hex.slice(32, 64)).toBe("00000000000000000000000000002222");
  });
});

describe("buildPaymasterAndData", () => {
  it("concatenates paymaster + verificationGas + postOpGas + signature", () => {
    const pnd = buildPaymasterAndData(
      "0x1111111111111111111111111111111111111111",
      100_000n,
      50_000n,
      "0x" + "aa".repeat(65),
    );
    expect(pnd).toMatch(/^0x/);
    // paymaster (20) + vgas (16) + postgas (16) + sig (65) = 117 bytes = 234 hex chars + 0x prefix
    expect(pnd.length).toBe(2 + 234);
  });
});

describe("signPaymasterApproval", () => {
  it("signs keccak256(address,uint256) with the provided signer", async () => {
    const signer = Wallet.createRandom();
    const sender = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const nonce = 42n;

    const sig = await signPaymasterApproval(signer as any, sender, nonce);

    // Reconstruct digest and verify signature
    const msg = AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [sender, nonce]);
    const digest = getBytes(keccak256(msg));
    const recovered = verifyMessage(digest, sig);
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });
});
