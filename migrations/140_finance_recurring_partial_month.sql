-- Explicit calendar-day proration. Existing rules retain full-month-only behavior.
ALTER TABLE finance_recurring_rules ADD COLUMN IF NOT EXISTS partial_month_policy text NOT NULL DEFAULT 'full_months_only';
ALTER TABLE finance_recurring_rules DROP CONSTRAINT IF EXISTS finance_recurring_partial_month_policy_check;
ALTER TABLE finance_recurring_rules ADD CONSTRAINT finance_recurring_partial_month_policy_check
  CHECK (partial_month_policy IN ('full_months_only','calendar_days'));
ALTER TABLE finance_payables ADD COLUMN IF NOT EXISTS proration_snapshot jsonb;
ALTER TABLE finance_payables DROP CONSTRAINT IF EXISTS finance_payables_proration_snapshot_check;
ALTER TABLE finance_payables ADD CONSTRAINT finance_payables_proration_snapshot_check CHECK (
  proration_snapshot IS NULL OR COALESCE((recurring_rule_id IS NOT NULL AND recurring_version_id IS NOT NULL
    AND jsonb_typeof(proration_snapshot)='object'
    AND proration_snapshot->>'policy'='calendar_days'
    AND proration_snapshot->>'calculationVersion'='1'
    AND jsonb_typeof(proration_snapshot->'monthlyLines')='array'
    AND jsonb_typeof(proration_snapshot->'calculatedLines')='array'
    AND (proration_snapshot->>'monthlyAmount')::numeric>=0
    AND (proration_snapshot->>'calculatedAmount')::numeric>=0
    AND (proration_snapshot->>'coveredTo')::date-(proration_snapshot->>'coveredFrom')::date+1=(proration_snapshot->>'coveredDays')::integer
    AND (proration_snapshot->>'coveredDays')::integer BETWEEN 1 AND 30
    AND (proration_snapshot->>'monthDays')::integer BETWEEN 28 AND 31
    AND (proration_snapshot->>'coveredDays')::integer < (proration_snapshot->>'monthDays')::integer
    AND proration_snapshot ?& ARRAY['calculationVersion','policy','coveredFrom','coveredTo','coveredDays','monthDays','monthlyAmount','monthlyLines','calculatedAmount','calculatedLines']),false));

CREATE OR REPLACE FUNCTION guard_finance_recurring_partial_policy()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.partial_month_policy IS DISTINCT FROM NEW.partial_month_policy THEN
    RAISE EXCEPTION 'finance_recurring_partial_policy_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_recurring_partial_policy_guard ON finance_recurring_rules;
CREATE TRIGGER finance_recurring_partial_policy_guard BEFORE UPDATE ON finance_recurring_rules
  FOR EACH ROW EXECUTE FUNCTION guard_finance_recurring_partial_policy();

CREATE OR REPLACE FUNCTION guard_finance_payable_proration_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.proration_snapshot IS DISTINCT FROM NEW.proration_snapshot THEN
    RAISE EXCEPTION 'finance_payable_proration_snapshot_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_proration_snapshot_guard ON finance_payables;
CREATE TRIGGER finance_payable_proration_snapshot_guard BEFORE UPDATE ON finance_payables
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_proration_snapshot();
