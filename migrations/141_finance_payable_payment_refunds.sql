-- Extend the existing cash-refund ledger to exact payments of contractual obligations.
ALTER TABLE finance_expense_refunds ADD COLUMN IF NOT EXISTS payable_id uuid;
ALTER TABLE finance_expense_refunds DROP CONSTRAINT IF EXISTS finance_expense_refunds_payable_fk;
ALTER TABLE finance_expense_refunds ADD CONSTRAINT finance_expense_refunds_payable_fk
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT;
ALTER TABLE finance_expense_refunds DROP CONSTRAINT IF EXISTS finance_expense_refunds_pnl_effect_check;
ALTER TABLE finance_expense_refunds ADD CONSTRAINT finance_expense_refunds_pnl_effect_check
  CHECK ((payable_id IS NULL AND pnl_effect='not_calculated') OR (payable_id IS NOT NULL AND pnl_effect='separate_payable_recognition'));
CREATE INDEX IF NOT EXISTS finance_expense_refunds_payable_idx ON finance_expense_refunds(venue_id,payable_id,refund_date,id);
COMMENT ON TABLE finance_expense_refunds IS 'Append-only cash receipts against exact manual/other expenses or contractual payable payments. Payable recognition and reversals remain separate events.';
COMMENT ON COLUMN finance_expense_refunds.payable_id IS 'Derived under the payable row lock from the immutable expense payment link; never inferred from labels.';

CREATE OR REPLACE FUNCTION guard_finance_expense_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  linked_payable uuid;
  destination_account finance_accounts%ROWTYPE;
  open_shift_id uuid;
  open_shift_count integer;
  already_returned numeric(14,2);
  venue_timezone text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_refunds_append_only' USING ERRCODE='55000';
  END IF;

  SELECT payable_id INTO linked_payable FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF linked_payable IS NOT NULL THEN
    PERFORM 1 FROM finance_payables WHERE venue_id=NEW.venue_id AND id=linked_payable AND status='approved' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'finance_payable_not_approved' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.payable_id IS NOT NULL AND NEW.payable_id IS DISTINCT FROM linked_payable THEN
    RAISE EXCEPTION 'finance_expense_refund_payable_mismatch' USING ERRCODE='23514';
  END IF;
  NEW.payable_id:=linked_payable;
  NEW.pnl_effect:=CASE WHEN linked_payable IS NULL THEN 'not_calculated' ELSE 'separate_payable_recognition' END;
  SELECT * INTO source_expense FROM expenses
    WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_expense_refund_source_not_found' USING ERRCODE='23503'; END IF;
  IF source_expense.source NOT IN ('manual','other') OR source_expense.purchase_document_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM payroll_entries WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_refund_not_supported' USING ERRCODE='23514';
  END IF;
  IF NEW.refund_date<source_expense.expense_date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_before_expense' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
  IF NEW.refund_date>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
    RAISE EXCEPTION 'finance_expense_refund_date_in_future' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO already_returned FROM finance_expense_refunds
    WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF already_returned+NEW.amount>source_expense.amount THEN
    RAISE EXCEPTION 'finance_expense_refund_exceeds_balance' USING ERRCODE='23514';
  END IF;

  SELECT * INTO destination_account FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF NOT FOUND OR NOT destination_account.active THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM destination_account.name THEN
    RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.payment_method=ANY(destination_account.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF destination_account.kind='pos_cashbox' THEN
    IF NEW.payment_method<>'cash' THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
    IF NEW.refund_date<>(now() AT TIME ZONE COALESCE(venue_timezone,'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_pos_cash_payment_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO open_shift_id FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT count(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM open_shift_id THEN
      RAISE EXCEPTION 'finance_payment_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_expense_refund_non_pos_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION guard_finance_payable_payment_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE; e expenses%ROWTYPE; paid numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_payment_links_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  SELECT * INTO e FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR KEY SHARE;
  IF p.id IS NULL OR p.status <> 'approved' OR e.id IS NULL OR e.source <> 'manual'
      OR e.amount <> NEW.applied_amount OR e.category_id <> p.category_id
      OR EXISTS(SELECT 1 FROM finance_expense_refunds WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_payable_payment_link_invalid' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(applied_amount),0)::numeric(14,2) INTO paid FROM finance_payable_payment_links
    WHERE venue_id=NEW.venue_id AND payable_id=NEW.payable_id;
  paid:=paid-(SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=NEW.venue_id AND payable_id=NEW.payable_id);
  IF paid + NEW.applied_amount > p.total_amount THEN
    RAISE EXCEPTION 'finance_payable_payment_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
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
    IF (SELECT COALESCE(SUM(applied_amount),0) FROM finance_payable_payment_links WHERE venue_id=OLD.venue_id AND payable_id=OLD.id)
       > (SELECT COALESCE(SUM(amount),0) FROM finance_expense_refunds WHERE venue_id=OLD.venue_id AND payable_id=OLD.id) THEN
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
