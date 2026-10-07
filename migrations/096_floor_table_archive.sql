-- Soft archive floor tables while preserving their IDs and historical links.
ALTER TABLE tables ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS archive_version bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS tables_active_zone_idx ON tables (zone_id) WHERE archived_at IS NULL;
