-- Track which referrer (if any) brought each member onto the platform.
-- Referrer is itself a member address; nullable since not every mint comes from a referral.

ALTER TABLE members
    ADD COLUMN referrer TEXT REFERENCES members(address);

CREATE INDEX IF NOT EXISTS members_referrer_idx ON members (referrer);
