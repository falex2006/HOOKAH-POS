-- Explicit accrual recognition for approved business payables. Cash remains in expenses.
CREATE TABLE IF NOT EXISTS finance_payable_recognitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  payable_id uuid NOT NULL,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  title_snapshot text NOT NULL CHECK (length(btrim(title_snapshot)) BETWEEN 1 AND 160),
  counterparty_name_snapshot text NOT NULL DEFAULT '' CHECK (length(counterparty_name_snapshot) <= 160),
  basis_snapshot text NOT NULL DEFAULT '' CHECK (length(basis_snapshot) <= 500),
  service_period_from date NOT NULL,
  service_period_to date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  recognition_date date NOT NULL,
  document_reference text CHECK (document_reference IS NULL OR length(document_reference) <= 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,payable_id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,payable_id) REFERENCES finance_payables(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (service_period_to >= service_period_from)
);
CREATE INDEX IF NOT EXISTS finance_payable_recognitions_date_idx
  ON finance_payable_recognitions(venue_id,recognition_date,category_id);
CREATE INDEX IF NOT EXISTS finance_payable_recognitions_period_idx
  ON finance_payable_recognitions(venue_id,service_period_from,service_period_to,payable_id);

CREATE TABLE IF NOT EXISTS finance_payable_recognition_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  recognition_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reversal_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  document_reference text CHECK (document_reference IS NULL OR length(document_reference) <= 200),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,recognition_id) REFERENCES finance_payable_recognitions(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_payable_recognition_reversals_date_idx
  ON finance_payable_recognition_reversals(venue_id,reversal_date,recognition_id);

CREATE OR REPLACE FUNCTION guard_finance_payable_recognition_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p finance_payables%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_recognitions_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM finance_payables WHERE venue_id=NEW.venue_id AND id=NEW.payable_id FOR UPDATE;
  IF p.id IS NULL OR p.status <> 'approved' OR p.total_amount <> NEW.amount
      OR p.category_id <> NEW.category_id OR p.category_name_snapshot <> NEW.category_name_snapshot
      OR p.title <> NEW.title_snapshot OR p.counterparty_name <> NEW.counterparty_name_snapshot
      OR p.basis <> NEW.basis_snapshot OR p.period_from <> NEW.service_period_from OR p.period_to <> NEW.service_period_to THEN
    RAISE EXCEPTION 'finance_payable_recognition_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_recognitions_guard ON finance_payable_recognitions;
CREATE TRIGGER finance_payable_recognitions_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_recognitions
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_recognition_immutable();

CREATE OR REPLACE FUNCTION guard_finance_payable_recognition_reversal_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payable_row finance_payables%ROWTYPE; r finance_payable_recognitions%ROWTYPE; reversed numeric(14,2);
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'finance_payable_recognition_reversals_append_only' USING ERRCODE='55000'; END IF;
  SELECT fp.* INTO payable_row FROM finance_payables fp JOIN finance_payable_recognitions source
    ON source.venue_id=fp.venue_id AND source.payable_id=fp.id
    WHERE source.venue_id=NEW.venue_id AND source.id=NEW.recognition_id FOR UPDATE OF fp;
  SELECT * INTO r FROM finance_payable_recognitions WHERE venue_id=NEW.venue_id AND id=NEW.recognition_id;
  IF payable_row.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'finance_payable_recognition_not_found' USING ERRCODE='23503'; END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO reversed
    FROM finance_payable_recognition_reversals WHERE venue_id=NEW.venue_id AND recognition_id=NEW.recognition_id;
  IF reversed + NEW.amount > r.amount THEN RAISE EXCEPTION 'finance_payable_recognition_reversal_exceeds_balance' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_payable_recognition_reversals_guard ON finance_payable_recognition_reversals;
CREATE TRIGGER finance_payable_recognition_reversals_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_payable_recognition_reversals
  FOR EACH ROW EXECUTE FUNCTION guard_finance_payable_recognition_reversal_immutable();

-- A recognized obligation can only be cancelled after full recognition reversal;
-- existing payment links continue to prohibit cancellation of paid obligations.
CREATE OR REPLACE FUNCTION guard_finance_payable_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recognized numeric(14,2);
BEGIN
  IF OLD.status <> 'draft' AND (
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
    OR OLD.category_name_snapshot IS DISTINCT FROM NEW.category_name_snapshot OR OLD.title IS DISTINCT FROM NEW.title
    OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name OR OLD.basis IS DISTINCT FROM NEW.basis
    OR OLD.period_from IS DISTINCT FROM NEW.period_from OR OLD.period_to IS DISTINCT FROM NEW.period_to
    OR OLD.due_date IS DISTINCT FROM NEW.due_date OR OLD.total_amount IS DISTINCT FROM NEW.total_amount
    OR OLD.recurring_rule_id IS DISTINCT FROM NEW.recurring_rule_id OR OLD.recurring_version_id IS DISTINCT FROM NEW.recurring_version_id
    OR OLD.period_key IS DISTINCT FROM NEW.period_key
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
