-- Add block_hash to indexer_cursor for reorg detection.
ALTER TABLE indexer_cursor ADD COLUMN IF NOT EXISTS block_hash TEXT;
