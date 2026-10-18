-- Internal transfers are a single source fact with two immutable account legs.
-- Opening balances are signed, confirmed starting positions, not cash receipts.

CREATE TABLE IF NOT EXISTS finance_account_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  transfer_date date NOT NULL,
  from_account_id uuid NOT NULL,
  from_account_name_snapshot text NOT NULL CHECK (length(btrim(from_account_name_snapshot)) BETWEEN 1 AND 120),
  to_account_id uuid NOT NULL,
  to_account_name_snapshot text NOT NULL CHECK (length(btrim(to_account_name_snapshot)) BETWEEN 1 AND 120),
  shift_id uuid,
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 500),
  reversal_of_transfer_id uuid,
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency='RUB'),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,from_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,to_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,reversal_of_transfer_id) REFERENCES finance_account_transfers(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK (from_account_id<>to_account_id)
);
CREATE INDEX IF NOT EXISTS finance_account_transfers_venue_date_idx
  ON finance_account_transfers(venue_id,transfer_date DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS finance_account_transfers_one_reversal_per_key_idx
  ON finance_account_transfers(venue_id,reversal_of_transfer_id,idempotency_key)
  WHERE reversal_of_transfer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance_account_transfer_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  leg_type text NOT NULL CHECK (leg_type IN ('debit','credit')),
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  shift_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,transfer_id,leg_type),
  FOREIGN KEY (venue_id,transfer_id) REFERENCES finance_account_transfers(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_account_transfer_legs_venue_account_idx
  ON finance_account_transfer_legs(venue_id,finance_account_id,transfer_id);

CREATE TABLE IF NOT EXISTS finance_account_opening_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 120),
  amount numeric(14,2) NOT NULL,
  effective_date date NOT NULL,
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 240),
  basis text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 500),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency='RUB'),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  confirmed_by uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,finance_account_id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,confirmed_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_account_opening_balances_venue_date_idx
  ON finance_account_opening_balances(venue_id,effective_date,id);

