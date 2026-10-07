CREATE TABLE IF NOT EXISTS shift_close_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  shift_id uuid NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version=1),
  checklist_version smallint NOT NULL DEFAULT 1 CHECK (checklist_version=1),
  snapshot_payload jsonb NOT NULL CHECK (jsonb_typeof(snapshot_payload)='object'),
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  closed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_close_snapshots_one_per_shift UNIQUE (venue_id,shift_id),
  CONSTRAINT shift_close_snapshots_shift_fk FOREIGN KEY (venue_id,shift_id)
    REFERENCES shifts(venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS shift_close_snapshots_venue_captured_idx
  ON shift_close_snapshots (venue_id,captured_at DESC,id DESC);

CREATE OR REPLACE FUNCTION guard_shift_close_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'shift close snapshots are immutable' USING ERRCODE='55000';
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='shift_close_snapshots_immutable'
      AND tgrelid='shift_close_snapshots'::regclass
  ) THEN
    CREATE TRIGGER shift_close_snapshots_immutable
      BEFORE UPDATE OR DELETE ON shift_close_snapshots
      FOR EACH ROW EXECUTE FUNCTION guard_shift_close_snapshot_immutable();
  END IF;
END $$;
