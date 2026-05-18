-- Add owner column to members table to support lookup by wallet address
ALTER TABLE members ADD COLUMN owner TEXT;

CREATE INDEX IF NOT EXISTS members_owner_idx ON members (owner);
