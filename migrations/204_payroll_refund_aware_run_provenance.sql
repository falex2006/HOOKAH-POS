-- Add an explicit second source capability without changing immutable v1 data.
-- 204 is payroll-reserved; 205 lifecycle still controls monetary transitions.
ALTER TABLE payroll_run_provenance DROP CONSTRAINT IF EXISTS payroll_run_provenance_schema_version_check;
ALTER TABLE payroll_run_provenance DROP CONSTRAINT IF EXISTS payroll_run_provenance_capability_version_check;
ALTER TABLE payroll_run_provenance DROP CONSTRAINT IF EXISTS payroll_run_provenance_capability_pair_check;
ALTER TABLE payroll_run_provenance ADD CONSTRAINT payroll_run_provenance_capability_pair_check CHECK (
  (schema_version=1 AND capability_version='employee_attributed_merchandise_net_no_refund_v1')
  OR (schema_version=2 AND capability_version='employee_attributed_remaining_net_refund_v2'));

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
      OR (NEW.schema_version=2 AND NEW.capability_version='employee_attributed_remaining_net_refund_v2' AND run.engine_version='payroll-verified-remaining-net-v2'))
    OR payload->>'schemeVersionId' IS DISTINCT FROM run.scheme_version_id::text
    OR source_period_from IS DISTINCT FROM run.period_from OR source_period_to IS DISTINCT FROM run.period_to
    OR payload->>'currency' IS DISTINCT FROM run.currency OR payload->>'venueTimezone' IS DISTINCT FROM run.venue_timezone
    OR run.input_checksum IS DISTINCT FROM NEW.evidence_sha256 OR run.input_watermark IS DISTINCT FROM payload->>'inputWatermark'
    OR closure->>'venueLocalDate' IS DISTINCT FROM to_char(closure_date,'YYYY-MM-DD')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name=closure->>'timezone')
    OR (closure_ts AT TIME ZONE (closure->>'timezone'))::date IS DISTINCT FROM closure_date
    OR closure_date<=run.period_to OR closure->>'timezone' IS DISTINCT FROM run.venue_timezone THEN
    RAISE EXCEPTION 'payroll provenance does not match verified ready run' USING ERRCODE='23514'; END IF;
  IF NEW.schema_version=2 THEN
    IF scheme->'sourcePolicies'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR scheme->'sourcePolicies'->'earnings' IS DISTINCT FROM '{"refunds":"remaining_merchandise_original_sale_date_v1","venueTurnover":"canonical_total_less_merchandise_returns_v1","marginCost":"frozen_sale_depletion_cost_payroll_v1"}'::jsonb
      OR payload->'sourceBundle'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR payload->'sourceBundle'->'recognitionEvidence'->>'encoding' IS DISTINCT FROM 'json-preserved-property-order-v1'
      OR jsonb_typeof(payload->'sourceBundle'->'recognitionEvidence'->'payload') IS DISTINCT FROM 'string'
      OR COALESCE(payload->>'sourceBundleWatermark','') !~ '^[a-f0-9]{64}$'
      OR jsonb_typeof(payload->'calculatorReplay') IS DISTINCT FROM 'object'
      OR jsonb_typeof(payload->'refundQuantityEvidence') IS DISTINCT FROM 'object'
      OR payload->'refundQuantityEvidence'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR payload->'sourceEvidence'->>'capabilityVersion' IS DISTINCT FROM NEW.capability_version
      OR payload->'calculatorReplay'->'input'->'sourceEvidence' IS DISTINCT FROM payload->'sourceEvidence'
      OR payload->'calculatorReplay'->'input'->'scheme' IS DISTINCT FROM scheme THEN
      RAISE EXCEPTION 'payroll refund aware source envelope invalid' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_validate_run_provenance_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_venue uuid; target_run uuid; parent record; provenance record; total numeric;
BEGIN
  IF TG_TABLE_NAME='payroll_calculation_runs' THEN target_venue:=NEW.venue_id; target_run:=NEW.id;
  ELSE target_venue:=NEW.venue_id; target_run:=NEW.run_id; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO parent USING target_venue,target_run;
  IF parent.id IS NULL OR parent.engine_version NOT IN ('payroll-verified-no-refund-v1','payroll-verified-remaining-net-v2') THEN RETURN NULL; END IF;
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

