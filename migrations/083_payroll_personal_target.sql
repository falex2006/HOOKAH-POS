-- Expand payroll-owned configuration only. Existing versions and snapshots are
-- untouched; typed incentive snapshot writing still requires a later contract.
-- Replacing these named checks is replay-safe and keeps every existing value.
ALTER TABLE payroll_scheme_versions
  DROP CONSTRAINT IF EXISTS payroll_scheme_versions_mode_check;
ALTER TABLE payroll_scheme_versions
  ADD CONSTRAINT payroll_scheme_versions_mode_check
  CHECK (mode IN ('progressive_daily','stable_percent','percent_only','final_month_threshold','personal_target'));

ALTER TABLE payroll_employee_overrides
  DROP CONSTRAINT IF EXISTS payroll_employee_overrides_parameter_path_check;
ALTER TABLE payroll_employee_overrides
  ADD CONSTRAINT payroll_employee_overrides_parameter_path_check
  CHECK (parameter_path ~ '^(mode|applyMilestones|perShiftCents|stableRateBps|targetCents|baseRateBps|bonusRateBps|excessRatePolicy|bracketRatesBps\.[0-9]+|cap\.(rateBps|basis)|milestoneBonusesCents\.[0-9]+)$');
