-- Candidate only: not part of the migration chain. All DDL and preflight run
-- under one table lock; failure leaves existing payroll entries untouched.
LOCK TABLE payroll_entries IN ACCESS EXCLUSIVE MODE;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM payroll_entries WHERE status IN ('draft','approved','paid')
    AND (venue_id IS NULL OR user_id IS NULL OR period_from IS NULL OR period_to IS NULL
      OR NOT isfinite(period_from) OR NOT isfinite(period_to) OR period_to < period_from)) THEN
    RAISE EXCEPTION 'payroll_active_period_invalid_preflight' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM payroll_entries a JOIN payroll_entries b
    ON a.venue_id=b.venue_id AND a.user_id=b.user_id AND a.id<b.id
    WHERE a.status IN ('draft','approved','paid') AND b.status IN ('draft','approved','paid')
      AND a.period_from<=b.period_to AND b.period_from<=a.period_to) THEN
    RAISE EXCEPTION 'payroll_active_period_overlap_preflight' USING ERRCODE='23P01';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass
    AND conname='payroll_entries_active_period_valid') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_active_period_valid CHECK (
      status NOT IN ('draft','approved','paid') OR
      (venue_id IS NOT NULL AND user_id IS NOT NULL AND period_from IS NOT NULL AND period_to IS NOT NULL
        AND isfinite(period_from) AND isfinite(period_to) AND period_to>=period_from));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass
    AND conname='payroll_entries_active_period_exclusion') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_active_period_exclusion
      EXCLUDE USING gist (venue_id WITH =, user_id WITH =, daterange(period_from,period_to,'[]') WITH &&)
      WHERE (status IN ('draft','approved','paid'));
  END IF;
END $$;

-- Build canonical definitions using the actual column types. Names alone do not
-- prove that a prior installation enforces the intended predicates/operators.
CREATE TEMP TABLE payroll_overlap_expected (LIKE payroll_entries) ON COMMIT DROP;
ALTER TABLE payroll_overlap_expected ADD CONSTRAINT payroll_entries_active_period_valid CHECK (
  status NOT IN ('draft','approved','paid') OR
  (venue_id IS NOT NULL AND user_id IS NOT NULL AND period_from IS NOT NULL AND period_to IS NOT NULL
    AND isfinite(period_from) AND isfinite(period_to) AND period_to>=period_from));
ALTER TABLE payroll_overlap_expected ADD CONSTRAINT payroll_entries_active_period_exclusion
  EXCLUDE USING gist (venue_id WITH =, user_id WITH =, daterange(period_from,period_to,'[]') WITH &&)
  WHERE (status IN ('draft','approved','paid'));
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint expected
    LEFT JOIN pg_constraint actual ON actual.conrelid='payroll_entries'::regclass
      AND actual.conname=expected.conname
    WHERE expected.conrelid='pg_temp.payroll_overlap_expected'::regclass
      AND (actual.oid IS NULL OR actual.contype<>expected.contype OR NOT actual.convalidated
        OR pg_get_constraintdef(actual.oid) IS DISTINCT FROM pg_get_constraintdef(expected.oid))
  ) THEN
    RAISE EXCEPTION 'payroll_active_period_constraint_definition_mismatch' USING ERRCODE='23514';
  END IF;
END $$;
DROP TABLE pg_temp.payroll_overlap_expected;
