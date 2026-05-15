-- Initial schema for the membership platform indexer + claim service.

CREATE TABLE IF NOT EXISTS members (
    address       TEXT PRIMARY KEY,
    token_id      NUMERIC NOT NULL UNIQUE,
    tier          SMALLINT NOT NULL,
    minted_block  BIGINT NOT NULL,
    minted_tx     TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS epochs (
    epoch            NUMERIC PRIMARY KEY,
    total_for_epoch  NUMERIC NOT NULL,
    closed_at_block  BIGINT NOT NULL,
    tx_hash          TEXT NOT NULL,
    closed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claims (
    tx_hash       TEXT PRIMARY KEY,
    token_id      NUMERIC NOT NULL,
    epoch         NUMERIC NOT NULL,
    amount        NUMERIC NOT NULL,
    block_number  BIGINT NOT NULL,
    processed     BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_token_epoch_idx ON claims (token_id, epoch);

CREATE TABLE IF NOT EXISTS reputation (
    address  TEXT PRIMARY KEY,
    points   NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS indexer_cursor (
    id            INT PRIMARY KEY,
    block_number  BIGINT NOT NULL
);
