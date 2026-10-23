-- Verified run lifecycle. This schema is necessary, not sufficient, authority:
-- approve/pay must collect current source proof under the service's private
-- source fence. An arbitrary JSON document is not authentication/freshness.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payroll_calculation_entry_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='expenses'::regclass AND conname='expenses_payroll_calculation_entry_fk') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_payroll_calculation_entry_fk
      FOREIGN KEY(venue_id,payroll_calculation_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS expenses_payroll_calculation_entry_uq
  ON expenses(venue_id,payroll_calculation_entry_id) WHERE payroll_calculation_entry_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS payroll_calculation_entry_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL, entry_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('approve','pay','cancel')),
  from_status text NOT NULL, to_status text NOT NULL,
  employee_id uuid NOT NULL, calculation_run_id uuid NOT NULL,
  provenance_sha256 char(64) NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
  gross_cents bigint NOT NULL CHECK(gross_cents BETWEEN 0 AND 9007199254740991),
  net_cents bigint NOT NULL CHECK(net_cents BETWEEN 0 AND gross_cents),
  protected_fixed_cents bigint NOT NULL CHECK(protected_fixed_cents BETWEEN 0 AND net_cents),
  ledger_hash char(64) NOT NULL CHECK(ledger_hash ~ '^[0-9a-f]{64}$'),
  source_proof_payload text, source_proof_sha256 char(64),
  settlement_kind text CHECK(settlement_kind IN ('positive_expense','zero')),
  expense_id uuid, payment_date date, payment_method text,
  finance_account_id uuid, finance_account_name_snapshot text, shift_id uuid,
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 3 AND 500),
  created_by uuid NOT NULL, created_by_name text NOT NULL CHECK(length(btrim(created_by_name)) BETWEEN 1 AND 500),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,entry_id,action),
  FOREIGN KEY(venue_id,entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,calculation_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,finance_account_id) REFERENCES finance_accounts(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,shift_id) REFERENCES shifts(venue_id,id) ON DELETE RESTRICT,
  CHECK(isfinite(created_at)),
  CHECK((action='approve' AND from_status='draft' AND to_status='approved')
    OR (action='pay' AND from_status='approved' AND to_status='paid')
    OR (action='cancel' AND from_status IN ('draft','approved') AND to_status='cancelled' AND reason IS NOT NULL)),
  CHECK((action='cancel' AND source_proof_payload IS NULL AND source_proof_sha256 IS NULL)
    OR (action IN ('approve','pay') AND source_proof_payload IS NOT NULL AND source_proof_sha256 IS NOT NULL
      AND octet_length(source_proof_payload)<=4194304 AND jsonb_typeof(source_proof_payload::jsonb)='object'
      AND source_proof_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(convert_to(source_proof_payload,'UTF8')),'hex')=source_proof_sha256)),
  CHECK((action<>'pay' AND settlement_kind IS NULL AND expense_id IS NULL AND payment_date IS NULL
      AND payment_method IS NULL AND finance_account_id IS NULL AND finance_account_name_snapshot IS NULL AND shift_id IS NULL)
    OR (action='pay' AND settlement_kind IS NOT NULL AND payment_date IS NOT NULL AND isfinite(payment_date)
      AND ((settlement_kind='zero' AND net_cents=0 AND expense_id IS NULL AND payment_method IS NULL
          AND finance_account_id IS NULL AND finance_account_name_snapshot IS NULL AND shift_id IS NULL)
        OR (settlement_kind='positive_expense' AND net_cents>0 AND expense_id IS NOT NULL
          AND payment_method IS NOT NULL AND payment_method IN ('cash','card','bank_transfer','other')
          AND finance_account_id IS NOT NULL AND finance_account_name_snapshot IS NOT NULL))))
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_calculation_transition_expense_uq
  ON payroll_calculation_entry_transitions(venue_id,expense_id) WHERE expense_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS payroll_calculation_entry_transition_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  transition_id uuid NOT NULL, created_by uuid NOT NULL,
  response_payload text NOT NULL CHECK(octet_length(response_payload)<=1048576 AND jsonb_typeof(response_payload::jsonb)='object'),
  response_hash char(64) NOT NULL CHECK(response_hash ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(response_payload,'UTF8')),'hex')=response_hash),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,idempotency_key),
  FOREIGN KEY(venue_id,transition_id) REFERENCES payroll_calculation_entry_transitions(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
-- A deployment replays migrations; a same-named weakened ownership index must
-- not silently turn a one-to-one financial invariant into a best-effort scan.
DO $$ DECLARE spec record; idx record; fk record; BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('expenses','expenses_payroll_calculation_entry_uq','payroll_calculation_entry_id'),
    ('payroll_calculation_entry_transitions','payroll_calculation_transition_expense_uq','expense_id')
  ) AS expected(table_name,index_name,column_name) LOOP
    SELECT i.* INTO idx FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid
      WHERE i.indrelid=to_regclass(spec.table_name) AND x.relname=spec.index_name;
    IF idx.indexrelid IS NULL OR NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready OR idx.indnkeyatts<>2
      OR pg_get_indexdef(idx.indexrelid,1,true)<>'venue_id' OR pg_get_indexdef(idx.indexrelid,2,true)<>spec.column_name
      OR regexp_replace(pg_get_expr(idx.indpred,idx.indrelid),'\s','','g') IS DISTINCT FROM '('||spec.column_name||'ISNOTNULL)' THEN
      RAISE EXCEPTION 'payroll_lifecycle_ownership_index_mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  SELECT * INTO fk FROM pg_constraint WHERE conrelid='expenses'::regclass AND conname='expenses_payroll_calculation_entry_fk';
  IF fk.contype IS DISTINCT FROM 'f' OR fk.confrelid IS DISTINCT FROM 'payroll_entries'::regclass
    OR fk.confdeltype IS DISTINCT FROM 'r'::"char" OR NOT fk.convalidated
    OR fk.conkey IS DISTINCT FROM ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='expenses'::regclass AND attname='venue_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid='expenses'::regclass AND attname='payroll_calculation_entry_id')]::smallint[]
    OR fk.confkey IS DISTINCT FROM ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='payroll_entries'::regclass AND attname='venue_id'),
      (SELECT attnum FROM pg_attribute WHERE attrelid='payroll_entries'::regclass AND attname='id')]::smallint[] THEN
    RAISE EXCEPTION 'payroll_lifecycle_ownership_fk_mismatch' USING ERRCODE='23514'; END IF;
