-- Managers may request permanent removal of an already archived, unused
-- inventory directory entry. Only an authenticated venue owner can decide.
CREATE TABLE IF NOT EXISTS inventory_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('department','subdepartment','category')),
  entity_id text NOT NULL,
  entity_name text NOT NULL,
  parent_name text,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_by_name text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by_name text NOT NULL DEFAULT '',
  decided_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_deletion_requests_pending_entity_uq
  ON inventory_deletion_requests (venue_id, entity_type, entity_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS inventory_deletion_requests_venue_status_idx
  ON inventory_deletion_requests (venue_id, status, requested_at DESC);
