-- Explicit finance-category classification for persisted payroll accruals and
-- supplier documents. Historical source records remain unclassified.

ALTER TABLE payroll_entries
  ADD COLUMN IF NOT EXISTS finance_category_id uuid,
  ADD COLUMN IF NOT EXISTS finance_category_name_snapshot text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payroll_entries_finance_category_fk' AND conrelid='payroll_entries'::regclass) THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_finance_category_fk
      FOREIGN KEY (venue_id,finance_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE inventory_purchase_documents
  ADD COLUMN IF NOT EXISTS finance_category_id uuid,
  ADD COLUMN IF NOT EXISTS finance_category_name_snapshot text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_purchase_documents_finance_category_fk' AND conrelid='inventory_purchase_documents'::regclass) THEN
    ALTER TABLE inventory_purchase_documents ADD CONSTRAINT inventory_purchase_documents_finance_category_fk
      FOREIGN KEY (venue_id,finance_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payroll_entries_venue_finance_category_idx
  ON payroll_entries(venue_id,finance_category_id) WHERE finance_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inventory_purchase_documents_venue_finance_category_idx
  ON inventory_purchase_documents(venue_id,finance_category_id) WHERE finance_category_id IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_payroll_finance_category()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  -- Never allow a classified historical entry to be moved between tenants.
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id
     AND (OLD.finance_category_id IS NOT NULL OR NEW.finance_category_id IS NOT NULL
       OR OLD.finance_category_name_snapshot IS NOT NULL OR NEW.finance_category_name_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'payroll_finance_category_venue_immutable' USING ERRCODE='55000';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status <> 'draft' THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'payroll_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    -- Approval/payment/cancellation transitions preserve the exact snapshot.
    -- In particular, an archived category must not block a later transition.
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='cancelled' THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'payroll_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  -- Legacy rows remain NULL. A snapshot without a stable category ID is never
  -- accepted, including when supplied by a caller during draft editing.
  IF NEW.finance_category_id IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.finance_category_id IS NOT NULL THEN
      -- Explicitly clearing a draft classification also clears its snapshot.
      NEW.finance_category_name_snapshot := NULL;
      RETURN NEW;
    ELSIF NEW.finance_category_name_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_finance_category_snapshot_without_id' USING ERRCODE='23514';
    END IF;
    NEW.finance_category_name_snapshot := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE'
     AND OLD.finance_category_id IS NOT DISTINCT FROM NEW.finance_category_id
     AND OLD.finance_category_name_snapshot IS NOT DISTINCT FROM NEW.finance_category_name_snapshot
     AND NEW.status <> 'approved' THEN
    -- Unrelated draft edits preserve an existing snapshot, even if its
    -- category was archived. Active status is required on assignment/approval.
    RETURN NEW;
  END IF;

  -- Validate whenever a draft is classified and again at draft -> approved.
  -- FOR SHARE serializes against category rename/archive/kind changes.
  SELECT name,kind,active INTO category_name,category_kind,category_active
    FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.finance_category_id FOR SHARE;
  IF NOT FOUND OR category_kind <> 'expense' OR NOT category_active THEN
    RAISE EXCEPTION 'invalid_payroll_finance_category' USING ERRCODE='23514';
  END IF;
  NEW.finance_category_name_snapshot := category_name;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_entries_finance_category_guard ON payroll_entries;
CREATE TRIGGER payroll_entries_finance_category_guard
  BEFORE INSERT OR UPDATE OF venue_id,status,finance_category_id,finance_category_name_snapshot
  ON payroll_entries FOR EACH ROW EXECUTE FUNCTION validate_payroll_finance_category();

CREATE OR REPLACE FUNCTION validate_purchase_document_finance_category()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.venue_id IS DISTINCT FROM NEW.venue_id
     AND (OLD.finance_category_id IS NOT NULL OR NEW.finance_category_id IS NOT NULL
       OR OLD.finance_category_name_snapshot IS NOT NULL OR NEW.finance_category_name_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'purchase_document_finance_category_venue_immutable' USING ERRCODE='55000';
  END IF;

  IF TG_OP='UPDATE' AND OLD.status IN ('posted','voided') THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'purchase_document_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    -- Posting/void/reversal lifecycle changes preserve history even after the
    -- category is archived; do not revalidate its current active flag here.
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' AND OLD.status='draft' AND NEW.status='voided' THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
       OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'purchase_document_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  -- A snapshot cannot be forged or retained without its stable category ID.
  IF NEW.finance_category_id IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.finance_category_id IS NOT NULL THEN
      -- Clearing a draft classification clears its captured name as well.
      NEW.finance_category_name_snapshot := NULL;
      RETURN NEW;
    ELSIF NEW.finance_category_name_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'purchase_document_finance_category_snapshot_without_id' USING ERRCODE='23514';
    END IF;
    NEW.finance_category_name_snapshot := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE'
     AND OLD.finance_category_id IS NOT DISTINCT FROM NEW.finance_category_id
     AND OLD.finance_category_name_snapshot IS NOT DISTINCT FROM NEW.finance_category_name_snapshot
     AND NEW.status <> 'posted' THEN
    -- Unrelated draft edits preserve the snapshot; posting still revalidates.
    RETURN NEW;
  END IF;

  -- Draft assignment and draft -> posted both require a current expense
  -- category. The lock serializes assignment against category kind/archive.
  SELECT name,kind,active INTO category_name,category_kind,category_active
    FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.finance_category_id FOR SHARE;
  IF NOT FOUND OR category_kind <> 'expense' OR NOT category_active THEN
    RAISE EXCEPTION 'invalid_purchase_document_finance_category' USING ERRCODE='23514';
  END IF;
  NEW.finance_category_name_snapshot := category_name;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS inventory_purchase_documents_finance_category_guard ON inventory_purchase_documents;
CREATE TRIGGER inventory_purchase_documents_finance_category_guard
  BEFORE INSERT OR UPDATE OF venue_id,status,finance_category_id,finance_category_name_snapshot
  ON inventory_purchase_documents FOR EACH ROW EXECUTE FUNCTION validate_purchase_document_finance_category();

-- Category direction is immutable once any payroll or purchase source uses it.
-- Assignment triggers take FOR SHARE on the category row, so this UPDATE's
-- row lock serializes the check with concurrent classifications.
CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();