END $$;

-- Gross remains frozen. INSERT202 still verifies net=gross exactly. Once draft
-- corrections exist, deferred ledger reconciliation is the only net authority.
ALTER TABLE payroll_entries DROP CONSTRAINT IF EXISTS payroll_entries_calculation_metadata_check;
ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_calculation_metadata_check CHECK(
  (calculation_run_id IS NULL AND calculation_provenance_sha256 IS NULL AND calculation_gross_cents IS NULL
    AND materialized_by IS NULL AND materialized_by_name IS NULL AND materialized_at IS NULL
    AND employee_name_snapshot IS NULL AND calculation_scheme_name_snapshot IS NULL)
  OR (calculation_run_id IS NOT NULL AND calculation_provenance_sha256 IS NOT NULL
    AND calculation_provenance_sha256 ~ '^[0-9a-f]{64}$' AND calculation_gross_cents IS NOT NULL
    AND calculation_gross_cents BETWEEN 0 AND 9007199254740991 AND amount*100 BETWEEN 0 AND calculation_gross_cents
    AND materialized_by IS NOT NULL AND materialized_by_name IS NOT NULL AND length(btrim(materialized_by_name)) BETWEEN 1 AND 500
    AND materialized_at IS NOT NULL AND isfinite(materialized_at)
    AND employee_name_snapshot IS NOT NULL AND length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160
    AND calculation_scheme_name_snapshot IS NOT NULL AND length(btrim(calculation_scheme_name_snapshot)) BETWEEN 1 AND 500
    AND rule_id IS NULL AND period_to>=period_from));

