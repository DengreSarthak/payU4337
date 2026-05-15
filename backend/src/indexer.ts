import { JsonRpcProvider, Contract, Log } from "ethers";
import { pool } from "./db";

const SBT_ABI = [
  "event Minted(address indexed to, uint256 indexed tokenId, uint8 tier)",
  "event TierChanged(uint256 indexed tokenId, uint8 oldTier, uint8 newTier)",
];

const REWARDS_ABI = [
  "event RewardClaimed(uint256 indexed tokenId, uint256 indexed epoch, uint256 amount)",
  "event EpochClosed(uint256 indexed epoch, uint256 totalForEpoch)",
];

const POLL_INTERVAL_MS = 4_000;
const BATCH = 500;

/**
 * Indexer
 *
 * Streams events from the SBT and RewardsDistributor contracts into Postgres.
 * Maintains a cursor table so it resumes from where it left off after a crash.
 */
export class Indexer {
  constructor(
    private provider: JsonRpcProvider,
    private sbt: Contract,
    private rewards: Contract,
  ) {}

  async start() {
    while (true) {
      try {
        await this.tick();
      } catch (e) {
        console.error("[indexer] tick failed", e);
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  async tick() {
    const head = await this.provider.getBlockNumber();
    const cursor = await this.getCursor();
    const from = cursor + 1;
    const to = Math.min(head, from + BATCH - 1);
    if (to < from) return;

    const [mints, tiers, claims, epochs] = await Promise.all([
      this.sbt.queryFilter(this.sbt.filters.Minted(), from, to),
      this.sbt.queryFilter(this.sbt.filters.TierChanged(), from, to),
      this.rewards.queryFilter(this.rewards.filters.RewardClaimed(), from, to),
      this.rewards.queryFilter(this.rewards.filters.EpochClosed(), from, to),
    ]);

    for (const log of mints) await this.onMint(log);
    for (const log of tiers) await this.onTierChange(log);
    for (const log of claims) await this.onClaim(log);
    for (const log of epochs) await this.onEpochClosed(log);

    await this.setCursor(to);
  }

  private async onMint(log: Log) {
    const { to, tokenId, tier } = (log as any).args ?? {};
    await pool.query(
      `INSERT INTO members (address, token_id, tier, minted_block, minted_tx)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (address) DO NOTHING`,
      [to.toLowerCase(), tokenId.toString(), Number(tier), log.blockNumber, log.transactionHash],
    );
  }

  private async onTierChange(log: Log) {
    const { tokenId, newTier } = (log as any).args ?? {};
    await pool.query(
      `UPDATE members SET tier = $1 WHERE token_id = $2`,
      [Number(newTier), tokenId.toString()],
    );
  }

  private async onClaim(log: Log) {
    const { tokenId, epoch, amount } = (log as any).args ?? {};
    // Mark this claim processed in our books — this is the source of truth
    // the reputation engine reads to credit "claimed-this-epoch" reputation.
    await pool.query(
      `INSERT INTO claims (token_id, epoch, amount, tx_hash, block_number, processed)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [tokenId.toString(), epoch.toString(), amount.toString(), log.transactionHash, log.blockNumber],
    );

    // Credit reputation immediately so the user sees their points update in the UI.
    await pool.query(
      `INSERT INTO reputation (address, points)
       SELECT address, 10 FROM members WHERE token_id = $1
       ON CONFLICT (address) DO UPDATE SET points = reputation.points + 10`,
      [tokenId.toString()],
    );
  }

  private async onEpochClosed(log: Log) {
    const { epoch, totalForEpoch } = (log as any).args ?? {};
    await pool.query(
      `INSERT INTO epochs (epoch, total_for_epoch, closed_at_block, tx_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (epoch) DO NOTHING`,
      [epoch.toString(), totalForEpoch.toString(), log.blockNumber, log.transactionHash],
    );
  }

  private async getCursor(): Promise<number> {
    const r = await pool.query<{ block_number: string }>(
      `SELECT block_number FROM indexer_cursor WHERE id = 1`,
    );
    return r.rows[0] ? Number(r.rows[0].block_number) : 0;
  }

  private async setCursor(block: number) {
    await pool.query(
      `INSERT INTO indexer_cursor (id, block_number) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET block_number = EXCLUDED.block_number`,
      [block],
    );
  }
}
