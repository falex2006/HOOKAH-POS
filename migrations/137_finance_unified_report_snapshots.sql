-- Temporary immutable projections for paged unified finance reports.
CREATE TABLE IF NOT EXISTS finance_unified_report_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters)='object'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  cursor_secret text NOT NULL CHECK (cursor_secret ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,created_by,idempotency_key),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (expires_at=created_at+interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS finance_unified_report_snapshots_expiry_idx
  ON finance_unified_report_snapshots(expires_at);
CREATE INDEX IF NOT EXISTS finance_unified_report_snapshots_venue_expiry_idx
  ON finance_unified_report_snapshots(venue_id,expires_at);

CREATE OR REPLACE FUNCTION guard_finance_unified_report_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.created_at:=clock_timestamp();
    NEW.expires_at:=NEW.created_at+interval '15 minutes';
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'finance_unified_report_snapshot_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' AND OLD.expires_at>clock_timestamp() THEN
    RAISE EXCEPTION 'finance_unified_report_snapshot_not_expired' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS finance_unified_report_snapshot_immutable ON finance_unified_report_snapshots;
CREATE TRIGGER finance_unified_report_snapshot_immutable
BEFORE INSERT OR UPDATE OR DELETE ON finance_unified_report_snapshots
FOR EACH ROW EXECUTE FUNCTION guard_finance_unified_report_snapshot();

COMMENT ON TABLE finance_unified_report_snapshots IS
  'Immutable venue-scoped unified finance report projection. Data expires exactly 15 minutes after creation; reads must still recheck current permissions.';
