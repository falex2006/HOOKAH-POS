-- Preserve tenant-scoped category identity in append-only expense correction history.
-- Existing snapshots are validated before constraints are installed; no history is rewritten.
LOCK TABLE finance_expense_corrections IN ACCESS EXCLUSIVE MODE;
LOCK TABLE finance_categories IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance_expense_corrections c
    CROSS JOIN LATERAL (VALUES (c.before_snapshot->>'categoryId'),(c.after_snapshot->>'categoryId')) refs(category_id)
    LEFT JOIN finance_categories fc ON fc.venue_id=c.venue_id AND fc.id=(CASE
      WHEN refs.category_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN refs.category_id::uuid ELSE NULL END)
    WHERE refs.category_id IS NOT NULL
      AND (refs.category_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR fc.id IS NULL OR fc.kind IS DISTINCT FROM 'expense'))
  THEN
    RAISE EXCEPTION 'finance_expense_correction_category_legacy_invalid' USING ERRCODE='23514';
  END IF;
END $$;

ALTER TABLE finance_expense_corrections
  ADD COLUMN IF NOT EXISTS before_category_id uuid GENERATED ALWAYS AS (NULLIF(before_snapshot->>'categoryId','')::uuid) STORED,
  ADD COLUMN IF NOT EXISTS after_category_id uuid GENERATED ALWAYS AS (NULLIF(after_snapshot->>'categoryId','')::uuid) STORED;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='finance_expense_corrections'::regclass AND conname='finance_expense_correction_before_category_fk') THEN
    ALTER TABLE finance_expense_corrections ADD CONSTRAINT finance_expense_correction_before_category_fk
      FOREIGN KEY (venue_id,before_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='finance_expense_corrections'::regclass AND conname='finance_expense_correction_after_category_fk') THEN
    ALTER TABLE finance_expense_corrections ADD CONSTRAINT finance_expense_correction_after_category_fk
      FOREIGN KEY (venue_id,after_category_id) REFERENCES finance_categories(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_finance_expense_correction_categories()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  category_id uuid;
  category_kind text;
  category_text text;
BEGIN
  FOREACH category_text IN ARRAY ARRAY[NEW.before_snapshot->>'categoryId',NEW.after_snapshot->>'categoryId'] LOOP
    IF category_text IS NULL OR category_text='' THEN CONTINUE; END IF;
    category_id := category_text::uuid;
    SELECT kind INTO category_kind FROM finance_categories
      WHERE venue_id=NEW.venue_id AND id=category_id FOR SHARE;
    IF NOT FOUND OR category_kind IS DISTINCT FROM 'expense' THEN
      RAISE EXCEPTION 'finance_expense_correction_category_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_expense_correction_category_guard ON finance_expense_corrections;
CREATE TRIGGER finance_expense_correction_category_guard
  BEFORE INSERT ON finance_expense_corrections
  FOR EACH ROW EXECUTE FUNCTION validate_finance_expense_correction_categories();

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
       OR EXISTS (SELECT 1 FROM finance_expense_corrections c WHERE c.venue_id=OLD.venue_id AND (c.before_category_id=OLD.id OR c.after_category_id=OLD.id))
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();
