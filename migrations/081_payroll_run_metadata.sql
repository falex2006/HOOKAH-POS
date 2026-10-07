-- Snapshot the venue calendar and scheme currency on newly created payroll runs.
-- Historical runs remain NULL because their original values cannot be inferred.

ALTER TABLE payroll_calculation_runs
  ADD COLUMN IF NOT EXISTS venue_timezone text;

ALTER TABLE payroll_calculation_runs
  ADD COLUMN IF NOT EXISTS currency char(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payroll_calculation_runs'::regclass
      AND conname = 'payroll_calculation_runs_metadata_pair_check'
  ) THEN
    ALTER TABLE payroll_calculation_runs
      ADD CONSTRAINT payroll_calculation_runs_metadata_pair_check
      CHECK ((venue_timezone IS NULL) = (currency IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payroll_calculation_runs'::regclass
      AND conname = 'payroll_calculation_runs_currency_format_check'
  ) THEN
    ALTER TABLE payroll_calculation_runs
      ADD CONSTRAINT payroll_calculation_runs_currency_format_check
      CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_validate_calculation_run_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  configured_timezone text;
  configured_currency char(3);
BEGIN
  IF NEW.venue_timezone IS NULL OR btrim(NEW.venue_timezone) = '' OR NEW.currency IS NULL THEN
    RAISE EXCEPTION 'new payroll runs require immutable timezone and currency snapshots'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name = NEW.venue_timezone
  ) THEN
    RAISE EXCEPTION 'payroll run timezone must be a recognized IANA timezone'
      USING ERRCODE = '23514';
  END IF;

  EXECUTE format(
    'SELECT v.timezone,sv.currency
       FROM %I.venues v
       JOIN %I.payroll_scheme_versions sv ON sv.venue_id=v.id
      WHERE v.id=$1 AND sv.id=$2
      FOR SHARE OF v,sv',
    TG_TABLE_SCHEMA,
    TG_TABLE_SCHEMA
  ) INTO configured_timezone,configured_currency
    USING NEW.venue_id,NEW.scheme_version_id;

  IF configured_timezone IS NULL OR configured_currency IS NULL THEN
    RAISE EXCEPTION 'payroll run venue or scheme version is unavailable'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.venue_timezone IS DISTINCT FROM configured_timezone THEN
    RAISE EXCEPTION 'payroll run timezone snapshot must match the venue timezone'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.currency IS DISTINCT FROM configured_currency THEN
    RAISE EXCEPTION 'payroll run currency snapshot must match the scheme version currency'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_calculation_runs_metadata_guard ON payroll_calculation_runs;
CREATE TRIGGER payroll_calculation_runs_metadata_guard
  BEFORE INSERT ON payroll_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_calculation_run_metadata();
