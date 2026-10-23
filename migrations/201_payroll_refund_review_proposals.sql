-- Review-only journal. No row in this journal is a payroll adjustment or payout.
CREATE TABLE IF NOT EXISTS payroll_refund_review_cases (
  id uuid PRIMARY KEY, venue_id uuid NOT NULL, run_id uuid NOT NULL,
  created_by uuid NOT NULL, created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,run_id), UNIQUE(venue_id,id,run_id),
  FOREIGN KEY(venue_id,run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS payroll_refund_review_assessments (
  id uuid PRIMARY KEY, sequence_no bigserial NOT NULL UNIQUE, venue_id uuid NOT NULL, case_id uuid NOT NULL, run_id uuid NOT NULL,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  assessment_hash char(64) NOT NULL CHECK(assessment_hash ~ '^[0-9a-f]{64}$'),
  payload text NOT NULL CHECK(octet_length(payload)<=4194304 AND jsonb_typeof(payload::jsonb)='object'
    AND encode(sha256(convert_to(payload,'UTF8')),'hex')=assessment_hash),
  coverage text NOT NULL CHECK(coverage IN ('complete','needs_review')),
  impact_cents bigint CHECK(impact_cents BETWEEN -9007199254740991 AND 9007199254740991),
  created_by uuid NOT NULL, created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,case_id,source_hash), UNIQUE(venue_id,case_id,id,assessment_hash),
  FOREIGN KEY(venue_id,case_id,run_id) REFERENCES payroll_refund_review_cases(venue_id,id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK(coverage='complete' OR impact_cents IS NULL)
);
CREATE INDEX IF NOT EXISTS payroll_refund_review_assessments_history ON payroll_refund_review_assessments(venue_id,case_id,sequence_no DESC);
CREATE TABLE IF NOT EXISTS payroll_refund_review_decisions (
  id uuid PRIMARY KEY, sequence_no bigserial NOT NULL UNIQUE, venue_id uuid NOT NULL, case_id uuid NOT NULL,
  assessment_id uuid NOT NULL, assessment_hash char(64) NOT NULL,
  decision text NOT NULL CHECK(decision IN ('hold_for_review','close_without_payroll_change','acknowledge_no_effect')),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL, created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,case_id,assessment_id,id),
  FOREIGN KEY(venue_id,case_id,assessment_id,assessment_hash)
    REFERENCES payroll_refund_review_assessments(venue_id,case_id,id,assessment_hash) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_refund_review_one_terminal_decision ON payroll_refund_review_decisions(venue_id,assessment_id)
  WHERE decision IN ('close_without_payroll_change','acknowledge_no_effect');
CREATE INDEX IF NOT EXISTS payroll_refund_review_decisions_history ON payroll_refund_review_decisions(venue_id,case_id,sequence_no DESC);
CREATE TABLE IF NOT EXISTS payroll_refund_review_requests (
  venue_id uuid NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
  request_kind text NOT NULL CHECK(request_kind IN ('assessment','decision')),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  case_id uuid NOT NULL, assessment_id uuid NOT NULL, assessment_hash char(64) NOT NULL, decision_id uuid,
  response_payload text NOT NULL CHECK(octet_length(response_payload)<=8388608 AND jsonb_typeof(response_payload::jsonb)='object'),
  response_hash char(64) NOT NULL CHECK(response_hash ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(response_payload,'UTF8')),'hex')=response_hash),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(venue_id,idempotency_key),
  FOREIGN KEY(venue_id,case_id,assessment_id,assessment_hash)
    REFERENCES payroll_refund_review_assessments(venue_id,case_id,id,assessment_hash) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,case_id,assessment_id,decision_id)
    REFERENCES payroll_refund_review_decisions(venue_id,case_id,assessment_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK((request_kind='assessment' AND decision_id IS NULL) OR (request_kind='decision' AND decision_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION payroll_refund_review_validate_assessment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb; provenance record; source_line jsonb; line_record record; refund_record record; source_order boolean; impact_total numeric:=0;
BEGIN
  p:=NEW.payload::jsonb;
  IF p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR p->>'policyVersion' IS DISTINCT FROM 'saved-run-refund-review-v1'
    OR p->>'basis' IS DISTINCT FROM 'saved_calculation_unposted' OR p->>'runId' IS DISTINCT FROM NEW.run_id::text
    OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR p->>'sourceHash' IS DISTINCT FROM NEW.source_hash::text
    OR p->>'coverage' IS DISTINCT FROM NEW.coverage OR p->'impactCents' IS DISTINCT FROM COALESCE(to_jsonb(NEW.impact_cents),'null'::jsonb)
    OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p->'reasons') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'lines') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p->'lines')>20000 THEN
    RAISE EXCEPTION 'payroll refund assessment context invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT p.evidence_sha256,r.currency FROM %I.payroll_run_provenance p JOIN %I.payroll_calculation_runs r ON r.venue_id=p.venue_id AND r.id=p.run_id WHERE p.venue_id=$1 AND p.run_id=$2',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO provenance USING NEW.venue_id,NEW.run_id;
  IF provenance.evidence_sha256 IS NULL OR p->>'provenanceSha256' IS DISTINCT FROM provenance.evidence_sha256::text
    OR p->>'currency' IS DISTINCT FROM provenance.currency THEN
    RAISE EXCEPTION 'payroll refund assessment provenance mismatch' USING ERRCODE='23514'; END IF;
  IF (NEW.coverage='complete' AND (NEW.impact_cents IS NULL OR jsonb_array_length(p->'reasons')<>0))
    OR (NEW.coverage='needs_review' AND jsonb_array_length(p->'reasons')=0) THEN
    RAISE EXCEPTION 'payroll refund review coverage invalid' USING ERRCODE='23514'; END IF;
  -- Validate source identities without adding constraints or writes to POS ledgers.
  FOR source_line IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
    IF jsonb_typeof(source_line) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'payroll refund source row invalid' USING ERRCODE='23514'; END IF;
    IF NEW.coverage='complete' THEN
      IF source_line->>'sourceSnapshotLineId' IS NULL OR source_line->>'originalSaleLineEventId' IS NULL
        OR source_line->>'refundLineEventId' IS NULL OR source_line->>'pricingLineId' IS NULL
        OR jsonb_typeof(source_line->'salaryImpactCents') IS DISTINCT FROM 'number'
        OR COALESCE(source_line->>'salaryImpactCents','') !~ '^-?(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'payroll refund review complete lineage required' USING ERRCODE='23514'; END IF;
      impact_total:=impact_total+(source_line->>'salaryImpactCents')::numeric;
    ELSIF source_line->'salaryImpactCents' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'payroll refund review unsupported impact must be unknown' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND run_id=$2 AND order_id=$3)',TG_TABLE_SCHEMA)
      INTO source_order USING NEW.venue_id,NEW.run_id,(source_line->>'orderId')::uuid;
    IF NOT source_order THEN RAISE EXCEPTION 'payroll refund order outside saved run' USING ERRCODE='23514'; END IF;
    IF source_line->>'refundEventId' IS NULL THEN
      IF NEW.coverage<>'needs_review' THEN RAISE EXCEPTION 'payroll refund missing recognition' USING ERRCODE='23514'; END IF;
      EXECUTE format('SELECT * FROM %I.order_refunds WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
        INTO refund_record USING NEW.venue_id,(source_line->>'refundId')::uuid;
      IF refund_record.id IS NULL OR refund_record.order_id::text IS DISTINCT FROM source_line->>'orderId' THEN
        RAISE EXCEPTION 'payroll refund header identity mismatch' USING ERRCODE='23514'; END IF;
    ELSE
      EXECUTE format('SELECT * FROM %I.pos_payroll_refund_events WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
        INTO refund_record USING NEW.venue_id,(source_line->>'refundEventId')::uuid;
      IF refund_record.id IS NULL OR refund_record.refund_id::text IS DISTINCT FROM source_line->>'refundId'
        OR refund_record.order_id::text IS DISTINCT FROM source_line->>'orderId' THEN
        RAISE EXCEPTION 'payroll refund event identity mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    IF source_line->>'sourceSnapshotLineId' IS NOT NULL THEN
      EXECUTE format('SELECT * FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND id=$2 AND run_id=$3',TG_TABLE_SCHEMA)
        INTO line_record USING NEW.venue_id,(source_line->>'sourceSnapshotLineId')::uuid,NEW.run_id;
      IF line_record.id IS NULL OR line_record.employee_id::text IS DISTINCT FROM source_line->>'employeeId'
        OR line_record.snapshot_id::text IS DISTINCT FROM source_line->>'sourceSnapshotId'
        OR line_record.order_id::text IS DISTINCT FROM source_line->>'orderId'
        OR line_record.order_item_id::text IS DISTINCT FROM source_line->>'orderItemId' THEN
        RAISE EXCEPTION 'payroll refund snapshot identity mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    IF source_line->>'originalSaleLineEventId' IS NOT NULL THEN
      EXECUTE format('SELECT * FROM %I.pos_payroll_sale_line_events WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
        INTO line_record USING NEW.venue_id,(source_line->>'originalSaleLineEventId')::uuid;
      IF line_record.id IS NULL OR line_record.sale_event_id::text IS DISTINCT FROM source_line->>'originalSaleEventId'
        OR line_record.snapshot_id::text IS DISTINCT FROM source_line->>'pricingSnapshotId'
        OR (source_line->>'pricingLineId' IS NOT NULL AND line_record.pricing_line_id::text IS DISTINCT FROM source_line->>'pricingLineId')
        OR line_record.order_id::text IS DISTINCT FROM source_line->>'orderId'
        OR line_record.order_item_id::text IS DISTINCT FROM source_line->>'orderItemId' THEN
        RAISE EXCEPTION 'payroll refund sale identity mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    IF source_line->>'refundLineEventId' IS NOT NULL THEN
      EXECUTE format('SELECT * FROM %I.pos_payroll_refund_line_events WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
        INTO line_record USING NEW.venue_id,(source_line->>'refundLineEventId')::uuid;
      IF line_record.id IS NULL OR line_record.refund_event_id::text IS DISTINCT FROM source_line->>'refundEventId'
        OR line_record.refund_item_id::text IS DISTINCT FROM source_line->>'refundItemId'
        OR line_record.original_sale_line_event_id::text IS DISTINCT FROM source_line->>'originalSaleLineEventId'
        OR line_record.order_item_id::text IS DISTINCT FROM source_line->>'orderItemId' THEN
        RAISE EXCEPTION 'payroll refund line identity mismatch' USING ERRCODE='23514'; END IF;
    ELSIF source_line->>'refundItemId' IS NOT NULL THEN
      EXECUTE format('SELECT * FROM %I.order_refund_items WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
        INTO line_record USING NEW.venue_id,(source_line->>'refundItemId')::uuid;
      IF line_record.id IS NULL OR line_record.refund_id::text IS DISTINCT FROM source_line->>'refundId' THEN
        RAISE EXCEPTION 'payroll refund item identity mismatch' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  IF NEW.coverage='complete' AND impact_total<>NEW.impact_cents THEN
    RAISE EXCEPTION 'payroll refund review impact total mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_refund_review_validate_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE assessment record; terminal boolean;
BEGIN
  EXECUTE format('SELECT id FROM %I.payroll_refund_review_cases WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    USING NEW.venue_id,NEW.case_id;
  EXECUTE format('SELECT * FROM %I.payroll_refund_review_assessments WHERE venue_id=$1 AND case_id=$2 ORDER BY sequence_no DESC LIMIT 1',TG_TABLE_SCHEMA)
    INTO assessment USING NEW.venue_id,NEW.case_id;
  IF assessment.id IS DISTINCT FROM NEW.assessment_id OR assessment.assessment_hash IS DISTINCT FROM NEW.assessment_hash THEN
    RAISE EXCEPTION 'payroll refund review assessment is stale' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_refund_review_decisions WHERE venue_id=$1 AND assessment_id=$2 AND decision<>''hold_for_review'')',TG_TABLE_SCHEMA)
    INTO terminal USING NEW.venue_id,NEW.assessment_id;
  IF terminal THEN RAISE EXCEPTION 'payroll refund review already decided' USING ERRCODE='23514'; END IF;
  IF NEW.decision='acknowledge_no_effect' AND (assessment.coverage<>'complete' OR assessment.impact_cents IS DISTINCT FROM 0::bigint) THEN
    RAISE EXCEPTION 'payroll refund review zero impact is not proven' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_refund_review_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll refund review history is immutable' USING ERRCODE='55000'; END $$;
CREATE OR REPLACE FUNCTION payroll_refund_review_validate_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p jsonb;
BEGIN
  p:=NEW.response_payload::jsonb;
  IF p->>'caseId' IS DISTINCT FROM NEW.case_id::text
    OR p->'latestAssessment'->>'id' IS DISTINCT FROM NEW.assessment_id::text
    OR p->'latestAssessment'->>'assessmentHash' IS DISTINCT FROM NEW.assessment_hash::text
    OR p->>'basis' IS DISTINCT FROM 'saved_calculation_unposted'
    OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
    OR p->'replayed' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'payroll refund review request response context invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_refund_review_assessment_validate ON payroll_refund_review_assessments;
CREATE TRIGGER payroll_refund_review_assessment_validate BEFORE INSERT ON payroll_refund_review_assessments
  FOR EACH ROW EXECUTE FUNCTION payroll_refund_review_validate_assessment();
DROP TRIGGER IF EXISTS payroll_refund_review_decision_validate ON payroll_refund_review_decisions;
CREATE TRIGGER payroll_refund_review_decision_validate BEFORE INSERT ON payroll_refund_review_decisions
  FOR EACH ROW EXECUTE FUNCTION payroll_refund_review_validate_decision();
DROP TRIGGER IF EXISTS payroll_refund_review_request_validate ON payroll_refund_review_requests;
CREATE TRIGGER payroll_refund_review_request_validate BEFORE INSERT ON payroll_refund_review_requests
  FOR EACH ROW EXECUTE FUNCTION payroll_refund_review_validate_request();
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['payroll_refund_review_cases','payroll_refund_review_assessments','payroll_refund_review_decisions','payroll_refund_review_requests'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_refund_review_reject_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_truncate',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION payroll_refund_review_reject_mutation()',table_name||'_truncate',table_name);
  END LOOP;
END $$;
