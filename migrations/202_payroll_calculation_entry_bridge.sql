-- Materialization only. Approval and payment stay disabled until the refund
-- correction contract is implemented. Legacy component rows remain supported.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE payroll_entries
  ADD COLUMN IF NOT EXISTS calculation_run_id uuid,
  ADD COLUMN IF NOT EXISTS calculation_provenance_sha256 char(64),
  ADD COLUMN IF NOT EXISTS calculation_gross_cents bigint,
  ADD COLUMN IF NOT EXISTS materialized_by uuid,
  ADD COLUMN IF NOT EXISTS materialized_by_name text,
  ADD COLUMN IF NOT EXISTS materialized_at timestamptz,
  ADD COLUMN IF NOT EXISTS employee_name_snapshot text,
  ADD COLUMN IF NOT EXISTS calculation_scheme_name_snapshot text;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_entries_venue_id_id_uq ON payroll_entries(venue_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_entries_calculation_employee_uq ON payroll_entries(venue_id,calculation_run_id,user_id)
  WHERE calculation_run_id IS NOT NULL;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM payroll_entries WHERE status IN ('draft','approved','paid')
    AND (period_to<period_from OR NOT isfinite(period_from) OR NOT isfinite(period_to))) THEN
    RAISE EXCEPTION 'payroll_calculation_entry_invalid_legacy_period_requires_review' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname='payroll_entries_calculation_provenance_fk') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_calculation_provenance_fk
      FOREIGN KEY(venue_id,calculation_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname='payroll_entries_materialized_owner_fk') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_materialized_owner_fk
      FOREIGN KEY(venue_id,materialized_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname='payroll_entries_calculation_metadata_check') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_calculation_metadata_check CHECK(
      (calculation_run_id IS NULL AND calculation_provenance_sha256 IS NULL AND calculation_gross_cents IS NULL
        AND materialized_by IS NULL AND materialized_by_name IS NULL AND materialized_at IS NULL
        AND employee_name_snapshot IS NULL AND calculation_scheme_name_snapshot IS NULL)
      OR (calculation_run_id IS NOT NULL AND calculation_provenance_sha256 IS NOT NULL
        AND calculation_provenance_sha256 ~ '^[0-9a-f]{64}$' AND calculation_gross_cents IS NOT NULL
        AND calculation_gross_cents BETWEEN 0 AND 9007199254740991 AND calculation_gross_cents=amount*100
        AND materialized_by IS NOT NULL AND length(btrim(materialized_by_name)) BETWEEN 1 AND 500 AND materialized_by_name IS NOT NULL
        AND materialized_at IS NOT NULL AND isfinite(materialized_at)
        AND employee_name_snapshot IS NOT NULL AND length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160
        AND calculation_scheme_name_snapshot IS NOT NULL AND length(btrim(calculation_scheme_name_snapshot)) BETWEEN 1 AND 500
        AND rule_id IS NULL AND period_to>=period_from));
  END IF;
  -- <> is commutative and supported by btree_gist integer_ops. This exclusion
  -- blocks mixed legacy/run pairs only, including concurrent uncommitted rows.
  -- Invalid active legacy periods fail the preflight above without changing rows.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname='payroll_entries_mixed_calculation_overlap') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_mixed_calculation_overlap
      EXCLUDE USING gist(venue_id WITH =,user_id WITH =,
        (daterange(period_from,period_to,'[]')) WITH &&,
        (CASE WHEN calculation_run_id IS NULL THEN 0 ELSE 1 END) WITH <>)
      WHERE(status IN ('draft','approved','paid'));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_entries'::regclass AND conname='payroll_entries_calculation_overlap') THEN
    ALTER TABLE payroll_entries ADD CONSTRAINT payroll_entries_calculation_overlap
      EXCLUDE USING gist(venue_id WITH =,user_id WITH =,(daterange(period_from,period_to,'[]')) WITH &&)
      WHERE(calculation_run_id IS NOT NULL AND status IN ('draft','approved','paid'));
  END IF;
