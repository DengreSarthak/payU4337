-- 003_add_tier_history.sql added `reputation_snapshot NUMERIC NOT NULL` with no DEFAULT.
-- Postgres refuses to add a NOT NULL column to a table that already has rows when no
-- DEFAULT is supplied. This migration fixes that using IF NOT EXISTS + DEFAULT 0.
--
-- If 003 ran on an empty database (succeeded), this is a no-op.
-- If 003 failed on a populated database, this adds the column correctly.
ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS reputation_snapshot NUMERIC NOT NULL DEFAULT 0;

-- Add a unique index on tier_history so the indexer can do idempotent inserts
-- (ON CONFLICT DO NOTHING) without relying solely on the reorg safety buffer.
CREATE UNIQUE INDEX IF NOT EXISTS tier_history_token_tx_uniq
    ON tier_history (token_id, tx_hash);
