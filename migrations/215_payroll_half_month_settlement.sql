-- Snapshot-only schema3 extension. Monthly entitlement claims and entry lifecycle
-- remain separate release gates. Do not relax 208's v1/v2 entry allowlist.
-- The full capability CHECK is installed once below, without an intermediate narrowing on replay.

-- Retain the original validator function and all hash/immutability constraints.
DROP TRIGGER IF EXISTS payroll_run_provenance_validate ON payroll_run_provenance;
CREATE TRIGGER payroll_run_provenance_validate BEFORE INSERT ON payroll_run_provenance
  FOR EACH ROW WHEN (NEW.schema_version<>3) EXECUTE FUNCTION payroll_validate_run_provenance();

CREATE OR REPLACE FUNCTION payroll_validate_half_month_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p jsonb; parent jsonb; earning jsonb; basis jsonb; closure jsonb;
  replay jsonb; scheme jsonb; month_from date; month_to date; earning_from date;
  closure_ts timestamptz; closure_date date; total numeric;
BEGIN
  p:=NEW.evidence_payload::jsonb; parent:=p->'parentEvidence';
  earning:=p->'earningPeriod'; basis:=p->'basisPeriod';
  closure:=parent->'periodClosure'; replay:=p->'calculatorReplay'; scheme:=parent->'schemeSnapshot';
  IF NEW.schema_version<>3 OR NEW.capability_version<>'refund-aware-half-month-evidence-v3'
    OR p->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR p->>'capabilityVersion' IS DISTINCT FROM NEW.capability_version
    OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR p->>'runId' IS DISTINCT FROM NEW.run_id::text
    OR jsonb_typeof(parent) IS DISTINCT FROM 'object' OR jsonb_typeof(earning) IS DISTINCT FROM 'object'
    OR jsonb_typeof(basis) IS DISTINCT FROM 'object' OR jsonb_typeof(replay) IS DISTINCT FROM 'object'
    OR jsonb_typeof(scheme) IS DISTINCT FROM 'object' OR jsonb_typeof(closure) IS DISTINCT FROM 'object'
    OR p->'milestoneClaimRequired' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'payroll half month context invalid' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['inputWatermark','candidateWatermark','snapshotInputWatermark','parentEvidenceWatermark']) k
    WHERE jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR COALESCE(p->>k,'') !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'payroll half month watermark invalid' USING ERRCODE='23514'; END IF;
  BEGIN
    month_from:=(basis->>'from')::date; month_to:=(basis->>'to')::date; earning_from:=(earning->>'from')::date;
    closure_ts:=(closure->>'transactionTimestamp')::timestamptz; closure_date:=(closure->>'venueLocalDate')::date;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'payroll half month date invalid' USING ERRCODE='23514'; END;
  IF NOT isfinite(month_from) OR NOT isfinite(month_to) OR NOT isfinite(earning_from)
    OR basis->>'from' IS DISTINCT FROM to_char(month_from,'YYYY-MM-DD')
    OR basis->>'to' IS DISTINCT FROM to_char(month_to,'YYYY-MM-DD')
    OR earning->>'from' IS DISTINCT FROM to_char(earning_from,'YYYY-MM-DD')
    OR earning->>'to' IS DISTINCT FROM basis->>'to'
    OR month_from IS DISTINCT FROM date_trunc('month',month_from)::date
    OR month_to IS DISTINCT FROM (month_from+interval '1 month - 1 day')::date
    OR earning_from IS DISTINCT FROM month_from+14
    OR p->>'scheduledPaymentDate' IS DISTINCT FROM to_char(month_to+1,'YYYY-MM-DD') THEN
    RAISE EXCEPTION 'payroll half month periods invalid' USING ERRCODE='23514'; END IF;
  -- The parent is a complete monthly v2 proof, never an earning-window proof.
  IF parent->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR parent->>'capabilityVersion' IS DISTINCT FROM 'employee_attributed_remaining_net_refund_v2'
    OR parent->>'venueId' IS DISTINCT FROM p->>'venueId' OR parent->>'runId' IS DISTINCT FROM p->>'runId'
    OR parent->>'schemeVersionId' IS DISTINCT FROM p->>'schemeVersionId'
    OR parent->>'currency' IS DISTINCT FROM p->>'currency' OR parent->>'venueTimezone' IS DISTINCT FROM p->>'venueTimezone'
    OR parent->'period' IS DISTINCT FROM basis
    OR scheme->>'versionId' IS DISTINCT FROM p->>'schemeVersionId' OR scheme->>'currency' IS DISTINCT FROM p->>'currency'
    OR scheme->'sourcePolicies'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR scheme->'sourcePolicies'->'earnings' IS DISTINCT FROM '{"refunds":"remaining_merchandise_original_sale_date_v1","venueTurnover":"canonical_total_less_merchandise_returns_v1","marginCost":"frozen_sale_depletion_cost_payroll_v1"}'::jsonb
    OR parent->'sourceBundle'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR parent->'sourceBundle'->'recognitionEvidence'->>'encoding' IS DISTINCT FROM 'json-preserved-property-order-v1'
    OR jsonb_typeof(parent->'sourceBundle'->'recognitionEvidence'->'payload') IS DISTINCT FROM 'string'
    OR parent->'refundQuantityEvidence'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR parent->'sourceEvidence'->>'capabilityVersion' IS DISTINCT FROM parent->>'capabilityVersion'
    OR parent->'calculatorReplay'->'input'->'scheme' IS DISTINCT FROM scheme
    OR scheme->>'mode' IS NOT DISTINCT FROM 'final_month_threshold'
    OR parent->'calculatorReplay'->'input'->>'periodFrom' IS DISTINCT FROM basis->>'from'
    OR parent->'calculatorReplay'->'input'->>'periodTo' IS DISTINCT FROM basis->>'to'
    OR parent->'calculatorReplay'->'result'->>'periodFrom' IS DISTINCT FROM basis->>'from'
    OR parent->'calculatorReplay'->'result'->>'periodTo' IS DISTINCT FROM basis->>'to'
    OR parent->'calculatorReplay'->'input'->'sourceEvidence' IS DISTINCT FROM parent->'sourceEvidence'
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['inputWatermark','closureWatermark','calculationWatermark','snapshotInputWatermark','sourceBundleWatermark']) k
      WHERE jsonb_typeof(parent->k) IS DISTINCT FROM 'string' OR COALESCE(parent->>k,'') !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'payroll half month parent invalid' USING ERRCODE='23514'; END IF;
  IF closure->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR closure->'period' IS DISTINCT FROM basis
    OR jsonb_typeof(closure->'transactionTimestamp') IS DISTINCT FROM 'string'
    OR COALESCE(closure->>'transactionTimestamp','') !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)$'
    OR closure->>'venueId' IS DISTINCT FROM NEW.venue_id::text
    OR closure->>'timezone' IS DISTINCT FROM p->>'venueTimezone'
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=closure->>'timezone') THEN
    RAISE EXCEPTION 'payroll half month closure invalid' USING ERRCODE='23514'; END IF;
  IF NOT isfinite(closure_ts) OR NOT isfinite(closure_date)
    OR closure->>'venueLocalDate' IS DISTINCT FROM to_char(closure_date,'YYYY-MM-DD')
    OR closure_date<=month_to OR (closure_ts AT TIME ZONE (closure->>'timezone'))::date IS DISTINCT FROM closure_date THEN
    RAISE EXCEPTION 'payroll half month closure not closed' USING ERRCODE='23514'; END IF;
  IF replay->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR replay->>'encoding' IS DISTINCT FROM 'canonical-json-safe-integers-v1'
    OR replay->>'inputSha256' IS DISTINCT FROM p->>'inputWatermark'
    OR COALESCE(replay->>'resultSha256','') !~ '^[a-f0-9]{64}$'
    OR COALESCE(replay->>'engineRevision','') !~ '^[a-f0-9]{64}$'
    OR replay->'input'->'scheme' IS DISTINCT FROM scheme
    OR replay->'input'->'sourceEvidence' IS DISTINCT FROM parent->'sourceEvidence'
    OR replay->'input'->>'periodFrom' IS DISTINCT FROM earning->>'from'
    OR replay->'input'->>'periodTo' IS DISTINCT FROM earning->>'to'
    OR replay->'result'->>'periodFrom' IS DISTINCT FROM earning->>'from'
    OR replay->'result'->>'periodTo' IS DISTINCT FROM earning->>'to'
    OR replay->'result'->>'schemeVersionId' IS DISTINCT FROM p->>'schemeVersionId'
    OR replay->'result'->>'currency' IS DISTINCT FROM p->>'currency'
    OR replay->'result'->>'status' IS DISTINCT FROM 'ready'
    OR replay->'result'->'blockers' IS DISTINCT FROM '[]'::jsonb
    OR replay->'result'->'criticalErrors' IS DISTINCT FROM '[]'::jsonb
    OR jsonb_typeof(replay->'result'->'employees') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'payroll half month replay invalid' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(replay->'result'->'employees') e
    WHERE jsonb_typeof(e->'amountCents') IS DISTINCT FROM 'number' OR COALESCE(e->>'amountCents','') !~ '^(0|[1-9][0-9]*)$'
      OR (e->>'amountCents')::numeric>9007199254740991) THEN
    RAISE EXCEPTION 'payroll half month employee total invalid' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum((e->>'amountCents')::numeric),0) INTO total FROM jsonb_array_elements(replay->'result'->'employees') e;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO r USING NEW.venue_id,NEW.run_id;
  IF r.id IS NULL OR r.status IS DISTINCT FROM 'ready' OR r.engine_version IS DISTINCT FROM 'payroll-verified-half-month-v3'
    OR r.period_from IS DISTINCT FROM earning_from OR r.period_to IS DISTINCT FROM month_to
    OR r.scheme_version_id::text IS DISTINCT FROM p->>'schemeVersionId' OR r.currency IS DISTINCT FROM p->>'currency'
    OR r.venue_timezone IS DISTINCT FROM p->>'venueTimezone' OR r.input_checksum IS DISTINCT FROM NEW.evidence_sha256
    OR r.input_watermark IS DISTINCT FROM p->>'inputWatermark'
    OR jsonb_typeof(p->'totalAmountCents') IS DISTINCT FROM 'number' OR COALESCE(p->>'totalAmountCents','') !~ '^(0|[1-9][0-9]*)$'
    OR (p->>'totalAmountCents')::numeric IS DISTINCT FROM NEW.total_amount_cents::numeric
    OR total IS DISTINCT FROM NEW.total_amount_cents::numeric THEN
    RAISE EXCEPTION 'payroll half month run mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

