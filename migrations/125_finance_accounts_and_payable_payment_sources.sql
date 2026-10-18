-- A shared venue-scoped account catalog. Existing ledgers remain canonical.
CREATE TABLE IF NOT EXISTS finance_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('pos_cashbox','cash','bank','electronic')),
  allowed_payment_methods text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,code),
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (cardinality(allowed_payment_methods) > 0),
  CHECK (allowed_payment_methods <@ ARRAY['cash','card','bank_transfer','other']::text[]),
  CHECK ((kind='pos_cashbox' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='cash' AND allowed_payment_methods <@ ARRAY['cash']::text[])
    OR (kind='bank' AND allowed_payment_methods <@ ARRAY['bank_transfer','card','other']::text[])
    OR (kind='electronic' AND allowed_payment_methods <@ ARRAY['card','other']::text[]))
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_one_active_pos_cashbox_idx
  ON finance_accounts(venue_id) WHERE kind='pos_cashbox' AND active;

CREATE OR REPLACE FUNCTION ensure_finance_account_defaults(target_venue uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance_accounts(venue_id,code,name,kind,allowed_payment_methods)
  VALUES(target_venue,'main_cashbox','Основная касса','pos_cashbox',ARRAY['cash']::text[])
  ON CONFLICT (venue_id,code) DO NOTHING;
END; $$;

CREATE OR REPLACE FUNCTION seed_finance_accounts_for_venue() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  PERFORM ensure_finance_account_defaults(NEW.id); RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS venues_seed_finance_accounts ON venues;
CREATE TRIGGER venues_seed_finance_accounts AFTER INSERT ON venues
  FOR EACH ROW EXECUTE FUNCTION seed_finance_accounts_for_venue();
DO $$ DECLARE venue_row record; BEGIN
  FOR venue_row IN SELECT id FROM venues LOOP
    PERFORM ensure_finance_account_defaults(venue_row.id);
  END LOOP;
END $$;

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS finance_account_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS finance_account_name_snapshot text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS shift_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_venue_finance_account_fk' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_venue_finance_account_fk
      FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_venue_shift_fk' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_venue_shift_fk
      FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_finance_account_snapshot_check' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_finance_account_snapshot_check
      CHECK ((finance_account_id IS NULL AND finance_account_name_snapshot IS NULL)
        OR (finance_account_id IS NOT NULL AND length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expenses_shift_requires_finance_account' AND conrelid='expenses'::regclass) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_shift_requires_finance_account
      CHECK (shift_id IS NULL OR (finance_account_id IS NOT NULL AND payment_method='cash'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS expenses_venue_finance_account_date_idx
  ON expenses(venue_id,finance_account_id,expense_date) WHERE finance_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_venue_shift_idx
  ON expenses(venue_id,shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_finance_account_event_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (
    OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id
    OR OLD.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot
    OR OLD.shift_id IS DISTINCT FROM NEW.shift_id
  ) THEN
    RAISE EXCEPTION 'finance_account_event_immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.finance_account_id IS NULL THEN
    IF NEW.finance_account_name_snapshot IS NOT NULL OR NEW.shift_id IS NOT NULL THEN
      RAISE EXCEPTION 'finance_account_snapshot_invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO account_row FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.payment_method IS NULL OR NOT (NEW.payment_method=ANY(account_row.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NOT account_row.active THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  IF account_row.kind='pos_cashbox' AND NEW.payment_method='cash' AND NEW.shift_id IS NULL THEN
    RAISE EXCEPTION 'finance_pos_cash_shift_required' USING ERRCODE='23514';
  END IF;
  IF NEW.shift_id IS NOT NULL AND (account_row.kind<>'pos_cashbox' OR NEW.payment_method<>'cash') THEN
    RAISE EXCEPTION 'finance_account_shift_mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NOT account_row.active
    AND OLD.finance_account_id IS DISTINCT FROM NEW.finance_account_id THEN
    RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS expenses_finance_account_snapshot_guard ON expenses;
CREATE TRIGGER expenses_finance_account_snapshot_guard
  BEFORE INSERT OR UPDATE OF venue_id,finance_account_id,finance_account_name_snapshot,shift_id,payment_method ON expenses
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_event_snapshot();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN
    RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.active=false AND NEW.active=true AND EXISTS (
    SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id
  ) THEN
    RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS finance_accounts_identity_guard ON finance_accounts;
CREATE TRIGGER finance_accounts_identity_guard BEFORE UPDATE ON finance_accounts
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_identity();
