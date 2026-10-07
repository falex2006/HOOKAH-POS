-- Payroll configuration expansion only; preserve all earlier modes and paths.
-- Does not rewrite versions, snapshots, source ledgers or payment entries.
ALTER TABLE payroll_scheme_versions
  DROP CONSTRAINT IF EXISTS payroll_scheme_versions_mode_check;
ALTER TABLE payroll_scheme_versions
  ADD CONSTRAINT payroll_scheme_versions_mode_check
  CHECK (mode IN ('progressive_daily','stable_percent','percent_only','final_month_threshold','personal_target','team_fund'));

ALTER TABLE payroll_employee_overrides
  DROP CONSTRAINT IF EXISTS payroll_employee_overrides_parameter_path_check;
ALTER TABLE payroll_employee_overrides
  ADD CONSTRAINT payroll_employee_overrides_parameter_path_check
  CHECK (parameter_path ~ '^(mode|applyMilestones|perShiftCents|stableRateBps|targetCents|baseRateBps|bonusRateBps|excessRatePolicy|teamWeight|bracketRatesBps\.[0-9]+|cap\.(rateBps|basis)|milestoneBonusesCents\.[0-9]+)$');
