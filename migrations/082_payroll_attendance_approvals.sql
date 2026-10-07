-- Payroll-owned frozen approvals over mutable HR schedules/work logs.
-- The source tables are read-only to this feature; no payroll entries or
-- expenses are created by approval.
CREATE TABLE IF NOT EXISTS payroll_attendance_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  period_from date NOT NULL,
  period_to date NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  venue_timezone text NOT NULL CHECK (length(btrim(venue_timezone)) BETWEEN 1 AND 80),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  source_watermark char(64) NOT NULL CHECK (source_watermark ~ '^[0-9a-f]{64}$'),
  source_schedule_count integer NOT NULL CHECK (source_schedule_count >= 0),
  source_log_count integer NOT NULL CHECK (source_log_count >= 0),
  shift_count integer NOT NULL CHECK (shift_count >= 0),
  approved_by uuid NOT NULL,
  approved_by_name text NOT NULL CHECK (length(btrim(approved_by_name)) BETWEEN 1 AND 160),
  approved_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 8 AND 120),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, period_from, period_to, revision),
  UNIQUE (venue_id, idempotency_key),
  CHECK (period_to >= period_from),
  CHECK (date_trunc('month', period_from::timestamp) = date_trunc('month', period_to::timestamp)),
  CONSTRAINT payroll_attendance_approvals_owner_venue_fk
    FOREIGN KEY (venue_id, approved_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_attendance_approvals_period_idx
  ON payroll_attendance_approvals (venue_id, period_from, period_to, revision DESC);

CREATE TABLE IF NOT EXISTS payroll_attendance_approval_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  approval_id uuid NOT NULL,
  schedule_source_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name_snapshot text NOT NULL CHECK (length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160),
  work_date date NOT NULL,
  planned_start timestamptz NOT NULL,
  planned_end timestamptz NOT NULL,
  planned_minutes integer NOT NULL CHECK (planned_minutes > 0 AND planned_minutes <= 1440),
  worked_minutes integer NOT NULL CHECK (worked_minutes >= 0 AND worked_minutes <= planned_minutes),
  source_interval_count integer NOT NULL CHECK (source_interval_count >= 0),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, approval_id, id),
  UNIQUE (venue_id, approval_id, schedule_source_id),
  CHECK (planned_end > planned_start),
  CONSTRAINT payroll_attendance_approval_shifts_header_fk
    FOREIGN KEY (venue_id, approval_id) REFERENCES payroll_attendance_approvals (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_attendance_approval_shifts_employee_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_attendance_approval_shifts_employee_date_idx
  ON payroll_attendance_approval_shifts (venue_id, employee_id, work_date);

CREATE TABLE IF NOT EXISTS payroll_attendance_approval_intervals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  approval_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  source_work_log_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('manual','shift','device')),
  UNIQUE (venue_id, approval_id, source_work_log_id),
  CHECK (ended_at > started_at),
  CONSTRAINT payroll_attendance_approval_intervals_shift_fk
    FOREIGN KEY (venue_id, approval_id, shift_id) REFERENCES payroll_attendance_approval_shifts (venue_id, approval_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_attendance_approval_intervals_employee_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_attendance_approval_intervals_shift_idx
  ON payroll_attendance_approval_intervals (venue_id, approval_id, shift_id, started_at);

CREATE OR REPLACE FUNCTION payroll_reject_attendance_approval_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payroll attendance approvals are append-only' USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_attendance_approvals',
    'payroll_attendance_approval_shifts',
    'payroll_attendance_approval_intervals'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_reject_attendance_approval_mutation()', table_name || '_immutable', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_no_truncate', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_attendance_approval_mutation()', table_name || '_no_truncate', table_name);
  END LOOP;
END $$;
