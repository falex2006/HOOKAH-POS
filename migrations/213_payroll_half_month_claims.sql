-- EXPERIMENTAL candidate only: review full baseline definitions and real
-- schema4 replay. Generic legacy H1 deferral guard is NOT YET IMPLEMENTED.
-- A later migration may extend this CHECK. Preserve that exact CHECK on
-- replay rather than narrowing it over existing future-schema records.
DO $$
DECLARE current_def text;
BEGIN
 SELECT pg_get_constraintdef(c.oid) INTO current_def FROM pg_constraint c
 WHERE c.conrelid='payroll_run_provenance'::regclass AND c.conname='payroll_run_provenance_capability_pair_check';
 IF current_def IS NULL THEN RAISE EXCEPTION 'payroll_h1_capability_constraint_missing'; END IF;
 IF position('employee_attributed_h1_fixed_shifts_v1' in current_def)>0 THEN
  IF position('employee_attributed_merchandise_net_no_refund_v1' in current_def)=0 OR position('employee_attributed_remaining_net_refund_v2' in current_def)=0 THEN
   RAISE EXCEPTION 'payroll_h1_capability_constraint_incompatible'; END IF;
 ELSE
  IF regexp_count(current_def,'schema_version')<>2 OR regexp_count(current_def,'capability_version')<>2 THEN RAISE EXCEPTION 'payroll_h1_later_constraint_requires_h1_support'; END IF;
  IF position('employee_attributed_merchandise_net_no_refund_v1' in current_def)=0 OR position('employee_attributed_remaining_net_refund_v2' in current_def)=0 THEN
   RAISE EXCEPTION 'payroll_h1_capability_constraint_incompatible'; END IF;
  ALTER TABLE payroll_run_provenance DROP CONSTRAINT payroll_run_provenance_capability_pair_check;
  ALTER TABLE payroll_run_provenance ADD CONSTRAINT payroll_run_provenance_capability_pair_check CHECK (
   (schema_version=1 AND capability_version='employee_attributed_merchandise_net_no_refund_v1') OR
   (schema_version=2 AND capability_version='employee_attributed_remaining_net_refund_v2') OR
   (schema_version=4 AND capability_version='employee_attributed_h1_fixed_shifts_v1'));
 END IF;
END $$;
CREATE OR REPLACE FUNCTION payroll_validate_run_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run record; payload jsonb; p jsonb; closure jsonb; scheme jsonb; source_period_from date; source_period_to date;
  closure_ts timestamptz; closure_date date;