-- Keep118 classification validation while preserving calculation snapshots.
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
  -- Calculation-linked entries freeze this name when the draft is created.
  -- Approval still validates current kind/active above, but a later rename
  -- cannot rewrite that frozen financial snapshot. Legacy approval keeps118.
  IF TG_OP='UPDATE' AND OLD.calculation_run_id IS NOT NULL THEN
    IF OLD.finance_category_id IS DISTINCT FROM NEW.finance_category_id
      OR OLD.finance_category_name_snapshot IS DISTINCT FROM NEW.finance_category_name_snapshot THEN
      RAISE EXCEPTION 'payroll_finance_category_immutable' USING ERRCODE='55000';
    END IF;
    NEW.finance_category_name_snapshot := OLD.finance_category_name_snapshot;
  ELSE
    NEW.finance_category_name_snapshot := category_name;
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION payroll_validate_calculation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; actor record; expense record; account record; shift_row record; proof jsonb;
  used numeric; fixed numeric; n bigint; other_link boolean; zone text;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO e USING NEW.venue_id,NEW.entry_id;
  IF e.id IS NULL OR e.calculation_run_id IS NULL OR e.status IS DISTINCT FROM NEW.from_status
    OR e.user_id IS DISTINCT FROM NEW.employee_id OR e.calculation_run_id IS DISTINCT FROM NEW.calculation_run_id
    OR e.calculation_provenance_sha256 IS DISTINCT FROM NEW.provenance_sha256
    OR e.calculation_gross_cents IS DISTINCT FROM NEW.gross_cents OR e.amount*100 IS DISTINCT FROM NEW.net_cents::numeric
    OR NEW.transaction_id IS DISTINCT FROM txid_current()
    OR NEW.created_at<date_trunc('milliseconds',transaction_timestamp()) OR NEW.created_at>clock_timestamp() THEN
    RAISE EXCEPTION 'payroll_lifecycle_transition_context_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name,role FROM %I.users WHERE venue_id=$1 AND id=$2 AND is_active=true AND deleted_at IS NULL FOR SHARE',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.created_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.created_by_name OR actor.role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'payroll_lifecycle_actor_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed USING NEW.venue_id,NEW.calculation_run_id,NEW.employee_id;
  IF fixed IS DISTINCT FROM NEW.protected_fixed_cents::numeric THEN
    RAISE EXCEPTION 'payroll_lifecycle_fixed_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.action<>'cancel' THEN
    EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
      INTO used USING NEW.venue_id,NEW.entry_id;
    IF NEW.net_cents IS DISTINCT FROM NEW.gross_cents-used OR used<0 THEN
      RAISE EXCEPTION 'payroll_lifecycle_net_mismatch' USING ERRCODE='23514'; END IF;
    proof:=NEW.source_proof_payload::jsonb;
    IF proof->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR proof->>'proofKind' IS DISTINCT FROM 'current_transition'
      OR proof->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR proof->>'entryId' IS DISTINCT FROM NEW.entry_id::text
      OR proof->>'employeeId' IS DISTINCT FROM NEW.employee_id::text OR proof->>'runId' IS DISTINCT FROM NEW.calculation_run_id::text
      OR proof->>'entryStatus' IS DISTINCT FROM NEW.from_status OR proof->>'origin' IS DISTINCT FROM 'calculation_run'
      OR proof->>'currency' IS DISTINCT FROM 'RUB' OR proof->>'periodFrom' IS DISTINCT FROM to_char(e.period_from,'YYYY-MM-DD')
      OR proof->>'periodTo' IS DISTINCT FROM to_char(e.period_to,'YYYY-MM-DD')
      OR proof->'grossCents' IS DISTINCT FROM to_jsonb(NEW.gross_cents) OR proof->'netCents' IS DISTINCT FROM to_jsonb(NEW.net_cents)
      OR proof->'protectedFixedCents' IS DISTINCT FROM to_jsonb(NEW.protected_fixed_cents)
      OR proof->'evidenceHashes'->>'provenanceSha256' IS DISTINCT FROM NEW.provenance_sha256::text
      OR proof->'freshness'->>'status' IS DISTINCT FROM 'current'
      OR proof->'corrections'->>'ledgerHash' IS DISTINCT FROM NEW.ledger_hash::text
      OR proof->'corrections'->'netCents' IS DISTINCT FROM to_jsonb(NEW.net_cents) THEN
      RAISE EXCEPTION 'payroll_lifecycle_source_proof_mismatch' USING ERRCODE='23514'; END IF;
    -- Freshness is collected by the authenticated service, not inferred from
    -- this checksum. Its timestamp must at least belong to this transaction.
    IF proof->'freshness'->>'checkedAt' IS NULL OR NOT isfinite((proof->'freshness'->>'checkedAt')::timestamptz)
      OR (proof->'freshness'->>'checkedAt')::timestamptz<date_trunc('milliseconds',transaction_timestamp())
      OR (proof->'freshness'->>'checkedAt')::timestamptz>clock_timestamp() THEN
      RAISE EXCEPTION 'payroll_lifecycle_source_proof_stale' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.action='pay' AND NEW.settlement_kind='positive_expense' THEN
    EXECUTE format('SELECT x.*,x.xmin::text::bigint AS row_xid FROM %I.expenses x WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
      INTO expense USING NEW.venue_id,NEW.expense_id;
    IF expense.id IS NULL OR expense.row_xid IS DISTINCT FROM mod(txid_current(),4294967296::bigint)
      OR expense.payroll_calculation_entry_id IS DISTINCT FROM NEW.entry_id
      OR expense.source IS DISTINCT FROM 'payroll' OR expense.amount*100 IS DISTINCT FROM NEW.net_cents::numeric
      OR expense.expense_date IS DISTINCT FROM NEW.payment_date OR expense.created_by IS DISTINCT FROM NEW.created_by
      OR expense.category_id IS DISTINCT FROM e.finance_category_id
      OR expense.category IS DISTINCT FROM COALESCE(e.finance_category_name_snapshot,'Зарплата')
      OR expense.payment_method IS DISTINCT FROM NEW.payment_method OR expense.finance_account_id IS DISTINCT FROM NEW.finance_account_id
      OR expense.finance_account_name_snapshot IS DISTINCT FROM NEW.finance_account_name_snapshot
      OR expense.shift_id IS DISTINCT FROM NEW.shift_id THEN
      RAISE EXCEPTION 'payroll_lifecycle_expense_mismatch' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE expense_id=$1 AND id<>$2)',TG_TABLE_SCHEMA)
      INTO other_link USING NEW.expense_id,NEW.entry_id;
    IF other_link THEN RAISE EXCEPTION 'payroll_lifecycle_expense_already_owned' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.finance_accounts WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
      INTO account USING NEW.venue_id,NEW.finance_account_id;
    IF account.id IS NULL OR NOT account.active OR account.name IS DISTINCT FROM NEW.finance_account_name_snapshot
      OR NOT(NEW.payment_method=ANY(account.allowed_payment_methods)) THEN
      RAISE EXCEPTION 'payroll_lifecycle_account_invalid' USING ERRCODE='23514'; END IF;
    IF account.kind='pos_cashbox' THEN
      EXECUTE format('SELECT * FROM %I.shifts WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
        INTO shift_row USING NEW.venue_id,NEW.shift_id;
      EXECUTE format('SELECT count(*) FROM %I.shifts WHERE venue_id=$1 AND closed_at IS NULL',TG_TABLE_SCHEMA) INTO n USING NEW.venue_id;
      EXECUTE format('SELECT COALESCE(NULLIF(v.timezone,''''),NULLIF(o.timezone,''''),''Asia/Yekaterinburg'') FROM %I.venues v LEFT JOIN %I.organizations o ON o.id=v.organization_id WHERE v.id=$1',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO zone USING NEW.venue_id;
      IF NEW.payment_method<>'cash' OR shift_row.id IS NULL OR shift_row.closed_at IS NOT NULL OR n<>1
        OR NEW.payment_date IS DISTINCT FROM (clock_timestamp() AT TIME ZONE COALESCE(zone,'UTC'))::date THEN
        RAISE EXCEPTION 'payroll_lifecycle_shift_invalid' USING ERRCODE='23514'; END IF;
    ELSIF NEW.shift_id IS NOT NULL THEN RAISE EXCEPTION 'payroll_lifecycle_shift_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_expense_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense record; owner_entry uuid;
BEGIN
  IF NEW.expense_id IS NULL THEN RETURN NEW; END IF;
  -- A new settlement expense is inserted in the settlement transaction. A RR
  -- snapshot predating it must reject the absent expense before a later FK
  -- snapshot could see it. If it sees the expense, it sees its ownership too.
  EXECUTE format('SELECT id,venue_id,payroll_calculation_entry_id FROM %I.expenses WHERE id=$1 FOR KEY SHARE',TG_TABLE_SCHEMA) INTO expense USING NEW.expense_id;
  IF expense.id IS NULL THEN RAISE EXCEPTION 'payroll_lifecycle_expense_not_visible' USING ERRCODE='23514'; END IF;
  IF expense.payroll_calculation_entry_id IS NOT NULL AND
    (expense.payroll_calculation_entry_id<>NEW.id OR expense.venue_id<>NEW.venue_id) THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_already_owned' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT entry_id FROM %I.payroll_calculation_entry_transitions WHERE expense_id=$1',TG_TABLE_SCHEMA)
    INTO owner_entry USING NEW.expense_id;
  IF owner_entry IS NOT NULL AND owner_entry<>NEW.id THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_already_owned' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_expense_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE referenced boolean; entry record;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.payroll_calculation_entry_id IS NULL THEN RETURN NEW; END IF;
    EXECUTE format('SELECT id,status,calculation_run_id FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
      INTO entry USING NEW.venue_id,NEW.payroll_calculation_entry_id;
    IF NEW.source IS DISTINCT FROM 'payroll' OR entry.id IS NULL OR entry.status<>'approved' OR entry.calculation_run_id IS NULL THEN
      RAISE EXCEPTION 'payroll_lifecycle_expense_marker_invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND NEW.payroll_calculation_entry_id IS DISTINCT FROM OLD.payroll_calculation_entry_id THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_marker_insert_only' USING ERRCODE='55000'; END IF;
  IF TG_OP='TRUNCATE' THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.expenses WHERE payroll_calculation_entry_id IS NOT NULL)',TG_TABLE_SCHEMA) INTO referenced;
  ELSE
    IF OLD.payroll_calculation_entry_id IS NOT NULL THEN RAISE EXCEPTION 'payroll_lifecycle_expense_immutable' USING ERRCODE='55000'; END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_entry_transitions WHERE expense_id=$1)',TG_TABLE_SCHEMA) INTO referenced USING OLD.id;
  END IF;
  IF referenced THEN RAISE EXCEPTION 'payroll_lifecycle_expense_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; IF TG_OP='TRUNCATE' THEN RETURN NULL; END IF; RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_expense_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expense record; entry record; n bigint;
