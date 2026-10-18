-- Versioned payroll configuration only. These keys select the existing scenario
-- department cap basis; they do not attest POS department/shift provenance.
-- No historical row, active version, snapshot, entry or expense is rewritten.
-- Run inside the migration runner transaction. Replaying preserves all paths.
ALTER TABLE payroll_employee_overrides
  DROP CONSTRAINT IF EXISTS payroll_employee_overrides_parameter_path_check;
ALTER TABLE payroll_employee_overrides
  ADD CONSTRAINT payroll_employee_overrides_parameter_path_check
  CHECK (parameter_path ~ '^(mode|applyMilestones|milestoneEligibility|perShiftCents|stableRateBps|targetCents|baseRateBps|bonusRateBps|excessRatePolicy|teamWeight|lossPolicy|itemRuleBasis|department|bracketRatesBps\.[0-9]+|cap\.(rateBps|basis|department)|milestoneBonusesCents\.[0-9]+)$');

-- Named configuration capability for service preflight on create/edit/activate.
-- Existing inherit/value-null, tenant FK, dated windows and immutable-version
-- guards remain in force. Only the two newly allowed paths receive this check.
-- char_length counts Unicode code points in the UTF-8 database, not UTF-16 units.
-- Explicit ECMAScript trim characters avoid locale-dependent POSIX whitespace.
-- JSONB rejects U+0000 and unpaired surrogates before this constraint is reached.
ALTER TABLE payroll_employee_overrides
  DROP CONSTRAINT IF EXISTS payroll_employee_overrides_department_value_check;
ALTER TABLE payroll_employee_overrides
  ADD CONSTRAINT payroll_employee_overrides_department_value_check
  CHECK (
    parameter_path NOT IN ('department','cap.department')
    OR override_mode = 'inherit'
    OR (
      override_mode = 'override'
      AND value_json IS NOT NULL
      AND jsonb_typeof(value_json) = 'string'
      AND char_length(value_json #>> '{}') BETWEEN 1 AND 80
      AND (value_json #>> '{}') = btrim(value_json #>> '{}',
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
      AND (value_json #>> '{}') !~ U&'[\0001-\001F\007F-\009F]'
    )
  );