-- Per-employee H2 settlement claims are separate from the full monthly source
-- run. The source dates/evidence live in an immutable envelope; the payroll
-- entry period remains 15..month-end. In particular, no sale or shift is
-- re-dated into the H2 period.
CREATE TABLE IF NOT EXISTS payroll_half_month_settlement_slots (
  venue_id uuid NOT NULL, employee_id uuid NOT NULL, month_from date NOT NULL,
  monthly_run_id uuid NOT NULL, h1_claim_id uuid, h1_entry_id uuid, h1_run_id uuid,
  h2_run_id uuid NOT NULL, h2_entry_id uuid,
  h2_provenance_sha256 char(64) NOT NULL CHECK(h2_provenance_sha256 ~ '^[0-9a-f]{64}$'),
  monthly_gross_minor bigint NOT NULL CHECK(monthly_gross_minor BETWEEN 0 AND 9007199254740991),
  h1_gross_minor bigint NOT NULL CHECK(h1_gross_minor BETWEEN 0 AND monthly_gross_minor),
  h2_gross_minor bigint NOT NULL CHECK(h2_gross_minor BETWEEN 0 AND 9007199254740991
    AND monthly_gross_minor-h1_gross_minor=h2_gross_minor),
  h1_state_sha256 char(64) NOT NULL CHECK(h1_state_sha256 ~ '^[0-9a-f]{64}$'),
  h1_economic_evidence_payload text NOT NULL CHECK(octet_length(h1_economic_evidence_payload)<=1048576
    AND jsonb_typeof(h1_economic_evidence_payload::jsonb)='object'
    AND encode(sha256(convert_to(h1_economic_evidence_payload,'UTF8')),'hex')=h1_state_sha256),
  h1_origin text NOT NULL CHECK(h1_origin IN ('official_claim','verified_zero_base')),
  h1_zero_base_evidence_payload text,
  h1_zero_base_evidence_sha256 char(64),
  settlement_evidence_payload text NOT NULL CHECK(octet_length(settlement_evidence_payload)<=4194304
    AND jsonb_typeof(settlement_evidence_payload::jsonb)='object'),
  settlement_evidence_sha256 char(64) NOT NULL CHECK(settlement_evidence_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(settlement_evidence_payload,'UTF8')),'hex')=settlement_evidence_sha256),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(venue_id,employee_id,month_from),
  UNIQUE(venue_id,h2_entry_id),
  CHECK(isfinite(month_from) AND extract(day FROM month_from)=1),
  CHECK((h1_origin='official_claim' AND h1_claim_id IS NOT NULL AND h1_entry_id IS NOT NULL AND h1_run_id IS NOT NULL
      AND h1_zero_base_evidence_payload IS NULL AND h1_zero_base_evidence_sha256 IS NULL)
    OR (h1_origin='verified_zero_base' AND h1_claim_id IS NULL AND h1_entry_id IS NULL AND h1_run_id IS NULL
      AND h1_gross_minor=0 AND h1_zero_base_evidence_payload IS NOT NULL AND h1_zero_base_evidence_sha256 IS NOT NULL
      AND h1_zero_base_evidence_sha256 ~ '^[0-9a-f]{64}$'
      AND encode(sha256(convert_to(h1_zero_base_evidence_payload,'UTF8')),'hex')=h1_zero_base_evidence_sha256)),
  FOREIGN KEY(venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,monthly_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,h2_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,h1_claim_id) REFERENCES payroll_half_month_claims(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,h1_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,h2_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payroll_h2_settlement_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE monthly record; h2 record; h1 record; payload jsonb; month_to date; employee_monthly numeric; employee_h2 numeric;
BEGIN
  IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'payroll_h2_slot_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'payroll_h2_slot_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.h2_entry_id IS NOT NULL OR NEW.h2_entry_id IS NULL
      OR (to_jsonb(NEW)-'h2_entry_id') IS DISTINCT FROM (to_jsonb(OLD)-'h2_entry_id') THEN
      RAISE EXCEPTION 'payroll_h2_slot_immutable' USING ERRCODE='55000'; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.created_at IS DISTINCT FROM transaction_timestamp() AND NEW.created_at IS DISTINCT FROM clock_timestamp() THEN
      NEW.created_at:=clock_timestamp(); END IF;
    EXECUTE format('SELECT r.*,p.evidence_payload,p.capability_version FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2 FOR SHARE OF r,p',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO monthly USING NEW.venue_id,NEW.monthly_run_id;
    EXECUTE format('SELECT r.*,p.evidence_payload,p.capability_version FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2 FOR SHARE OF r,p',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO h2 USING NEW.venue_id,NEW.h2_run_id;
    month_to:=(NEW.month_from+interval '1 month-1 day')::date;
    IF monthly.id IS NULL OR monthly.status IS DISTINCT FROM 'ready' OR monthly.engine_version IS DISTINCT FROM 'payroll-verified-remaining-net-v2'
      OR monthly.period_from IS DISTINCT FROM NEW.month_from OR monthly.period_to IS DISTINCT FROM month_to
      OR monthly.capability_version IS DISTINCT FROM 'employee_attributed_remaining_net_refund_v2'
      OR h2.id IS NULL OR h2.status IS DISTINCT FROM 'ready' OR h2.period_from IS DISTINCT FROM NEW.month_from+14
      OR h2.period_to IS DISTINCT FROM month_to OR h2.input_checksum IS DISTINCT FROM NEW.h2_provenance_sha256
      OR h2.capability_version IS DISTINCT FROM 'refund-aware-half-month-evidence-v3'
      OR NEW.settlement_evidence_sha256 IS NULL OR NEW.h1_state_sha256 IS NULL THEN
      RAISE EXCEPTION 'payroll_h2_run_binding_invalid' USING ERRCODE='23514'; END IF;
    payload:=NEW.settlement_evidence_payload::jsonb;
    IF payload->>'monthlyRunId' IS DISTINCT FROM NEW.monthly_run_id::text
      OR payload->>'h2RunId' IS DISTINCT FROM NEW.h2_run_id::text
      OR payload->>'employeeId' IS DISTINCT FROM NEW.employee_id::text
      OR payload->>'economicEvidenceSha256' IS DISTINCT FROM NEW.h1_state_sha256
      OR (payload->>'monthlyGrossMinor')::numeric IS DISTINCT FROM NEW.monthly_gross_minor::numeric
      OR (payload->>'h1GrossAccruedMinor')::numeric IS DISTINCT FROM NEW.h1_gross_minor::numeric
      OR (payload->>'h2GrossAccruedMinor')::numeric IS DISTINCT FROM NEW.h2_gross_minor::numeric THEN
      RAISE EXCEPTION 'payroll_h2_settlement_evidence_invalid' USING ERRCODE='23514'; END IF;
    IF NEW.h1_origin='official_claim' THEN
      EXECUTE format('SELECT c.*,e.status,e.user_id,e.calculation_run_id,e.calculation_gross_cents,e.period_from,e.period_to,e.calculation_provenance_sha256,e.payroll_half_kind FROM %I.payroll_h1_claim_slots s JOIN %I.payroll_half_month_claims c ON c.venue_id=s.venue_id AND c.employee_id=s.employee_id AND c.month_from=s.month_from AND c.id=s.claim_id JOIN %I.payroll_entries e ON e.venue_id=c.venue_id AND e.id=c.entry_id WHERE s.venue_id=$1 AND s.employee_id=$2 AND s.month_from=$3 AND c.id=$4 AND c.entry_id=$5 AND c.run_id=$6 FOR SHARE OF s,e',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
        INTO h1 USING NEW.venue_id,NEW.employee_id,NEW.month_from,NEW.h1_claim_id,NEW.h1_entry_id,NEW.h1_run_id;
      IF h1.id IS NULL OR h1.status NOT IN ('approved','paid') OR h1.user_id IS DISTINCT FROM NEW.employee_id
        OR h1.calculation_run_id IS DISTINCT FROM NEW.h1_run_id OR h1.period_from IS DISTINCT FROM NEW.month_from
        OR h1.period_to IS DISTINCT FROM NEW.month_from+13 OR h1.payroll_half_kind IS DISTINCT FROM 'h1'
        OR h1.calculation_gross_cents IS DISTINCT FROM NEW.h1_gross_minor
        OR h1.calculation_provenance_sha256 IS DISTINCT FROM h1.provenance_sha256 THEN
        RAISE EXCEPTION 'payroll_h2_h1_claim_invalid' USING ERRCODE='23514'; END IF;
    ELSE
      payload:=NEW.h1_zero_base_evidence_payload::jsonb;
      IF payload->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR payload->>'employeeId' IS DISTINCT FROM NEW.employee_id::text
        OR payload->>'month' IS DISTINCT FROM to_char(NEW.month_from,'YYYY-MM') OR payload->>'monthlyRunId' IS DISTINCT FROM NEW.monthly_run_id::text
        OR (payload->>'grossMinor')::numeric IS DISTINCT FROM 0 OR (payload->>'activeOverlapCount')::numeric IS DISTINCT FROM 0 THEN
        RAISE EXCEPTION 'payroll_h2_zero_base_invalid' USING ERRCODE='23514'; END IF;
    END IF;
    EXECUTE format('SELECT COALESCE(sum(d.final_amount*100),0) FROM %I.payroll_daily_snapshots d WHERE d.venue_id=$1 AND d.run_id=$2 AND d.employee_id=$3',TG_TABLE_SCHEMA)
      INTO employee_monthly USING NEW.venue_id,NEW.monthly_run_id,NEW.employee_id;
    IF employee_monthly IS DISTINCT FROM NEW.monthly_gross_minor::numeric THEN
      RAISE EXCEPTION 'payroll_h2_monthly_gross_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.h2_entry_id IS NOT NULL THEN
    EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
      INTO h2 USING NEW.venue_id,NEW.h2_entry_id;
    IF h2.id IS NULL OR h2.user_id IS DISTINCT FROM NEW.employee_id OR h2.calculation_run_id IS DISTINCT FROM NEW.h2_run_id
      OR h2.calculation_provenance_sha256 IS DISTINCT FROM NEW.h2_provenance_sha256
      OR h2.period_from IS DISTINCT FROM NEW.month_from+14 OR h2.period_to IS DISTINCT FROM month_to
      OR h2.calculation_gross_cents IS DISTINCT FROM NEW.h2_gross_minor THEN
      RAISE EXCEPTION 'payroll_h2_entry_binding_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_h2_settlement_slot_guard ON payroll_half_month_settlement_slots;
CREATE TRIGGER payroll_h2_settlement_slot_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_half_month_settlement_slots
  FOR EACH ROW EXECUTE FUNCTION payroll_h2_settlement_slot_guard();
DROP TRIGGER IF EXISTS payroll_h2_settlement_slot_truncate ON payroll_half_month_settlement_slots;
CREATE TRIGGER payroll_h2_settlement_slot_truncate BEFORE TRUNCATE ON payroll_half_month_settlement_slots
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_h2_settlement_slot_guard();
CREATE OR REPLACE FUNCTION payroll_h2_entry_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; run_engine text;
BEGIN
  IF NEW.calculation_run_id IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT engine_version FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO run_engine USING NEW.venue_id,NEW.calculation_run_id;
  IF run_engine IS DISTINCT FROM 'payroll-verified-half-month-v3' THEN RETURN NULL; END IF;
  EXECUTE format('SELECT count(*) FROM %I.payroll_half_month_settlement_slots s WHERE s.venue_id=$1 AND s.employee_id=$2 AND s.h2_run_id=$3 AND s.h2_entry_id=$4 AND s.h2_provenance_sha256=$5 AND s.h2_gross_minor=NEW.calculation_gross_cents AND s.month_from=NEW.period_from-(extract(day from NEW.period_from)::int-1) AND s.month_from+14=NEW.period_from',TG_TABLE_SCHEMA)
    INTO n USING NEW.venue_id,NEW.user_id,NEW.calculation_run_id,NEW.id,NEW.calculation_provenance_sha256;
  IF n<>1 THEN RAISE EXCEPTION 'payroll_h2_entry_claim_missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS payroll_h2_entry_commit_check ON payroll_entries;
CREATE CONSTRAINT TRIGGER payroll_h2_entry_commit_check AFTER INSERT OR UPDATE ON payroll_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payroll_h2_entry_commit_check();
DROP TRIGGER IF EXISTS payroll_run_half_month_provenance_validate ON payroll_run_provenance;
CREATE TRIGGER payroll_run_half_month_provenance_validate BEFORE INSERT ON payroll_run_provenance
  FOR EACH ROW WHEN (NEW.schema_version=3) EXECUTE FUNCTION payroll_validate_half_month_provenance();

CREATE OR REPLACE FUNCTION payroll_validate_half_month_provenance_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_venue uuid; target_run uuid; r record; p record; total numeric; payload jsonb; mismatch boolean;
BEGIN
  target_venue:=NEW.venue_id;
  IF TG_TABLE_NAME='payroll_calculation_runs' THEN target_run:=NEW.id; ELSE target_run:=NEW.run_id; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO r USING target_venue,target_run;
  IF r.id IS NULL OR r.engine_version IS DISTINCT FROM 'payroll-verified-half-month-v3' THEN RETURN NULL; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA)
    INTO p USING target_venue,target_run;
  IF r.status='ready' THEN
    IF p.run_id IS NULL OR p.schema_version<>3 OR p.capability_version<>'refund-aware-half-month-evidence-v3'
      OR p.evidence_sha256 IS DISTINCT FROM r.input_checksum THEN
      RAISE EXCEPTION 'payroll half month provenance required' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA)
      INTO total USING target_venue,target_run;
    IF total IS DISTINCT FROM p.total_amount_cents::numeric THEN
      RAISE EXCEPTION 'payroll half month snapshot total mismatch' USING ERRCODE='23514'; END IF;
    payload:=p.evidence_payload::jsonb;
    IF jsonb_typeof(payload->'calculatorReplay'->'result'->'daily') IS DISTINCT FROM 'array'
      OR jsonb_typeof(payload->'calculatorReplay'->'input'->'sales') IS DISTINCT FROM 'array'
      OR jsonb_typeof(payload->'parentEvidence'->'refundQuantityEvidence'->'lines') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'payroll half month coverage context invalid' USING ERRCODE='23514'; END IF;
    -- EXCEPT ALL checks identities and multiplicity, including zero rows.
    EXECUTE format($q$
      WITH expected AS (
        SELECT d->>'date' local_date,e->>'employeeId' employee_id,
          (e->>'amountCents')::numeric amount,e->>'roleId' role_id
        FROM jsonb_array_elements($3->'calculatorReplay'->'result'->'daily') d
        CROSS JOIN LATERAL jsonb_array_elements(d->'employees') e
      ), actual AS (
        SELECT local_date::text,employee_id::text,final_amount*100 amount,role_key_snapshot role_id
        FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2
      ) SELECT EXISTS(SELECT 1 FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
        UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) diff)
      $q$,TG_TABLE_SCHEMA) INTO mismatch USING target_venue,target_run,payload;
    IF mismatch THEN RAISE EXCEPTION 'payroll half month daily coverage mismatch' USING ERRCODE='23514'; END IF;
    -- Child result and input must cover the same sale events. The nested v2
    -- refund sidecar supplies their immutable order-item identities.
    WITH expected AS (
      SELECT l->>'lineId' id FROM jsonb_array_elements(payload->'calculatorReplay'->'result'->'daily') d
        CROSS JOIN LATERAL jsonb_array_elements(d->'lines') l
    ), supplied AS (SELECT s->>'id' id FROM jsonb_array_elements(payload->'calculatorReplay'->'input'->'sales') s)
    SELECT EXISTS(SELECT 1 FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM supplied)
      UNION ALL (SELECT * FROM supplied EXCEPT ALL SELECT * FROM expected)) diff) INTO mismatch;
    IF mismatch THEN RAISE EXCEPTION 'payroll half month input line coverage mismatch' USING ERRCODE='23514'; END IF;
    IF r.eligible_line_count IS DISTINCT FROM jsonb_array_length(payload->'calculatorReplay'->'input'->'sales') THEN
      RAISE EXCEPTION 'payroll half month eligible line count mismatch' USING ERRCODE='23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(payload->'calculatorReplay'->'input'->'sales') s
      WHERE (SELECT count(*) FROM jsonb_array_elements(payload->'parentEvidence'->'refundQuantityEvidence'->'lines') f
        WHERE f->>'saleLineEventId'=s->>'id')<>1
    ) THEN RAISE EXCEPTION 'payroll half month line identity missing' USING ERRCODE='23514'; END IF;
    EXECUTE format($q$
      WITH expected AS (
        SELECT d->>'date' local_date,l->>'employeeId' employee_id,f->>'orderId' order_id,f->>'orderItemId' order_item_id
        FROM jsonb_array_elements($3->'calculatorReplay'->'result'->'daily') d
        CROSS JOIN LATERAL jsonb_array_elements(d->'lines') l
        JOIN LATERAL jsonb_array_elements($3->'parentEvidence'->'refundQuantityEvidence'->'lines') f
          ON f->>'saleLineEventId'=l->>'lineId'
      ), actual AS (
        SELECT local_date::text,employee_id::text,order_id::text,order_item_id::text
        FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND run_id=$2
      ) SELECT EXISTS(SELECT 1 FROM ((SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
        UNION ALL (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)) diff)
        OR (SELECT count(*) FROM actual)<>$4
      $q$,TG_TABLE_SCHEMA) INTO mismatch USING target_venue,target_run,payload,r.eligible_line_count;
    IF mismatch THEN RAISE EXCEPTION 'payroll half month stored line coverage mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payroll_calculation_runs','payroll_run_provenance','payroll_daily_snapshots','payroll_daily_snapshot_lines'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',t||'_half_month_provenance_commit',t);
    IF t='payroll_calculation_runs' THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_half_month_provenance_commit()',t||'_half_month_provenance_commit',t);
    ELSE
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_half_month_provenance_commit()',t||'_half_month_provenance_commit',t);
    END IF;
  END LOOP;
END $$;


-- EXPERIMENTAL, not migration-ready. Schema5 protected amounts and same-transaction
-- H2 slot/receipt requirements must be completed and tested before integration.
CREATE TABLE IF NOT EXISTS payroll_h2_settlement_claims (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), venue_id uuid NOT NULL, employee_id uuid NOT NULL,
 month_from date NOT NULL, monthly_run_id uuid NOT NULL, h1_origin text NOT NULL, h1_claim_id uuid,
 zero_base_payload text, zero_base_sha256 char(64),
 h2_run_id uuid NOT NULL, h2_entry_id uuid NOT NULL, evidence_sha256 char(64) NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 claim_insert_xid bigint NOT NULL,
 UNIQUE(venue_id,id), UNIQUE(venue_id,employee_id,month_from,id),
 UNIQUE(venue_id,h2_run_id), UNIQUE(venue_id,h2_entry_id),
 CHECK(isfinite(month_from) AND extract(day from month_from)=1),
 CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 CHECK((h1_origin='official_claim' AND h1_claim_id IS NOT NULL AND zero_base_payload IS NULL AND zero_base_sha256 IS NULL) OR
       (h1_origin='verified_zero_base' AND h1_claim_id IS NULL AND zero_base_payload IS NOT NULL AND zero_base_sha256 ~ '^[0-9a-f]{64}$'
        AND encode(sha256(convert_to(zero_base_payload,'UTF8')),'hex')=zero_base_sha256)),
 FOREIGN KEY(venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,monthly_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,h2_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,h1_claim_id) REFERENCES payroll_half_month_claims(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,h2_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS payroll_h2_claim_slots (
 venue_id uuid NOT NULL, employee_id uuid NOT NULL, month_from date NOT NULL, claim_id uuid,
 revision bigint NOT NULL CHECK(revision>0), PRIMARY KEY(venue_id,employee_id,month_from),
 FOREIGN KEY(venue_id,employee_id,month_from,claim_id)
  REFERENCES payroll_h2_settlement_claims(venue_id,employee_id,month_from,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS payroll_h2_claim_voids (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), venue_id uuid NOT NULL, claim_id uuid NOT NULL,
 transition_id uuid NOT NULL, created_by uuid NOT NULL, reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), void_insert_xid bigint NOT NULL,
 UNIQUE(venue_id,claim_id), UNIQUE(venue_id,transition_id),
 FOREIGN KEY(venue_id,claim_id) REFERENCES payroll_h2_settlement_claims(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,transition_id) REFERENCES payroll_calculation_entry_transitions(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
-- Hold: schema5 provenance validation, claim SQL, active slot guard, deferred
-- commit receipts, cancellation VOID, H1 cancellation lock, update guards,
-- protected-fixed correction and psql full-schema/real receipt tests.

CREATE OR REPLACE FUNCTION payroll_h2_slot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'payroll_h2_slot_immutable' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND (ROW(NEW.venue_id,NEW.employee_id,NEW.month_from) IS DISTINCT FROM ROW(OLD.venue_id,OLD.employee_id,OLD.month_from)
   OR NEW.revision IS DISTINCT FROM OLD.revision+1) THEN RAISE EXCEPTION 'payroll_h2_slot_invalid' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' AND (NEW.revision<>1 OR NEW.claim_id IS NULL) THEN RAISE EXCEPTION 'payroll_h2_slot_invalid' USING ERRCODE='23514'; END IF;
 IF (TG_OP='INSERT' OR OLD.claim_id IS NULL) AND NEW.claim_id IS NOT NULL THEN
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_settlement_claims WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3 AND id=$4 AND claim_insert_xid=txid_current()',TG_TABLE_SCHEMA)
   INTO n USING NEW.venue_id,NEW.employee_id,NEW.month_from,NEW.claim_id;
 ELSIF TG_OP='UPDATE' AND OLD.claim_id IS NOT NULL AND NEW.claim_id IS NULL THEN
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_claim_voids WHERE venue_id=$1 AND claim_id=$2 AND void_insert_xid=txid_current()',TG_TABLE_SCHEMA)
   INTO n USING OLD.venue_id,OLD.claim_id;
 ELSE RAISE EXCEPTION 'payroll_h2_slot_transition_invalid' USING ERRCODE='23514'; END IF;
 IF n<>1 THEN RAISE EXCEPTION 'payroll_h2_slot_witness_missing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_h2_claim_activate_slot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
 EXECUTE format('INSERT INTO %I.payroll_h2_claim_slots AS s (venue_id,employee_id,month_from,claim_id,revision) VALUES($1,$2,$3,$4,1) ON CONFLICT (venue_id,employee_id,month_from) DO UPDATE SET claim_id=EXCLUDED.claim_id,revision=s.revision+1 WHERE s.claim_id IS NULL RETURNING revision',TG_TABLE_SCHEMA)
  INTO v USING NEW.venue_id,NEW.employee_id,NEW.month_from,NEW.id;
 IF v IS NULL THEN RAISE EXCEPTION 'payroll_h2_slot_occupied' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION payroll_h2_void_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; e record; t record;
BEGIN
 IF NEW.void_insert_xid IS NOT NULL THEN RAISE EXCEPTION 'payroll_h2_void_xid_db_owned' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT * FROM %I.payroll_h2_settlement_claims WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO c USING NEW.venue_id,NEW.claim_id;
 EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO e USING NEW.venue_id,c.h2_entry_id;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO t USING NEW.venue_id,NEW.transition_id;
 IF c.id IS NULL OR e.id IS NULL OR e.status IS DISTINCT FROM 'cancelled' OR e.expense_id IS NOT NULL
   OR t.id IS NULL OR t.action IS DISTINCT FROM 'cancel' OR t.entry_id IS DISTINCT FROM c.h2_entry_id
   OR t.employee_id IS DISTINCT FROM c.employee_id OR t.calculation_run_id IS DISTINCT FROM c.h2_run_id
   OR t.provenance_sha256 IS DISTINCT FROM c.evidence_sha256 OR t.transaction_id IS DISTINCT FROM txid_current()
   OR t.created_by IS DISTINCT FROM NEW.created_by OR e.cancelled_by IS DISTINCT FROM t.created_by
   OR e.cancelled_at IS DISTINCT FROM t.created_at OR t.reason IS DISTINCT FROM NEW.reason OR e.cancellation_reason IS DISTINCT FROM t.reason THEN
  RAISE EXCEPTION 'payroll_h2_void_invalid' USING ERRCODE='23514'; END IF;
 NEW.void_insert_xid:=txid_current(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_h2_auto_void() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; t record; updated bigint;
BEGIN
 IF OLD.payroll_half_kind IS DISTINCT FROM 'h2' OR NEW.status IS DISTINCT FROM 'cancelled' OR OLD.status='cancelled' THEN RETURN NULL; END IF;
 EXECUTE format('SELECT * FROM %I.payroll_h2_settlement_claims WHERE venue_id=$1 AND h2_entry_id=$2',TG_TABLE_SCHEMA) INTO c USING NEW.venue_id,NEW.id;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND entry_id=$2 AND action=''cancel'' AND transaction_id=txid_current()',TG_TABLE_SCHEMA) INTO t USING NEW.venue_id,NEW.id;
 IF c.id IS NULL OR t.id IS NULL THEN RAISE EXCEPTION 'payroll_h2_cancel_transition_missing' USING ERRCODE='23514'; END IF;
 EXECUTE format('INSERT INTO %I.payroll_h2_claim_voids (venue_id,claim_id,transition_id,created_by,reason) VALUES($1,$2,$3,$4,$5)',TG_TABLE_SCHEMA)
  USING NEW.venue_id,c.id,t.id,t.created_by,t.reason;
 EXECUTE format('UPDATE %I.payroll_h2_claim_slots SET claim_id=NULL,revision=revision+1 WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3 AND claim_id=$4',TG_TABLE_SCHEMA)
  USING c.venue_id,c.employee_id,c.month_from,c.id;
 GET DIAGNOSTICS updated=ROW_COUNT;
 IF updated<>1 THEN RAISE EXCEPTION 'payroll_h2_slot_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION payroll_h2_void_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; active bigint;
BEGIN
 EXECUTE format('SELECT count(*) FROM %I.payroll_calculation_entry_transition_requests q JOIN %I.payroll_calculation_entry_transitions t ON t.venue_id=q.venue_id AND t.id=q.transition_id WHERE q.venue_id=$1 AND q.transition_id=$2 AND q.created_by=$3 AND encode(sha256(convert_to(q.response_payload,''UTF8'')),''hex'')=q.response_hash AND (q.response_payload::jsonb)->>''action''=''cancel'' AND (q.response_payload::jsonb)->>''transitionId''=$2::text AND (q.response_payload::jsonb)->''entry''->>''id''=t.entry_id::text AND (q.response_payload::jsonb)->''entry''->>''status''=''cancelled''',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
  INTO n USING NEW.venue_id,NEW.transition_id,NEW.created_by;
 EXECUTE format('SELECT count(*) FROM %I.payroll_h2_claim_slots WHERE venue_id=$1 AND claim_id=$2',TG_TABLE_SCHEMA) INTO active USING NEW.venue_id,NEW.claim_id;
 IF n<>1 OR active<>0 THEN RAISE EXCEPTION 'payroll_h2_void_receipt_or_slot_invalid' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

CREATE TABLE IF NOT EXISTS payroll_h2_requests (
 venue_id uuid NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
 request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 created_by uuid NOT NULL, claim_id uuid NOT NULL,
 response_payload text NOT NULL CHECK(octet_length(response_payload)<=1048576 AND jsonb_typeof(response_payload::jsonb)='object'),
 response_sha256 char(64) NOT NULL CHECK(response_sha256 ~ '^[0-9a-f]{64}$'
  AND encode(sha256(convert_to(response_payload,'UTF8')),'hex')=response_sha256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(venue_id,idempotency_key), UNIQUE(venue_id,claim_id),
 FOREIGN KEY(venue_id,claim_id) REFERENCES payroll_h2_settlement_claims(venue_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
-- NB: Must be backed by trigger checks on actor, exact request/response and
-- same source-fenced transaction. This table alone grants no authority.

CREATE OR REPLACE FUNCTION payroll_half_month_serialized_key(v uuid,e uuid,m date) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF v IS NULL OR e IS NULL OR m IS NULL OR NOT isfinite(m) OR extract(day from m)<>1 THEN
  RAISE EXCEPTION 'payroll_half_month_lock_invalid' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(v::text||':'||e::text||':'||to_char(m,'YYYY-MM-DD'),413832541));
END $$;
-- REQUIRED: all h1 claim / active legacy or full-month entry / h2 claim paths
-- take this exact key before reading or writing slots. A partial rollout is unsafe.
CREATE OR REPLACE FUNCTION payroll_h2_claim_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry record; run record; proof record; parent record; h1 record; slot record; zero_doc jsonb;
 snapshot_count bigint; snapshot_sum numeric; conflicts bigint; owner_ok boolean; h1_receipt_ok boolean; evidence jsonb;
BEGIN
 IF NEW.claim_insert_xid IS NOT NULL THEN RAISE EXCEPTION 'payroll_h2_claim_xid_db_owned' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT %I.payroll_half_month_serialized_key($1,$2,$3)',TG_TABLE_SCHEMA) USING NEW.venue_id,NEW.employee_id,NEW.month_from;
 EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO entry USING NEW.venue_id,NEW.h2_entry_id;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO run USING NEW.venue_id,NEW.h2_run_id;
 EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA) INTO proof USING NEW.venue_id,NEW.h2_run_id;
 EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA) INTO parent USING NEW.venue_id,NEW.monthly_run_id;
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active AND deleted_at IS NULL)',TG_TABLE_SCHEMA) INTO owner_ok USING NEW.venue_id,NEW.created_by;
 IF NOT owner_ok OR entry.id IS NULL OR entry.payroll_half_kind IS DISTINCT FROM 'h2'
  OR entry.payroll_h2_insert_xid IS DISTINCT FROM txid_current() OR entry.status IS DISTINCT FROM 'draft'
  OR entry.user_id IS DISTINCT FROM NEW.employee_id OR entry.calculation_run_id IS DISTINCT FROM NEW.h2_run_id
  OR entry.calculation_provenance_sha256 IS DISTINCT FROM NEW.evidence_sha256 OR entry.materialized_by IS DISTINCT FROM NEW.created_by
  OR entry.period_from IS DISTINCT FROM NEW.month_from+14 OR entry.period_to IS DISTINCT FROM (NEW.month_from+interval '1 month - 1 day')::date
  OR run.id IS NULL OR run.engine_version IS DISTINCT FROM 'payroll-deferred-month-settlement-v1'
  OR proof.schema_version IS DISTINCT FROM 5 OR proof.capability_version IS DISTINCT FROM 'payroll-deferred-month-settlement-v1'
  OR proof.evidence_sha256 IS DISTINCT FROM NEW.evidence_sha256 OR parent.schema_version IS DISTINCT FROM 2
  OR parent.capability_version IS DISTINCT FROM 'employee_attributed_remaining_net_refund_v2' THEN
  RAISE EXCEPTION 'payroll_h2_claim_binding_invalid' USING ERRCODE='23514'; END IF;
 evidence:=proof.evidence_payload::jsonb;
 IF evidence->>'employeeId' IS DISTINCT FROM NEW.employee_id::text OR evidence->>'venueId' IS DISTINCT FROM NEW.venue_id::text
  OR evidence->>'month' IS DISTINCT FROM to_char(NEW.month_from,'YYYY-MM') OR evidence->>'monthlyRunId' IS DISTINCT FROM NEW.monthly_run_id::text
  OR evidence->>'h2RunId' IS DISTINCT FROM NEW.h2_run_id::text OR evidence->>'monthlyEvidenceSha256' IS DISTINCT FROM parent.evidence_sha256::text
  OR (evidence->>'h2GrossAccruedMinor')::numeric IS DISTINCT FROM entry.calculation_gross_cents::numeric THEN
  RAISE EXCEPTION 'payroll_h2_claim_evidence_invalid' USING ERRCODE='23514'; END IF;
 IF NEW.h1_origin='official_claim' THEN
  EXECUTE format('SELECT c.*,e.status,e.calculation_gross_cents FROM %I.payroll_half_month_claims c JOIN %I.payroll_h1_claim_slots s ON s.venue_id=c.venue_id AND s.employee_id=c.employee_id AND s.month_from=c.month_from AND s.claim_id=c.id JOIN %I.payroll_entries e ON e.venue_id=c.venue_id AND e.id=c.entry_id WHERE c.venue_id=$1 AND c.id=$2 FOR UPDATE OF s,e',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
   INTO h1 USING NEW.venue_id,NEW.h1_claim_id;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_entry_transitions t JOIN %I.payroll_calculation_entry_transition_requests q ON q.venue_id=t.venue_id AND q.transition_id=t.id WHERE t.venue_id=$1 AND t.entry_id=$2 AND t.action=''approve'' AND t.gross_cents=$3 AND t.protected_fixed_cents=$4 AND t.ledger_hash=$5 AND q.created_by=t.created_by AND encode(sha256(convert_to(q.response_payload,''UTF8'')),''hex'')=q.response_hash)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
   INTO h1_receipt_ok USING NEW.venue_id,h1.entry_id,(evidence->>'h1GrossAccruedMinor')::bigint,(evidence->>'h1ProtectedFixedMinor')::bigint,evidence->'h1Binding'->>'approvalLedgerSha256';
  IF h1.id IS NULL OR h1.employee_id IS DISTINCT FROM NEW.employee_id OR h1.month_from IS DISTINCT FROM NEW.month_from
   OR h1.status NOT IN ('approved','paid') OR NOT h1_receipt_ok OR evidence->'h1Binding'->>'h1ClaimId' IS DISTINCT FROM NEW.h1_claim_id::text
   OR (evidence->>'h1GrossAccruedMinor')::numeric IS DISTINCT FROM h1.calculation_gross_cents::numeric THEN
   RAISE EXCEPTION 'payroll_h2_h1_binding_invalid' USING ERRCODE='23514'; END IF;
 ELSIF NEW.h1_origin='verified_zero_base' THEN
  zero_doc:=NEW.zero_base_payload::jsonb;
  EXECUTE format('SELECT count(*),COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3 AND local_date BETWEEN $4 AND $4+13',TG_TABLE_SCHEMA)
   INTO snapshot_count,snapshot_sum USING NEW.venue_id,NEW.monthly_run_id,NEW.employee_id,NEW.month_from;
  EXECUTE format('SELECT count(*) FROM %I.payroll_entries WHERE venue_id=$1 AND user_id=$2 AND status IN (''draft'',''approved'',''paid'') AND id<>$3 AND period_from<=$4+13 AND period_to>=$4',TG_TABLE_SCHEMA)
   INTO conflicts USING NEW.venue_id,NEW.employee_id,NEW.h2_entry_id,NEW.month_from;
  EXECUTE format('SELECT * FROM %I.payroll_h1_claim_slots WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3 FOR UPDATE',TG_TABLE_SCHEMA)
   INTO slot USING NEW.venue_id,NEW.employee_id,NEW.month_from;
  IF zero_doc->>'capabilityVersion' IS DISTINCT FROM 'payroll-h1-zero-base-v1'
   OR zero_doc->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR zero_doc->>'employeeId' IS DISTINCT FROM NEW.employee_id::text
   OR zero_doc->>'month' IS DISTINCT FROM to_char(NEW.month_from,'YYYY-MM') OR zero_doc->>'monthlyRunId' IS DISTINCT FROM NEW.monthly_run_id::text
   OR zero_doc->>'monthlyEvidenceSha256' IS DISTINCT FROM parent.evidence_sha256::text
   OR zero_doc->>'sourceWatermark' IS DISTINCT FROM parent.evidence_payload::jsonb->>'inputWatermark'
   OR zero_doc->'schemaVersion' IS DISTINCT FROM '1'::jsonb
   OR zero_doc->'period'->>'from' IS DISTINCT FROM to_char(NEW.month_from,'YYYY-MM-DD')
   OR zero_doc->'period'->>'to' IS DISTINCT FROM to_char(NEW.month_from+13,'YYYY-MM-DD')
   OR evidence->'h1Binding'->>'h1Origin' IS DISTINCT FROM 'verified_zero_base'
   OR evidence->'h1Binding'->>'approvalLedgerSha256' IS DISTINCT FROM NEW.zero_base_sha256::text
   OR (zero_doc->>'snapshotRowCount')::numeric IS DISTINCT FROM snapshot_count::numeric OR snapshot_sum<>0 OR conflicts<>0 OR slot.claim_id IS NOT NULL
   OR zero_doc->'grossMinor' IS DISTINCT FROM '0'::jsonb OR zero_doc->'activeOverlapCount' IS DISTINCT FROM '0'::jsonb
   OR zero_doc->'h1ClaimCount' IS DISTINCT FROM '0'::jsonb THEN RAISE EXCEPTION 'payroll_h2_zero_base_invalid' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'payroll_h2_origin_invalid' USING ERRCODE='23514'; END IF;
 NEW.claim_insert_xid:=txid_current(); NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h2_source_conflict_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m date; overlap_count bigint; h2_count bigint; claim_row record;
BEGIN
 IF TG_OP='UPDATE' AND NEW.status='cancelled' AND OLD.payroll_half_kind='h1' THEN
  EXECUTE format('SELECT * FROM %I.payroll_half_month_claims WHERE venue_id=$1 AND entry_id=$2',TG_TABLE_SCHEMA) INTO claim_row USING OLD.venue_id,OLD.id;
  IF claim_row.id IS NULL THEN RAISE EXCEPTION 'payroll_h2_h1_claim_missing' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT %I.payroll_half_month_serialized_key($1,$2,$3)',TG_TABLE_SCHEMA) USING OLD.venue_id,OLD.user_id,claim_row.month_from;
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_claim_slots s JOIN %I.payroll_h2_settlement_claims c ON c.venue_id=s.venue_id AND c.id=s.claim_id WHERE s.venue_id=$1 AND s.employee_id=$2 AND s.month_from=$3 AND c.h1_claim_id=$4',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
   INTO h2_count USING OLD.venue_id,OLD.user_id,claim_row.month_from,claim_row.id;
  IF h2_count>0 THEN RAISE EXCEPTION 'payroll_h1_cancel_h2_active' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status NOT IN ('draft','approved','paid') OR NEW.period_from IS NULL OR NEW.period_to IS NULL THEN RETURN NEW; END IF;
 IF NOT isfinite(NEW.period_from) OR NOT isfinite(NEW.period_to) OR NEW.period_to<NEW.period_from
  OR NEW.period_to>NEW.period_from+interval '10 years' THEN RAISE EXCEPTION 'payroll_h2_entry_period_invalid' USING ERRCODE='23514'; END IF;
 FOR m IN SELECT generate_series(date_trunc('month',NEW.period_from)::date,date_trunc('month',NEW.period_to)::date,interval '1 month')::date LOOP
  IF NEW.period_from>m+13 THEN CONTINUE; END IF;
  EXECUTE format('SELECT %I.payroll_half_month_serialized_key($1,$2,$3)',TG_TABLE_SCHEMA) USING NEW.venue_id,NEW.user_id,m;
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_claim_slots s JOIN %I.payroll_h2_settlement_claims c ON c.venue_id=s.venue_id AND c.id=s.claim_id WHERE s.venue_id=$1 AND s.employee_id=$2 AND s.month_from=$3 AND c.h1_origin=''verified_zero_base''',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
   INTO overlap_count USING NEW.venue_id,NEW.user_id,m;
  IF overlap_count>0 THEN RAISE EXCEPTION 'payroll_h2_zero_base_source_reserved' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
-- Attach only after every schema5 writer/void path also acquires the same key.
ALTER TABLE payroll_entries ADD COLUMN IF NOT EXISTS payroll_h2_insert_xid bigint;
CREATE OR REPLACE FUNCTION payroll_h1_entry_marker_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.payroll_h1_insert_xid IS NOT NULL OR NEW.payroll_h2_insert_xid IS NOT NULL THEN RAISE EXCEPTION 'payroll_half_xid_db_owned' USING ERRCODE='23514'; END IF;
  IF NEW.payroll_half_kind IS NULL THEN RETURN NEW; END IF;
  IF NEW.payroll_half_kind='h1' THEN
   IF NEW.calculation_run_id IS NULL OR NEW.status<>'draft' OR extract(day from NEW.period_from)<>1 OR NEW.period_to IS DISTINCT FROM NEW.period_from+13 THEN RAISE EXCEPTION 'payroll_h1_marker_invalid' USING ERRCODE='23514'; END IF;
   NEW.payroll_h1_insert_xid:=txid_current(); RETURN NEW;
  ELSIF NEW.payroll_half_kind='h2' THEN
   IF NEW.calculation_run_id IS NULL OR NEW.status<>'draft' OR extract(day from NEW.period_from)<>15
    OR NEW.period_to IS DISTINCT FROM (date_trunc('month',NEW.period_from)+interval '1 month - 1 day')::date THEN RAISE EXCEPTION 'payroll_h2_marker_invalid' USING ERRCODE='23514'; END IF;
   NEW.payroll_h2_insert_xid:=txid_current(); RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payroll_half_marker_invalid' USING ERRCODE='23514';
 END IF;
 IF ROW(NEW.payroll_half_kind,NEW.payroll_h1_insert_xid,NEW.payroll_h2_insert_xid) IS DISTINCT FROM ROW(OLD.payroll_half_kind,OLD.payroll_h1_insert_xid,OLD.payroll_h2_insert_xid) THEN RAISE EXCEPTION 'payroll_half_marker_immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
-- 213 deferred entry trigger must return immediately for h2; a distinct H2
-- deferred trigger below will prove its own request + active slot + marker.

CREATE OR REPLACE FUNCTION payroll_h1_entry_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; k bigint; active bigint;
BEGIN
 IF NEW.payroll_half_kind IS DISTINCT FROM 'h1' THEN RETURN NULL; END IF;
 EXECUTE format('SELECT count(*) FROM %I.payroll_half_month_claims c WHERE c.venue_id=$1 AND c.entry_id=$2 AND c.employee_id=$3 AND c.run_id=$4 AND c.period_from=$5 AND c.period_to=$6 AND c.provenance_sha256=$7',TG_TABLE_SCHEMA)
  INTO n USING NEW.venue_id,NEW.id,NEW.user_id,NEW.calculation_run_id,NEW.period_from,NEW.period_to,NEW.calculation_provenance_sha256;
 EXECUTE format('SELECT count(*) FROM %I.payroll_calculation_entry_requests q WHERE q.venue_id=$1 AND q.entry_id=$2 AND q.created_by=$3 AND (q.response_payload::jsonb)->>''existing''=''false'' AND (q.response_payload::jsonb)->>''replayed''=''false'' AND (q.response_payload::jsonb)->''entry''->>''id''=$2::text',TG_TABLE_SCHEMA)
  INTO k USING NEW.venue_id,NEW.id,NEW.materialized_by;
 EXECUTE format('SELECT count(*) FROM %I.payroll_h1_claim_slots s JOIN %I.payroll_half_month_claims c ON c.venue_id=s.venue_id AND c.id=s.claim_id WHERE c.venue_id=$1 AND c.entry_id=$2 AND s.employee_id=c.employee_id AND s.month_from=c.month_from',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) INTO active USING NEW.venue_id,NEW.id;
 IF n<>1 OR k<>1 OR active<>1 THEN RAISE EXCEPTION 'payroll_h1_claim_or_receipt_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION payroll_h2_request_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record; response jsonb;
BEGIN
 EXECUTE format('SELECT * FROM %I.payroll_h2_settlement_claims WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO c USING NEW.venue_id,NEW.claim_id;
 response:=NEW.response_payload::jsonb;
 IF c.id IS NULL OR c.claim_insert_xid IS DISTINCT FROM txid_current() OR c.created_by IS DISTINCT FROM NEW.created_by
  OR response->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR response->>'action' IS DISTINCT FROM 'h2_materialize'
  OR response->>'claimId' IS DISTINCT FROM c.id::text OR response->>'runId' IS DISTINCT FROM c.h2_run_id::text
  OR response->'entry'->>'id' IS DISTINCT FROM c.h2_entry_id::text OR response->'replayed' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'payroll_h2_request_mismatch' USING ERRCODE='23514'; END IF;
 NEW.created_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h2_entry_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claims bigint; receipts bigint; materializations bigint; run_engine text;
BEGIN
 IF NEW.payroll_half_kind IS DISTINCT FROM 'h2' THEN
  IF NEW.calculation_run_id IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT engine_version FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO run_engine USING NEW.venue_id,NEW.calculation_run_id;
  IF run_engine IS DISTINCT FROM 'payroll-verified-half-month-v3' THEN RETURN NULL; END IF;
  EXECUTE format('SELECT count(*) FROM %I.payroll_half_month_settlement_slots s WHERE s.venue_id=$1 AND s.employee_id=$2 AND s.h2_run_id=$3 AND s.h2_entry_id=$4 AND s.h2_provenance_sha256=$5 AND s.h2_gross_minor=$6 AND s.month_from+14=$7',TG_TABLE_SCHEMA)
   INTO claims USING NEW.venue_id,NEW.user_id,NEW.calculation_run_id,NEW.id,NEW.calculation_provenance_sha256,NEW.calculation_gross_cents,NEW.period_from;
  IF claims<>1 THEN RAISE EXCEPTION 'payroll_h2_entry_claim_missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 IF NEW.status='cancelled' THEN
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_settlement_claims c JOIN %I.payroll_h2_claim_voids v ON v.venue_id=c.venue_id AND v.claim_id=c.id WHERE c.venue_id=$1 AND c.h2_entry_id=$2 AND c.h2_run_id=$3 AND c.employee_id=$4 AND c.evidence_sha256=$5',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
   INTO claims USING NEW.venue_id,NEW.id,NEW.calculation_run_id,NEW.user_id,NEW.calculation_provenance_sha256;
 ELSE
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_settlement_claims c JOIN %I.payroll_h2_claim_slots s ON s.venue_id=c.venue_id AND s.employee_id=c.employee_id AND s.month_from=c.month_from AND s.claim_id=c.id WHERE c.venue_id=$1 AND c.h2_entry_id=$2 AND c.h2_run_id=$3 AND c.employee_id=$4 AND c.evidence_sha256=$5',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
   INTO claims USING NEW.venue_id,NEW.id,NEW.calculation_run_id,NEW.user_id,NEW.calculation_provenance_sha256;
 END IF;
 EXECUTE format('SELECT count(*) FROM %I.payroll_h2_requests q JOIN %I.payroll_h2_settlement_claims c ON c.venue_id=q.venue_id AND c.id=q.claim_id WHERE c.venue_id=$1 AND c.h2_entry_id=$2 AND q.created_by=$3',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
  INTO receipts USING NEW.venue_id,NEW.id,NEW.materialized_by;
 EXECUTE format('SELECT count(*) FROM %I.payroll_calculation_entry_requests q WHERE q.venue_id=$1 AND q.entry_id=$2 AND q.created_by=$3 AND (q.response_payload::jsonb)->>''existing''=''false'' AND (q.response_payload::jsonb)->>''replayed''=''false'' AND (q.response_payload::jsonb)->''entry''->>''id''=$2::text',TG_TABLE_SCHEMA)
  INTO materializations USING NEW.venue_id,NEW.id,NEW.materialized_by;
 IF claims<>1 OR receipts<>1 OR materializations<>1 THEN RAISE EXCEPTION 'payroll_h2_claim_or_receipt_missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION payroll_validate_h2_settlement_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb; run record; parent record; monthly record; employee_total numeric; monthly_fixed numeric;
 first_fixed numeric; second_fixed numeric; h1_fixed numeric; employee_count bigint; monthly_from date; month_end date; employee uuid;
BEGIN
 IF NEW.schema_version<>5 OR NEW.capability_version<>'payroll-deferred-month-settlement-v1' THEN RAISE EXCEPTION 'payroll_h2_provenance_invalid' USING ERRCODE='23514'; END IF;
 p:=NEW.evidence_payload::jsonb;
 BEGIN monthly_from:=((p->>'month') || '-01')::date; employee:=(p->>'employeeId')::uuid;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'payroll_h2_provenance_context_invalid' USING ERRCODE='23514'; END;
 month_end:=(monthly_from+interval '1 month - 1 day')::date;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO run USING NEW.venue_id,NEW.run_id;
 EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2::uuid',TG_TABLE_SCHEMA) INTO parent USING NEW.venue_id,p->>'monthlyRunId';
 EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2::uuid',TG_TABLE_SCHEMA) INTO monthly USING NEW.venue_id,p->>'monthlyRunId';
 IF p->'schemaVersion' IS DISTINCT FROM '5'::jsonb OR p->>'capabilityVersion' IS DISTINCT FROM NEW.capability_version
   OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR p->>'h2RunId' IS DISTINCT FROM NEW.run_id::text
   OR p->>'month' IS DISTINCT FROM to_char(monthly_from,'YYYY-MM') OR p->>'periodFrom' IS DISTINCT FROM to_char(monthly_from+14,'YYYY-MM-DD')
   OR p->>'periodTo' IS DISTINCT FROM to_char(month_end,'YYYY-MM-DD') OR p->>'currency' IS DISTINCT FROM 'RUB'
   OR run.id IS NULL OR run.engine_version IS DISTINCT FROM 'payroll-deferred-month-settlement-v1'
   OR run.status IS DISTINCT FROM 'ready' OR run.period_from IS DISTINCT FROM monthly_from+14 OR run.period_to IS DISTINCT FROM month_end
   OR run.input_checksum IS DISTINCT FROM NEW.evidence_sha256 OR run.currency IS DISTINCT FROM 'RUB'
   OR monthly.period_from IS DISTINCT FROM monthly_from OR monthly.period_to IS DISTINCT FROM month_end
   OR monthly.status IS DISTINCT FROM 'ready' OR monthly.engine_version IS DISTINCT FROM 'payroll-verified-remaining-net-v2'
   OR run.scheme_version_id IS DISTINCT FROM monthly.scheme_version_id
   OR run.venue_timezone IS DISTINCT FROM monthly.venue_timezone
   OR parent.evidence_payload::jsonb->>'schemeVersionId' IS DISTINCT FROM monthly.scheme_version_id::text
   OR parent.evidence_payload::jsonb->>'venueTimezone' IS DISTINCT FROM monthly.venue_timezone
   OR parent.schema_version IS DISTINCT FROM 2 OR parent.capability_version IS DISTINCT FROM 'employee_attributed_remaining_net_refund_v2'
   OR p->>'monthlyEvidenceSha256' IS DISTINCT FROM parent.evidence_sha256::text THEN
  RAISE EXCEPTION 'payroll_h2_provenance_context_invalid' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['monthlyGrossMinor','h1GrossAccruedMinor','h2GrossAccruedMinor','monthlyProtectedFixedMinor','h1ProtectedFixedMinor','h2ProtectedFixedMinor','h2EligibleVariableMinor']) k
   WHERE jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR (p->>k) !~ '^(0|[1-9][0-9]*)$' OR (p->>k)::numeric>9007199254740991) THEN
  RAISE EXCEPTION 'payroll_h2_amount_invalid' USING ERRCODE='23514'; END IF;
 SELECT count(*),max((x->>'amountCents')::numeric) INTO employee_count,employee_total FROM jsonb_array_elements(parent.evidence_payload::jsonb->'calculatorReplay'->'result'->'employees') x WHERE x->>'employeeId'=employee::text;
 EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0),COALESCE(sum(LEAST(base_pay,final_amount)*100) FILTER(WHERE local_date<=$4+13),0),COALESCE(sum(LEAST(base_pay,final_amount)*100) FILTER(WHERE local_date>=$4+14),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
  INTO monthly_fixed,first_fixed,second_fixed USING NEW.venue_id,monthly.id,employee,monthly_from;
 IF employee_count<>1 OR employee_total IS NULL OR employee_total IS DISTINCT FROM (p->>'monthlyGrossMinor')::numeric
  OR monthly_fixed IS DISTINCT FROM (p->>'monthlyProtectedFixedMinor')::numeric
  OR first_fixed IS DISTINCT FROM (p->>'h1ProtectedFixedMinor')::numeric
  OR second_fixed IS DISTINCT FROM (p->>'h2ProtectedFixedMinor')::numeric
  OR (p->>'h2GrossAccruedMinor')::numeric IS DISTINCT FROM employee_total-(p->>'h1GrossAccruedMinor')::numeric
  OR (p->>'h2ProtectedFixedMinor')::numeric>(p->>'h2GrossAccruedMinor')::numeric
  OR (p->>'h2EligibleVariableMinor')::numeric IS DISTINCT FROM (p->>'h2GrossAccruedMinor')::numeric-(p->>'h2ProtectedFixedMinor')::numeric
  OR NEW.total_amount_cents IS DISTINCT FROM (p->>'h2GrossAccruedMinor')::numeric THEN
  RAISE EXCEPTION 'payroll_h2_amount_reconciliation_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_h2_provenance_commit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_venue uuid; target_run uuid; run record; proof_count bigint; claim_count bigint; daily_count bigint;
BEGIN
 IF TG_TABLE_NAME='payroll_calculation_runs' THEN target_venue:=NEW.venue_id; target_run:=NEW.id;
 ELSE target_venue:=NEW.venue_id; target_run:=NEW.run_id; END IF;
 EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO run USING target_venue,target_run;
 IF run.engine_version IS DISTINCT FROM 'payroll-deferred-month-settlement-v1' THEN RETURN NULL; END IF;
 EXECUTE format('SELECT count(*) FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2 AND schema_version=5 AND capability_version=''payroll-deferred-month-settlement-v1''',TG_TABLE_SCHEMA) INTO proof_count USING target_venue,target_run;
 EXECUTE format('SELECT count(*) FROM %I.payroll_h2_settlement_claims WHERE venue_id=$1 AND h2_run_id=$2',TG_TABLE_SCHEMA) INTO claim_count USING target_venue,target_run;
 EXECUTE format('SELECT count(*) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA) INTO daily_count USING target_venue,target_run;
 IF proof_count<>1 OR claim_count<>1 OR daily_count<>0 THEN RAISE EXCEPTION 'payroll_h2_provenance_commit_invalid' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
-- Wiring appears below only as reviewable draft; dependencies/legacy provenance
-- routing must be adapted to 215 full source in one transaction before use.

CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p jsonb; actor record; employee record; total numeric; member_count integer; input_count integer; replay_amount numeric; names integer; transition record; next_action text; is_v2 boolean; replaced boolean; h2_employee_name text; h2_scheme_name text;
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
  IF r.engine_version='payroll-deferred-month-settlement-v1' THEN
    p:=r.evidence_payload::jsonb;
    IF r.status IS DISTINCT FROM 'ready' OR r.provenance_schema_version IS DISTINCT FROM 5
      OR r.provenance_capability_version IS DISTINCT FROM 'payroll-deferred-month-settlement-v1'
      OR NEW.payroll_half_kind IS DISTINCT FROM 'h2' OR r.currency IS DISTINCT FROM 'RUB'
      OR r.period_from IS DISTINCT FROM NEW.period_from OR r.period_to IS DISTINCT FROM NEW.period_to
      OR r.evidence_sha256 IS DISTINCT FROM NEW.calculation_provenance_sha256
      OR p->>'employeeId' IS DISTINCT FROM NEW.user_id::text OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text
      OR (p->>'h2GrossAccruedMinor')::numeric IS DISTINCT FROM NEW.calculation_gross_cents::numeric
      OR NEW.amount*100 IS DISTINCT FROM NEW.calculation_gross_cents::numeric THEN
     RAISE EXCEPTION 'payroll_h2_entry_run_mismatch' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT count(DISTINCT d.employee_name_snapshot),max(d.employee_name_snapshot),max(p.evidence_payload::jsonb->''schemeSnapshot''->>''name'') FROM %I.payroll_run_provenance p JOIN %I.payroll_daily_snapshots d ON d.venue_id=p.venue_id AND d.run_id=p.run_id WHERE p.venue_id=$1 AND p.run_id=$2::uuid AND d.employee_id=$3',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO names,h2_employee_name,h2_scheme_name USING NEW.venue_id,p->>'monthlyRunId',NEW.user_id;
    IF names<>1 OR COALESCE(h2_employee_name,'')='' OR h2_employee_name IS DISTINCT FROM NEW.employee_name_snapshot OR h2_scheme_name IS DISTINCT FROM NEW.calculation_scheme_name_snapshot THEN
      RAISE EXCEPTION 'payroll_h2_snapshot_names_mismatch' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
      INTO actor USING NEW.venue_id,NEW.materialized_by;
    IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.materialized_by_name THEN
     RAISE EXCEPTION 'payroll_calculation_entry_owner_invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
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
       AND NEW.period_to = NEW.period_from + 13)
     AND NOT (NEW.engine_version IS NOT DISTINCT FROM 'payroll-deferred-month-settlement-v1'
       AND extract(day from NEW.period_from)=15
       AND NEW.period_to = (date_trunc('month',NEW.period_from)+interval '1 month - 1 day')::date) THEN
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

CREATE OR REPLACE FUNCTION payroll_validate_calculation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; actor record; expense record; account record; shift_row record; proof jsonb;
  used numeric; fixed numeric; n bigint; other_link boolean; zone text; h2_proof jsonb;
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
  IF e.payroll_half_kind='h2' THEN
    EXECUTE format('SELECT p.evidence_payload::jsonb FROM %I.payroll_run_provenance p JOIN %I.payroll_h2_settlement_claims c ON c.venue_id=p.venue_id AND c.h2_run_id=p.run_id JOIN %I.payroll_h2_claim_slots s ON s.venue_id=c.venue_id AND s.employee_id=c.employee_id AND s.month_from=c.month_from AND s.claim_id=c.id WHERE p.venue_id=$1 AND p.run_id=$2 AND c.h2_entry_id=$3 AND p.schema_version=5 AND p.capability_version=''payroll-deferred-month-settlement-v1'' AND p.evidence_sha256=$4',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO h2_proof USING NEW.venue_id,NEW.calculation_run_id,NEW.entry_id,NEW.provenance_sha256;
    IF h2_proof IS NULL OR jsonb_typeof(h2_proof->'h2ProtectedFixedMinor') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'payroll_h2_fixed_evidence_invalid' USING ERRCODE='23514'; END IF;
    fixed:=(h2_proof->>'h2ProtectedFixedMinor')::numeric;
  ELSE
    EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
      INTO fixed USING NEW.venue_id,NEW.calculation_run_id,NEW.employee_id;
  END IF;
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
    EXECUTE format('SELECT x.* FROM %I.expenses x WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO expense USING NEW.venue_id,NEW.expense_id;
    IF expense.id IS NULL OR expense.payroll_settlement_entry_id IS DISTINCT FROM NEW.entry_id OR expense.payroll_settlement_insert_xid IS DISTINCT FROM txid_current()
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
-- Work-in-progress trigger wiring; do not apply before complete QA.
ALTER TABLE payroll_run_provenance DROP CONSTRAINT IF EXISTS payroll_run_provenance_capability_pair_check;
ALTER TABLE payroll_run_provenance ADD CONSTRAINT payroll_run_provenance_capability_pair_check CHECK (
 (schema_version=1 AND capability_version='employee_attributed_merchandise_net_no_refund_v1') OR
 (schema_version=2 AND capability_version='employee_attributed_remaining_net_refund_v2') OR
 (schema_version=3 AND capability_version='refund-aware-half-month-evidence-v3') OR
 (schema_version=4 AND capability_version='employee_attributed_h1_fixed_shifts_v1') OR
 (schema_version=5 AND capability_version='payroll-deferred-month-settlement-v1'));
DROP TRIGGER IF EXISTS payroll_run_provenance_validate ON payroll_run_provenance;
CREATE TRIGGER payroll_run_provenance_validate BEFORE INSERT ON payroll_run_provenance FOR EACH ROW
 WHEN (NEW.schema_version NOT IN (3,5)) EXECUTE FUNCTION payroll_validate_run_provenance();
DROP TRIGGER IF EXISTS payroll_h2_provenance_validate ON payroll_run_provenance;
CREATE TRIGGER payroll_h2_provenance_validate BEFORE INSERT ON payroll_run_provenance FOR EACH ROW
 WHEN (NEW.schema_version=5) EXECUTE FUNCTION payroll_validate_h2_settlement_provenance();
DROP TRIGGER IF EXISTS payroll_h2_run_provenance_commit ON payroll_calculation_runs;
CREATE CONSTRAINT TRIGGER payroll_h2_run_provenance_commit AFTER INSERT OR UPDATE ON payroll_calculation_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_h2_provenance_commit_check();
DROP TRIGGER IF EXISTS payroll_h2_provenance_commit ON payroll_run_provenance;
CREATE CONSTRAINT TRIGGER payroll_h2_provenance_commit AFTER INSERT ON payroll_run_provenance DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_h2_provenance_commit_check();
DROP TRIGGER IF EXISTS payroll_h2_claim_validate ON payroll_h2_settlement_claims;
CREATE TRIGGER payroll_h2_claim_validate BEFORE INSERT ON payroll_h2_settlement_claims FOR EACH ROW EXECUTE FUNCTION payroll_h2_claim_validate();
DROP TRIGGER IF EXISTS payroll_h2_claim_immutable ON payroll_h2_settlement_claims;
CREATE TRIGGER payroll_h2_claim_immutable BEFORE UPDATE OR DELETE ON payroll_h2_settlement_claims FOR EACH ROW EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h2_claim_truncate ON payroll_h2_settlement_claims;
CREATE TRIGGER payroll_h2_claim_truncate BEFORE TRUNCATE ON payroll_h2_settlement_claims FOR EACH STATEMENT EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h2_claim_activate_slot ON payroll_h2_settlement_claims;
CREATE TRIGGER payroll_h2_claim_activate_slot AFTER INSERT ON payroll_h2_settlement_claims FOR EACH ROW EXECUTE FUNCTION payroll_h2_claim_activate_slot();
DROP TRIGGER IF EXISTS payroll_h2_slot_guard ON payroll_h2_claim_slots;
CREATE TRIGGER payroll_h2_slot_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_h2_claim_slots FOR EACH ROW EXECUTE FUNCTION payroll_h2_slot_guard();
DROP TRIGGER IF EXISTS payroll_h2_slot_truncate ON payroll_h2_claim_slots;
CREATE TRIGGER payroll_h2_slot_truncate BEFORE TRUNCATE ON payroll_h2_claim_slots FOR EACH STATEMENT EXECUTE FUNCTION payroll_h2_slot_guard();
DROP TRIGGER IF EXISTS payroll_h2_void_validate ON payroll_h2_claim_voids;
CREATE TRIGGER payroll_h2_void_validate BEFORE INSERT ON payroll_h2_claim_voids FOR EACH ROW EXECUTE FUNCTION payroll_h2_void_validate();
DROP TRIGGER IF EXISTS payroll_h2_void_immutable ON payroll_h2_claim_voids;
CREATE TRIGGER payroll_h2_void_immutable BEFORE UPDATE OR DELETE ON payroll_h2_claim_voids FOR EACH ROW EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h2_void_truncate ON payroll_h2_claim_voids;
CREATE TRIGGER payroll_h2_void_truncate BEFORE TRUNCATE ON payroll_h2_claim_voids FOR EACH STATEMENT EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h2_auto_void ON payroll_entries;
CREATE TRIGGER payroll_h2_auto_void AFTER UPDATE OF status ON payroll_entries FOR EACH ROW EXECUTE FUNCTION payroll_h2_auto_void();
DROP TRIGGER IF EXISTS payroll_h2_void_commit_check ON payroll_h2_claim_voids;
CREATE CONSTRAINT TRIGGER payroll_h2_void_commit_check AFTER INSERT ON payroll_h2_claim_voids DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_h2_void_commit_check();
DROP TRIGGER IF EXISTS payroll_h2_source_conflict_guard ON payroll_entries;
CREATE TRIGGER payroll_h2_source_conflict_guard BEFORE INSERT OR UPDATE OF status ON payroll_entries FOR EACH ROW EXECUTE FUNCTION payroll_h2_source_conflict_guard();
DROP TRIGGER IF EXISTS payroll_h2_entry_commit_check ON payroll_entries;
CREATE CONSTRAINT TRIGGER payroll_h2_entry_commit_check AFTER INSERT OR UPDATE ON payroll_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_h2_entry_commit_check();
DROP TRIGGER IF EXISTS payroll_h2_request_validate ON payroll_h2_requests;
CREATE TRIGGER payroll_h2_request_validate BEFORE INSERT ON payroll_h2_requests FOR EACH ROW EXECUTE FUNCTION payroll_h2_request_validate();
DROP TRIGGER IF EXISTS payroll_h2_request_immutable ON payroll_h2_requests;
CREATE TRIGGER payroll_h2_request_immutable BEFORE UPDATE OR DELETE ON payroll_h2_requests FOR EACH ROW EXECUTE FUNCTION payroll_h1_immutable();
DROP TRIGGER IF EXISTS payroll_h2_request_truncate ON payroll_h2_requests;
CREATE TRIGGER payroll_h2_request_truncate BEFORE TRUNCATE ON payroll_h2_requests FOR EACH STATEMENT EXECUTE FUNCTION payroll_h1_immutable();


-- Candidate only; version-bound to migrations 203/206. Verify schema+PG before integration.
CREATE OR REPLACE FUNCTION payroll_h2_correction_basis(v uuid,entry_id uuid,employee uuid,schema_name text)
RETURNS TABLE(protected_fixed numeric,gross_amount numeric) LANGUAGE plpgsql AS $$
DECLARE e record; c record; p record; evidence jsonb; n bigint;
BEGIN
 EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 AND user_id=$3',schema_name) INTO e USING v,entry_id,employee;
 IF e.id IS NULL OR e.payroll_half_kind IS DISTINCT FROM 'h2' THEN RAISE EXCEPTION 'payroll_h2_correction_basis_invalid' USING ERRCODE='23514'; END IF;
 EXECUTE format('SELECT * FROM %I.payroll_h2_settlement_claims WHERE venue_id=$1 AND h2_entry_id=$2 AND employee_id=$3',schema_name) INTO c USING v,entry_id,employee;
 EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',schema_name) INTO p USING v,e.calculation_run_id;
 IF c.id IS NULL OR c.h2_run_id IS DISTINCT FROM e.calculation_run_id OR c.evidence_sha256 IS DISTINCT FROM e.calculation_provenance_sha256
   OR p.schema_version IS DISTINCT FROM 5 OR p.capability_version IS DISTINCT FROM 'payroll-deferred-month-settlement-v1'
   OR p.evidence_sha256 IS DISTINCT FROM c.evidence_sha256
   OR encode(sha256(convert_to(p.evidence_payload,'UTF8')),'hex') IS DISTINCT FROM p.evidence_sha256 THEN
  RAISE EXCEPTION 'payroll_h2_correction_basis_invalid' USING ERRCODE='23514'; END IF;
 IF e.status='cancelled' THEN
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_claim_voids WHERE venue_id=$1 AND claim_id=$2',schema_name) INTO n USING v,c.id;
 ELSE
  EXECUTE format('SELECT count(*) FROM %I.payroll_h2_claim_slots WHERE venue_id=$1 AND employee_id=$2 AND month_from=$3 AND claim_id=$4',schema_name) INTO n USING v,employee,c.month_from,c.id;
 END IF;
 IF n<>1 THEN RAISE EXCEPTION 'payroll_h2_correction_basis_invalid' USING ERRCODE='23514'; END IF;
 evidence:=p.evidence_payload::jsonb;
 IF evidence->>'employeeId' IS DISTINCT FROM employee::text OR evidence->>'venueId' IS DISTINCT FROM v::text
   OR jsonb_typeof(evidence->'h2ProtectedFixedMinor') IS DISTINCT FROM 'number'
   OR jsonb_typeof(evidence->'h2GrossAccruedMinor') IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'payroll_h2_correction_basis_invalid' USING ERRCODE='23514'; END IF;
 protected_fixed:=(evidence->>'h2ProtectedFixedMinor')::numeric; gross_amount:=(evidence->>'h2GrossAccruedMinor')::numeric;
 IF gross_amount IS DISTINCT FROM e.calculation_gross_cents::numeric OR protected_fixed<0 OR protected_fixed>gross_amount THEN
  RAISE EXCEPTION 'payroll_h2_correction_basis_invalid' USING ERRCODE='23514'; END IF;
 RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION payroll_correction_validate_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record; target record; assessment record; actor record; expense record; previous_seq integer; used numeric; fixed numeric; gross numeric; plan jsonb; planned_count integer; planned_total numeric; allocation jsonb; amount_key text;
BEGIN
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.created_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.created_by_name THEN
    RAISE EXCEPTION 'payroll_correction_owner_required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO original USING NEW.venue_id,NEW.original_entry_id;
  IF NEW.operation<>'release' THEN
  EXECUTE format('SELECT * FROM %I.payroll_refund_review_assessments WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO assessment USING NEW.venue_id,NEW.assessment_id;
  IF original.id IS NULL OR original.status<>'paid' OR original.calculation_run_id IS NULL OR original.user_id<>NEW.employee_id
    OR assessment.id IS NULL OR assessment.coverage<>'complete' OR assessment.run_id<>original.calculation_run_id
    OR assessment.assessment_hash<>NEW.assessment_hash OR assessment.source_hash<>NEW.source_hash THEN
    RAISE EXCEPTION 'payroll_correction_batch_basis_invalid' USING ERRCODE='23514'; END IF;
  IF original.expense_id IS NULL THEN
    PERFORM payroll_correction_require_zero_settlement(TG_TABLE_SCHEMA,NEW.venue_id,NEW.original_entry_id,(NEW.plan_payload::jsonb->>'originalSettlementTransitionId')::uuid);
  ELSE
  EXECUTE format('SELECT * FROM %I.expenses WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO expense USING NEW.venue_id,original.expense_id;
  IF expense.id IS NULL OR expense.source<>'payroll' OR expense.amount IS DISTINCT FROM original.amount THEN
    RAISE EXCEPTION 'payroll_correction_original_expense_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  END IF;
  plan:=NEW.plan_payload::jsonb;
  IF plan->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR plan->>'policyVersion' IS DISTINCT FROM (CASE WHEN NEW.operation<>'release' AND original.expense_id IS NULL THEN 'owner-reviewed-variable-correction-v2' ELSE 'owner-reviewed-variable-correction-v1' END)
    OR plan->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR plan->>'employeeId' IS DISTINCT FROM NEW.employee_id::text
    OR plan->>'currency' IS DISTINCT FROM NEW.currency
    OR plan->>'ledgerHash' IS DISTINCT FROM NEW.ledger_hash::text OR plan->'officialReady' IS DISTINCT FROM 'false'::jsonb
    OR plan->'payoutEligible' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'payroll_correction_plan_context_invalid' USING ERRCODE='23514'; END IF;
  IF NEW.operation<>'release' THEN
    IF plan->>'originalEntryId' IS DISTINCT FROM NEW.original_entry_id::text
      OR plan->>'originalProvenanceSha256' IS DISTINCT FROM original.calculation_provenance_sha256::text
      OR plan->>'originalExpenseId' IS DISTINCT FROM original.expense_id::text
      OR (original.expense_id IS NULL AND (plan->'originalExpenseId' IS DISTINCT FROM 'null'::jsonb OR plan->'originalPaidCents' IS DISTINCT FROM '0'::jsonb))
      OR (original.expense_id IS NOT NULL AND plan ? 'originalSettlementTransitionId')
      OR plan->>'originalRunId' IS DISTINCT FROM original.calculation_run_id::text
      OR plan->>'assessmentHash' IS DISTINCT FROM NEW.assessment_hash::text OR plan->>'sourceHash' IS DISTINCT FROM NEW.source_hash::text
      OR jsonb_typeof(plan->'allocations') IS DISTINCT FROM 'array'
      OR (NEW.operation='apply' AND plan->'applyCents' IS DISTINCT FROM to_jsonb(NEW.total_cents))
      OR (NEW.operation='waive' AND (plan->>'operation' IS DISTINCT FROM 'waive' OR plan->'waiveCents' IS DISTINCT FROM to_jsonb(NEW.total_cents))) THEN
      RAISE EXCEPTION 'payroll_correction_plan_context_invalid' USING ERRCODE='23514'; END IF;
  ELSIF plan->>'operation' IS DISTINCT FROM 'release' OR jsonb_typeof(plan->'releases') IS DISTINCT FROM 'array'
    OR plan->'releaseCents' IS DISTINCT FROM to_jsonb(NEW.total_cents) THEN
    RAISE EXCEPTION 'payroll_correction_plan_context_invalid' USING ERRCODE='23514';
  END IF;
  amount_key:=CASE NEW.operation WHEN 'apply' THEN 'applyCents' WHEN 'waive' THEN 'waiveCents' ELSE 'amountCents' END;
  planned_count:=0; planned_total:=0;
  FOR allocation IN SELECT value FROM jsonb_array_elements(plan->(CASE NEW.operation WHEN 'release' THEN 'releases' ELSE 'allocations' END)) LOOP
    IF jsonb_typeof(allocation->amount_key) IS DISTINCT FROM 'number' OR (allocation->>amount_key)!~'^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'payroll_correction_plan_amount_invalid' USING ERRCODE='23514'; END IF;
    IF (allocation->>amount_key)::numeric>0 THEN
      planned_count:=planned_count+1; planned_total:=planned_total+(allocation->>amount_key)::numeric;
    END IF;
  END LOOP;
  IF planned_count<>NEW.event_count OR planned_total<>NEW.total_cents THEN
    RAISE EXCEPTION 'payroll_correction_plan_event_total_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.operation='waive' THEN RETURN NEW; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO target USING NEW.venue_id,NEW.target_entry_id;
  IF target.id IS NULL OR target.user_id<>NEW.employee_id OR target.calculation_run_id IS NULL
    OR (NEW.operation='apply' AND (target.period_from<=original.period_to OR target.calculation_run_id=original.calculation_run_id OR target.status<>'draft'))
    OR (NEW.operation='release' AND target.status NOT IN ('draft','approved','cancelled')) THEN
    RAISE EXCEPTION 'payroll_correction_target_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(max(target_sequence_no),0) FROM %I.payroll_correction_batches WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO previous_seq USING NEW.venue_id,NEW.target_entry_id;
  IF NEW.target_sequence_no IS DISTINCT FROM previous_seq+1 THEN RAISE EXCEPTION 'payroll_correction_target_sequence_conflict' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO used USING NEW.venue_id,NEW.target_entry_id;
  IF target.payroll_half_kind='h2' THEN
    EXECUTE format('SELECT protected_fixed,gross_amount FROM %I.payroll_h2_correction_basis($1,$2,$3,$4)',TG_TABLE_SCHEMA)
      INTO fixed,gross USING NEW.venue_id,target.id,NEW.employee_id,TG_TABLE_SCHEMA;
  ELSE
    EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0),COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
      INTO fixed,gross USING NEW.venue_id,target.calculation_run_id,NEW.employee_id;
  END IF;
  IF gross IS DISTINCT FROM target.calculation_gross_cents::numeric OR fixed IS DISTINCT FROM NEW.protected_fixed_cents::numeric
    OR NEW.target_before_cents::numeric IS DISTINCT FROM gross-used
    OR (NEW.operation='apply' AND (NEW.target_after_cents::numeric<>gross-used-NEW.total_cents OR NEW.target_after_cents<fixed))
    OR (NEW.operation='release' AND (NEW.total_cents<>used OR NEW.target_after_cents<>NEW.target_before_cents))
    OR plan->>'targetEntryId' IS DISTINCT FROM NEW.target_entry_id::text
    OR plan->>'targetProvenanceSha256' IS DISTINCT FROM target.calculation_provenance_sha256::text
    OR plan->'targetBeforeCents' IS DISTINCT FROM to_jsonb(NEW.target_before_cents)
    OR (NEW.operation='apply' AND plan->'targetAfterCents' IS DISTINCT FROM to_jsonb(NEW.target_after_cents))
    OR (NEW.operation='release' AND plan->'cancelledHistoricalCents' IS DISTINCT FROM to_jsonb(NEW.target_after_cents))
    OR plan->'protectedFixedCents' IS DISTINCT FROM to_jsonb(NEW.protected_fixed_cents) THEN
    RAISE EXCEPTION 'payroll_correction_target_capacity_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_correction_validate_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch record; target record; v uuid; b uuid; n bigint; total numeric; unreleased bigint; used numeric; fixed numeric;
BEGIN
  v:=NEW.venue_id;
  IF TG_TABLE_NAME='payroll_correction_batches' THEN b:=NEW.id;
  ELSIF TG_TABLE_NAME='payroll_correction_events' THEN b:=NEW.batch_id;
  ELSE b:=NULL; END IF;
  IF b IS NOT NULL THEN
    EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO batch USING v,b;
    EXECUTE format('SELECT count(*),COALESCE(sum(amount_cents),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND batch_id=$2',TG_TABLE_SCHEMA)
      INTO n,total USING v,b;
    IF n<>batch.event_count OR total<>batch.total_cents THEN RAISE EXCEPTION 'payroll_correction_batch_incomplete' USING ERRCODE='23514'; END IF;
    IF batch.target_entry_id IS NULL THEN RETURN NULL; END IF;
    EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA) INTO target USING v,batch.target_entry_id;
    IF batch.operation='release' AND target.status<>'cancelled' THEN
      RAISE EXCEPTION 'payroll_correction_release_requires_cancel' USING ERRCODE='23514'; END IF;
    IF batch.operation='release' AND target.amount*100 IS DISTINCT FROM batch.target_before_cents::numeric THEN
      RAISE EXCEPTION 'payroll_correction_cancel_historical_amount_changed' USING ERRCODE='23514'; END IF;
  ELSE
    -- A deferred row trigger may carry an earlier version from the same
    -- transaction (net update followed by cancellation). Re-read final state.
    EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO target USING v,NEW.id;
    IF target.id IS NULL THEN RETURN NULL; END IF;
  END IF;
  EXECUTE format('SELECT count(*) FROM %I.payroll_correction_events a WHERE a.venue_id=$1 AND a.target_entry_id=$2 AND a.kind=''apply'' AND NOT EXISTS(SELECT 1 FROM %I.payroll_correction_events r WHERE r.venue_id=a.venue_id AND r.reverses_event_id=a.id)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO unreleased USING v,target.id;
  IF target.status='cancelled' THEN
    IF unreleased<>0 THEN RAISE EXCEPTION 'payroll_correction_cancel_requires_full_release' USING ERRCODE='23514'; END IF;
    RETURN NULL;
  END IF;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO used USING v,target.id;
  IF b IS NULL AND used=0 THEN RETURN NULL; END IF;
  IF target.payroll_half_kind='h2' THEN
    EXECUTE format('SELECT protected_fixed FROM %I.payroll_h2_correction_basis($1,$2,$3,$4)',TG_TABLE_SCHEMA)
      INTO fixed USING v,target.id,target.user_id,TG_TABLE_SCHEMA;
  ELSE
    EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
      INTO fixed USING v,target.calculation_run_id,target.user_id;
  END IF;
  IF used<0 OR target.calculation_gross_cents-used<fixed OR target.amount*100 IS DISTINCT FROM target.calculation_gross_cents-used THEN
    RAISE EXCEPTION 'payroll_correction_target_net_reconciliation_required' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
