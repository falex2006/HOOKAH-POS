ALTER TABLE finance_payables
  ADD COLUMN IF NOT EXISTS variable_amount_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS variable_amount_confirmed_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='finance_payables_variable_amount_confirmed_by_fk'
      AND conrelid='finance_payables'::regclass
  ) THEN
    ALTER TABLE finance_payables
      ADD CONSTRAINT finance_payables_variable_amount_confirmed_by_fk
      FOREIGN KEY (venue_id,variable_amount_confirmed_by)
      REFERENCES users(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='finance_payables_variable_amount_confirmation_pair_check'
      AND conrelid='finance_payables'::regclass
  ) THEN
    ALTER TABLE finance_payables
      ADD CONSTRAINT finance_payables_variable_amount_confirmation_pair_check
      CHECK ((variable_amount_confirmed_at IS NULL) = (variable_amount_confirmed_by IS NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recognized numeric(14,2);
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot
    OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
    OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.period_from IS DISTINCT FROM NEW.period_from
    OR OLD.period_to IS DISTINCT FROM NEW.period_to OR OLD.due_date IS DISTINCT FROM NEW.due_date
    OR OLD.total_amount IS DISTINCT FROM NEW.total_amount OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id
    OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id OR OLD.period_key IS DISTINCT FROM NEW.period_key
    OR OLD.variable_amount_confirmed_at IS DISTINCT FROM NEW.variable_amount_confirmed_at
    OR OLD.variable_amount_confirmed_by IS DISTINCT FROM NEW.variable_amount_confirmed_by
  ) THEN RAISE EXCEPTION 'finance_payable_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.status='approved' AND NEW.status='cancelled' THEN
    IF EXISTS (SELECT 1 FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
      RAISE EXCEPTION 'finance_payable_has_payments' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(r.amount,0)-COALESCE(SUM(x.amount),0) INTO recognized
      FROM finance_payable_recognitions r LEFT JOIN finance_payable_recognition_reversals x
        ON x.venue_id=r.venue_id AND x.recognition_id=r.id
      WHERE r.venue_id=OLD.venue_id AND r.payable_id=OLD.id GROUP BY r.amount;
    IF COALESCE(recognized,0)>0 THEN RAISE EXCEPTION 'finance_payable_has_recognition' USING ERRCODE='23514'; END IF;
  ELSIF OLD.status <> NEW.status AND NOT (OLD.status='draft' AND NEW.status IN ('approved','cancelled')) THEN
    RAISE EXCEPTION 'finance_payable_transition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION validate_finance_payable_posting()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_total numeric(14,2); category_kind text; category_active boolean; variable_amount boolean;
BEGIN
  IF OLD.status='draft' AND NEW.status='approved' THEN
    SELECT kind,active INTO category_kind,category_active FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'expense' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_payable_category_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(bool_or(variable_amount),false) INTO variable_amount
      FROM finance_recurring_rule_versions
      WHERE venue_id=NEW.venue_id AND rule_id=NEW.recurring_rule_id AND id=NEW.recurring_version_id;
    IF variable_amount AND (NEW.variable_amount_confirmed_at IS NULL OR NEW.variable_amount_confirmed_by IS NULL) THEN
      RAISE EXCEPTION 'finance_payable_variable_amount_confirmation_required' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO line_total
      FROM finance_payable_lines WHERE venue_id=NEW.venue_id AND payable_id=NEW.id;
    IF line_total <> NEW.total_amount THEN
      RAISE EXCEPTION 'finance_payable_lines_total_mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
