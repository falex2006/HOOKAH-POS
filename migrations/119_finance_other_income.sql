-- Non-POS business income has its own recognition document and cash-receipt
-- events. Do not reuse POS tenders or the expense ledger.
CREATE TABLE IF NOT EXISTS finance_other_income_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  counterparty_name text NOT NULL DEFAULT '' CHECK (length(counterparty_name) <= 160),
  basis text NOT NULL DEFAULT '' CHECK (length(basis) <= 500),
  document_reference text NOT NULL DEFAULT '' CHECK (length(document_reference) <= 160),
  recognition_date date NOT NULL,
  total_amount numeric(14,2) NOT NULL CHECK (total_amount > 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  created_by uuid,
  posted_by uuid,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,posted_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK ((status='posted' AND posted_by IS NOT NULL AND posted_at IS NOT NULL)
      OR (status<>'posted' AND posted_by IS NULL AND posted_at IS NULL))
);
CREATE INDEX IF NOT EXISTS finance_other_income_documents_date_idx
  ON finance_other_income_documents(venue_id,recognition_date,status,category_id);

CREATE TABLE IF NOT EXISTS finance_other_income_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  receipt_date date NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr','bank_transfer','other')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,document_id) REFERENCES finance_other_income_documents(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_document_idx
  ON finance_other_income_receipts(venue_id,document_id,receipt_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_date_idx
  ON finance_other_income_receipts(venue_id,receipt_date,document_id);

CREATE OR REPLACE FUNCTION guard_finance_other_income_document()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'finance_other_income_document_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN
    RAISE EXCEPTION 'finance_other_income_document_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'finance_other_income_venue_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status NOT IN ('draft','posted','cancelled') THEN
    RAISE EXCEPTION 'finance_other_income_document_transition_invalid' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='cancelled'
      AND (OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.category_id IS DISTINCT FROM NEW.category_id
        OR OLD.title IS DISTINCT FROM NEW.title OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name
        OR OLD.basis IS DISTINCT FROM NEW.basis OR OLD.document_reference IS DISTINCT FROM NEW.document_reference
        OR OLD.recognition_date IS DISTINCT FROM NEW.recognition_date OR OLD.total_amount IS DISTINCT FROM NEW.total_amount) THEN
    RAISE EXCEPTION 'finance_other_income_document_transition_invalid' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    SELECT name,kind,active INTO category_name,category_kind,category_active
      FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'income' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_other_income_category_invalid' USING ERRCODE='23514';
    END IF;
    NEW.category_name_snapshot := category_name;
  ELSIF TG_OP='UPDATE' AND OLD.category_id IS DISTINCT FROM NEW.category_id THEN
    SELECT name,kind,active INTO category_name,category_kind,category_active
      FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'income' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_other_income_category_invalid' USING ERRCODE='23514';
    END IF;
    NEW.category_name_snapshot := category_name;
  ELSIF TG_OP='UPDATE' THEN
    NEW.category_name_snapshot := OLD.category_name_snapshot;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='posted' THEN
    SELECT name,kind,active INTO category_name,category_kind,category_active
      FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR KEY SHARE;
    IF category_kind IS DISTINCT FROM 'income' OR category_active IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'finance_other_income_category_invalid' USING ERRCODE='23514';
    END IF;
    NEW.category_name_snapshot := category_name;
    NEW.posted_at := COALESCE(NEW.posted_at,now());
    IF NEW.posted_by IS NULL THEN RAISE EXCEPTION 'finance_other_income_actor_required' USING ERRCODE='23514'; END IF;
  ELSE
    NEW.posted_at := NULL;
    NEW.posted_by := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_document_guard ON finance_other_income_documents;
CREATE TRIGGER finance_other_income_document_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_documents
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_document();

CREATE OR REPLACE FUNCTION guard_finance_other_income_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document finance_other_income_documents%ROWTYPE; received numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_other_income_receipts_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO document FROM finance_other_income_documents
    WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF document.id IS NULL OR document.status<>'posted' THEN
    RAISE EXCEPTION 'finance_other_income_document_not_receivable' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(SUM(amount),0)::numeric(14,2) INTO received FROM finance_other_income_receipts
    WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id;
  IF received+NEW.amount>document.total_amount THEN
    RAISE EXCEPTION 'finance_other_income_receipt_exceeds_balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_receipt_guard ON finance_other_income_receipts;
CREATE TRIGGER finance_other_income_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_other_income_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_receipt();

CREATE OR REPLACE FUNCTION guard_finance_other_income_category_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS (
    SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id
  ) THEN RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_category_kind_guard ON finance_categories;
CREATE TRIGGER finance_other_income_category_kind_guard
  BEFORE UPDATE OF kind ON finance_categories FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_category_kind();
