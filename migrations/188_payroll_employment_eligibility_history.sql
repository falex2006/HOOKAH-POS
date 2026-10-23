-- Immutable owner-attested venue eligibility snapshots, independent of wage roles.
-- This is historical payroll scope evidence only; it creates no wage or ledger rows.

CREATE TABLE IF NOT EXISTS payroll_employment_eligibility_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  supersedes_revision_id uuid,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 1000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 160),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  period_count integer NOT NULL CHECK (period_count BETWEEN 0 AND 10000),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, revision_no),
  UNIQUE (venue_id, idempotency_key),
  CONSTRAINT payroll_employment_eligibility_revision_previous_fk
    FOREIGN KEY (venue_id, supersedes_revision_id)
    REFERENCES payroll_employment_eligibility_revisions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_employment_eligibility_revision_actor_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CHECK ((revision_no = 1 AND supersedes_revision_id IS NULL)
      OR (revision_no > 1 AND supersedes_revision_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS payroll_employment_eligibility_revision_latest_idx
  ON payroll_employment_eligibility_revisions (venue_id, revision_no DESC);

CREATE TABLE IF NOT EXISTS payroll_employment_eligibility_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name_snapshot text NOT NULL CHECK (length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160),
  effective_from date NOT NULL,
  effective_to date,
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, revision_id, employee_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_employment_eligibility_period_revision_fk
    FOREIGN KEY (venue_id, revision_id)
    REFERENCES payroll_employment_eligibility_revisions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_employment_eligibility_period_employee_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS payroll_employment_eligibility_period_employee_dates_idx
  ON payroll_employment_eligibility_periods (venue_id, revision_id, employee_id, effective_from, effective_to);

CREATE OR REPLACE FUNCTION payroll_guard_employment_eligibility_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_role text;
  actor_active boolean;
  actor_deleted_at timestamptz;
  actor_name text;
  expected_revision integer;
  expected_previous uuid;
BEGIN
  -- Match the payroll source fence before taking the venue row lock. This
  -- protects direct SQL writers as well as the owner API transaction wrapper.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('payroll-official-source-v1:'||NEW.venue_id::text,0));
  -- Serialize revision allocation per venue even when two owner requests race.
  PERFORM id FROM venues WHERE id = NEW.venue_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payroll employment revision venue is missing' USING ERRCODE = '23503';
  END IF;

  SELECT role::text,is_active,deleted_at,full_name
    INTO actor_role,actor_active,actor_deleted_at,actor_name
    FROM users WHERE venue_id=NEW.venue_id AND id=NEW.created_by FOR SHARE;
  IF actor_role IS DISTINCT FROM 'owner' OR actor_active IS DISTINCT FROM true OR actor_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'payroll employment revisions require an active venue owner' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(MAX(revision_no),0)::int+1, (array_agg(id ORDER BY revision_no DESC))[1]
    INTO expected_revision,expected_previous
    FROM payroll_employment_eligibility_revisions WHERE venue_id=NEW.venue_id;
  IF NEW.revision_no IS DISTINCT FROM expected_revision OR NEW.supersedes_revision_id IS DISTINCT FROM expected_previous THEN
    RAISE EXCEPTION 'payroll employment revision sequence is invalid' USING ERRCODE = '23514';
  END IF;
  NEW.created_by_name := actor_name;
  NEW.created_at := transaction_timestamp();
  NEW.created_transaction_id := pg_current_xact_id();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_guard_employment_eligibility_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_created_at timestamptz;
  revision_transaction_id xid8;
  revision_period_count integer;
  employee_name text;
  inserted_periods integer;
BEGIN
  SELECT created_at,created_transaction_id,period_count INTO revision_created_at,revision_transaction_id,revision_period_count
    FROM payroll_employment_eligibility_revisions
    WHERE venue_id=NEW.venue_id AND id=NEW.revision_id;
  IF revision_created_at IS NULL OR revision_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'payroll employment periods must be inserted with their immutable revision' USING ERRCODE = '55000';
  END IF;

  SELECT full_name INTO employee_name FROM users WHERE venue_id=NEW.venue_id AND id=NEW.employee_id FOR SHARE;
  IF employee_name IS NULL OR length(btrim(employee_name)) = 0 THEN
    RAISE EXCEPTION 'payroll employment employee is unavailable in venue' USING ERRCODE = '23503';
  END IF;
  NEW.employee_name_snapshot := employee_name;

  IF EXISTS (
    SELECT 1 FROM payroll_employment_eligibility_periods existing
    WHERE existing.venue_id=NEW.venue_id AND existing.revision_id=NEW.revision_id AND existing.employee_id=NEW.employee_id
      AND (existing.effective_to IS NULL OR existing.effective_to >= NEW.effective_from)
      AND (NEW.effective_to IS NULL OR NEW.effective_to >= existing.effective_from)
  ) THEN
    RAISE EXCEPTION 'payroll employment periods overlap' USING ERRCODE = '23P01';
  END IF;

  SELECT count(*)::int INTO inserted_periods FROM payroll_employment_eligibility_periods
    WHERE venue_id=NEW.venue_id AND revision_id=NEW.revision_id;
  IF inserted_periods >= revision_period_count THEN
    RAISE EXCEPTION 'payroll employment revision period count exceeded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_validate_employment_eligibility_revision_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actual_count integer;
BEGIN
  SELECT count(*)::int INTO actual_count FROM payroll_employment_eligibility_periods
    WHERE venue_id=NEW.venue_id AND revision_id=NEW.id;
  IF actual_count IS DISTINCT FROM NEW.period_count THEN
    RAISE EXCEPTION 'payroll employment revision period count mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_reject_employment_eligibility_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payroll employment eligibility history is append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS payroll_employment_eligibility_revision_insert_guard ON payroll_employment_eligibility_revisions;
CREATE TRIGGER payroll_employment_eligibility_revision_insert_guard
  BEFORE INSERT ON payroll_employment_eligibility_revisions
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_employment_eligibility_revision();

DROP TRIGGER IF EXISTS payroll_employment_eligibility_revision_immutable ON payroll_employment_eligibility_revisions;
CREATE TRIGGER payroll_employment_eligibility_revision_immutable
  BEFORE UPDATE OR DELETE ON payroll_employment_eligibility_revisions
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_employment_eligibility_history_mutation();
DROP TRIGGER IF EXISTS payroll_employment_eligibility_period_immutable ON payroll_employment_eligibility_periods;
CREATE TRIGGER payroll_employment_eligibility_period_immutable
  BEFORE UPDATE OR DELETE ON payroll_employment_eligibility_periods
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_employment_eligibility_history_mutation();

DROP TRIGGER IF EXISTS payroll_employment_eligibility_period_insert_guard ON payroll_employment_eligibility_periods;
CREATE TRIGGER payroll_employment_eligibility_period_insert_guard
  BEFORE INSERT ON payroll_employment_eligibility_periods
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_employment_eligibility_period();

DROP TRIGGER IF EXISTS payroll_employment_eligibility_revision_count_guard ON payroll_employment_eligibility_revisions;
CREATE CONSTRAINT TRIGGER payroll_employment_eligibility_revision_count_guard
  AFTER INSERT ON payroll_employment_eligibility_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_employment_eligibility_revision_complete();

DROP TRIGGER IF EXISTS payroll_employment_eligibility_revision_truncate_guard ON payroll_employment_eligibility_revisions;
CREATE TRIGGER payroll_employment_eligibility_revision_truncate_guard
  BEFORE TRUNCATE ON payroll_employment_eligibility_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_employment_eligibility_history_mutation();
DROP TRIGGER IF EXISTS payroll_employment_eligibility_period_truncate_guard ON payroll_employment_eligibility_periods;
CREATE TRIGGER payroll_employment_eligibility_period_truncate_guard
  BEFORE TRUNCATE ON payroll_employment_eligibility_periods
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_employment_eligibility_history_mutation();