BEGIN
  IF NEW.payroll_calculation_entry_id IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT * FROM %I.expenses WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO expense USING NEW.venue_id,NEW.id;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO entry USING NEW.venue_id,NEW.payroll_calculation_entry_id;
  EXECUTE format('SELECT count(*) FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND entry_id=$2 AND expense_id=$3 AND action=''pay'' AND settlement_kind=''positive_expense''',TG_TABLE_SCHEMA)
    INTO n USING NEW.venue_id,NEW.payroll_calculation_entry_id,NEW.id;
  IF expense.id IS NULL OR entry.id IS NULL OR entry.status<>'paid' OR entry.expense_id IS DISTINCT FROM NEW.id OR n<>1 THEN
    RAISE EXCEPTION 'payroll_lifecycle_expense_settlement_incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; t record; v uuid; entry uuid; used numeric; fixed numeric; unreleased bigint; journaled boolean;
BEGIN
  v:=NEW.venue_id;
  IF TG_TABLE_NAME='payroll_calculation_entry_transitions' THEN entry:=NEW.entry_id; ELSE entry:=NEW.id; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO e USING v,entry;
  IF e.id IS NULL OR e.calculation_run_id IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO used USING v,entry;
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed USING v,e.calculation_run_id,e.user_id;
  IF e.status<>'cancelled' AND (used<0 OR e.amount*100 IS DISTINCT FROM e.calculation_gross_cents-used OR e.amount*100<fixed) THEN
    RAISE EXCEPTION 'payroll_lifecycle_net_reconciliation_required' USING ERRCODE='23514'; END IF;
  IF e.status='cancelled' THEN
    EXECUTE format('SELECT count(*) FROM %I.payroll_correction_events a WHERE venue_id=$1 AND target_entry_id=$2 AND kind=''apply'' AND NOT EXISTS(SELECT 1 FROM %I.payroll_correction_events r WHERE r.venue_id=a.venue_id AND r.reverses_event_id=a.id)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO unreleased USING v,entry;
    IF unreleased<>0 THEN RAISE EXCEPTION 'payroll_correction_cancel_requires_full_release' USING ERRCODE='23514'; END IF;
  END IF;
  FOR t IN EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND entry_id=$2',TG_TABLE_SCHEMA) USING v,entry LOOP
    IF t.action='approve' AND (e.status NOT IN ('approved','paid','cancelled') OR e.approved_at IS DISTINCT FROM t.created_at
      OR e.approved_by IS DISTINCT FROM t.created_by OR e.amount*100 IS DISTINCT FROM t.net_cents::numeric)
      OR t.action='pay' AND (e.status<>'paid' OR e.paid_at IS DISTINCT FROM t.created_at OR e.paid_by IS DISTINCT FROM t.created_by
        OR e.expense_id IS DISTINCT FROM t.expense_id OR e.payment_date IS DISTINCT FROM t.payment_date OR e.amount*100 IS DISTINCT FROM t.net_cents::numeric)
      OR t.action='cancel' AND (e.status<>'cancelled' OR e.cancelled_at IS DISTINCT FROM t.created_at OR e.cancelled_by IS DISTINCT FROM t.created_by
        OR e.cancellation_reason IS DISTINCT FROM t.reason OR e.amount*100 IS DISTINCT FROM t.net_cents::numeric) THEN
      RAISE EXCEPTION 'payroll_lifecycle_transition_incomplete' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_entry_transition_requests WHERE venue_id=$1 AND transition_id=$2)',TG_TABLE_SCHEMA)
      INTO journaled USING v,t.id;
    IF NOT journaled THEN RAISE EXCEPTION 'payroll_lifecycle_request_required' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION payroll_validate_calculation_transition_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record; p jsonb;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO t USING NEW.venue_id,NEW.transition_id;
  p:=NEW.response_payload::jsonb;
  IF t.id IS NULL OR t.created_by<>NEW.created_by OR p->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR p->'replayed' IS DISTINCT FROM 'false'::jsonb OR p->>'transitionId' IS DISTINCT FROM t.id::text
    OR p->>'action' IS DISTINCT FROM t.action OR p->'entry'->>'id' IS DISTINCT FROM t.entry_id::text
    OR p->'entry'->>'status' IS DISTINCT FROM t.to_status OR p->'entry'->'amountCents' IS DISTINCT FROM to_jsonb(t.net_cents)
    OR p->'entry'->>'calculationRunId' IS DISTINCT FROM t.calculation_run_id::text
    OR p->'entry'->>'provenanceSha256' IS DISTINCT FROM t.provenance_sha256::text THEN
    RAISE EXCEPTION 'payroll_lifecycle_response_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll_lifecycle_history_immutable' USING ERRCODE='55000'; END $$;
