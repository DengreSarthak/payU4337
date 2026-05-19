import { JsonRpcProvider, Contract, Log } from "ethers";
import { pool, withTx } from "./db";

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
// Set to 1 for testnets (fast feedback); raise to 12+ for mainnet.
const REORG_BUFFER = 1;

/**
 * Indexer
 *
 * Streams events from the SBT and RewardsDistributor contracts into Postgres.
 * Maintains a cursor table so it resumes from where it left off after a crash.
 *
 * Reorg safety:
 *  1. We store both block_number and block_hash in the cursor.
 *  2. Before each tick we verify the block at the cursor still has the same hash.
 *  3. If the hash changed (reorg), we rewind the cursor by REORG_BUFFER blocks.
 *  4. The entire tick (all event inserts + cursor update) runs in one DB transaction.
 *     If the process crashes mid-tick, Postgres rolls back — no partial state.
 *
 * Known race that was fixed:
 *  Previously events were written outside a transaction. A crash between
 *  `INSERT INTO claims` and the reputation UPDATE left the claim row in the DB
 *  but without the cursor being advanced. On restart the same block range was
 *  re-scanned, the claim insert was skipped by ON CONFLICT, but the reputation
 *  UPDATE ran again, inflating the score by +10 every restart.
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

    // Detect reorgs and rewind cursor if necessary.
    const cursor = await this.reconcileCursor(safeHead);

    const from = cursor.block + 1;
    const to = Math.min(safeHead, from + BATCH - 1);
    if (to < from) return;

    const [mints, tiers, claims, epochs] = await Promise.all([
      this.sbt.queryFilter(this.sbt.filters.Minted(), from, to),
      this.sbt.queryFilter(this.sbt.filters.TierChanged(), from, to),
      this.rewards.queryFilter(this.rewards.filters.RewardClaimed(), from, to),
      this.rewards.queryFilter(this.rewards.filters.EpochClosed(), from, to),
    ]);

    const toBlock = await this.provider.getBlock(to);
    const toHash = toBlock?.hash ?? null;
    if (!toHash) {
      console.warn(`[indexer] could not fetch block hash for ${to}, skipping tick`);
      return;
    }

    // Process everything in a single DB transaction.
    await withTx(async (client) => {
      for (const log of mints) await this.onMint(client, log);
      for (const log of tiers) await this.onTierChange(client, log);
      for (const log of claims) await this.onClaim(client, log);
      for (const log of epochs) await this.onEpochClosed(client, log);

      await client.query(
        `INSERT INTO indexer_cursor (id, block_number, block_hash)
         VALUES (1, $1, $2)
         ON CONFLICT (id)
         DO UPDATE SET block_number = EXCLUDED.block_number, block_hash = EXCLUDED.block_hash`,
        [to, toHash],
      );
    });

    console.log(`[indexer] indexed blocks ${from}–${to} (${mints.length} mints, ${tiers.length} tiers, ${claims.length} claims, ${epochs.length} epochs)`);
  }

  /**
   * Reconcile the cursor against on-chain block hashes.
   * If the block at the stored cursor was reorged out, rewind by REORG_BUFFER.
   */
  private async reconcileCursor(safeHead: number): Promise<{ block: number; hash: string | null }> {
    const r = await pool.query<{ block_number: string; block_hash: string | null }>(
      `SELECT block_number, block_hash FROM indexer_cursor WHERE id = 1`,
    );
    const row = r.rows[0];
    let block = row ? Number(row.block_number) : 0;
    let hash = row?.block_hash ?? null;

    if (block > 0 && hash) {
      try {
        const onChain = await this.provider.getBlock(block);
        if (!onChain || onChain.hash !== hash) {
          console.warn(`[indexer] reorg detected at block ${block}; rewinding ${REORG_BUFFER} blocks`);
          block = Math.max(0, block - REORG_BUFFER);
          hash = null;
        }
      } catch (e) {
        console.warn(`[indexer] failed to verify block ${block} hash, rewinding`, e);
        block = Math.max(0, block - REORG_BUFFER);
        hash = null;
      }
    }

    return { block, hash };
  }

  private async onMint(client: import("pg").PoolClient, log: Log) {
    const { to, tokenId, tier } = (log as any).args ?? {};
    // Idempotent on any unique violation (address OR token_id) so reprocessing
    // the same Mint event during reorg/cursor rewind never crashes the indexer.
    await client.query(
      `INSERT INTO members (address, token_id, tier, minted_block, minted_tx, owner)
       VALUES ($1, $2, $3, $4, $5, $1)
       ON CONFLICT DO NOTHING`,
      [to.toLowerCase(), tokenId.toString(), Number(tier), log.blockNumber, log.transactionHash],
    );
  }

  private async onTierChange(client: import("pg").PoolClient, log: Log) {
    const { tokenId, newTier } = (log as any).args ?? {};
    await client.query(
      `UPDATE members SET tier = $1 WHERE token_id = $2`,
      [Number(newTier), tokenId.toString()],
    );
    await client.query(
      `INSERT INTO tier_history (token_id, tier, block_number, tx_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_id, tx_hash) DO NOTHING`,
      [tokenId.toString(), Number(newTier), log.blockNumber, log.transactionHash],
    );
  }

  private async onClaim(client: import("pg").PoolClient, log: Log) {
    const { tokenId, epoch, amount } = (log as any).args ?? {};

    let reputationSnapshot = "0";
    try {
      const rep = await this.rewards.reputationOf(tokenId.toString(), { blockTag: log.blockNumber });
      reputationSnapshot = rep.toString();
    } catch {
      // If the historical call fails (e.g. node doesn't support archive), default to 0.
    }

    // Insert the claim. If it already exists (same tx_hash), the RETURNING clause
    // gives us null — we use that to gate the reputation update, preventing double
    // counting if this block range is ever re-processed.
    const insertRes = await client.query<{ tx_hash: string }>(
      `INSERT INTO claims (token_id, epoch, amount, reputation_snapshot, tx_hash, block_number, processed)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (tx_hash) DO NOTHING
       RETURNING tx_hash`,
      [
        tokenId.toString(),
        epoch.toString(),
        amount.toString(),
        reputationSnapshot,
        log.transactionHash,
        log.blockNumber,
      ],
    );

    // Only bump reputation if we actually inserted a new claim row.
    if (insertRes.rowCount && insertRes.rowCount > 0) {
      await client.query(
        `INSERT INTO reputation (address, points)
         SELECT address, 10 FROM members WHERE token_id = $1
         ON CONFLICT (address) DO UPDATE SET points = reputation.points + 10`,
        [tokenId.toString()],
      );
    }
  }

  private async onEpochClosed(client: import("pg").PoolClient, log: Log) {
    const { epoch, totalForEpoch } = (log as any).args ?? {};
    await client.query(
      `INSERT INTO epochs (epoch, total_for_epoch, closed_at_block, tx_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (epoch) DO NOTHING`,
      [epoch.toString(), totalForEpoch.toString(), log.blockNumber, log.transactionHash],
    );
  }
}

export { REWARDS_ABI, SBT_ABI };