CREATE TABLE IF NOT EXISTS finance_account_opening_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  opening_balance_id uuid NOT NULL,
  finance_account_id uuid NOT NULL,
  amount_delta numeric(14,2) NOT NULL CHECK (amount_delta<>0),
  adjustment_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) BETWEEN 1 AND 240),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,idempotency_key),
  FOREIGN KEY (venue_id,opening_balance_id) REFERENCES finance_account_opening_balances(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS finance_account_opening_adjustments_venue_opening_idx
  ON finance_account_opening_adjustments(venue_id,opening_balance_id,adjustment_date,id);

CREATE OR REPLACE FUNCTION guard_finance_account_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_account finance_accounts%ROWTYPE; destination_account finance_accounts%ROWTYPE;
  venue_timezone text; current_shift uuid; open_shift_count integer; original finance_account_transfers%ROWTYPE;
  reversed_amount numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_transfers_append_only' USING ERRCODE='55000'; END IF;
  PERFORM 1 FROM finance_accounts WHERE venue_id=NEW.venue_id
    AND id IN (NEW.from_account_id,NEW.to_account_id) ORDER BY id FOR UPDATE;
  SELECT * INTO source_account FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.from_account_id;
  SELECT * INTO destination_account FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.to_account_id;
  IF source_account.id IS NULL OR destination_account.id IS NULL THEN RAISE EXCEPTION 'finance_transfer_account_not_found' USING ERRCODE='23503'; END IF;
  IF NEW.reversal_of_transfer_id IS NULL AND (NOT source_account.active OR NOT destination_account.active) THEN RAISE EXCEPTION 'finance_transfer_account_inactive' USING ERRCODE='23514'; END IF;
  IF source_account.name IS DISTINCT FROM NEW.from_account_name_snapshot OR destination_account.name IS DISTINCT FROM NEW.to_account_name_snapshot THEN
    RAISE EXCEPTION 'finance_transfer_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.reversal_of_transfer_id IS NOT NULL THEN
    SELECT * INTO original FROM finance_account_transfers WHERE venue_id=NEW.venue_id AND id=NEW.reversal_of_transfer_id FOR UPDATE;
    IF original.id IS NULL OR original.reversal_of_transfer_id IS NOT NULL
      OR NEW.from_account_id IS DISTINCT FROM original.to_account_id
      OR NEW.to_account_id IS DISTINCT FROM original.from_account_id THEN
      RAISE EXCEPTION 'finance_transfer_reversal_invalid' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(SUM(amount),0) INTO reversed_amount FROM finance_account_transfers
      WHERE venue_id=NEW.venue_id AND reversal_of_transfer_id=original.id;
    IF reversed_amount+NEW.amount>original.amount THEN RAISE EXCEPTION 'finance_transfer_reversal_exceeds_original' USING ERRCODE='23514'; END IF;
  END IF;
  IF source_account.kind='pos_cashbox' OR destination_account.kind='pos_cashbox' THEN
    SELECT timezone INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
    IF NEW.transfer_date<>(now() AT TIME ZONE COALESCE(NULLIF(venue_timezone,''),'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_transfer_pos_cash_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO current_shift FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT COUNT(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM current_shift THEN
      RAISE EXCEPTION 'finance_transfer_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_transfer_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_transfers_guard ON finance_account_transfers;
CREATE TRIGGER finance_account_transfers_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_transfers
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_transfer();

CREATE OR REPLACE FUNCTION create_finance_account_transfer_legs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO finance_account_transfer_legs(venue_id,transfer_id,leg_type,finance_account_id,finance_account_name_snapshot,amount,shift_id)
  VALUES(NEW.venue_id,NEW.id,'debit',NEW.from_account_id,NEW.from_account_name_snapshot,NEW.amount,
    CASE WHEN EXISTS(SELECT 1 FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.from_account_id AND kind='pos_cashbox') THEN NEW.shift_id ELSE NULL END),
    (NEW.venue_id,NEW.id,'credit',NEW.to_account_id,NEW.to_account_name_snapshot,NEW.amount,
    CASE WHEN EXISTS(SELECT 1 FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.to_account_id AND kind='pos_cashbox') THEN NEW.shift_id ELSE NULL END);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_transfers_create_legs ON finance_account_transfers;
CREATE TRIGGER finance_account_transfers_create_legs AFTER INSERT ON finance_account_transfers
  FOR EACH ROW EXECUTE FUNCTION create_finance_account_transfer_legs();

CREATE OR REPLACE FUNCTION guard_finance_account_transfer_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_transfer_legs_append_only' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance_account_transfers t WHERE t.venue_id=NEW.venue_id AND t.id=NEW.transfer_id
    AND ((NEW.leg_type='debit' AND NEW.finance_account_id=t.from_account_id AND NEW.finance_account_name_snapshot=t.from_account_name_snapshot AND NEW.amount=t.amount)
      OR (NEW.leg_type='credit' AND NEW.finance_account_id=t.to_account_id AND NEW.finance_account_name_snapshot=t.to_account_name_snapshot AND NEW.amount=t.amount)))
  THEN RAISE EXCEPTION 'finance_account_transfer_leg_source_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_transfer_legs_guard ON finance_account_transfer_legs;
CREATE TRIGGER finance_account_transfer_legs_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_transfer_legs
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_transfer_leg();

CREATE OR REPLACE FUNCTION guard_finance_account_opening_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_opening_balances_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF account_row.id IS NULL OR NOT account_row.active THEN RAISE EXCEPTION 'finance_opening_account_inactive' USING ERRCODE='23514'; END IF;
  IF account_row.kind='pos_cashbox' THEN RAISE EXCEPTION 'finance_opening_pos_cashbox_forbidden' USING ERRCODE='23514'; END IF;
  IF account_row.name IS DISTINCT FROM NEW.finance_account_name_snapshot THEN RAISE EXCEPTION 'finance_opening_account_snapshot_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_opening_balances_guard ON finance_account_opening_balances;
CREATE TRIGGER finance_account_opening_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_opening_balances
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_opening_balance();

CREATE OR REPLACE FUNCTION guard_finance_account_opening_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE opening finance_account_opening_balances%ROWTYPE; account_row finance_accounts%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'finance_account_opening_adjustments_append_only' USING ERRCODE='55000'; END IF;
  SELECT * INTO opening FROM finance_account_opening_balances
    WHERE venue_id=NEW.venue_id AND id=NEW.opening_balance_id FOR UPDATE;
  IF opening.id IS NULL OR opening.finance_account_id IS DISTINCT FROM NEW.finance_account_id THEN
    RAISE EXCEPTION 'finance_opening_adjustment_source_invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO account_row FROM finance_accounts WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF account_row.id IS NULL OR NOT account_row.active THEN RAISE EXCEPTION 'finance_opening_account_inactive' USING ERRCODE='23514'; END IF;
  IF NEW.adjustment_date<opening.effective_date THEN RAISE EXCEPTION 'finance_opening_adjustment_before_cutoff' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_account_opening_adjustments_guard ON finance_account_opening_adjustments;
CREATE TRIGGER finance_account_opening_adjustments_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_account_opening_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_finance_account_opening_adjustment();

CREATE OR REPLACE FUNCTION guard_finance_balance_events_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'finance_balance_events_append_only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS finance_account_transfers_no_truncate ON finance_account_transfers;
CREATE TRIGGER finance_account_transfers_no_truncate BEFORE TRUNCATE ON finance_account_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();
DROP TRIGGER IF EXISTS finance_account_transfer_legs_no_truncate ON finance_account_transfer_legs;
CREATE TRIGGER finance_account_transfer_legs_no_truncate BEFORE TRUNCATE ON finance_account_transfer_legs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();
DROP TRIGGER IF EXISTS finance_account_opening_balances_no_truncate ON finance_account_opening_balances;
CREATE TRIGGER finance_account_opening_balances_no_truncate BEFORE TRUNCATE ON finance_account_opening_balances
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();
DROP TRIGGER IF EXISTS finance_account_opening_adjustments_no_truncate ON finance_account_opening_adjustments;
CREATE TRIGGER finance_account_opening_adjustments_no_truncate BEFORE TRUNCATE ON finance_account_opening_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_balance_events_truncate();

CREATE OR REPLACE FUNCTION guard_finance_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.code IS DISTINCT FROM NEW.code OR OLD.kind IS DISTINCT FROM NEW.kind OR OLD.allowed_payment_methods IS DISTINCT FROM NEW.allowed_payment_methods THEN RAISE EXCEPTION 'finance_account_identity_immutable' USING ERRCODE='55000'; END IF;
  IF OLD.active=false AND NEW.active=true AND (
    EXISTS (SELECT 1 FROM expenses e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_receipts r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_other_income_refunds r WHERE r.venue_id=OLD.venue_id AND r.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.venue_id=OLD.venue_id AND p.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM order_refund_tenders t WHERE t.venue_id=OLD.venue_id AND t.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_funding_events e WHERE e.venue_id=OLD.venue_id AND e.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_account_transfer_legs l WHERE l.venue_id=OLD.venue_id AND l.finance_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM finance_account_opening_balances o WHERE o.venue_id=OLD.venue_id AND o.finance_account_id=OLD.id)
  ) THEN RAISE EXCEPTION 'finance_account_used_cannot_be_reactivated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

COMMENT ON TABLE finance_account_transfers IS 'Atomic internal account movement. Two immutable legs are generated from one committed transfer; no P&L effect.';
COMMENT ON TABLE finance_account_opening_balances IS 'Confirmed opening position as of the start of a venue-local date; not a cash receipt or a complete current account balance.';
COMMENT ON TABLE finance_account_opening_adjustments IS 'Append-only corrections to a confirmed opening position with explicit evidence and reason.';