CREATE OR REPLACE FUNCTION payroll_calculation_lifecycle_identity_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The finance category BEFORE trigger may refresh a name on approval. A
  -- calculation-linked snapshot must remain frozen even after other triggers.
  IF OLD.calculation_run_id IS NOT NULL AND
    (to_jsonb(NEW)-ARRAY['amount','status','approved_at','approved_by','paid_at','paid_by','payment_date','expense_id','cancelled_at','cancelled_by','cancellation_reason'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['amount','status','approved_at','approved_by','paid_at','paid_by','payment_date','expense_id','cancelled_at','cancelled_by','cancellation_reason']) THEN
    RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_calculation_entry_transitions','payroll_calculation_entry_transition_requests'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_lifecycle_immutable ON %I',t);
    EXECUTE format('CREATE TRIGGER payroll_lifecycle_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_calculation_lifecycle_reject_mutation()',t);
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_lifecycle_truncate ON %I',t);
    EXECUTE format('CREATE TRIGGER payroll_lifecycle_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION payroll_calculation_lifecycle_reject_mutation()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['payroll_calculation_entry_transitions','payroll_entries'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_lifecycle_commit ON %I',t);
    EXECUTE format('CREATE CONSTRAINT TRIGGER payroll_lifecycle_commit AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_calculation_lifecycle_commit()',t);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS payroll_lifecycle_transition_validate ON payroll_calculation_entry_transitions;
