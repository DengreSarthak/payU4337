import { describe, it, expect, vi, beforeEach } from "vitest";
import { Log } from "ethers";
import { Indexer, SBT_ABI, REWARDS_ABI } from "../indexer";

describe("Indexer event handlers", () => {
  const provider = {} as any;
  const sbt = { filters: { Minted: () => ({}), TierChanged: () => ({}) }, queryFilter: vi.fn() } as any;
  const rewards = { filters: { RewardClaimed: () => ({}), EpochClosed: () => ({}) }, queryFilter: vi.fn(), reputationOf: vi.fn() } as any;

  const indexer = new Indexer(provider, sbt, rewards);
  const queryMock = vi.fn();

  beforeEach(() => {
    queryMock.mockReset();
  });

  function makeLog(overrides: Partial<Log> = {}): Log {
    return {
      blockNumber: 100,
      blockHash: "0xabc",
      transactionIndex: 0,
      removed: false,
      address: "0x0",
      data: "0x",
      topics: [],
      transactionHash: "0xtx",
      logIndex: 0,
      ...overrides,
    } as Log;
  }

  it("onMint inserts a member with ON CONFLICT DO NOTHING", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const log = makeLog();
    (log as any).args = { to: "0xaaa", tokenId: 1n, tier: 0 };

    // Access private method via any cast
    await (indexer as any).onMint({ query: queryMock }, log);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO members"),
      ["0xaaa", "1", 0, 100, "0xtx"],
    );
  });

  it("onTierChange updates tier and inserts tier_history", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const log = makeLog();
    (log as any).args = { tokenId: 1n, oldTier: 0, newTier: 2 };

    await (indexer as any).onTierChange({ query: queryMock }, log);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE members SET tier"),
      [2, "1"],
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tier_history"),
      ["1", 2, 100, "0xtx"],
    );
  });

  it("onClaim inserts claim and bumps reputation only on new insert", async () => {
    // First call: INSERT claim returns a row (new insert)
    // Second call: reputation UPDATE
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ tx_hash: "0xtx" }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    rewards.reputationOf.mockResolvedValue(50n);
    const log = makeLog();
    (log as any).args = { tokenId: 1n, epoch: 1n, amount: 100n };

    await (indexer as any).onClaim({ query: queryMock }, log);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO claims"),
      expect.arrayContaining(["1", "1", "100", "50", "0xtx", 100]),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO reputation"),
      ["1"],
    );
  });

  it("onClaim skips reputation bump when claim already existed", async () => {
    // INSERT returns no rows (already existed via ON CONFLICT)
    queryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    rewards.reputationOf.mockResolvedValue(50n);
    const log = makeLog();
    (log as any).args = { tokenId: 1n, epoch: 1n, amount: 100n };

    await (indexer as any).onClaim({ query: queryMock }, log);

    // Should NOT have called the reputation INSERT
    const reputationCalls = queryMock.mock.calls.filter((call: any) =>
      call[0].includes("INSERT INTO reputation"),
    );
    expect(reputationCalls.length).toBe(0);
  });

  it("onEpochClosed inserts epoch with ON CONFLICT DO NOTHING", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const log = makeLog();
    (log as any).args = { epoch: 5n, totalForEpoch: 10000n };

    await (indexer as any).onEpochClosed({ query: queryMock }, log);

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO epochs"),
      ["5", "10000", 100, "0xtx"],
    );
  });
});
