-- Append-only accounting corrections for posted manual/other expenses.
-- Corrections change accounting metadata through signed deltas; they never
-- rewrite the original expense cash-out event.
CREATE TABLE IF NOT EXISTS finance_expense_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  expense_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  before_snapshot jsonb NOT NULL CHECK (jsonb_typeof(before_snapshot)='object'),
  after_snapshot jsonb NOT NULL CHECK (jsonb_typeof(after_snapshot)='object'),
  amount_delta numeric(14,2) NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_json jsonb NOT NULL CHECK (jsonb_typeof(response_json)='object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,expense_id,sequence),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (sequence=expected_version+1)
);
CREATE INDEX IF NOT EXISTS finance_expense_corrections_expense_idx
  ON finance_expense_corrections(venue_id,expense_id,sequence);
CREATE INDEX IF NOT EXISTS finance_expense_corrections_created_idx
  ON finance_expense_corrections(venue_id,created_at DESC,id);
COMMENT ON COLUMN finance_expense_corrections.before_snapshot IS
  'JSON object contract: amount (decimal string), categoryId (UUID or null), categoryName, counterpartyName, description, documentUrl.';
COMMENT ON COLUMN finance_expense_corrections.after_snapshot IS
  'JSON object contract: amount (decimal string), categoryId (UUID or null), categoryName, counterpartyName, description, documentUrl.';
COMMENT ON COLUMN finance_expense_corrections.response_json IS
  'Immutable success response captured at creation for exact idempotent replay.';

CREATE OR REPLACE FUNCTION guard_finance_expense_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_expense expenses%ROWTYPE;
  current_version integer;
  before_amount numeric;
  after_amount numeric;
  snapshot jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_expense_corrections_append_only' USING ERRCODE='55000';
  END IF;

  FOREACH snapshot IN ARRAY ARRAY[NEW.before_snapshot,NEW.after_snapshot] LOOP
    IF (SELECT count(*) FROM jsonb_object_keys(snapshot))<>6
      OR NOT (snapshot ?& ARRAY['amount','categoryId','categoryName','counterpartyName','description','documentUrl']) THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_shape_invalid' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(snapshot->'amount')<>'string'
      OR snapshot->>'amount' !~ '^(0|[1-9][0-9]{0,11})([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_amount_invalid' USING ERRCODE='23514';
    END IF;
    IF (snapshot->>'amount')::numeric<=0 THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_amount_invalid' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(snapshot->'categoryId') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'categoryName') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'counterpartyName') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'description') NOT IN ('null','string')
      OR jsonb_typeof(snapshot->'documentUrl') NOT IN ('null','string')
      OR ((snapshot->'categoryId'='null'::jsonb) IS DISTINCT FROM (snapshot->'categoryName'='null'::jsonb)) THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_field_invalid' USING ERRCODE='23514';
    END IF;
    IF jsonb_typeof(snapshot->'categoryId')='string'
      AND snapshot->>'categoryId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'finance_expense_correction_snapshot_category_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;

  before_amount := (NEW.before_snapshot->>'amount')::numeric;
  after_amount := (NEW.after_snapshot->>'amount')::numeric;
  IF NEW.amount_delta<>after_amount-before_amount THEN
    RAISE EXCEPTION 'finance_expense_correction_amount_delta_mismatch' USING ERRCODE='23514';
  END IF;

  -- The source-row lock is the serialization point. The handler should take
  -- this lock before reading expected_version and hold it through insertion.
  SELECT * INTO source_expense
  FROM expenses
  WHERE venue_id=NEW.venue_id AND id=NEW.expense_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finance_expense_correction_source_not_found' USING ERRCODE='23503';
  END IF;
  IF source_expense.source NOT IN ('manual','other') THEN
    RAISE EXCEPTION 'finance_expense_correction_source_ineligible' USING ERRCODE='23514';
  END IF;
  IF source_expense.purchase_document_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM finance_payable_payment_links p
      WHERE p.venue_id=NEW.venue_id AND p.expense_id=NEW.expense_id)
    OR EXISTS (SELECT 1 FROM payroll_entries pe
      WHERE pe.venue_id=NEW.venue_id AND pe.expense_id=NEW.expense_id) THEN
    RAISE EXCEPTION 'finance_expense_correction_source_linked' USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(MAX(sequence),0) INTO current_version
  FROM finance_expense_corrections
  WHERE venue_id=NEW.venue_id AND expense_id=NEW.expense_id;
  IF NEW.expected_version<>current_version OR NEW.sequence<>current_version+1 THEN
    RAISE EXCEPTION 'finance_expense_correction_version_conflict' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_expense_correction_guard ON finance_expense_corrections;
CREATE TRIGGER finance_expense_correction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON finance_expense_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_finance_expense_correction();