CREATE TRIGGER payroll_lifecycle_transition_validate BEFORE INSERT ON payroll_calculation_entry_transitions
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_calculation_transition();
DROP TRIGGER IF EXISTS payroll_lifecycle_request_validate ON payroll_calculation_entry_transition_requests;
CREATE TRIGGER payroll_lifecycle_request_validate BEFORE INSERT ON payroll_calculation_entry_transition_requests
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_calculation_transition_request();
DROP TRIGGER IF EXISTS payroll_lifecycle_expense_reference ON payroll_entries;
CREATE TRIGGER payroll_lifecycle_expense_reference BEFORE INSERT OR UPDATE OF expense_id ON payroll_entries
  FOR EACH ROW EXECUTE FUNCTION payroll_calculation_lifecycle_expense_reference();
DROP TRIGGER IF EXISTS payroll_lifecycle_expense_immutable ON expenses;
CREATE TRIGGER payroll_lifecycle_expense_immutable BEFORE INSERT OR UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION payroll_calculation_lifecycle_expense_immutable();
DROP TRIGGER IF EXISTS payroll_lifecycle_expense_truncate ON expenses;
CREATE TRIGGER payroll_lifecycle_expense_truncate BEFORE TRUNCATE ON expenses
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_calculation_lifecycle_expense_immutable();
DROP TRIGGER IF EXISTS payroll_lifecycle_expense_commit ON expenses;
CREATE CONSTRAINT TRIGGER payroll_lifecycle_expense_commit AFTER INSERT ON expenses DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payroll_calculation_lifecycle_expense_commit();
DROP TRIGGER IF EXISTS payroll_lifecycle_identity_after ON payroll_entries;
CREATE TRIGGER payroll_lifecycle_identity_after AFTER UPDATE ON payroll_entries
  FOR EACH ROW EXECUTE FUNCTION payroll_calculation_lifecycle_identity_after();

