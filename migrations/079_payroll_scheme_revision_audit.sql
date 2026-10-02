-- Append-only audit snapshots for owner changes to payroll scheme versions.

CREATE TABLE IF NOT EXISTS payroll_scheme_version_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  scheme_version_id uuid NOT NULL,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  change_kind text NOT NULL CHECK (change_kind IN ('created','edited','activated')),
  config_snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(config_snapshot_json) = 'object'),
  changed_by uuid NOT NULL,
  changed_by_name text NOT NULL CHECK (length(btrim(changed_by_name)) BETWEEN 1 AND 160),
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, scheme_version_id, revision_no),
  CONSTRAINT payroll_scheme_version_revisions_version_venue_fk
    FOREIGN KEY (venue_id, scheme_version_id) REFERENCES payroll_scheme_versions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_scheme_version_revisions_actor_venue_fk
    FOREIGN KEY (venue_id, changed_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS payroll_scheme_version_revisions_history_idx
  ON payroll_scheme_version_revisions (venue_id, scheme_version_id, revision_no DESC);

CREATE OR REPLACE FUNCTION payroll_validate_scheme_version_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
  actor_role text;
  actor_active boolean;
  actor_deleted_at timestamptz;
  actor_name text;
  expected_revision integer;
BEGIN
  EXECUTE format('SELECT status FROM %I.payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO version_status USING NEW.venue_id, NEW.scheme_version_id;
  IF version_status IS NULL
    OR (NEW.change_kind IN ('created','edited') AND version_status <> 'draft')
    OR (NEW.change_kind = 'activated' AND version_status <> 'active') THEN
    RAISE EXCEPTION 'payroll scheme revision does not match version lifecycle' USING ERRCODE = '23514';
  END IF;

  EXECUTE format('SELECT role::text,is_active,deleted_at,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 FOR SHARE', TG_TABLE_SCHEMA)
    INTO actor_role,actor_active,actor_deleted_at,actor_name USING NEW.venue_id,NEW.changed_by;
  IF actor_role IS DISTINCT FROM 'owner' OR actor_active IS DISTINCT FROM true OR actor_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'payroll scheme revisions require an active venue owner' USING ERRCODE = '42501';
  END IF;

  EXECUTE format('SELECT COALESCE(MAX(revision_no),0)::int+1 FROM %I.payroll_scheme_version_revisions WHERE venue_id=$1 AND scheme_version_id=$2', TG_TABLE_SCHEMA)
    INTO expected_revision USING NEW.venue_id,NEW.scheme_version_id;
  IF NEW.revision_no IS DISTINCT FROM expected_revision
    OR (NEW.change_kind = 'created' AND expected_revision <> 1)
    OR (NEW.change_kind <> 'created' AND expected_revision = 1) THEN
    RAISE EXCEPTION 'payroll scheme revision sequence is invalid' USING ERRCODE = '23514';
  END IF;
  NEW.changed_by_name := actor_name;
  NEW.changed_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_reject_scheme_revision_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payroll scheme revision history cannot be truncated' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS payroll_scheme_version_revisions_immutable ON payroll_scheme_version_revisions;
CREATE TRIGGER payroll_scheme_version_revisions_immutable
  BEFORE UPDATE OR DELETE ON payroll_scheme_version_revisions
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_history_mutation();

DROP TRIGGER IF EXISTS payroll_scheme_version_revisions_insert_guard ON payroll_scheme_version_revisions;
CREATE TRIGGER payroll_scheme_version_revisions_insert_guard
  BEFORE INSERT ON payroll_scheme_version_revisions
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_scheme_version_revision();

DROP TRIGGER IF EXISTS payroll_scheme_version_revisions_truncate_guard ON payroll_scheme_version_revisions;
CREATE TRIGGER payroll_scheme_version_revisions_truncate_guard
  BEFORE TRUNCATE ON payroll_scheme_version_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_scheme_revision_truncate();
