-- Fix for databases where the old (broken) 003_add_tier_history.sql partially ran.
--
-- The old 003 had two problems on a populated database:
--  1. `ALTER TABLE claims ADD COLUMN reputation_snapshot NUMERIC NOT NULL` failed
--     because existing rows had no value for the new NOT NULL column.
--  2. The backfill INSERT into tier_history had no ON CONFLICT guard, so every
--     retry of the failed migration created duplicate rows.
--
-- This migration cleans up both issues idempotently.

-- 1. Ensure reputation_snapshot exists with a safe default.
ALTER TABLE claims
    ADD COLUMN IF NOT EXISTS reputation_snapshot NUMERIC NOT NULL DEFAULT 0;

-- 2. Deduplicate tier_history rows that may have been created by retries of the
--    old broken 003. We keep the row with the smallest id (first inserted).
DELETE FROM tier_history
WHERE id NOT IN (
    SELECT MIN(id)
    FROM tier_history
    GROUP BY token_id, tx_hash
);

-- 3. Ensure the unique index exists so the indexer can safely use ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS tier_history_token_tx_uniq
    ON tier_history (token_id, tx_hash);
