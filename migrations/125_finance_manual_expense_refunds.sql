-- Actual cash returned to a venue for an exact, unlinked manual expense.
-- This is a cash receipt only; it does not mutate expenses or P&L recognition.
CREATE TABLE IF NOT EXISTS finance_expense_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  refund_date date NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr','bank_transfer','other')),
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 160),
  shift_id uuid,
  document_reference text CHECK (document_reference IS NULL OR length(document_reference) <= 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  pnl_effect text NOT NULL DEFAULT 'not_calculated' CHECK (pnl_effect='not_calculated'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_expense_refunds_expense_idx
  ON finance_expense_refunds(venue_id,expense_id,refund_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_expense_refunds_date_idx
  ON finance_expense_refunds(venue_id,refund_date,created_at,id);

COMMENT ON TABLE finance_expense_refunds IS
  'Append-only positive cash receipts tied to exact manual/other expenses. No P&L, supplier, payable, payroll or inventory effect is calculated.';
COMMENT ON COLUMN finance_expense_refunds.pnl_effect IS
  'Explicitly uncalculated. The receipt is excluded from expense/P&L recognition and business-income totals.';

CREATE OR REPLACE FUNCTION guard_finance_expense_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  destination_account finance_accounts%ROWTYPE;
  open_shift_id uuid;
  open_shift_count integer;
  already_returned numeric(14,2);
  venue_timezone text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_refunds_append_only' USING ERRCODE='55000';
  END IF;

  SELECT * INTO source_expense FROM expenses
    WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_expense_refund_source_not_found' USING ERRCODE='23503'; END IF;
  IF source_expense.source NOT IN ('manual','other') OR source_expense.purchase_document_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id)
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

DROP TRIGGER IF EXISTS finance_expense_refunds_guard ON finance_expense_refunds;
CREATE TRIGGER finance_expense_refunds_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_expense_refunds
  FOR EACH ROW EXECUTE FUNCTION guard_finance_expense_refund();
