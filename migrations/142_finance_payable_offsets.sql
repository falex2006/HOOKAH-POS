-- Non-cash redistribution of an existing contractual payment.
CREATE TABLE IF NOT EXISTS finance_payable_offsets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
 expense_id uuid NOT NULL,
 source_payable_id uuid NOT NULL,
 destination_payable_id uuid NOT NULL,
 amount numeric(14,2) NOT NULL CHECK(amount>0),
 offset_date date NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 document_reference text CHECK(length(document_reference)<=200),
 reversal_of_id uuid,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(venue_id,id), UNIQUE(venue_id,idempotency_key),
 CHECK(source_payable_id<>destination_payable_id),
 FOREIGN KEY(venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,source_payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,destination_payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,reversal_of_id) REFERENCES finance_payable_offsets(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_expense_idx ON finance_payable_offsets(venue_id,expense_id);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_source_idx ON finance_payable_offsets(venue_id,source_payable_id);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_destination_idx ON finance_payable_offsets(venue_id,destination_payable_id);
CREATE INDEX IF NOT EXISTS finance_payable_offsets_reversal_idx ON finance_payable_offsets(venue_id,reversal_of_id);

CREATE OR REPLACE FUNCTION finance_payable_expense_allocation(v uuid,e uuid,p uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT SUM(applied_amount) FROM finance_payable_payment_links WHERE venue_id=v AND expense_id=e AND payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_expense_refunds WHERE venue_id=v AND expense_id=e AND payable_id=p),0)
 +COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND expense_id=e AND destination_payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND expense_id=e AND source_payable_id=p),0))::numeric(14,2)
$$;
CREATE OR REPLACE FUNCTION finance_payable_settled_amount(v uuid,p uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT (COALESCE((SELECT SUM(applied_amount) FROM finance_payable_payment_links WHERE venue_id=v AND payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_expense_refunds WHERE venue_id=v AND payable_id=p),0)
 +COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND destination_payable_id=p),0)
 -COALESCE((SELECT SUM(amount) FROM finance_payable_offsets WHERE venue_id=v AND source_payable_id=p),0))::numeric(14,2)
$$;

CREATE OR REPLACE FUNCTION guard_finance_payable_offset()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin_id uuid; source_doc finance_payables%ROWTYPE; destination_doc finance_payables%ROWTYPE;
 source_expense expenses%ROWTYPE; original finance_payable_offsets%ROWTYPE; reversed numeric; tz text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_payable_offsets_append_only' USING ERRCODE='55000'; END IF;
 SELECT payable_id INTO origin_id FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
 IF origin_id IS NULL THEN RAISE EXCEPTION 'finance_payable_offset_payment_not_found' USING ERRCODE='23514'; END IF;
 -- All writers lock payable rows before expenses; include the original even for chained allocations.
 PERFORM id FROM finance_payables WHERE venue_id=NEW.venue_id AND id IN(origin_id,NEW.source_payable_id,NEW.destination_payable_id) ORDER BY id FOR UPDATE;
 SELECT * INTO source_doc FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.source_payable_id;
 SELECT * INTO destination_doc FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.destination_payable_id;
 IF source_doc.id IS NULL OR destination_doc.id IS NULL OR source_doc.status<>'approved' OR destination_doc.status<>'approved' THEN
  RAISE EXCEPTION 'finance_payable_offset_document_not_approved' USING ERRCODE='23514'; END IF;
 SELECT * INTO source_expense FROM expenses WHERE venue_id=NEW.venue_id AND id=NEW.expense_id FOR UPDATE;
 SELECT COALESCE(NULLIF(timezone,''),'Europe/Moscow') INTO tz FROM venues WHERE id=NEW.venue_id;
 IF NEW.offset_date<source_expense.expense_date OR NEW.offset_date>(now() AT TIME ZONE tz)::date THEN
  RAISE EXCEPTION 'finance_payable_offset_date_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.reversal_of_id IS NOT NULL THEN
  SELECT * INTO original FROM finance_payable_offsets WHERE venue_id=NEW.venue_id AND id=NEW.reversal_of_id;
  IF original.id IS NULL OR original.reversal_of_id IS NOT NULL OR original.expense_id<>NEW.expense_id
   OR original.source_payable_id<>NEW.destination_payable_id OR original.destination_payable_id<>NEW.source_payable_id
   OR NEW.offset_date<original.offset_date THEN
   RAISE EXCEPTION 'finance_payable_offset_reversal_invalid' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0) INTO reversed FROM finance_payable_offsets WHERE venue_id=NEW.venue_id AND reversal_of_id=original.id;
  IF reversed+NEW.amount>original.amount THEN RAISE EXCEPTION 'finance_payable_offset_reversal_exceeds_balance' USING ERRCODE='23514'; END IF;
 END IF;
 IF finance_payable_expense_allocation(NEW.venue_id,NEW.expense_id,NEW.source_payable_id)<NEW.amount THEN
  RAISE EXCEPTION 'finance_payable_offset_exceeds_allocation' USING ERRCODE='23514'; END IF;
 IF finance_payable_settled_amount(NEW.venue_id,NEW.destination_payable_id)+NEW.amount>destination_doc.total_amount THEN
  RAISE EXCEPTION 'finance_payable_offset_exceeds_debt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_offsets_guard ON finance_payable_offsets;
CREATE TRIGGER finance_payable_offsets_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_offsets FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_offset();
COMMENT ON TABLE finance_payable_offsets IS 'Append-only non-cash allocation of an existing expense payment. Never a new payment, cash receipt, or recognition event.';

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
  -- A link created while waiting for the expense lock requires a fresh transaction.
  IF linked_payable IS DISTINCT FROM (SELECT payable_id FROM finance_payable_payment_links WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_refund_source_changed' USING ERRCODE='40001'; END IF;
  IF linked_payable IS NOT NULL AND finance_payable_expense_allocation(NEW.venue_id,NEW.expense_id,linked_payable)<NEW.amount THEN
    RAISE EXCEPTION 'finance_expense_refund_exceeds_allocation' USING ERRCODE='23514'; END IF;
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
  paid:=finance_payable_settled_amount(NEW.venue_id,NEW.payable_id);
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
    IF finance_payable_settled_amount(OLD.venue_id,OLD.id)>0 THEN
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