BEGIN
  payload:=NEW.evidence_payload::jsonb; p:=payload->'period'; closure:=payload->'periodClosure'; scheme:=payload->'schemeSnapshot';
  IF payload->'schemaVersion' IS DISTINCT FROM to_jsonb(NEW.schema_version)
    OR payload->>'capabilityVersion' IS DISTINCT FROM NEW.capability_version
    OR payload->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR payload->>'runId' IS DISTINCT FROM NEW.run_id::text
    OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(scheme) IS DISTINCT FROM 'object'
    OR jsonb_typeof(closure) IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'sourceEvidence') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payroll provenance payload context invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(payload->'inputWatermark') IS DISTINCT FROM 'string' OR COALESCE(payload->>'inputWatermark','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(payload->'closureWatermark') IS DISTINCT FROM 'string' OR COALESCE(payload->>'closureWatermark','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(payload->'calculationWatermark') IS DISTINCT FROM 'string' OR COALESCE(payload->>'calculationWatermark','') !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(payload->'snapshotInputWatermark') IS DISTINCT FROM 'string' OR COALESCE(payload->>'snapshotInputWatermark','') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'payroll provenance watermark invalid' USING ERRCODE='23514'; END IF;
  IF payload->>'totalAmountCents' IS NULL OR (payload->>'totalAmountCents') !~ '^(0|[1-9][0-9]*)$'
    OR (payload->>'totalAmountCents')::numeric<>NEW.total_amount_cents THEN
    RAISE EXCEPTION 'payroll provenance total payload mismatch' USING ERRCODE='23514'; END IF;
  BEGIN source_period_from:=(p->>'from')::date; source_period_to:=(p->>'to')::date;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'payroll provenance period invalid' USING ERRCODE='23514'; END;
  IF jsonb_typeof(p->'from') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'to') IS DISTINCT FROM 'string'
    OR COALESCE(p->>'from','') !~ '^\d{4}-\d{2}-\d{2}$' OR COALESCE(p->>'to','') !~ '^\d{4}-\d{2}-\d{2}$'
    OR source_period_from IS DISTINCT FROM to_char(source_period_from,'YYYY-MM-DD')::date
    OR source_period_to IS DISTINCT FROM to_char(source_period_to,'YYYY-MM-DD')::date
    OR p->>'from' IS DISTINCT FROM to_char(source_period_from,'YYYY-MM-DD') OR p->>'to' IS DISTINCT FROM to_char(source_period_to,'YYYY-MM-DD')
    OR closure->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR closure->>'venueId' IS DISTINCT FROM NEW.venue_id::text
    OR closure->'period' IS DISTINCT FROM p OR jsonb_typeof(closure->'transactionTimestamp') IS DISTINCT FROM 'string'
    OR jsonb_typeof(closure->'venueLocalDate') IS DISTINCT FROM 'string' OR jsonb_typeof(closure->'timezone') IS DISTINCT FROM 'string'
    OR scheme->>'versionId' IS DISTINCT FROM payload->>'schemeVersionId'
    OR scheme->>'currency' IS DISTINCT FROM payload->>'currency' THEN
    RAISE EXCEPTION 'payroll provenance closure invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO run USING NEW.venue_id,NEW.run_id;
  IF jsonb_typeof(closure->'transactionTimestamp') IS DISTINCT FROM 'string'
    OR COALESCE(closure->>'transactionTimestamp','') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$'
    OR COALESCE(closure->>'venueLocalDate','') !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'payroll provenance closure format invalid' USING ERRCODE='23514'; END IF;
  BEGIN closure_ts:=(closure->>'transactionTimestamp')::timestamptz; closure_date:=(closure->>'venueLocalDate')::date;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'payroll provenance closure timestamp invalid' USING ERRCODE='23514'; END;
  IF run.status IS DISTINCT FROM 'ready' OR NOT ((NEW.schema_version=1 AND NEW.capability_version='employee_attributed_merchandise_net_no_refund_v1' AND run.engine_version='payroll-verified-no-refund-v1')
      OR (NEW.schema_version=2 AND NEW.capability_version='employee_attributed_remaining_net_refund_v2' AND run.engine_version='payroll-verified-remaining-net-v2')
      OR (NEW.schema_version=4 AND NEW.capability_version='employee_attributed_h1_fixed_shifts_v1' AND run.engine_version='h1_fixed_shifts_v1' AND extract(day from run.period_from)=1 AND run.period_to=run.period_from+13))
    OR payload->>'schemeVersionId' IS DISTINCT FROM run.scheme_version_id::text
    OR source_period_from IS DISTINCT FROM run.period_from OR source_period_to IS DISTINCT FROM run.period_to
    OR payload->>'currency' IS DISTINCT FROM run.currency OR payload->>'venueTimezone' IS DISTINCT FROM run.venue_timezone
    OR run.input_checksum IS DISTINCT FROM NEW.evidence_sha256 OR run.input_watermark IS DISTINCT FROM payload->>'inputWatermark'
    OR closure->>'venueLocalDate' IS DISTINCT FROM to_char(closure_date,'YYYY-MM-DD')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name=closure->>'timezone')
    OR (closure_ts AT TIME ZONE (closure->>'timezone'))::date IS DISTINCT FROM closure_date
    OR closure_date<=run.period_to OR closure->>'timezone' IS DISTINCT FROM run.venue_timezone THEN
    RAISE EXCEPTION 'payroll provenance does not match verified ready run' USING ERRCODE='23514'; END IF;
  IF NEW.schema_version IN (2,4) THEN
    IF scheme->'sourcePolicies'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR scheme->'sourcePolicies'->'earnings' IS DISTINCT FROM '{"refunds":"remaining_merchandise_original_sale_date_v1","venueTurnover":"canonical_total_less_merchandise_returns_v1","marginCost":"frozen_sale_depletion_cost_payroll_v1"}'::jsonb
      OR payload->'sourceBundle'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR payload->'sourceBundle'->'recognitionEvidence'->>'encoding' IS DISTINCT FROM 'json-preserved-property-order-v1'
      OR jsonb_typeof(payload->'sourceBundle'->'recognitionEvidence'->'payload') IS DISTINCT FROM 'string'
      OR COALESCE(payload->>'sourceBundleWatermark','') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(payload->'calculatorReplay') IS DISTINCT FROM 'object'
      OR jsonb_typeof(payload->'refundQuantityEvidence') IS DISTINCT FROM 'object'
      OR payload->'refundQuantityEvidence'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR payload->'sourceEvidence'->>'capabilityVersion' IS DISTINCT FROM (CASE WHEN NEW.schema_version=4 THEN 'employee_attributed_remaining_net_refund_v2' ELSE NEW.capability_version END)
      OR payload->'calculatorReplay'->'input'->'sourceEvidence' IS DISTINCT FROM payload->'sourceEvidence'
      OR payload->'calculatorReplay'->'input'->'scheme' IS DISTINCT FROM scheme THEN
      RAISE EXCEPTION 'payroll refund aware source envelope invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.schema_version=4 AND (payload->'calculatorReplay'->'schemaVersion' IS DISTINCT FROM '1'::jsonb
     OR payload->'calculatorReplay'->>'encoding' IS DISTINCT FROM 'canonical-json-safe-integers-v1'
     OR payload->'calculatorReplay'->>'algorithm' IS DISTINCT FROM 'h1_fixed_shifts_v1'
     OR COALESCE(payload->'calculatorReplay'->>'engineRevision','') !~ '^[0-9a-f]{64}$'
     OR COALESCE(payload->'calculatorReplay'->>'inputSha256','') !~ '^[0-9a-f]{64}$'
     OR COALESCE(payload->'calculatorReplay'->>'resultSha256','') !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(payload->'calculatorReplay'->'result'->'employees') IS DISTINCT FROM 'array'
     OR jsonb_path_exists(payload->'calculatorReplay'->'result','$.**.milestoneBonusCents ? (@ != 0)')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'calculatorReplay'->'result'->'employees') x
       WHERE x->'milestoneBonusCents' IS DISTINCT FROM '0'::jsonb)) THEN
    RAISE EXCEPTION 'payroll_h1_monthly_milestone_not_deferred' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_validate_run_provenance_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_venue uuid; target_run uuid; parent record; provenance record; total numeric;
