-- Attribute new external POS tender events to an explicit finance account.
-- Existing rows remain NULL and are reported as unknown_legacy.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE order_refund_tenders ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE order_refund_tenders ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE order_refund_tenders ADD COLUMN IF NOT EXISTS shift_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_finance_account_fk' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_finance_account_fk FOREIGN KEY (finance_account_id) REFERENCES finance_accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payments_finance_account_snapshot_check' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payments_finance_account_snapshot_check CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_refund_tenders_finance_account_fk' AND conrelid='order_refund_tenders'::regclass) THEN
    ALTER TABLE order_refund_tenders ADD CONSTRAINT order_refund_tenders_finance_account_fk FOREIGN KEY (finance_account_id) REFERENCES finance_accounts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_refund_tenders_shift_fk' AND conrelid='order_refund_tenders'::regclass) THEN
    ALTER TABLE order_refund_tenders ADD CONSTRAINT order_refund_tenders_shift_fk FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='order_refund_tenders_account_snapshot_check' AND conrelid='order_refund_tenders'::regclass) THEN
    ALTER TABLE order_refund_tenders ADD CONSTRAINT order_refund_tenders_account_snapshot_check CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL AND shift_id IS NULL) OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS payments_finance_account_idx ON payments(finance_account_id,created_at) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_refund_tenders_finance_account_idx ON order_refund_tenders(finance_account_id,created_at) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_refund_tenders_shift_idx ON order_refund_tenders(shift_id,created_at) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_pos_payment_finance_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_venue uuid; account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND OLD.method IS DISTINCT FROM NEW.method THEN RAISE EXCEPTION 'payment_method_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND (OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id OR OLD.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot OR OLD.shift_id IS DISTINCT FROM NEW.shift_id) THEN
    RAISE EXCEPTION 'finance_account_event_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.method IN ('bonus','deposit','reservation') THEN
    IF NEW.finance_account_id IS NOT NULL OR NEW.finance_account_name_snapshot IS NOT NULL THEN RAISE EXCEPTION 'finance_account_not_applicable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.method NOT IN ('cash','card','qr') THEN RETURN NEW; END IF;
  IF NEW.finance_account_id IS NULL THEN
    IF TG_OP='INSERT' THEN RAISE EXCEPTION 'finance_account_required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT venue_id INTO order_venue FROM orders WHERE id=NEW.order_id;
  SELECT * INTO account_row FROM finance_accounts WHERE id=NEW.finance_account_id AND venue_id=order_venue FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM account_row.name THEN RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.method<>ALL(account_row.allowed_payment_methods) THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF (NEW.method='cash' AND account_row.kind<>'pos_cashbox') OR (NEW.method='card' AND account_row.kind NOT IN ('bank','electronic')) OR (NEW.method='qr' AND account_row.kind<>'electronic') THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF account_row.kind='pos_cashbox' THEN
    IF NEW.method<>'cash' OR NEW.shift_id IS NULL OR NOT EXISTS(SELECT 1 FROM shifts s WHERE s.venue_id=order_venue AND s.id=NEW.shift_id AND s.closed_at IS NULL) THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payments_finance_account_guard ON payments;
CREATE TRIGGER payments_finance_account_guard BEFORE INSERT OR UPDATE OF order_id,method,finance_account_id,finance_account_name_snapshot,shift_id ON payments FOR EACH ROW EXECUTE FUNCTION guard_pos_payment_finance_account();

CREATE OR REPLACE FUNCTION guard_pos_refund_tender_finance_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE; refund_shift uuid; refund_venue uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'order refunds are append-only' USING ERRCODE='55000'; END IF;
  IF NEW.finance_account_id IS NULL OR NEW.finance_account_name_snapshot IS NULL THEN RAISE EXCEPTION 'finance_account_required' USING ERRCODE='23514'; END IF;
  SELECT venue_id,shift_id INTO refund_venue,refund_shift FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR SHARE;
  IF NOT FOUND OR refund_venue IS NULL THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM account_row.name THEN RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.payout_method<>ALL(account_row.allowed_payment_methods) THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
  IF NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF (NEW.payout_method='cash' AND account_row.kind<>'pos_cashbox') OR (NEW.payout_method='card' AND account_row.kind NOT IN ('bank','electronic')) OR (NEW.payout_method='qr' AND account_row.kind<>'electronic') THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
  IF account_row.kind='pos_cashbox' THEN
    IF NEW.payout_method<>'cash' OR NEW.shift_id IS NULL OR NEW.shift_id<>refund_shift OR NOT EXISTS(SELECT 1 FROM shifts s WHERE s.venue_id=NEW.venue_id AND s.id=NEW.shift_id AND s.closed_at IS NULL) THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refund_tenders_finance_account_guard ON order_refund_tenders;
CREATE TRIGGER order_refund_tenders_finance_account_guard BEFORE INSERT OR UPDATE OR DELETE ON order_refund_tenders FOR EACH ROW EXECUTE FUNCTION guard_pos_refund_tender_finance_account();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.active=false AND NEW.active=true AND (
    EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_receipts r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_refunds r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=OLD.venue_id AND p.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM order_refund_tenders t WHERE t.venue_id=OLD.venue_id AND t.finance_account_id=OLD.id)
  ) THEN RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
