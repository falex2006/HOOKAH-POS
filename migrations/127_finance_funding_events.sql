-- Append-only balance events for owner contributions and loan principal.
-- These are cash/balance facts only; they are not expenses or other income.
CREATE TABLE IF NOT EXISTS finance_funding_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  document_type text NOT NULL CHECK (document_type IN ('owner_contribution','loan')),
  counterparty_name text NOT NULL CHECK (length(btrim(counterparty_name)) BETWEEN 1 AND 160),
  basis text NOT NULL CHECK (length(btrim(basis)) BETWEEN 1 AND 500),
  document_reference text NOT NULL DEFAULT '' CHECK (length(document_reference) <= 160),
  principal_limit numeric(14,2),
  currency text NOT NULL DEFAULT 'RUB' CHECK (currency='RUB'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','cancelled')),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_funding_documents_type_limit_check CHECK (
    (document_type='loan' AND principal_limit IS NOT NULL AND principal_limit>0)
    OR (document_type='owner_contribution' AND principal_limit IS NULL)
  ),
  CONSTRAINT finance_funding_documents_venue_id_unique UNIQUE (venue_id,id),
  CONSTRAINT finance_funding_documents_idempotency_unique UNIQUE (venue_id,idempotency_key),
  CONSTRAINT finance_funding_documents_creator_fk FOREIGN KEY (venue_id,created_by)
    REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS finance_funding_documents_venue_created_idx
  ON finance_funding_documents(venue_id,created_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS finance_funding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  document_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('owner_contribution_received','loan_principal_received','loan_principal_repaid')),
  amount numeric(14,2) NOT NULL CHECK (amount>0),
  event_date date NOT NULL,
  finance_account_id uuid NOT NULL,
  finance_account_name_snapshot text NOT NULL CHECK (length(btrim(finance_account_name_snapshot)) BETWEEN 1 AND 160),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','card','qr','bank_transfer','other')),
  shift_id uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note)<=500),
  idempotency_key uuid NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_funding_events_venue_id_unique UNIQUE (venue_id,id),
  CONSTRAINT finance_funding_events_idempotency_unique UNIQUE (venue_id,idempotency_key),
  CONSTRAINT finance_funding_events_document_fk FOREIGN KEY (venue_id,document_id)
    REFERENCES finance_funding_documents(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT finance_funding_events_account_fk FOREIGN KEY (venue_id,finance_account_id)
    REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT finance_funding_events_shift_fk FOREIGN KEY (venue_id,shift_id)
    REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT finance_funding_events_actor_fk FOREIGN KEY (venue_id,created_by)
    REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS finance_funding_events_venue_date_idx
  ON finance_funding_events(venue_id,event_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_funding_events_document_idx
  ON finance_funding_events(venue_id,document_id,event_date,created_at,id);
CREATE INDEX IF NOT EXISTS finance_funding_events_account_date_idx
  ON finance_funding_events(venue_id,finance_account_id,event_date);
CREATE INDEX IF NOT EXISTS finance_funding_events_shift_idx
  ON finance_funding_events(venue_id,shift_id) WHERE shift_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_finance_funding_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'finance_funding_document_delete_forbidden' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' THEN RAISE EXCEPTION 'finance_funding_document_state_invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM finance_funding_events WHERE venue_id=OLD.venue_id AND document_id=OLD.id) THEN
    IF OLD.venue_id IS DISTINCT FROM NEW.venue_id OR OLD.document_type IS DISTINCT FROM NEW.document_type
      OR OLD.id IS DISTINCT FROM NEW.id OR OLD.updated_at IS DISTINCT FROM NEW.updated_at
      OR OLD.counterparty_name IS DISTINCT FROM NEW.counterparty_name OR OLD.basis IS DISTINCT FROM NEW.basis
      OR OLD.document_reference IS DISTINCT FROM NEW.document_reference OR OLD.principal_limit IS DISTINCT FROM NEW.principal_limit
      OR OLD.currency IS DISTINCT FROM NEW.currency OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
      OR OLD.request_sha256 IS DISTINCT FROM NEW.request_sha256 OR OLD.created_by IS DISTINCT FROM NEW.created_by
      OR OLD.created_at IS DISTINCT FROM NEW.created_at OR NEW.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'finance_funding_document_immutable_after_event' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status<>'draft' OR NEW.status NOT IN ('draft','active','cancelled')
    OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.document_type IS DISTINCT FROM OLD.document_type
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'finance_funding_document_state_invalid' USING ERRCODE='55000';
  END IF;
  IF NEW.status='active' THEN
    RAISE EXCEPTION 'finance_funding_document_event_required' USING ERRCODE='23514';
  END IF;
  IF NEW.status='cancelled' AND (NEW.counterparty_name IS DISTINCT FROM OLD.counterparty_name
    OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.document_reference IS DISTINCT FROM OLD.document_reference
    OR NEW.principal_limit IS DISTINCT FROM OLD.principal_limit) THEN
    RAISE EXCEPTION 'finance_funding_document_state_invalid' USING ERRCODE='55000';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_funding_documents_guard ON finance_funding_documents;
CREATE TRIGGER finance_funding_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_funding_documents
  FOR EACH ROW EXECUTE FUNCTION guard_finance_funding_document();

CREATE OR REPLACE FUNCTION guard_finance_funding_event() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE document_row finance_funding_documents%ROWTYPE; account_row finance_accounts%ROWTYPE;
  venue_timezone text; open_shift_id uuid; open_shift_count integer; received_amount numeric(14,2); repaid_amount numeric(14,2);
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'finance_funding_events_append_only' USING ERRCODE='55000';
  END IF;
  SELECT * INTO document_row FROM finance_funding_documents
    WHERE venue_id=NEW.venue_id AND id=NEW.document_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'finance_funding_document_not_found' USING ERRCODE='23503'; END IF;
  IF document_row.status IN ('cancelled') THEN RAISE EXCEPTION 'finance_funding_document_not_open' USING ERRCODE='23514'; END IF;
  IF (document_row.document_type='owner_contribution' AND NEW.event_type<>'owner_contribution_received')
    OR (document_row.document_type='loan' AND NEW.event_type NOT IN ('loan_principal_received','loan_principal_repaid')) THEN
    RAISE EXCEPTION 'finance_funding_event_document_type_mismatch' USING ERRCODE='23514';
  END IF;
  IF document_row.document_type='loan' AND NEW.event_type='loan_principal_received' THEN
    SELECT COALESCE(SUM(amount),0) INTO received_amount FROM finance_funding_events
      WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id AND event_type='loan_principal_received';
    IF received_amount+NEW.amount>document_row.principal_limit THEN
      RAISE EXCEPTION 'finance_loan_principal_limit_exceeded' USING ERRCODE='23514';
    END IF;
  ELSIF document_row.document_type='loan' AND NEW.event_type='loan_principal_repaid' THEN
    SELECT COALESCE(SUM(amount) FILTER (WHERE event_type='loan_principal_received'),0),
      COALESCE(SUM(amount) FILTER (WHERE event_type='loan_principal_repaid'),0)
      INTO received_amount,repaid_amount FROM finance_funding_events
      WHERE venue_id=NEW.venue_id AND document_id=NEW.document_id;
    IF repaid_amount+NEW.amount>received_amount THEN
      RAISE EXCEPTION 'finance_loan_repayment_exceeds_principal' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO account_row FROM finance_accounts
    WHERE venue_id=NEW.venue_id AND id=NEW.finance_account_id FOR UPDATE;
  IF NOT FOUND OR NOT account_row.active THEN RAISE EXCEPTION 'finance_account_inactive' USING ERRCODE='23514'; END IF;
  IF NEW.finance_account_name_snapshot IS DISTINCT FROM account_row.name THEN
    RAISE EXCEPTION 'finance_account_snapshot_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT (NEW.payment_method=ANY(account_row.allowed_payment_methods)) THEN
    RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514';
  END IF;
  IF account_row.kind='pos_cashbox' THEN
    IF NEW.payment_method<>'cash' THEN RAISE EXCEPTION 'finance_payment_method_account_mismatch' USING ERRCODE='23514'; END IF;
    SELECT timezone INTO venue_timezone FROM venues WHERE id=NEW.venue_id;
    IF NEW.event_date<>(now() AT TIME ZONE COALESCE(NULLIF(venue_timezone,''),'Europe/Moscow'))::date THEN
      RAISE EXCEPTION 'finance_pos_cash_payment_date_must_be_today' USING ERRCODE='23514';
    END IF;
    SELECT id INTO open_shift_id FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL FOR UPDATE;
    SELECT COUNT(*)::int INTO open_shift_count FROM shifts WHERE venue_id=NEW.venue_id AND closed_at IS NULL;
    IF open_shift_count<>1 OR NEW.shift_id IS DISTINCT FROM open_shift_id THEN
      RAISE EXCEPTION 'finance_payment_open_shift_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'finance_funding_non_pos_shift_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_funding_events_guard ON finance_funding_events;
CREATE TRIGGER finance_funding_events_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_funding_events
  FOR EACH ROW EXECUTE FUNCTION guard_finance_funding_event();

CREATE OR REPLACE FUNCTION activate_finance_funding_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE finance_funding_documents SET status='active'
    WHERE venue_id=NEW.venue_id AND id=NEW.document_id AND status='draft';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_funding_event_activates_document ON finance_funding_events;
CREATE TRIGGER finance_funding_event_activates_document AFTER INSERT ON finance_funding_events
  FOR EACH ROW EXECUTE FUNCTION activate_finance_funding_document();

CREATE OR REPLACE FUNCTION guard_finance_funding_events_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'finance_funding_events_append_only' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS finance_funding_events_no_truncate ON finance_funding_events;
CREATE TRIGGER finance_funding_events_no_truncate BEFORE TRUNCATE ON finance_funding_events
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_funding_events_truncate();

DROP TRIGGER IF EXISTS finance_funding_documents_no_truncate ON finance_funding_documents;
CREATE TRIGGER finance_funding_documents_no_truncate BEFORE TRUNCATE ON finance_funding_documents
  FOR EACH STATEMENT EXECUTE FUNCTION guard_finance_funding_events_truncate();

COMMENT ON TABLE finance_funding_documents IS
  'Venue-scoped owner contribution and loan principal documents. No expense, revenue or current-account-balance semantics.';
COMMENT ON TABLE finance_funding_events IS
  'Append-only owner contribution receipts and loan principal receipts/repayments; P&L effect is always none.';