BEGIN
  IF TG_TABLE_NAME='payroll_calculation_runs' THEN target_venue:=NEW.venue_id; target_run:=NEW.id;
  ELSE target_venue:=NEW.venue_id; target_run:=NEW.run_id; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO parent USING target_venue,target_run;
  IF parent.id IS NULL OR parent.engine_version NOT IN ('payroll-verified-no-refund-v1','payroll-verified-remaining-net-v2','h1_fixed_shifts_v1') THEN RETURN NULL; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA)
    INTO provenance USING target_venue,target_run;
  IF parent.status='ready' AND provenance.run_id IS NULL THEN
    RAISE EXCEPTION 'verified payroll run requires provenance' USING ERRCODE='23514'; END IF;
  IF parent.status='ready' THEN
    EXECUTE format('SELECT COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA)
      INTO total USING target_venue,target_run;
    IF total<>provenance.total_amount_cents THEN RAISE EXCEPTION 'payroll provenance total mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
-- UNNUMBERED REVIEW DRAFT. Target candidate 213, base a0c94872/202+204+205+208.
-- NOT production-ready: exact catalog fingerprint/replay review required.
-- H1 claim is a durable identity, not proof of payout or an H2 authorization.
ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS payroll_half_kind text;
ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS payroll_h1_insert_xid bigint;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_entries_h1_identity_uq ON payroll_entries
 (venue_id,id,user_id,calculation_run_id,period_from,period_to,calculation_provenance_sha256);
CREATE TABLE IF NOT EXISTS payroll_half_month_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 venue_id uuid NOT NULL, employee_id uuid NOT NULL, month_from date NOT NULL,
 period_from date NOT NULL, period_to date NOT NULL, run_id uuid NOT NULL, entry_id uuid NOT NULL,
 provenance_sha256 char(64) NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), claim_insert_xid bigint NOT NULL,
 UNIQUE(venue_id,id), UNIQUE(venue_id,employee_id,month_from,id), UNIQUE(venue_id,entry_id),
 CHECK(isfinite(month_from) AND extract(day from month_from)=1 AND period_from=month_from AND period_to=month_from+13),
 FOREIGN KEY(venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,entry_id,employee_id,run_id,period_from,period_to,provenance_sha256)
  REFERENCES payroll_entries(venue_id,id,user_id,calculation_run_id,period_from,period_to,calculation_provenance_sha256) ON DELETE RESTRICT
);
-- H1 history is append-only; uniqueness of the active assignment lives in a slot.
CREATE TABLE IF NOT EXISTS payroll_h1_claim_slots (
 venue_id uuid NOT NULL, employee_id uuid NOT NULL, month_from date NOT NULL,
 claim_id uuid, revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(venue_id,employee_id,month_from),
 FOREIGN KEY(venue_id,employee_id,month_from,claim_id)
  REFERENCES payroll_half_month_claims(venue_id,employee_id,month_from,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS payroll_h1_claim_voids (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), venue_id uuid NOT NULL, claim_id uuid NOT NULL,
 transition_id uuid NOT NULL, created_by uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), void_insert_xid bigint NOT NULL,
 UNIQUE(venue_id,claim_id), UNIQUE(venue_id,transition_id),
 FOREIGN KEY(venue_id,claim_id) REFERENCES payroll_half_month_claims(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,transition_id) REFERENCES payroll_calculation_entry_transitions(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION payroll_h1_entry_marker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.payroll_h1_insert_xid IS NOT NULL THEN RAISE EXCEPTION 'payroll_h1_xid_db_owned' USING ERRCODE='23514'; END IF;
  IF NEW.payroll_half_kind IS NULL THEN RETURN NEW; END IF;
  IF NEW.payroll_half_kind<>'h1' OR NEW.calculation_run_id IS NULL OR NEW.status<>'draft'
    OR extract(day from NEW.period_from)<>1
    OR NEW.period_to IS DISTINCT FROM NEW.period_from+13 THEN
   RAISE EXCEPTION 'payroll_h1_marker_invalid' USING ERRCODE='23514'; END IF;
  NEW.payroll_h1_insert_xid:=txid_current(); RETURN NEW;
 END IF;
 IF ROW(NEW.payroll_half_kind,NEW.payroll_h1_insert_xid) IS DISTINCT FROM ROW(OLD.payroll_half_kind,OLD.payroll_h1_insert_xid) THEN
  RAISE EXCEPTION 'payroll_h1_marker_immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h1_claim_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; p record; r record; a record; payload jsonb;
BEGIN
 EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO e USING NEW.venue_id,NEW.entry_id;
 EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA) INTO p USING NEW.venue_id,NEW.run_id;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO r USING NEW.venue_id,NEW.run_id;
 EXECUTE format('SELECT id FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA) INTO a USING NEW.venue_id,NEW.created_by;
 IF e.id IS NULL OR e.payroll_half_kind IS DISTINCT FROM 'h1' OR e.payroll_h1_insert_xid IS DISTINCT FROM txid_current()
    OR e.status IS DISTINCT FROM 'draft' OR e.user_id IS DISTINCT FROM NEW.employee_id OR e.calculation_run_id IS DISTINCT FROM NEW.run_id
    OR e.period_from IS DISTINCT FROM NEW.period_from OR e.period_to IS DISTINCT FROM NEW.period_to
    OR e.calculation_provenance_sha256 IS DISTINCT FROM NEW.provenance_sha256 OR e.materialized_by IS DISTINCT FROM NEW.created_by
    OR a.id IS NULL OR p.run_id IS NULL OR r.id IS NULL OR r.status IS DISTINCT FROM 'ready'
    OR r.period_from IS DISTINCT FROM NEW.period_from OR r.period_to IS DISTINCT FROM NEW.period_to
    OR p.evidence_sha256 IS DISTINCT FROM NEW.provenance_sha256
    OR NOT ((p.schema_version=1 AND p.capability_version='employee_attributed_merchandise_net_no_refund_v1' AND r.engine_version='payroll-verified-no-refund-v1')
         OR (p.schema_version=2 AND p.capability_version='employee_attributed_remaining_net_refund_v2' AND r.engine_version='payroll-verified-remaining-net-v2')
         OR (p.schema_version=4 AND p.capability_version='employee_attributed_h1_fixed_shifts_v1' AND r.engine_version='h1_fixed_shifts_v1')) THEN
  RAISE EXCEPTION 'payroll_h1_claim_binding_invalid' USING ERRCODE='23514'; END IF;
 payload:=p.evidence_payload::jsonb;
 IF payload->'period'->>'from' IS DISTINCT FROM to_char(NEW.period_from,'YYYY-MM-DD')
    OR payload->'period'->>'to' IS DISTINCT FROM to_char(NEW.period_to,'YYYY-MM-DD')
    OR COALESCE(payload->'periodClosure'->>'venueLocalDate','') !~ '^\d{4}-\d{2}-\d{2}$'
    OR (payload->'periodClosure'->>'venueLocalDate')::date <= NEW.period_to THEN
  RAISE EXCEPTION 'payroll_h1_closure_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.claim_insert_xid IS NOT NULL THEN RAISE EXCEPTION 'payroll_h1_claim_xid_db_owned' USING ERRCODE='23514'; END IF;
 NEW.claim_insert_xid:=txid_current(); NEW.created_at:=clock_timestamp();
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h1_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll_h1_claim_immutable' USING ERRCODE='55000'; END $$;
CREATE OR REPLACE FUNCTION payroll_h1_entry_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; k bigint; active bigint;
BEGIN
 IF NEW.payroll_half_kind IS NULL THEN RETURN NULL; END IF;
 EXECUTE format('SELECT count(*) FROM %I.payroll_half_month_claims c WHERE c.venue_id=$1 AND c.entry_id=$2 AND c.employee_id=$3 AND c.run_id=$4 AND c.period_from=$5 AND c.period_to=$6 AND c.provenance_sha256=$7',TG_TABLE_SCHEMA)
  INTO n USING NEW.venue_id,NEW.id,NEW.user_id,NEW.calculation_run_id,NEW.period_from,NEW.period_to,NEW.calculation_provenance_sha256;
 EXECUTE format('SELECT count(*) FROM %I.payroll_calculation_entry_requests q WHERE q.venue_id=$1 AND q.entry_id=$2 AND q.created_by=$3 AND (q.response_payload::jsonb)->>''existing''=''false'' AND (q.response_payload::jsonb)->>''replayed''=''false'' AND (q.response_payload::jsonb)->''entry''->>''id''=$2::text',TG_TABLE_SCHEMA)
  INTO k USING NEW.venue_id,NEW.id,NEW.materialized_by;
 EXECUTE format('SELECT count(*) FROM %I.payroll_h1_claim_slots s JOIN %I.payroll_half_month_claims c ON c.venue_id=s.venue_id AND c.id=s.claim_id WHERE c.venue_id=$1 AND c.entry_id=$2 AND s.employee_id=c.employee_id AND s.month_from=c.month_from',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO active USING NEW.venue_id,NEW.id;
 IF n<>1 OR k<>1 OR active<>1 THEN RAISE EXCEPTION 'payroll_h1_claim_or_receipt_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- A claim or VOID minted in this same transaction is the only authority to
-- change a slot. Generic direct writes, deletes and truncates are rejected.
CREATE OR REPLACE FUNCTION payroll_h1_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'payroll_h1_slot_immutable' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.venue_id,NEW.employee_id,NEW.month_from) IS DISTINCT FROM ROW(OLD.venue_id,OLD.employee_id,OLD.month_from)
   OR NEW.revision IS DISTINCT FROM OLD.revision+1) THEN RAISE EXCEPTION 'payroll_h1_slot_invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.revision<>1 OR NEW.claim_id IS NULL) THEN RAISE EXCEPTION 'payroll_h1_slot_invalid' USING ERRCODE='23514'; END IF;
 IF (TG_OP='INSERT' OR OLD.claim_id IS NULL) AND NEW.claim_id IS NOT NULL THEN
  EXECUTE format('SELECT count(*) FROM %I.payroll_half_month_claims WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3 AND id=$4 AND claim_insert_xid=txid_current()',TG_TABLE_SCHEMA)
   INTO n USING NEW.venue_id,NEW.employee_id,NEW.month_from,NEW.claim_id;
 ELSIF TG_OP='UPDATE' AND OLD.claim_id IS NOT NULL AND NEW.claim_id IS NULL THEN
  EXECUTE format('SELECT count(*) FROM %I.payroll_h1_claim_voids WHERE venue_id=$1 AND claim_id=$2 AND void_insert_xid=txid_current()',TG_TABLE_SCHEMA)
   INTO n USING OLD.venue_id,OLD.claim_id;
 ELSE RAISE EXCEPTION 'payroll_h1_slot_transition_invalid' USING ERRCODE='23514'; END IF;
 IF n<>1 THEN RAISE EXCEPTION 'payroll_h1_slot_witness_missing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h1_claim_activate_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
 EXECUTE format('INSERT INTO %I.payroll_h1_claim_slots AS s (venue_id,employee_id,month_from,claim_id,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT (venue_id,employee_id,month_from) DO UPDATE SET claim_id=EXCLUDED.claim_id,revision=s.revision+1 WHERE s.claim_id IS NULL RETURNING revision',TG_TABLE_SCHEMA)
  INTO v USING NEW.venue_id,NEW.employee_id,NEW.month_from,NEW.id;
 IF v IS NULL THEN RAISE EXCEPTION 'payroll_h1_slot_occupied' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION payroll_h1_void_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; e record; t record;
BEGIN
 IF NEW.void_insert_xid IS NOT NULL THEN RAISE EXCEPTION 'payroll_h1_void_xid_db_owned' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT * FROM %I.payroll_half_month_claims WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO c USING NEW.venue_id,NEW.claim_id;
 EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO e USING NEW.venue_id,c.entry_id;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO t USING NEW.venue_id,NEW.transition_id;
 IF c.id IS NULL OR e.id IS NULL OR e.status IS DISTINCT FROM 'cancelled' OR e.expense_id IS NOT NULL
   OR t.id IS NULL OR t.action IS DISTINCT FROM 'cancel' OR t.entry_id IS DISTINCT FROM c.entry_id
   OR t.employee_id IS DISTINCT FROM c.employee_id OR t.calculation_run_id IS DISTINCT FROM c.run_id
   OR t.provenance_sha256 IS DISTINCT FROM c.provenance_sha256 OR t.transaction_id IS DISTINCT FROM txid_current()
   OR t.created_by IS DISTINCT FROM NEW.created_by OR e.cancelled_by IS DISTINCT FROM t.created_by
   OR e.cancelled_at IS DISTINCT FROM t.created_at OR t.reason IS DISTINCT FROM NEW.reason OR e.cancellation_reason IS DISTINCT FROM t.reason THEN
  RAISE EXCEPTION 'payroll_h1_void_invalid' USING ERRCODE='23514'; END IF;
 NEW.void_insert_xid:=txid_current(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h1_auto_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; t record; updated bigint;
BEGIN
 IF OLD.payroll_half_kind IS DISTINCT FROM 'h1' OR NEW.status IS DISTINCT FROM 'cancelled' OR OLD.status='cancelled' THEN RETURN NULL; END IF;
 EXECUTE format('SELECT * FROM %I.payroll_half_month_claims WHERE venue_id=$1 AND entry_id=$2',TG_TABLE_SCHEMA) INTO c USING NEW.venue_id,NEW.id;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND entry_id=$2 AND action=''cancel'' AND transaction_id=txid_current()',TG_TABLE_SCHEMA) INTO t USING NEW.venue_id,NEW.id;
 IF c.id IS NULL OR t.id IS NULL THEN RAISE EXCEPTION 'payroll_h1_cancel_transition_missing' USING ERRCODE='23514'; END IF;
 EXECUTE format('INSERT INTO %I.payroll_h1_claim_voids (venue_id,claim_id,transition_id,created_by,reason) VALUES($1,$2,$3,$4,$5)',TG_TABLE_SCHEMA)
  USING NEW.venue_id,c.id,t.id,t.created_by,t.reason;
 EXECUTE format('UPDATE %I.payroll_h1_claim_slots SET claim_id=NULL,revision=revision+1 WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3 AND claim_id=$4',TG_TABLE_SCHEMA)
  USING c.venue_id,c.employee_id,c.month_from,c.id;
 GET DIAGNOSTICS updated=ROW_COUNT;
 IF updated<>1 THEN RAISE EXCEPTION 'payroll_h1_slot_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION payroll_h1_void_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; active bigint;
BEGIN
 EXECUTE format('SELECT count(*) FROM %I.payroll_calculation_entry_transition_requests q JOIN %I.payroll_calculation_entry_transitions t ON t.venue_id=q.venue_id AND t.id=q.transition_id WHERE q.venue_id=$1 AND q.transition_id=$2 AND q.created_by=$3 AND encode(sha256(convert_to(q.response_payload,''UTF8'')),''hex'')=q.response_hash AND (q.response_payload::jsonb)->>''action''=''cancel'' AND (q.response_payload::jsonb)->>''transitionId''=$2::text AND (q.response_payload::jsonb)->''entry''->>''id''=t.entry_id::text AND (q.response_payload::jsonb)->''entry''->>''status''=''cancelled''',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
  INTO n USING NEW.venue_id,NEW.transition_id,NEW.created_by;
 EXECUTE format('SELECT count(*) FROM %I.payroll_h1_claim_slots WHERE venue_id=$1 AND claim_id=$2',TG_TABLE_SCHEMA) INTO active USING NEW.venue_id,NEW.claim_id;
 IF n<>1 OR active<>0 THEN RAISE EXCEPTION 'payroll_h1_void_receipt_or_slot_invalid' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS payroll_h1_marker_guard ON payroll_entries;
CREATE TRIGGER payroll_h1_marker_guard BEFORE INSERT OR UPDATE ON payroll_entries FOR EACH ROW EXECUTE FUNCTION payroll_h1_entry_marker_guard();
DROP TRIGGER IF EXISTS payroll_h1_claim_validate ON payroll_half_month_claims;
CREATE TRIGGER payroll_h1_claim_validate BEFORE INSERT ON payroll_half_month_claims FOR EACH ROW EXECUTE FUNCTION payroll_h1_claim_validate();
DROP TRIGGER IF EXISTS payroll_h1_claim_immutable ON payroll_half_month_claims;
CREATE TRIGGER payroll_h1_claim_immutable BEFORE UPDATE OR DELETE ON payroll_half_month_claims FOR EACH ROW EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h1_claim_truncate ON payroll_half_month_claims;
CREATE TRIGGER payroll_h1_claim_truncate BEFORE TRUNCATE ON payroll_half_month_claims FOR EACH STATEMENT EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h1_entry_commit_check ON payroll_entries;
CREATE CONSTRAINT TRIGGER payroll_h1_entry_commit_check AFTER INSERT ON payroll_entries DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION payroll_h1_entry_commit_check();

DROP TRIGGER IF EXISTS payroll_h1_slot_guard ON payroll_h1_claim_slots;
CREATE TRIGGER payroll_h1_slot_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_h1_claim_slots FOR EACH ROW EXECUTE FUNCTION payroll_h1_slot_guard();
DROP TRIGGER IF EXISTS payroll_h1_slot_truncate ON payroll_h1_claim_slots;
CREATE TRIGGER payroll_h1_slot_truncate BEFORE TRUNCATE ON payroll_h1_claim_slots FOR EACH STATEMENT EXECUTE FUNCTION payroll_h1_slot_guard();
DROP TRIGGER IF EXISTS payroll_h1_claim_activate_slot ON payroll_half_month_claims;
CREATE TRIGGER payroll_h1_claim_activate_slot AFTER INSERT ON payroll_half_month_claims FOR EACH ROW EXECUTE FUNCTION payroll_h1_claim_activate_slot();
DROP TRIGGER IF EXISTS payroll_h1_void_validate ON payroll_h1_claim_voids;
CREATE TRIGGER payroll_h1_void_validate BEFORE INSERT ON payroll_h1_claim_voids FOR EACH ROW EXECUTE FUNCTION payroll_h1_void_validate();
DROP TRIGGER IF EXISTS payroll_h1_void_immutable ON payroll_h1_claim_voids;
CREATE TRIGGER payroll_h1_void_immutable BEFORE UPDATE OR DELETE ON payroll_h1_claim_voids FOR EACH ROW EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h1_void_truncate ON payroll_h1_claim_voids;
CREATE TRIGGER payroll_h1_void_truncate BEFORE TRUNCATE ON payroll_h1_claim_voids FOR EACH STATEMENT EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h1_auto_void ON payroll_entries;
CREATE TRIGGER payroll_h1_auto_void AFTER UPDATE OF status ON payroll_entries FOR EACH ROW EXECUTE FUNCTION payroll_h1_auto_void();
DROP TRIGGER IF EXISTS payroll_h1_void_commit_check ON payroll_h1_claim_voids;
CREATE CONSTRAINT TRIGGER payroll_h1_void_commit_check AFTER INSERT ON payroll_h1_claim_voids DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION payroll_h1_void_commit_check();

CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p jsonb; actor record; employee record; total numeric; member_count integer; input_count integer; replay_amount numeric; names integer; transition record; next_action text; is_v2 boolean; replaced boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.calculation_run_id IS NOT NULL THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  -- v2 money transitions require exact verified provenance; insertion remains draft-only.
  IF NEW.calculation_run_id IS NOT NULL THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2 AND r.engine_version=''payroll-verified-remaining-net-v2'' AND r.status=''ready'' AND p.schema_version=2 AND p.capability_version=''employee_attributed_remaining_net_refund_v2'' AND p.evidence_sha256=$3)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO is_v2 USING NEW.venue_id,NEW.calculation_run_id,NEW.calculation_provenance_sha256;
    IF TG_OP='INSERT' AND is_v2 THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND supersedes_run_id=$2 AND engine_version=''payroll-verified-remaining-net-v2'')',TG_TABLE_SCHEMA)
        INTO replaced USING NEW.venue_id,NEW.calculation_run_id;
      IF replaced THEN RAISE EXCEPTION 'payroll_supersession_original_replaced' USING ERRCODE='23514'; END IF;
    END IF;
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
  EXECUTE format('SELECT r.*,p.evidence_payload,p.evidence_sha256,p.schema_version AS provenance_schema_version,p.capability_version AS provenance_capability_version FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO r USING NEW.venue_id,NEW.calculation_run_id;
  IF r.id IS NULL OR r.status<>'ready' OR NOT ((r.engine_version='payroll-verified-no-refund-v1' AND r.provenance_schema_version=1 AND r.provenance_capability_version='employee_attributed_merchandise_net_no_refund_v1')
      OR (r.engine_version='payroll-verified-remaining-net-v2' AND r.provenance_schema_version=2 AND r.provenance_capability_version='employee_attributed_remaining_net_refund_v2')
      OR (r.engine_version='h1_fixed_shifts_v1' AND r.provenance_schema_version=4 AND r.provenance_capability_version='employee_attributed_h1_fixed_shifts_v1' AND NEW.payroll_half_kind='h1')) OR r.currency<>'RUB'
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

-- Legacy partial runs must not turn monthly components into an early payment.
-- Evaluate only this employee, each active date and its first assigned role;
-- ordered personal mode overrides use the calculator's precedence. Actual
-- milestone awarded to this employee is checked in immutable replay result.
CREATE OR REPLACE FUNCTION payroll_h1_legacy_deferred_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; evidence jsonb; scheme jsonb; input jsonb; result jsonb; employee jsonb; assignment jsonb;
 override_row jsonb; member jsonb; role_params jsonb; d date; effective_mode text; active boolean;
BEGIN
 IF NEW.calculation_run_id IS NULL OR NEW.period_from IS NULL OR NEW.period_to IS NULL
   OR extract(day from NEW.period_from)<>1 OR NEW.period_to IS DISTINCT FROM NEW.period_from+13 THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN IF NEW.status NOT IN ('draft','approved','paid') THEN RETURN NEW; END IF;
 ELSIF NEW.status NOT IN ('approved','paid') OR NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
 EXECUTE format('SELECT schema_version,capability_version,evidence_payload,evidence_sha256 FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA)
  INTO p USING NEW.venue_id,NEW.calculation_run_id;
 IF p.schema_version=4 AND p.capability_version='employee_attributed_h1_fixed_shifts_v1' THEN RETURN NEW; END IF;
 IF p.schema_version NOT IN (1,2) OR p.evidence_payload IS NULL OR p.evidence_sha256 IS DISTINCT FROM NEW.calculation_provenance_sha256
    OR encode(sha256(convert_to(p.evidence_payload,'UTF8')),'hex') IS DISTINCT FROM p.evidence_sha256 THEN
  RAISE EXCEPTION 'payroll_h1_legacy_evidence_invalid' USING ERRCODE='23514'; END IF;
 evidence:=p.evidence_payload::jsonb; scheme:=evidence->'schemeSnapshot'; input:=evidence->'calculatorReplay'->'input'; result:=evidence->'calculatorReplay'->'result';
 IF jsonb_typeof(scheme) IS DISTINCT FROM 'object' OR jsonb_typeof(scheme->'roleParameters') IS DISTINCT FROM 'object'
   OR jsonb_typeof(input->'employees') IS DISTINCT FROM 'array' OR jsonb_typeof(input->'roleAssignments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(result->'employees') IS DISTINCT FROM 'array' OR (scheme ? 'employeeOverrides' AND jsonb_typeof(scheme->'employeeOverrides')<>'array') THEN
  RAISE EXCEPTION 'payroll_h1_legacy_evidence_invalid' USING ERRCODE='23514'; END IF;
 SELECT x INTO employee FROM jsonb_array_elements(input->'employees') x WHERE x->>'id'=NEW.user_id::text LIMIT 1;
 SELECT x INTO member FROM jsonb_array_elements(result->'employees') x WHERE x->>'employeeId'=NEW.user_id::text LIMIT 1;
 IF employee IS NULL OR member IS NULL OR jsonb_typeof(member->'milestoneBonusCents') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'payroll_h1_legacy_evidence_invalid' USING ERRCODE='23514'; END IF;
 IF (member->>'milestoneBonusCents')::numeric<>0 THEN RAISE EXCEPTION 'payroll_h1_monthly_component_deferred' USING ERRCODE='23514'; END IF;
 FOR d IN SELECT generate_series(NEW.period_from::timestamp,NEW.period_to::timestamp,interval '1 day')::date LOOP
  IF jsonb_typeof(employee->'activeIntervals')='array' THEN
   SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(employee->'activeIntervals') a WHERE a->>'from'<=to_char(d,'YYYY-MM-DD') AND a->>'to'>=to_char(d,'YYYY-MM-DD')) INTO active;
  ELSE active:=(COALESCE(employee->>'activeFrom','')='' OR employee->>'activeFrom'<=to_char(d,'YYYY-MM-DD'))
    AND (COALESCE(employee->>'activeTo','')='' OR employee->>'activeTo'>=to_char(d,'YYYY-MM-DD')); END IF;
  IF NOT active THEN CONTINUE; END IF;
  SELECT a INTO assignment FROM jsonb_array_elements(input->'roleAssignments') WITH ORDINALITY z(a,i)
   WHERE a->>'employeeId'=NEW.user_id::text AND a->>'effectiveFrom'<=to_char(d,'YYYY-MM-DD')
     AND (COALESCE(a->>'effectiveTo','')='' OR a->>'effectiveTo'>=to_char(d,'YYYY-MM-DD')) ORDER BY i LIMIT 1;
  IF assignment IS NULL THEN CONTINUE; END IF;
  role_params:=scheme->'roleParameters'->(assignment->>'roleId');
  IF jsonb_typeof(role_params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payroll_h1_legacy_evidence_invalid' USING ERRCODE='23514'; END IF;
  effective_mode:=COALESCE(role_params->>'mode',scheme->>'mode');
  FOR override_row IN SELECT x FROM jsonb_array_elements(COALESCE(scheme->'employeeOverrides','[]'::jsonb)) WITH ORDINALITY z(x,i)
   WHERE x->>'employeeId'=NEW.user_id::text AND x->>'mode'='override' AND x->>'path'='mode'
    AND (COALESCE(x->>'effectiveFrom','')='' OR x->>'effectiveFrom'<=to_char(d,'YYYY-MM-DD'))
    AND (COALESCE(x->>'effectiveTo','')='' OR x->>'effectiveTo'>=to_char(d,'YYYY-MM-DD')) ORDER BY i
  LOOP effective_mode:=override_row->>'value'; END LOOP;
  IF effective_mode IS NULL THEN RAISE EXCEPTION 'payroll_h1_legacy_evidence_invalid' USING ERRCODE='23514'; END IF;
  IF effective_mode='final_month_threshold' THEN RAISE EXCEPTION 'payroll_h1_monthly_component_deferred' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_h1_legacy_deferred_guard ON payroll_entries;
CREATE TRIGGER payroll_h1_legacy_deferred_guard BEFORE INSERT OR UPDATE OF status ON payroll_entries FOR EACH ROW EXECUTE FUNCTION payroll_h1_legacy_deferred_guard();

CREATE OR REPLACE FUNCTION payroll_validate_calculation_run() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_row record;
  superseded_run record;
BEGIN
  EXECUTE format('SELECT status,mode,effective_from,effective_to FROM %I.payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR SHARE', TG_TABLE_SCHEMA)
    INTO version_row USING NEW.venue_id, NEW.scheme_version_id;
  IF version_row.status IS NULL OR version_row.status = 'draft' THEN
    RAISE EXCEPTION 'payroll runs require an active or retired scheme version' USING ERRCODE = '55000';
  END IF;
  IF NEW.period_from < version_row.effective_from
     OR (version_row.effective_to IS NOT NULL AND NEW.period_to > version_row.effective_to) THEN
    RAISE EXCEPTION 'payroll run period is outside scheme version effective window' USING ERRCODE = '23514';
  END IF;
  IF date_trunc('month', NEW.period_from)::date <> date_trunc('month', NEW.period_to)::date THEN
    RAISE EXCEPTION 'payroll runs cannot cross calendar months' USING ERRCODE = '23514';
  END IF;
  IF version_row.mode = 'final_month_threshold'
     AND (NEW.period_from <> date_trunc('month', NEW.period_from)::date
       OR NEW.period_to <> (date_trunc('month', NEW.period_to) + interval '1 month - 1 day')::date)
     AND NOT (NEW.engine_version IS NOT DISTINCT FROM 'h1_fixed_shifts_v1'
       AND NEW.period_from = date_trunc('month', NEW.period_from)::date
       AND NEW.period_to = NEW.period_from + 13) THEN
    RAISE EXCEPTION 'final-month threshold runs require the complete closed calendar month' USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_run_id IS NOT NULL THEN
    EXECUTE format('SELECT period_from,period_to FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR SHARE', TG_TABLE_SCHEMA)
      INTO superseded_run USING NEW.venue_id, NEW.supersedes_run_id;
    IF superseded_run.period_from IS DISTINCT FROM NEW.period_from OR superseded_run.period_to IS DISTINCT FROM NEW.period_to THEN
      RAISE EXCEPTION 'a replacement payroll run must preserve its source period' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
