-- Connect actual other-income receipts and cash refunds to the shared account registry.
-- Existing events remain unattributed; account and shift are never inferred from payment method.
DO $$ DECLARE constraint_row record; BEGIN
  FOR constraint_row IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='finance_accounts'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%<@%'
  LOOP
    EXECUTE format('ALTER TABLE finance_accounts DROP CONSTRAINT %I',constraint_row.conname);
  END LOOP;
END $$;
ALTER TABLE finance_accounts ADD CONSTRAINT finance_accounts_allowed_methods_v2_check
  CHECK (allowed_payment_methods <@ ARRAY['cash','card','qr','bank_transfer','other']::text[]);
ALTER TABLE finance_accounts ADD CONSTRAINT finance_accounts_method_matrix_v2_check
  CHECK ((kind='pos_cashbox' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='cash' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='bank' AND allowed_payment_methods <@ ARRAY['bank_transfer','card','other']::text[])
    OR (kind='electronic' AND allowed_payment_methods <@ ARRAY['card','qr','other']::text[]));

ALTER TABLE finance_other_income_receipts ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE finance_other_income_receipts ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE finance_other_income_receipts ADD COLUMN IF NOT EXISTS shift_id uuid;
ALTER TABLE finance_other_income_refunds ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE finance_other_income_refunds ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE finance_other_income_refunds ADD COLUMN IF NOT EXISTS shift_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_venue_account_fk' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_venue_account_fk
      FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_venue_shift_fk' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_venue_shift_fk
      FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_account_snapshot_check' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_account_snapshot_check
      CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_receipts_shift_account_check' AND conrelid='finance_other_income_receipts'::regclass) THEN
    ALTER TABLE finance_other_income_receipts ADD CONSTRAINT other_income_receipts_shift_account_check CHECK (shift_id IS NULL OR (finance_account_id IS NOT NULL AND payment_method='cash'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_venue_account_fk' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_venue_account_fk
      FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_venue_shift_fk' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_venue_shift_fk
      FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_account_snapshot_check' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_account_snapshot_check
      CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='other_income_refunds_shift_account_check' AND conrelid='finance_other_income_refunds'::regclass) THEN
    ALTER TABLE finance_other_income_refunds ADD CONSTRAINT other_income_refunds_shift_account_check CHECK (shift_id IS NULL OR (finance_account_id IS NOT NULL AND payout_method='cash'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_account_date_idx ON finance_other_income_receipts(venue_id,finance_account_id,receipt_date) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_other_income_receipts_shift_idx ON finance_other_income_receipts(venue_id,shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_account_date_idx ON finance_other_income_refunds(venue_id,finance_account_id,refund_date) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_other_income_refunds_shift_idx ON finance_other_income_refunds(venue_id,shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_finance_other_income_account_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE; event_method text;
BEGIN
  event_method:=COALESCE(to_jsonb(NEW)->>'payment_method',to_jsonb(NEW)->>'payout_method');
  IF TG_OP='UPDATE' AND (OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id
    OR OLD.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot
    OR OLD.shift_id IS DISTINCT FROM NEW.shift_id) THEN
    RAISE EXCEPTION 'finance_account_event_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.finance_account_id IS NULL THEN
    IF NEW.finance_account_name_snapshot IS NOT NULL OR NEW.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'finance_account_snapshot_invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF event_method IS NULL OR NOT (event_method=ANY(account_row.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF account_row.kind='pos_cashbox' AND event_method='cash' AND NEW.shift_id IS NULL THEN
    RAISE EXCEPTION 'finance_pos_cash_shift_required' USING ERRCODE='23514';
  END IF;
  IF NEW.shift_id IS NOT NULL AND (account_row.kind<>'pos_cashbox' OR event_method<>'cash') THEN
    RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT account_row.active AND OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_other_income_receipt_account_guard ON finance_other_income_receipts;
CREATE TRIGGER finance_other_income_receipt_account_guard BEFORE INSERT OR UPDATE OF venue_id,finance_account_id,finance_account_name_snapshot,shift_id,payment_method ON finance_other_income_receipts FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_account_event();
DROP TRIGGER IF EXISTS finance_other_income_refund_account_guard ON finance_other_income_refunds;
CREATE TRIGGER finance_other_income_refund_account_guard BEFORE INSERT OR UPDATE OF venue_id,finance_account_id,finance_account_name_snapshot,shift_id,payout_method ON finance_other_income_refunds FOR EACH ROW EXECUTE FUNCTION guard_finance_other_income_account_event();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN
    RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.active=false AND NEW.active=true AND (
    EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_receipts r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_refunds r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
  ) THEN RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
