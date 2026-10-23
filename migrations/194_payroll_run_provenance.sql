-- Immutable evidence for the explicitly versioned verified payroll engine.
-- Legacy ready and blocked runs retain their existing storage contract.
CREATE TABLE IF NOT EXISTS payroll_run_provenance (
  venue_id uuid NOT NULL,
  run_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version=1),
  capability_version text NOT NULL CHECK (capability_version='employee_attributed_merchandise_net_no_refund_v1'),
  evidence_payload text NOT NULL CHECK (jsonb_typeof(evidence_payload::jsonb)='object'),
  evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(evidence_payload,'UTF8')),'hex')=evidence_sha256),
  total_amount_cents bigint NOT NULL CHECK (total_amount_cents BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (venue_id,run_id),
  FOREIGN KEY (venue_id,run_id) REFERENCES payroll_calculation_runs(venue_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payroll_validate_run_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run record; payload jsonb; p jsonb; closure jsonb; scheme jsonb; source_period_from date; source_period_to date;
  closure_ts timestamptz; closure_date date;
BEGIN
  payload:=NEW.evidence_payload::jsonb; p:=payload->'period'; closure:=payload->'periodClosure'; scheme:=payload->'schemeSnapshot';
  IF payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR payload->>'capabilityVersion' IS DISTINCT FROM 'employee_attributed_merchandise_net_no_refund_v1'
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
  IF run.status IS DISTINCT FROM 'ready' OR run.engine_version IS DISTINCT FROM 'payroll-verified-no-refund-v1'
    OR payload->>'schemeVersionId' IS DISTINCT FROM run.scheme_version_id::text
    OR source_period_from IS DISTINCT FROM run.period_from OR source_period_to IS DISTINCT FROM run.period_to
    OR payload->>'currency' IS DISTINCT FROM run.currency OR payload->>'venueTimezone' IS DISTINCT FROM run.venue_timezone
    OR run.input_checksum IS DISTINCT FROM NEW.evidence_sha256 OR run.input_watermark IS DISTINCT FROM payload->>'inputWatermark'
    OR closure->>'venueLocalDate' IS DISTINCT FROM to_char(closure_date,'YYYY-MM-DD')
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name=closure->>'timezone')
    OR (closure_ts AT TIME ZONE (closure->>'timezone'))::date IS DISTINCT FROM closure_date
    OR closure_date<=run.period_to OR closure->>'timezone' IS DISTINCT FROM run.venue_timezone THEN
    RAISE EXCEPTION 'payroll provenance does not match verified ready run' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_validate_run_provenance_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_venue uuid; target_run uuid; parent record; provenance record; total numeric;
BEGIN
  IF TG_TABLE_NAME='payroll_calculation_runs' THEN target_venue:=NEW.venue_id; target_run:=NEW.id;
  ELSE target_venue:=NEW.venue_id; target_run:=NEW.run_id; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO parent USING target_venue,target_run;
  IF parent.id IS NULL OR parent.engine_version IS DISTINCT FROM 'payroll-verified-no-refund-v1' THEN RETURN NULL; END IF;
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

CREATE OR REPLACE FUNCTION payroll_reject_run_provenance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll run provenance is immutable' USING ERRCODE='55000'; END $$;
CREATE OR REPLACE FUNCTION payroll_reject_run_provenance_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll run provenance cannot be truncated' USING ERRCODE='55000'; END $$;

DROP TRIGGER IF EXISTS payroll_run_provenance_validate ON payroll_run_provenance;
CREATE TRIGGER payroll_run_provenance_validate BEFORE INSERT ON payroll_run_provenance
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_run_provenance();
DROP TRIGGER IF EXISTS payroll_run_provenance_immutable ON payroll_run_provenance;
CREATE TRIGGER payroll_run_provenance_immutable BEFORE UPDATE OR DELETE ON payroll_run_provenance
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_run_provenance_mutation();
DROP TRIGGER IF EXISTS payroll_run_provenance_truncate ON payroll_run_provenance;
CREATE TRIGGER payroll_run_provenance_truncate BEFORE TRUNCATE ON payroll_run_provenance
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_run_provenance_truncate();
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['payroll_calculation_runs','payroll_run_provenance','payroll_daily_snapshots'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_provenance_commit',table_name);
    IF table_name='payroll_calculation_runs' THEN
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_run_provenance_commit()',table_name||'_provenance_commit',table_name);
    ELSE
      EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_run_provenance_commit()',table_name||'_provenance_commit',table_name);
    END IF;
  END LOOP;
END $$;
