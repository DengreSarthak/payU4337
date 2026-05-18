-- Snapshot tier history. Used by RewardsDistributor's epoch-close reputation aggregation:
-- the indexer needs to know what tier a member was at the moment the epoch closed.
--
-- Every existing member becomes a Bronze (0) historical row at the time this migration runs.

CREATE TABLE IF NOT EXISTS tier_history (
    id           BIGSERIAL PRIMARY KEY,
    token_id     NUMERIC NOT NULL,
    tier         SMALLINT NOT NULL,
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tier_history_token_block_idx ON tier_history (token_id, block_number DESC);

-- Unique index so the INSERT below can use ON CONFLICT (also used by indexer for idempotency).
CREATE UNIQUE INDEX IF NOT EXISTS tier_history_token_tx_uniq
    ON tier_history (token_id, tx_hash);

-- Backfill: every existing member gets an initial tier_history row at their mint block.
-- ON CONFLICT prevents duplicate rows if this migration is ever re-run after a partial failure.
INSERT INTO tier_history (token_id, tier, block_number, tx_hash)
SELECT token_id, tier, minted_block, minted_tx FROM members
ON CONFLICT (token_id, tx_hash) DO NOTHING;

-- The RewardsDistributor's reputation push now requires every claim row to carry the
-- snapshotted reputation that was used to compute the payout. Add the column with
-- DEFAULT 0 so it succeeds on a populated database (existing rows get 0).
ALTER TABLE claims
    ADD COLUMN reputation_snapshot NUMERIC NOT NULL DEFAULT 0;
