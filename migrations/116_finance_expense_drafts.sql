-- Persist manual expense drafts separately from the immutable cash-out journal.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS counterparty_name text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_counterparty_name_check' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_counterparty_name_check
      CHECK (counterparty_name IS NULL OR length(btrim(counterparty_name)) BETWEEN 1 AND 160);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS finance_expense_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_by uuid NOT NULL,
  updated_by uuid NOT NULL,
  category_id uuid NOT NULL,
  category_name_snapshot text NOT NULL CHECK (length(btrim(category_name_snapshot)) BETWEEN 1 AND 80),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  expense_date date NOT NULL,
  counterparty_name text CHECK (counterparty_name IS NULL OR length(btrim(counterparty_name)) BETWEEN 1 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  document_url text CHECK (document_url IS NULL OR length(document_url) <= 2000000),
  source text NOT NULL CHECK (source IN ('manual','other')),
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','bank_transfer','other')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  create_payload jsonb NOT NULL CHECK (jsonb_typeof(create_payload)='object'),
  create_idempotency_key text NOT NULL CHECK (length(create_idempotency_key) BETWEEN 8 AND 128),
  expense_id uuid,
  posted_at timestamptz,
  posted_by uuid,
  post_idempotency_key text,
  posted_version integer,
  cancelled_at timestamptz,
  cancelled_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,created_by,create_idempotency_key),
  UNIQUE (venue_id,expense_id),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,updated_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,posted_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,cancelled_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  CHECK ((status='draft' AND expense_id IS NULL AND posted_at IS NULL AND posted_by IS NULL AND post_idempotency_key IS NULL AND posted_version IS NULL AND cancelled_at IS NULL AND cancelled_by IS NULL)
    OR (status='posted' AND expense_id IS NOT NULL AND posted_at IS NOT NULL AND posted_by IS NOT NULL AND post_idempotency_key IS NOT NULL AND length(post_idempotency_key) BETWEEN 8 AND 128 AND posted_version IS NOT NULL AND posted_version > 0 AND cancelled_at IS NULL AND cancelled_by IS NULL)
    OR (status='cancelled' AND expense_id IS NULL AND posted_at IS NULL AND posted_by IS NULL AND post_idempotency_key IS NULL AND posted_version IS NULL AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finance_expense_drafts_venue_status_updated_idx
  ON finance_expense_drafts(venue_id,status,updated_at DESC,id);

CREATE OR REPLACE FUNCTION guard_finance_expense_draft_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'finance_expense_draft_immutable_delete' USING ERRCODE='55000';
  END IF;
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.created_by IS DISTINCT FROM NEW.created_by
    OR OLD.create_idempotency_key IS DISTINCT FROM NEW.create_idempotency_key
    OR OLD.create_payload IS DISTINCT FROM NEW.create_payload
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'finance_expense_draft_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'finance_expense_draft_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.version <> OLD.version + 1 AND NEW.status='draft' THEN
    RAISE EXCEPTION 'finance_expense_draft_version_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.status='posted' AND (NEW.category_id IS DISTINCT FROM OLD.category_id
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    OR NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.document_url IS DISTINCT FROM OLD.document_url OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.finance_account_id IS DISTINCT FROM OLD.finance_account_id OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'finance_expense_draft_post_payload_changed' USING ERRCODE='55000';
  END IF;
  IF NEW.status='posted' AND NOT EXISTS (
    SELECT 1 FROM expenses e
    WHERE e.venue_id=NEW.venue_id AND e.id=NEW.expense_id
      AND e.category_id=NEW.category_id AND e.category=NEW.category_name_snapshot
      AND e.amount=NEW.amount AND e.expense_date=NEW.expense_date
      AND e.counterparty_name IS NOT DISTINCT FROM NEW.counterparty_name
      AND e.description IS NOT DISTINCT FROM NEW.description
      AND e.source=NEW.source AND e.document_url IS NOT DISTINCT FROM NEW.document_url
      AND e.finance_account_id=NEW.finance_account_id
      AND e.finance_account_name_snapshot=NEW.finance_account_name_snapshot
      AND e.payment_method=NEW.payment_method
      AND e.idempotency_key=NEW.post_idempotency_key
      AND e.created_by=NEW.posted_by
      AND NEW.posted_version=NEW.version
  ) THEN
    RAISE EXCEPTION 'finance_expense_draft_post_expense_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.status='cancelled' AND (NEW.category_id IS DISTINCT FROM OLD.category_id
    OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    OR NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.document_url IS DISTINCT FROM OLD.document_url OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.finance_account_id IS DISTINCT FROM OLD.finance_account_id OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
    OR NEW.version IS DISTINCT FROM OLD.version) THEN
    RAISE EXCEPTION 'finance_expense_draft_cancel_payload_changed' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_expense_draft_lifecycle_guard ON finance_expense_drafts;
CREATE TRIGGER finance_expense_draft_lifecycle_guard
  BEFORE UPDATE OR DELETE ON finance_expense_drafts
  FOR EACH ROW EXECUTE FUNCTION guard_finance_expense_draft_lifecycle();

CREATE OR REPLACE FUNCTION guard_posted_expense_draft_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM finance_expense_drafts d WHERE d.venue_id=OLD.venue_id AND d.expense_id=OLD.id AND d.status='posted') THEN
    RAISE EXCEPTION 'posted_finance_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.source IN ('manual','other') AND TG_OP='DELETE' THEN
    RAISE EXCEPTION 'posted_finance_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND OLD.source IN ('manual','other') THEN
    -- Payroll may adopt an existing expense only through its linked payroll entry.
    IF OLD.source='manual' AND NEW.source='payroll'
      AND OLD.venue_id IS NOT DISTINCT FROM NEW.venue_id
      AND OLD.counterparty_name IS NOT DISTINCT FROM NEW.counterparty_name
      AND OLD.document_url IS NOT DISTINCT FROM NEW.document_url
      AND OLD.payment_method IS NOT DISTINCT FROM NEW.payment_method
      AND OLD.finance_account_id IS NOT DISTINCT FROM NEW.finance_account_id
      AND OLD.finance_account_name_snapshot IS NOT DISTINCT FROM NEW.finance_account_name_snapshot
      AND OLD.shift_id IS NOT DISTINCT FROM NEW.shift_id
      AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
      AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
      AND EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.expense_id=OLD.id
        AND pe.status='approved' AND pe.amount=NEW.amount
        AND pe.finance_category_id IS NOT DISTINCT FROM NEW.category_id
        AND COALESCE(pe.finance_category_name_snapshot,'Зарплата')=NEW.category
        AND NEW.description='Выплата зарплаты за ' || to_char(pe.period_from,'DD.MM.YYYY') || ' — ' || to_char(pe.period_to,'DD.MM.YYYY')) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'posted_finance_expense_immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS posted_expense_draft_source_guard ON expenses;
CREATE TRIGGER posted_expense_draft_source_guard
  BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_posted_expense_draft_source();

-- Preserve a category's direction after it is used by any finance source.
CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_payables p WHERE p.venue_id=OLD.venue_id AND p.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_recurring_rules r WHERE r.venue_id=OLD.venue_id AND r.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_expense_drafts d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_income_category_mappings m WHERE m.venue_id=OLD.venue_id AND m.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM pos_order_income_category_allocations a WHERE a.venue_id=OLD.venue_id AND a.category_id=OLD.id)
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();
