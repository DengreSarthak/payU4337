import { JsonRpcProvider, Contract, Log } from "ethers";
import { pool } from "./db";

const SBT_ABI = [
  "event Minted(address indexed to, uint256 indexed tokenId, uint8 tier)",
  "event TierChanged(uint256 indexed tokenId, uint8 oldTier, uint8 newTier)",
];

const REWARDS_ABI = [
  "event RewardClaimed(uint256 indexed tokenId, uint256 indexed epoch, uint256 amount)",
  "event EpochClosed(uint256 indexed epoch, uint256 totalForEpoch)",
  "function reputationOf(uint256) view returns (uint256)",
];

const POLL_INTERVAL_MS = 4_000;
const BATCH = 500;
// Stay this many blocks behind the tip so a reorg does not leave phantom events in the DB.
const REORG_BUFFER = 12;

/**
 * Indexer
 *
 * Streams events from the SBT and RewardsDistributor contracts into Postgres.
 * Maintains a cursor table so it resumes from where it left off after a crash.
 *
 * Reorg safety: we never index closer than REORG_BUFFER blocks to the chain tip.
 * Events within the buffer window are picked up on the next tick once they are
 * deep enough to be considered final.
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
    const safeHead = head - REORG_BUFFER;
    const cursor = await this.getCursor();
    const from = cursor + 1;
    const to = Math.min(safeHead, from + BATCH - 1);
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
    // Record the tier change in tier_history for historical queries.
    // ON CONFLICT uses the unique index added in migration 004.
    await pool.query(
      `INSERT INTO tier_history (token_id, tier, block_number, tx_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_id, tx_hash) DO NOTHING`,
      [tokenId.toString(), Number(newTier), log.blockNumber, log.transactionHash],
    );
  }

  private async onClaim(log: Log) {
    const { tokenId, epoch, amount } = (log as any).args ?? {};

    // Fetch the reputation that was used to compute this payout at the exact claim block.
    let reputationSnapshot = "0";
    try {
      const rep = await this.rewards.reputationOf(tokenId.toString(), { blockTag: log.blockNumber });
      reputationSnapshot = rep.toString();
    } catch {
      // If the historical call fails (e.g. node doesn't support archive), default to 0.
    }

    await pool.query(
      `INSERT INTO claims (token_id, epoch, amount, reputation_snapshot, tx_hash, block_number, processed)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        tokenId.toString(),
        epoch.toString(),
        amount.toString(),
        reputationSnapshot,
        log.transactionHash,
        log.blockNumber,
      ],
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

export { REWARDS_ABI, SBT_ABI };
