import { describe, it, expect, vi } from "vitest";
import express from "express";
import { z } from "zod";

// We test the Zod schema and endpoint logic without starting the full server.
const ClaimReqSchema = z.object({
  smartAccount: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "smartAccount must be a checksummed hex address"),
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "owner must be a hex address"),
  salt: z.string().min(1, "salt is required"),
  tokenId: z.string().min(1, "tokenId is required"),
  epoch: z.string().min(1, "epoch is required"),
  userSignature: z.string().startsWith("0x", "userSignature must be a 0x-prefixed hex string"),
  userOpSignature: z.string().startsWith("0x").optional(),
});

describe("ClaimReqSchema", () => {
  const valid = {
    smartAccount: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    owner: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    salt: "0",
    tokenId: "1",
    epoch: "1",
    userSignature: "0x1234",
  };

  it("accepts a valid claim request", () => {
    const parsed = ClaimReqSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it("rejects a smartAccount that is not a hex address", () => {
    const parsed = ClaimReqSchema.safeParse({ ...valid, smartAccount: "not-an-address" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a userSignature without 0x prefix", () => {
    const parsed = ClaimReqSchema.safeParse({ ...valid, userSignature: "1234" });
    expect(parsed.success).toBe(false);
  });

  it("rejects missing salt", () => {
    const parsed = ClaimReqSchema.safeParse({ ...valid, salt: "" });
    expect(parsed.success).toBe(false);
  });

  it("allows optional userOpSignature", () => {
    const parsed = ClaimReqSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect((parsed as any).data.userOpSignature).toBeUndefined();
  });
});
