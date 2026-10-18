-- Append-only correction events for recognized non-POS income and cash refunds.
CREATE TABLE IF NOT EXISTS finance_other_income_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  correction_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  document_reference text NOT NULL DEFAULT '' CHECK (length(document_reference) <= 160),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,document_id) REFERENCES finance_other_income_documents(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_other_income_corrections_document_idx
  ON finance_other_income_corrections(venue_id,document_id,correction_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_other_income_corrections_date_idx
  ON finance_other_income_corrections(venue_id,correction_date,document_id);

CREATE OR REPLACE FUNCTION guard_finance_other_income_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document finance_other_income_documents%ROWTYPE; corrected numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_other_income_corrections_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO document FROM finance_other_income_documents WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF document.id IS NULL OR document.status<>'posted' THEN
    RAISE EXCEPTION 'finance_other_income_document_not_correctable' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO corrected FROM finance_other_income_corrections
    WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id;
  IF corrected+NEW.amount>document.total_amount THEN
    RAISE EXCEPTION 'finance_other_income_correction_exceeds_recognition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_correction_guard ON finance_other_income_corrections;
CREATE TRIGGER finance_other_income_correction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_correction();

CREATE TABLE IF NOT EXISTS finance_other_income_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  refund_date date NOT NULL,
  payout_method text NOT NULL CHECK (payout_method IN ('cash','card','qr','bank_transfer','other')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,document_id) REFERENCES finance_other_income_documents(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,receipt_id) REFERENCES finance_other_income_receipts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_receipt_idx
  ON finance_other_income_refunds(venue_id,receipt_id,refund_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_date_idx
  ON finance_other_income_refunds(venue_id,refund_date,document_id);

CREATE OR REPLACE FUNCTION guard_finance_other_income_refund()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document finance_other_income_documents%ROWTYPE; receipt finance_other_income_receipts%ROWTYPE; refunded numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_other_income_refunds_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO document FROM finance_other_income_documents WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF document.id IS NULL OR document.status<>'posted' THEN
    RAISE EXCEPTION 'finance_other_income_document_not_refundable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO receipt FROM finance_other_income_receipts WHERE venue_id=NEW.venue_id AND id=NEW.receipt_id AND document_id=NEW.document_id FOR UPDATE;
  IF receipt.id IS NULL THEN RAISE EXCEPTION 'finance_other_income_receipt_not_found' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO refunded FROM finance_other_income_refunds
    WHERE venue_id=NEW.venue_id AND receipt_id=NEW.receipt_id;
  IF refunded+NEW.amount>receipt.amount THEN
    RAISE EXCEPTION 'finance_other_income_refund_exceeds_receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_refund_guard ON finance_other_income_refunds;
CREATE TRIGGER finance_other_income_refund_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_refunds
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_refund();