-- The INSERT and DELETE branches below are retained from202. Only UPDATE is replaced.
CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p jsonb; actor record; employee record; total numeric; member_count integer; input_count integer; replay_amount numeric; names integer; transition record; next_action text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.calculation_run_id IS NOT NULL THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.status IN ('draft','approved','paid') AND (NEW.period_to<NEW.period_from OR NOT isfinite(NEW.period_from) OR NOT isfinite(NEW.period_to)) THEN
    RAISE EXCEPTION 'payroll_calculation_entry_period_invalid' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.calculation_run_id IS NULL AND NEW.calculation_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_calculation_entry_insert_only' USING ERRCODE='23514'; END IF;
    IF OLD.calculation_run_id IS NOT NULL THEN
      IF OLD.status IN ('paid','cancelled') THEN
        IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.status=OLD.status THEN
        IF OLD.status='draft' THEN
          IF (to_jsonb(NEW)-'amount') IS DISTINCT FROM (to_jsonb(OLD)-'amount') THEN
            RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
        ELSIF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
        RETURN NEW;
      END IF;
      next_action:=CASE WHEN OLD.status='draft' AND NEW.status='approved' THEN 'approve'
        WHEN OLD.status='approved' AND NEW.status='paid' THEN 'pay'
        WHEN OLD.status IN ('draft','approved') AND NEW.status='cancelled' THEN 'cancel' ELSE NULL END;
      IF next_action IS NULL THEN RAISE EXCEPTION 'payroll_calculation_entry_transition_invalid' USING ERRCODE='23514'; END IF;
      EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND entry_id=$2 AND action=$3 AND transaction_id=txid_current()',TG_TABLE_SCHEMA)
        INTO transition USING OLD.venue_id,OLD.id,next_action;
      IF transition.id IS NULL OR transition.from_status IS DISTINCT FROM OLD.status OR transition.to_status IS DISTINCT FROM NEW.status
        OR transition.net_cents::numeric IS DISTINCT FROM OLD.amount*100 THEN
        RAISE EXCEPTION 'payroll_lifecycle_transition_required' USING ERRCODE='23514'; END IF;
      IF next_action='approve' THEN
        IF (to_jsonb(NEW)-ARRAY['status','approved_at','approved_by']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','approved_at','approved_by'])
          OR NEW.approved_at IS DISTINCT FROM transition.created_at OR NEW.approved_by IS DISTINCT FROM transition.created_by THEN
          RAISE EXCEPTION 'payroll_lifecycle_transition_metadata_mismatch' USING ERRCODE='23514'; END IF;
      ELSIF next_action='pay' THEN
        IF (to_jsonb(NEW)-ARRAY['status','paid_at','paid_by','payment_date','expense_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','paid_at','paid_by','payment_date','expense_id'])
          OR NEW.paid_at IS DISTINCT FROM transition.created_at OR NEW.paid_by IS DISTINCT FROM transition.created_by
          OR NEW.payment_date IS DISTINCT FROM transition.payment_date OR NEW.expense_id IS DISTINCT FROM transition.expense_id THEN
          RAISE EXCEPTION 'payroll_lifecycle_transition_metadata_mismatch' USING ERRCODE='23514'; END IF;
      ELSE
        IF (to_jsonb(NEW)-ARRAY['status','cancelled_at','cancelled_by','cancellation_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancelled_at','cancelled_by','cancellation_reason'])
          OR NEW.cancelled_at IS DISTINCT FROM transition.created_at OR NEW.cancelled_by IS DISTINCT FROM transition.created_by
          OR NEW.cancellation_reason IS DISTINCT FROM transition.reason THEN
          RAISE EXCEPTION 'payroll_lifecycle_transition_metadata_mismatch' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.calculation_run_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('approved','paid') THEN RAISE EXCEPTION 'payroll_run_payout_not_enabled' USING ERRCODE='23514'; END IF;
  IF NEW.status<>'draft' OR NEW.expense_id IS NOT NULL OR NEW.approved_at IS NOT NULL OR NEW.approved_by IS NOT NULL
    OR NEW.paid_at IS NOT NULL OR NEW.paid_by IS NOT NULL OR NEW.payment_date IS NOT NULL
    OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancellation_reason IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_calculation_entry_draft_required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT r.*,p.evidence_payload,p.evidence_sha256 FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO r USING NEW.venue_id,NEW.calculation_run_id;
  IF r.id IS NULL OR r.status<>'ready' OR r.engine_version<>'payroll-verified-no-refund-v1' OR r.currency<>'RUB'
    OR r.period_from IS DISTINCT FROM NEW.period_from OR r.period_to IS DISTINCT FROM NEW.period_to
    OR r.evidence_sha256 IS DISTINCT FROM NEW.calculation_provenance_sha256 THEN
    RAISE EXCEPTION 'payroll_calculation_entry_run_mismatch' USING ERRCODE='23514'; END IF;
  p:=r.evidence_payload::jsonb;
  IF jsonb_typeof(p->'calculatorReplay'->'input'->'employees') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p->'calculatorReplay'->'result'->'employees') IS DISTINCT FROM 'array'
    OR p->'schemeSnapshot'->>'name' IS DISTINCT FROM NEW.calculation_scheme_name_snapshot THEN
    RAISE EXCEPTION 'payroll_calculation_entry_replay_required' USING ERRCODE='23514'; END IF;
  SELECT count(*),max((value->>'amountCents')::numeric) INTO member_count,replay_amount
    FROM jsonb_array_elements(p->'calculatorReplay'->'result'->'employees') WHERE value->>'employeeId'=NEW.user_id::text;
  SELECT count(*) INTO input_count FROM jsonb_array_elements(p->'calculatorReplay'->'input'->'employees') WHERE value->>'id'=NEW.user_id::text;
  EXECUTE format('SELECT COALESCE(sum(final_amount*100),0),count(DISTINCT employee_name_snapshot) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO total,names USING NEW.venue_id,NEW.calculation_run_id,NEW.user_id;
  EXECUTE format('SELECT employee_name_snapshot FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3 LIMIT 1',TG_TABLE_SCHEMA)
    INTO employee USING NEW.venue_id,NEW.calculation_run_id,NEW.user_id;
  IF member_count<>1 OR input_count<>1 OR names<>1 OR replay_amount IS DISTINCT FROM NEW.calculation_gross_cents::numeric
    OR total IS DISTINCT FROM NEW.calculation_gross_cents::numeric OR NEW.amount*100 IS DISTINCT FROM total
    OR employee.employee_name_snapshot IS DISTINCT FROM NEW.employee_name_snapshot THEN
    RAISE EXCEPTION 'payroll_calculation_entry_employee_total_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.materialized_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.materialized_by_name THEN
    RAISE EXCEPTION 'payroll_calculation_entry_owner_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