END $$;
-- Do not accept a same-named but weakened pre-existing exclusion/index.
DO $$ DECLARE c record; idx record; expected_ops oid[]; expected_expression text; expected_predicate text;
BEGIN
  FOR c IN SELECT conname,contype,convalidated,condeferrable,conexclop,conindid
    FROM pg_constraint WHERE conrelid='payroll_entries'::regclass
      AND conname IN ('payroll_entries_mixed_calculation_overlap','payroll_entries_calculation_overlap') LOOP
    SELECT * INTO idx FROM pg_index WHERE indexrelid=c.conindid;
    expected_ops:=ARRAY['=(uuid,uuid)'::regoperator::oid,'=(uuid,uuid)'::regoperator::oid,'&&(anyrange,anyrange)'::regoperator::oid];
    expected_expression:='daterange(period_from,period_to,''[]''::text)';
    expected_predicate:='(status=ANY(ARRAY[''draft''::text,''approved''::text,''paid''::text]))';
    IF c.conname='payroll_entries_mixed_calculation_overlap' THEN
      expected_ops:=array_append(expected_ops,'<>(integer,integer)'::regoperator::oid);
      expected_expression:=expected_expression||',CASEWHEN(calculation_run_idISNULL)THEN0ELSE1END';
    ELSE
      expected_predicate:='((calculation_run_idISNOTNULL)AND'||expected_predicate||')';
    END IF;
    IF c.contype<>'x' OR NOT c.convalidated OR c.condeferrable OR c.conexclop IS DISTINCT FROM expected_ops
      OR NOT COALESCE(idx.indisvalid,false) OR NOT COALESCE(idx.indisready,false)
      OR idx.indnkeyatts<>cardinality(expected_ops)
      OR pg_get_indexdef(c.conindid,1,true)<>'venue_id' OR pg_get_indexdef(c.conindid,2,true)<>'user_id'
      OR regexp_replace(pg_get_expr(idx.indexprs,idx.indrelid),'\s','','g') IS DISTINCT FROM expected_expression
      OR regexp_replace(pg_get_expr(idx.indpred,idx.indrelid),'\s','','g') IS DISTINCT FROM expected_predicate THEN
      RAISE EXCEPTION 'payroll_calculation_entry_overlap_constraint_mismatch: %',c.conname USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT i.* INTO idx FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid
    WHERE i.indrelid='payroll_entries'::regclass AND x.relname='payroll_entries_calculation_employee_uq';
  IF idx.indexrelid IS NULL OR NOT idx.indisunique OR NOT idx.indisvalid OR idx.indnkeyatts<>3
    OR pg_get_indexdef(idx.indexrelid,1,true)<>'venue_id' OR pg_get_indexdef(idx.indexrelid,2,true)<>'calculation_run_id'
    OR pg_get_indexdef(idx.indexrelid,3,true)<>'user_id'
    OR regexp_replace(pg_get_expr(idx.indpred,idx.indrelid),'\s','','g') IS DISTINCT FROM '(calculation_run_idISNOTNULL)' THEN
    RAISE EXCEPTION 'payroll_calculation_entry_identity_index_mismatch' USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p jsonb; actor record; employee record; total numeric; member_count integer; input_count integer; replay_amount numeric; names integer;
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
      IF NEW.status IN ('approved','paid') THEN RAISE EXCEPTION 'payroll_run_payout_not_enabled' USING ERRCODE='23514'; END IF;
      IF (to_jsonb(NEW)-ARRAY['status','cancelled_at','cancelled_by','cancellation_reason'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancelled_at','cancelled_by','cancellation_reason']) THEN
        RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
      IF OLD.status='cancelled' THEN
        IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
        RETURN NEW;
      END IF;
      IF OLD.status<>'draft' OR NEW.status NOT IN ('draft','cancelled') THEN
        RAISE EXCEPTION 'payroll_calculation_entry_transition_invalid' USING ERRCODE='23514'; END IF;
      IF NEW.status='cancelled' THEN
        -- The authenticated legacy finance service owns permission checks for
        -- cancellation. Do not narrow its existing permission to owner-only.
        EXECUTE format('SELECT id FROM %I.users WHERE venue_id=$1 AND id=$2 AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
          INTO actor USING NEW.venue_id,NEW.cancelled_by;
        IF actor.id IS NULL OR NEW.cancelled_at IS NULL OR NOT isfinite(NEW.cancelled_at)
          OR length(btrim(COALESCE(NEW.cancellation_reason,''))) NOT BETWEEN 3 AND 500 THEN
          RAISE EXCEPTION 'payroll_calculation_entry_cancellation_invalid' USING ERRCODE='23514'; END IF;
      ELSIF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancellation_reason IS NOT NULL THEN
        RAISE EXCEPTION 'payroll_calculation_entry_cancellation_invalid' USING ERRCODE='23514';
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
CREATE OR REPLACE FUNCTION payroll_reject_calculation_entry_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked boolean;
BEGIN
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE calculation_run_id IS NOT NULL)',TG_TABLE_SCHEMA) INTO linked;
  IF linked THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS payroll_calculation_entry_guard ON payroll_entries;
CREATE TRIGGER payroll_calculation_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_entries
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_calculation_entry();
DROP TRIGGER IF EXISTS payroll_calculation_entry_truncate ON payroll_entries;
CREATE TRIGGER payroll_calculation_entry_truncate BEFORE TRUNCATE ON payroll_entries
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_calculation_entry_truncate();

CREATE TABLE IF NOT EXISTS payroll_calculation_entry_requests (
  venue_id uuid NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL, entry_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  response_payload text NOT NULL CHECK(octet_length(response_payload)<=65536 AND jsonb_typeof(response_payload::jsonb)='object'),
  response_sha256 char(64) NOT NULL CHECK(response_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(response_payload,'UTF8')),'hex')=response_sha256),
  PRIMARY KEY(venue_id,idempotency_key),
  FOREIGN KEY(venue_id,entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; p jsonb; body jsonb;
BEGIN
  p:=NEW.response_payload::jsonb; body:=p->'entry';
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO e USING NEW.venue_id,NEW.entry_id;
  IF e.id IS NULL OR e.calculation_run_id IS NULL OR p->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR p->'replayed' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p->'existing') IS DISTINCT FROM 'boolean'
    OR body->>'id' IS DISTINCT FROM NEW.entry_id::text OR body->>'userId' IS DISTINCT FROM e.user_id::text
    OR body->>'origin' IS DISTINCT FROM 'calculation_run' OR body->>'calculationRunId' IS DISTINCT FROM e.calculation_run_id::text
    OR body->>'provenanceSha256' IS DISTINCT FROM e.calculation_provenance_sha256::text
    OR body->'amountCents' IS DISTINCT FROM to_jsonb(e.calculation_gross_cents)
    OR body->>'periodFrom' IS DISTINCT FROM to_char(e.period_from,'YYYY-MM-DD') OR body->>'periodTo' IS DISTINCT FROM to_char(e.period_to,'YYYY-MM-DD')
    OR body->>'currency' IS DISTINCT FROM 'RUB' OR body->>'employeeName' IS DISTINCT FROM e.employee_name_snapshot
    OR body->>'schemeName' IS DISTINCT FROM e.calculation_scheme_name_snapshot
    OR body->>'financeCategoryId' IS DISTINCT FROM e.finance_category_id::text
    OR body->>'status' IS DISTINCT FROM e.status
    OR body->'allowedActions' IS DISTINCT FROM (CASE WHEN e.status='draft' THEN '["cancel"]'::jsonb ELSE '[]'::jsonb END)
    OR body->'officialReady' IS DISTINCT FROM 'false'::jsonb OR body->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
    OR body->>'transitionBlockedReason' IS DISTINCT FROM 'payroll_run_payout_not_enabled' THEN
    RAISE EXCEPTION 'payroll_calculation_entry_response_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_reject_calculation_entry_request_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll_calculation_entry_request_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS payroll_calculation_entry_request_guard ON payroll_calculation_entry_requests;
CREATE TRIGGER payroll_calculation_entry_request_guard BEFORE INSERT ON payroll_calculation_entry_requests
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_calculation_entry_request();
DROP TRIGGER IF EXISTS payroll_calculation_entry_request_immutable ON payroll_calculation_entry_requests;
CREATE TRIGGER payroll_calculation_entry_request_immutable BEFORE UPDATE OR DELETE ON payroll_calculation_entry_requests
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_calculation_entry_request_mutation();
DROP TRIGGER IF EXISTS payroll_calculation_entry_request_truncate ON payroll_calculation_entry_requests;
CREATE TRIGGER payroll_calculation_entry_request_truncate BEFORE TRUNCATE ON payroll_calculation_entry_requests
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_calculation_entry_request_mutation();
