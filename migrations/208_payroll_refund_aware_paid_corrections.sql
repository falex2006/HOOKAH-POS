-- Whole-period, refund-aware correction evidence and period-v2 branch.
-- Period review plans never authorize correction application automatically;
-- source-backed v2 approval and payment remain behind existing lifecycle guards.

CREATE TABLE IF NOT EXISTS payroll_refund_aware_paid_assessments (
  id uuid PRIMARY KEY,
  venue_id uuid NOT NULL,
  run_id uuid NOT NULL,
  provenance_sha256 char(64) NOT NULL CHECK(provenance_sha256 ~ '^[0-9a-f]{64}$'),
  assessment_hash char(64) NOT NULL CHECK(assessment_hash ~ '^[0-9a-f]{64}$'),
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  payload text NOT NULL CHECK(octet_length(payload)<=41943040 AND jsonb_typeof(payload::jsonb)='object'
    AND encode(sha256(convert_to(payload,'UTF8')),'hex')=assessment_hash),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK(length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(created_at)),
  UNIQUE(venue_id,id), UNIQUE(venue_id,run_id,assessment_hash),
  FOREIGN KEY(venue_id,run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_refund_aware_paid_assessments_history
  ON payroll_refund_aware_paid_assessments(venue_id,run_id,created_at DESC);

ALTER TABLE payroll_correction_claims
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'line_v1',
  ADD COLUMN IF NOT EXISTS cohort_assessment_id uuid;
ALTER TABLE payroll_correction_claims ALTER COLUMN refund_line_event_id DROP NOT NULL;
ALTER TABLE payroll_correction_claims ALTER COLUMN source_snapshot_line_id DROP NOT NULL;
ALTER TABLE payroll_correction_claims ALTER COLUMN assessment_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_claims'::regclass AND conname='payroll_correction_claim_source_kind_ck') THEN
    ALTER TABLE payroll_correction_claims ADD CONSTRAINT payroll_correction_claim_source_kind_ck
      CHECK(source_kind IN ('line_v1','period_v2'));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_claims'::regclass AND conname='payroll_correction_claim_source_xor_ck') THEN
    ALTER TABLE payroll_correction_claims ADD CONSTRAINT payroll_correction_claim_source_xor_ck CHECK(
      (source_kind='line_v1' AND refund_line_event_id IS NOT NULL AND source_snapshot_line_id IS NOT NULL
        AND assessment_id IS NOT NULL AND cohort_assessment_id IS NULL)
      OR (source_kind='period_v2' AND refund_line_event_id IS NULL AND source_snapshot_line_id IS NULL
        AND assessment_id IS NULL AND cohort_assessment_id IS NOT NULL));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_claims'::regclass AND conname='payroll_correction_claim_period_assessment_fk') THEN
    ALTER TABLE payroll_correction_claims ADD CONSTRAINT payroll_correction_claim_period_assessment_fk
      FOREIGN KEY(venue_id,cohort_assessment_id) REFERENCES payroll_refund_aware_paid_assessments(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_correction_claim_period_original_employee_uq
  ON payroll_correction_claims(venue_id,original_entry_id,employee_id) WHERE source_kind='period_v2';
CREATE UNIQUE INDEX IF NOT EXISTS payroll_correction_claim_period_run_employee_uq
  ON payroll_correction_claims(venue_id,original_run_id,employee_id) WHERE source_kind='period_v2';

ALTER TABLE payroll_correction_batches
  ADD COLUMN IF NOT EXISTS cohort_assessment_id uuid;
-- Replace migration 203's non-release assessment-id check with the source XOR.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name FROM pg_constraint
  WHERE conrelid='payroll_correction_batches'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%assessment_id IS NOT NULL%'
    AND pg_get_constraintdef(oid) LIKE '%operation <> ''release''%'
  ORDER BY conname LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE payroll_correction_batches DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_batches'::regclass AND conname='payroll_correction_batch_source_xor_ck') THEN
    ALTER TABLE payroll_correction_batches ADD CONSTRAINT payroll_correction_batch_source_xor_ck CHECK(
      (operation='release' AND assessment_id IS NULL AND cohort_assessment_id IS NULL AND assessment_hash IS NULL AND source_hash IS NULL)
      OR (operation<>'release' AND assessment_id IS NOT NULL AND cohort_assessment_id IS NULL
        AND assessment_hash IS NOT NULL AND source_hash IS NOT NULL)
      OR (operation<>'release' AND assessment_id IS NULL AND cohort_assessment_id IS NOT NULL
        AND assessment_hash IS NOT NULL AND source_hash IS NOT NULL));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_batches'::regclass AND conname='payroll_correction_batch_period_assessment_fk') THEN
    ALTER TABLE payroll_correction_batches ADD CONSTRAINT payroll_correction_batch_period_assessment_fk
      FOREIGN KEY(venue_id,cohort_assessment_id) REFERENCES payroll_refund_aware_paid_assessments(venue_id,id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION payroll_refund_aware_assessment_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; actor record; p jsonb; line_ids jsonb; run_ids jsonb; paid_ids jsonb; actual_paid_ids jsonb; n integer; conflict boolean;
BEGIN
  EXECUTE format('SELECT r.id,r.engine_version,r.currency,r.input_checksum,p.evidence_sha256,p.schema_version,p.capability_version
    FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id
    WHERE r.venue_id=$1 AND r.id=$2 FOR UPDATE OF r',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO r USING NEW.venue_id,NEW.run_id;
  p:=NEW.payload::jsonb;
  IF r.id IS NULL OR r.engine_version<>'payroll-verified-remaining-net-v2' OR r.currency<>'RUB'
    OR r.input_checksum IS DISTINCT FROM NEW.provenance_sha256 OR r.evidence_sha256 IS DISTINCT FROM NEW.provenance_sha256
    OR r.schema_version<>2 OR r.capability_version<>'employee_attributed_remaining_net_refund_v2'
    OR p ? 'assessmentWatermark' OR p->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR p->>'policyCode' IS DISTINCT FROM 'payroll_refund_aware_paid_review_v1'
    OR p->>'status' IS DISTINCT FROM 'paid_review_assessed'
    OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR p->>'runId' IS DISTINCT FROM NEW.run_id::text
    OR p->>'originalProvenanceSha256' IS DISTINCT FROM NEW.provenance_sha256::text
    OR p->>'sourceCohortSha256' IS DISTINCT FROM NEW.source_hash::text
    OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
    OR p->'sourceAttested' IS DISTINCT FROM 'false'::jsonb OR p->'deltaApplicationEligible' IS DISTINCT FROM 'false'::jsonb
    OR p->>'persistence' IS DISTINCT FROM 'none' OR p->>'financialAction' IS DISTINCT FROM 'none'
    OR p->>'positiveEntitlementAction' IS DISTINCT FROM 'none'
    OR jsonb_typeof(p->'employeeDeltas') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p->'dailyDeltas') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'paidReviews') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p->'employeeDeltas')>500 OR jsonb_array_length(p->'paidReviews')>500 THEN
    RAISE EXCEPTION 'payroll_refund_aware_assessment_invalid' USING ERRCODE='23514'; END IF;
  IF encode(sha256(convert_to(NEW.payload,'UTF8')),'hex')<>NEW.assessment_hash THEN
    RAISE EXCEPTION 'payroll_refund_aware_assessment_hash_invalid' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value->>'employeeId' ORDER BY value->>'employeeId'),'[]'::jsonb),count(*)
    INTO line_ids,n FROM jsonb_array_elements(p->'employeeDeltas') value;
  IF n=0 OR n<>jsonb_array_length(p->'employeeDeltas')
    OR n<>(SELECT count(DISTINCT value->>'employeeId') FROM jsonb_array_elements(p->'employeeDeltas') value) THEN
    RAISE EXCEPTION 'payroll_refund_aware_employee_cohort_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(value->>''employeeId'' ORDER BY value->>''employeeId''),''[]''::jsonb) FROM %I.payroll_run_provenance p CROSS JOIN LATERAL jsonb_array_elements(p.evidence_payload::jsonb->''calculatorReplay''->''result''->''employees'') value WHERE p.venue_id=$1 AND p.run_id=$2',TG_TABLE_SCHEMA)
    INTO run_ids USING NEW.venue_id,NEW.run_id;
  IF line_ids IS DISTINCT FROM run_ids THEN
    RAISE EXCEPTION 'payroll_refund_aware_employee_cohort_mismatch' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value->>'employeeId' ORDER BY value->>'employeeId'),'[]'::jsonb),count(*)
    INTO paid_ids,n FROM jsonb_array_elements(p->'paidReviews') value;
  IF n=0 OR n<>(SELECT count(DISTINCT value->>'employeeId') FROM jsonb_array_elements(p->'paidReviews') value) THEN
    RAISE EXCEPTION 'payroll_refund_aware_paid_review_duplicate' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(DISTINCT user_id::text ORDER BY user_id::text),''[]''::jsonb) FROM %I.payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 AND status=''paid''',TG_TABLE_SCHEMA)
    INTO actual_paid_ids USING NEW.venue_id,NEW.run_id;
  IF paid_ids IS DISTINCT FROM actual_paid_ids THEN
    RAISE EXCEPTION 'payroll_refund_aware_paid_entry_cohort_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements($3->''employeeDeltas'') d
    LEFT JOIN LATERAL jsonb_array_elements((SELECT evidence_payload::jsonb->''calculatorReplay''->''result''->''employees'' FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2)) original
      ON original->>''employeeId''=d->>''employeeId''
    WHERE original IS NULL OR (d->''baseline''->''amountCents'') IS DISTINCT FROM (original->''amountCents''))',TG_TABLE_SCHEMA)
    INTO conflict USING NEW.venue_id,NEW.run_id,p;
  IF conflict THEN RAISE EXCEPTION 'payroll_refund_aware_baseline_result_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements($3->''paidReviews'') review
    LEFT JOIN %I.payroll_entries pe ON pe.venue_id=$1 AND pe.id=(review->>''entryId'')::uuid
      AND pe.calculation_run_id=$2 AND pe.user_id=(review->>''employeeId'')::uuid AND pe.status=''paid''
    LEFT JOIN LATERAL (SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0)::numeric AS fixed
      FROM %I.payroll_daily_snapshots s WHERE s.venue_id=$1 AND s.run_id=$2 AND s.employee_id=pe.user_id) fixed ON true
    LEFT JOIN LATERAL jsonb_array_elements($3->''employeeDeltas'') delta
      ON delta->>''employeeId''=review->>''employeeId''
    WHERE pe.id IS NULL
      OR review->>''runId'' IS DISTINCT FROM $2::text
      OR jsonb_typeof(review->''grossCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''netCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''originalProtectedFixedCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''incomingSettledCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''candidateGrossCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''originalNetAfterIncomingCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''candidateAfterIncomingCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''protectedFloorCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''potentialReductionReviewCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''positiveEntitlementInformationCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(review->''signedCounterfactualDeltaCents'') IS DISTINCT FROM ''number''
      OR jsonb_typeof(delta->''current''->''amountCents'') IS DISTINCT FROM ''number''
      OR review->>''incomingSettledTreatment'' IS DISTINCT FROM ''deducted_once_from_baseline_and_candidate''
      OR review->>''fixedPayTreatment'' IS DISTINCT FROM ''original_paid_protected_fixed_amount_is_floor''
      OR review->>''settlementEffect'' IS DISTINCT FROM ''assessment_only_no_claim_or_payment''
      OR COALESCE((review->>''paidProofWatermark'') !~ ''^[0-9a-f]{64}$'',true)
      OR fixed.fixed IS DISTINCT FROM (review->>''originalProtectedFixedCents'')::numeric
      OR pe.calculation_gross_cents::numeric IS DISTINCT FROM (review->>''grossCents'')::numeric
      OR pe.amount*100 IS DISTINCT FROM (review->>''netCents'')::numeric
      OR (review->>''incomingSettledCents'')::numeric IS DISTINCT FROM pe.calculation_gross_cents::numeric-pe.amount*100
      OR (review->>''originalNetAfterIncomingCents'')::numeric IS DISTINCT FROM pe.amount*100
      OR (review->>''candidateAfterIncomingCents'')::numeric IS DISTINCT FROM (review->>''candidateGrossCents'')::numeric-(pe.calculation_gross_cents::numeric-pe.amount*100)
      OR (review->>''protectedFloorCents'')::numeric IS DISTINCT FROM (review->>''originalProtectedFixedCents'')::numeric
      OR (review->>''candidateGrossCents'')::numeric IS DISTINCT FROM (delta->''current''->>''amountCents'')::numeric
      OR (review->>''potentialReductionReviewCents'')::numeric IS DISTINCT FROM GREATEST(0::numeric,pe.amount*100-GREATEST(fixed.fixed,(review->>''candidateGrossCents'')::numeric-(pe.calculation_gross_cents::numeric-pe.amount*100)))
      OR (review->>''positiveEntitlementInformationCents'')::numeric IS DISTINCT FROM GREATEST(0::numeric,(review->>''candidateGrossCents'')::numeric-(pe.calculation_gross_cents::numeric-pe.amount*100)-pe.amount*100)
      OR (review->>''signedCounterfactualDeltaCents'')::numeric IS DISTINCT FROM (review->>''candidateGrossCents'')::numeric-pe.calculation_gross_cents::numeric)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO conflict USING NEW.venue_id,NEW.run_id,p;
  IF conflict THEN RAISE EXCEPTION 'payroll_refund_aware_paid_review_entry_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_correction_claims c JOIN %I.payroll_entries e ON e.venue_id=c.venue_id AND e.id=c.original_entry_id WHERE c.venue_id=$1 AND e.calculation_run_id=$2 AND c.source_kind=''line_v1'')',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO conflict USING NEW.venue_id,NEW.run_id;
  IF conflict THEN RAISE EXCEPTION 'payroll_correction_mixed_run_basis' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.created_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.created_by_name THEN
    RAISE EXCEPTION 'payroll_refund_aware_assessment_owner_required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_refund_aware_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll_refund_aware_correction_history_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS payroll_refund_aware_assessment_validate ON payroll_refund_aware_paid_assessments;
CREATE TRIGGER payroll_refund_aware_assessment_validate BEFORE INSERT ON payroll_refund_aware_paid_assessments
  FOR EACH ROW EXECUTE FUNCTION payroll_refund_aware_assessment_validate();
DROP TRIGGER IF EXISTS payroll_refund_aware_assessment_immutable ON payroll_refund_aware_paid_assessments;
CREATE TRIGGER payroll_refund_aware_assessment_immutable BEFORE UPDATE OR DELETE ON payroll_refund_aware_paid_assessments
  FOR EACH ROW EXECUTE FUNCTION payroll_refund_aware_history_immutable();
DROP TRIGGER IF EXISTS payroll_refund_aware_assessment_truncate ON payroll_refund_aware_paid_assessments;
CREATE TRIGGER payroll_refund_aware_assessment_truncate BEFORE TRUNCATE ON payroll_refund_aware_paid_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_refund_aware_history_immutable();

-- Retain the v1 line validators unchanged. Each writer branch is explicit.
DROP TRIGGER IF EXISTS payroll_correction_validate ON payroll_correction_claims;
CREATE TRIGGER payroll_correction_validate BEFORE INSERT ON payroll_correction_claims
  FOR EACH ROW WHEN (NEW.source_kind='line_v1') EXECUTE FUNCTION payroll_correction_validate_claim();
DROP TRIGGER IF EXISTS payroll_correction_validate ON payroll_correction_batches;
CREATE TRIGGER payroll_correction_validate BEFORE INSERT ON payroll_correction_batches
  FOR EACH ROW WHEN (NEW.cohort_assessment_id IS NULL AND NEW.operation<>'release') EXECUTE FUNCTION payroll_correction_validate_batch();

-- Serialize all claims for the source run so mixed-basis claims cannot race.
CREATE OR REPLACE FUNCTION payroll_correction_basis_exclusivity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_id uuid; conflict boolean;
BEGIN
  EXECUTE format('SELECT calculation_run_id FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO run_id USING NEW.venue_id,NEW.original_entry_id;
  IF run_id IS NULL OR run_id IS DISTINCT FROM NEW.original_run_id THEN
    RAISE EXCEPTION 'payroll_correction_original_run_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    USING NEW.venue_id,run_id;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_correction_claims c JOIN %I.payroll_entries e ON e.venue_id=c.venue_id AND e.id=c.original_entry_id WHERE c.venue_id=$1 AND e.calculation_run_id=$2 AND c.source_kind<>$3)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO conflict USING NEW.venue_id,run_id,NEW.source_kind;
  IF conflict THEN RAISE EXCEPTION 'payroll_correction_mixed_run_basis' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_correction_00_basis_lock ON payroll_correction_claims;
CREATE TRIGGER payroll_correction_00_basis_lock BEFORE INSERT ON payroll_correction_claims
  FOR EACH ROW EXECUTE FUNCTION payroll_correction_basis_exclusivity_guard();

CREATE OR REPLACE FUNCTION payroll_refund_aware_period_validate_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record; run_row record; assessment record; expense record; review jsonb; owner_row record; matches integer; initial numeric;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO original USING NEW.venue_id,NEW.original_entry_id;
  IF NEW.source_kind IS DISTINCT FROM 'period_v2' OR original.id IS NULL OR original.status<>'paid'
    OR original.calculation_run_id IS DISTINCT FROM NEW.original_run_id OR original.user_id IS DISTINCT FROM NEW.employee_id
    OR original.calculation_provenance_sha256 IS DISTINCT FROM NEW.original_provenance_sha256
    OR original.paid_at IS NULL OR original.paid_by IS NULL OR original.payment_date IS NULL THEN
    RAISE EXCEPTION 'payroll_refund_aware_claim_paid_basis_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT r.*,p.schema_version,p.capability_version,p.evidence_sha256 FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2 FOR UPDATE OF r',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO run_row USING NEW.venue_id,NEW.original_run_id;
  IF run_row.id IS NULL OR run_row.engine_version<>'payroll-verified-remaining-net-v2'
    OR run_row.schema_version<>2 OR run_row.capability_version<>'employee_attributed_remaining_net_refund_v2'
    OR run_row.evidence_sha256 IS DISTINCT FROM NEW.original_provenance_sha256 THEN
    RAISE EXCEPTION 'payroll_refund_aware_claim_run_invalid' USING ERRCODE='23514'; END IF;
  IF original.expense_id IS NOT NULL THEN
    EXECUTE format('SELECT * FROM %I.expenses x WHERE x.venue_id=$1 AND x.id=$2 AND x.source=''payroll'' AND x.amount=$3 FOR SHARE',TG_TABLE_SCHEMA)
      INTO expense USING NEW.venue_id,original.expense_id,original.amount;
    IF expense.id IS NULL THEN RAISE EXCEPTION 'payroll_refund_aware_claim_expense_invalid' USING ERRCODE='23514'; END IF;
    IF NEW.original_expense_id IS DISTINCT FROM original.expense_id OR NEW.original_settlement_transition_id IS NOT NULL THEN
      RAISE EXCEPTION 'payroll_refund_aware_claim_settlement_invalid' USING ERRCODE='23514'; END IF;
  ELSE
    IF NEW.original_expense_id IS NOT NULL OR NEW.original_settlement_transition_id IS NULL THEN
      RAISE EXCEPTION 'payroll_refund_aware_claim_settlement_invalid' USING ERRCODE='23514'; END IF;
    PERFORM payroll_correction_require_zero_settlement(TG_TABLE_SCHEMA,NEW.venue_id,NEW.original_entry_id,NEW.original_settlement_transition_id);
  END IF;
  EXECUTE format('SELECT * FROM %I.payroll_refund_aware_paid_assessments WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO assessment USING NEW.venue_id,NEW.cohort_assessment_id;
  IF assessment.id IS NULL OR assessment.run_id<>NEW.original_run_id
    OR assessment.provenance_sha256<>NEW.original_provenance_sha256 OR assessment.assessment_hash<>NEW.assessment_hash
    OR assessment.source_hash<>NEW.source_hash THEN
    RAISE EXCEPTION 'payroll_refund_aware_claim_assessment_mismatch' USING ERRCODE='23514'; END IF;
  SELECT count(*),(jsonb_agg(value)->0),max((value->>'potentialReductionReviewCents')::numeric)
    INTO matches,review,initial
    FROM jsonb_array_elements(assessment.payload::jsonb->'paidReviews') value
    WHERE value->>'entryId'=NEW.original_entry_id::text AND value->>'employeeId'=NEW.employee_id::text
      AND value->>'runId'=NEW.original_run_id::text;
  IF matches<>1 OR initial IS DISTINCT FROM NEW.assessed_cents::numeric OR initial<=0
    OR review->>'paidProofWatermark' IS NULL THEN
    RAISE EXCEPTION 'payroll_refund_aware_claim_first_assessment_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO owner_row USING NEW.venue_id,NEW.created_by;
  IF owner_row.id IS NULL OR owner_row.full_name IS DISTINCT FROM NEW.created_by_name THEN
    RAISE EXCEPTION 'payroll_refund_aware_claim_owner_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_refund_aware_period_claim_guard ON payroll_correction_claims;
CREATE TRIGGER payroll_refund_aware_period_claim_guard BEFORE INSERT ON payroll_correction_claims
  FOR EACH ROW WHEN (NEW.source_kind='period_v2') EXECUTE FUNCTION payroll_refund_aware_period_validate_claim();

CREATE OR REPLACE FUNCTION payroll_refund_aware_period_validate_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim record; original record; target record; assessment record; run_row record; owner_row record; p jsonb; review jsonb;
  matches integer; n integer; potential numeric; fixed numeric; gross numeric; used numeric; disposed numeric; target_used numeric;
  expected numeric; allocation jsonb;
BEGIN
  IF NEW.operation NOT IN ('apply','waive') OR NEW.cohort_assessment_id IS NULL OR NEW.assessment_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_source_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO owner_row USING NEW.venue_id,NEW.created_by;
  IF owner_row.id IS NULL OR owner_row.full_name IS DISTINCT FROM NEW.created_by_name THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_owner_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT c.* FROM %I.payroll_correction_claims c WHERE c.venue_id=$1 AND c.original_entry_id=$2 AND c.employee_id=$3 AND c.source_kind=''period_v2'' FOR UPDATE',TG_TABLE_SCHEMA)
    INTO claim USING NEW.venue_id,NEW.original_entry_id,NEW.employee_id;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO original USING NEW.venue_id,NEW.original_entry_id;
  EXECUTE format('SELECT id FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO run_row USING NEW.venue_id,claim.original_run_id;
  EXECUTE format('SELECT * FROM %I.payroll_refund_aware_paid_assessments WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO assessment USING NEW.venue_id,NEW.cohort_assessment_id;
  IF claim.id IS NULL OR run_row.id IS NULL OR original.id IS NULL OR original.status<>'paid' OR original.calculation_run_id<>claim.original_run_id
    OR original.user_id<>NEW.employee_id OR assessment.id IS NULL OR assessment.run_id<>claim.original_run_id
    OR assessment.assessment_hash<>NEW.assessment_hash OR assessment.source_hash<>NEW.source_hash
    OR assessment.provenance_sha256<>claim.original_provenance_sha256
    OR NEW.original_entry_id<>claim.original_entry_id THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_basis_invalid' USING ERRCODE='23514'; END IF;
  p:=NEW.plan_payload::jsonb;
  IF p->'schemaVersion' IS DISTINCT FROM '3'::jsonb OR p->>'policyCode' IS DISTINCT FROM 'reviewed_period_variable_pay_only_v1'
    OR p->>'basisKind' IS DISTINCT FROM 'period_variable' OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text
    OR p->>'employeeId' IS DISTINCT FROM NEW.employee_id::text OR p->>'currency' IS DISTINCT FROM NEW.currency
    OR p->>'originalEntryId' IS DISTINCT FROM claim.original_entry_id::text OR p->>'originalRunId' IS DISTINCT FROM claim.original_run_id::text
    OR p->>'originalProvenanceSha256' IS DISTINCT FROM claim.original_provenance_sha256::text
    OR p->'originalPaidCents' IS DISTINCT FROM to_jsonb((original.amount*100)::bigint)
    OR p->'originalExpenseId' IS DISTINCT FROM COALESCE(to_jsonb(original.expense_id),'null'::jsonb)
    OR p->>'assessmentHash' IS DISTINCT FROM assessment.assessment_hash::text OR p->>'sourceHash' IS DISTINCT FROM assessment.source_hash::text
    OR p->>'ledgerHash' IS DISTINCT FROM NEW.ledger_hash::text OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb
    OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb OR p->'sourceAttested' IS DISTINCT FROM 'false'::jsonb
    OR p->'deltaApplicationEligible' IS DISTINCT FROM 'false'::jsonb OR p->>'financialAction' IS DISTINCT FROM 'none'
    OR p->>'persistence' IS DISTINCT FROM 'none' OR p->>'positiveEntitlementAction' IS DISTINCT FROM 'none' OR p ? 'planHash'
    OR jsonb_typeof(p->'allocations') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_plan_invalid' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(p->'allocations')<>1 THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_allocation_invalid' USING ERRCODE='23514'; END IF;
  IF NEW.event_count<>1 OR NEW.total_cents<1 THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_event_count_invalid' USING ERRCODE='23514'; END IF;
  SELECT count(*),(jsonb_agg(value)->0),max((value->>'potentialReductionReviewCents')::numeric) INTO matches,review,potential
    FROM jsonb_array_elements(assessment.payload::jsonb->'paidReviews') value
    WHERE value->>'entryId'=claim.original_entry_id::text AND value->>'employeeId'=claim.employee_id::text;
  IF matches<>1 OR p->>'currentPotentialCents' IS DISTINCT FROM potential::text
    OR p->>'firstAssessedCents' IS DISTINCT FROM claim.assessed_cents::text THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_potential_invalid' USING ERRCODE='23514'; END IF;
  SELECT count(*),(jsonb_agg(value)->0) INTO matches,allocation FROM jsonb_array_elements(p->'allocations') value
    WHERE value->>'basisKind'='period_variable'
      AND (value->'claimId' IS NOT DISTINCT FROM to_jsonb(claim.id) OR value->'claimId'='null'::jsonb)
      AND value->>'firstAssessedCents'=claim.assessed_cents::text
      AND value->>'assessedCents'=potential::text;
  IF matches<>1 THEN RAISE EXCEPTION 'payroll_refund_aware_batch_allocation_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''release'' THEN -amount_cents ELSE amount_cents END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND claim_id=$2',TG_TABLE_SCHEMA)
    INTO used USING NEW.venue_id,claim.id;
  disposed:=used;
  IF (allocation->>'alreadyDisposedCents')::numeric IS DISTINCT FROM disposed
    OR p->>'alreadyDisposedCents' IS DISTINCT FROM disposed::text THEN
    RAISE EXCEPTION 'payroll_refund_aware_batch_ledger_stale' USING ERRCODE='23514'; END IF;
  IF NEW.operation='waive' THEN
    expected:=GREATEST(0,potential-disposed);
    IF expected<=0 OR NEW.target_entry_id IS NOT NULL OR NEW.target_sequence_no IS NOT NULL OR NEW.total_cents<>expected
      OR p->>'operation' IS DISTINCT FROM 'waive'
      OR allocation->'waiveCents' IS DISTINCT FROM to_jsonb(expected::bigint)
      OR p->'waiveCents' IS DISTINCT FROM to_jsonb(expected::bigint) THEN
      RAISE EXCEPTION 'payroll_refund_aware_waiver_invalid' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO target USING NEW.venue_id,NEW.target_entry_id;
  IF target.id IS NULL OR target.user_id<>NEW.employee_id OR target.calculation_run_id IS NULL
    OR target.period_from<=original.period_to OR target.calculation_run_id=original.calculation_run_id OR target.status<>'draft' THEN
    RAISE EXCEPTION 'payroll_refund_aware_target_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0),COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed,gross USING NEW.venue_id,target.calculation_run_id,NEW.employee_id;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO target_used USING NEW.venue_id,target.id;
  EXECUTE format('SELECT COALESCE(max(target_sequence_no),0) FROM %I.payroll_correction_batches WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO n USING NEW.venue_id,target.id;
  expected:=LEAST(GREATEST(0,potential-disposed),GREATEST(0,gross-target_used-fixed));
  IF expected<=0 OR p->>'operation' IS DISTINCT FROM 'apply' OR NEW.target_sequence_no<>n+1 OR gross<>target.calculation_gross_cents OR fixed<>NEW.protected_fixed_cents
    OR NEW.target_before_cents<>gross-target_used OR NEW.total_cents<>expected
    OR NEW.target_after_cents<>gross-target_used-expected OR NEW.target_after_cents<fixed
    OR p->'applyCents' IS DISTINCT FROM to_jsonb(expected::bigint)
    OR p->>'targetEntryId' IS DISTINCT FROM target.id::text OR p->>'targetRunId' IS DISTINCT FROM target.calculation_run_id::text
    OR p->>'targetProvenanceSha256' IS DISTINCT FROM target.calculation_provenance_sha256::text
    OR p->'targetBeforeCents' IS DISTINCT FROM to_jsonb(NEW.target_before_cents)
    OR p->'targetAfterCents' IS DISTINCT FROM to_jsonb(NEW.target_after_cents)
    OR p->'protectedFixedCents' IS DISTINCT FROM to_jsonb(NEW.protected_fixed_cents)
    OR allocation->'applyCents' IS DISTINCT FROM to_jsonb(expected::bigint)
    OR p->'availableReviewCents' IS DISTINCT FROM to_jsonb(GREATEST(0,potential-disposed)::bigint)
    OR p->'residualReviewCents' IS DISTINCT FROM to_jsonb(GREATEST(0,potential-disposed-expected)::bigint) THEN
    RAISE EXCEPTION 'payroll_refund_aware_target_capacity_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_refund_aware_period_batch_guard ON payroll_correction_batches;
CREATE TRIGGER payroll_refund_aware_period_batch_guard BEFORE INSERT ON payroll_correction_batches
  FOR EACH ROW WHEN (NEW.cohort_assessment_id IS NOT NULL) EXECUTE FUNCTION payroll_refund_aware_period_validate_batch();

CREATE OR REPLACE FUNCTION payroll_refund_aware_release_batch_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor record; target record; p jsonb; row_json jsonb; parent record; claim record; parent_batch record;
  amount numeric; total numeric:=0; n integer:=0; actual_count integer; actual_total numeric; matches integer;
  fixed numeric; gross numeric; net numeric; used numeric; previous_seq integer; context_count integer; conflict boolean;
BEGIN
  IF NEW.operation<>'release' OR NEW.assessment_id IS NOT NULL OR NEW.cohort_assessment_id IS NOT NULL
    OR NEW.original_entry_id IS NOT NULL OR NEW.target_entry_id IS NULL THEN
    RAISE EXCEPTION 'payroll_correction_release_batch_context_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.created_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.created_by_name THEN
    RAISE EXCEPTION 'payroll_correction_release_owner_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO target USING NEW.venue_id,NEW.target_entry_id;
  IF target.id IS NULL OR target.status NOT IN ('draft','approved','cancelled') OR target.user_id<>NEW.employee_id
    OR NEW.target_after_cents IS DISTINCT FROM NEW.target_before_cents THEN
    RAISE EXCEPTION 'payroll_correction_release_target_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0),COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed,gross USING NEW.venue_id,target.calculation_run_id,NEW.employee_id;
  IF gross<>target.calculation_gross_cents OR fixed<>NEW.protected_fixed_cents
    OR NEW.target_before_cents::numeric IS DISTINCT FROM target.amount*100 THEN
    RAISE EXCEPTION 'payroll_correction_release_target_basis_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(max(target_sequence_no),0) FROM %I.payroll_correction_batches WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO previous_seq USING NEW.venue_id,target.id;
  IF NEW.target_sequence_no<>previous_seq+1 THEN RAISE EXCEPTION 'payroll_correction_target_sequence_conflict' USING ERRCODE='23514'; END IF;
  p:=NEW.plan_payload::jsonb;
  IF p->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR p->>'operation' IS DISTINCT FROM 'release'
    OR p->>'policyVersion' IS DISTINCT FROM 'owner-reviewed-variable-correction-v1'
    OR p->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR p->>'employeeId' IS DISTINCT FROM NEW.employee_id::text
    OR p->>'targetEntryId' IS DISTINCT FROM target.id::text OR p->>'targetRunId' IS DISTINCT FROM target.calculation_run_id::text
    OR p->>'targetProvenanceSha256' IS DISTINCT FROM target.calculation_provenance_sha256::text
    OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
    OR p->>'persistence' IS DISTINCT FROM 'none' OR jsonb_typeof(p->'releases') IS DISTINCT FROM 'array'
    OR p->'releaseCents' IS DISTINCT FROM to_jsonb(NEW.total_cents)
    OR p->'targetBeforeCents' IS DISTINCT FROM to_jsonb(NEW.target_before_cents)
    OR p->'cancelledHistoricalCents' IS DISTINCT FROM to_jsonb(NEW.target_after_cents)
    OR p->'protectedFixedCents' IS DISTINCT FROM to_jsonb(NEW.protected_fixed_cents)
    OR NEW.plan_hash IS NULL OR encode(sha256(convert_to(NEW.plan_payload,'UTF8')),'hex')<>NEW.plan_hash THEN
    RAISE EXCEPTION 'payroll_correction_release_plan_invalid' USING ERRCODE='23514'; END IF;
  FOR row_json IN SELECT value FROM jsonb_array_elements(p->'releases') LOOP
    SELECT count(*) INTO matches FROM jsonb_array_elements(p->'releases') value
      WHERE value->>'reversesEventId' IS NOT DISTINCT FROM row_json->>'reversesEventId';
    IF matches<>1 THEN RAISE EXCEPTION 'payroll_correction_release_parent_invalid' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.payroll_correction_events WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO parent USING NEW.venue_id,(row_json->>'reversesEventId')::uuid;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_correction_events x WHERE x.venue_id=$1 AND x.reverses_event_id=$2)',TG_TABLE_SCHEMA)
      INTO conflict USING NEW.venue_id,parent.id;
    IF parent.id IS NULL OR parent.kind<>'apply' OR parent.target_entry_id<>target.id OR conflict THEN
      RAISE EXCEPTION 'payroll_correction_release_parent_invalid' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT * FROM %I.payroll_correction_claims WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO claim USING NEW.venue_id,parent.claim_id;
    EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO parent_batch USING NEW.venue_id,parent.batch_id;
    IF claim.id IS NULL OR claim.employee_id<>NEW.employee_id OR parent_batch.employee_id<>NEW.employee_id
      OR parent_batch.operation<>'apply' OR parent_batch.target_entry_id<>target.id
      OR row_json->>'originalEntryId' IS DISTINCT FROM claim.original_entry_id::text
      OR row_json->'amountCents' IS DISTINCT FROM to_jsonb(parent.amount_cents) THEN
      RAISE EXCEPTION 'payroll_correction_release_source_invalid' USING ERRCODE='23514'; END IF;
    IF claim.source_kind='period_v2' THEN
      IF row_json->>'sourceKind' IS DISTINCT FROM 'period_v2' OR row_json->>'cohortClaimId' IS DISTINCT FROM claim.id::text
        OR row_json->>'cohortAssessmentId' IS DISTINCT FROM parent_batch.cohort_assessment_id::text
        OR parent_batch.cohort_assessment_id IS NULL OR row_json->'refundLineEventId' IS DISTINCT FROM 'null'::jsonb THEN
        RAISE EXCEPTION 'payroll_refund_aware_release_source_invalid' USING ERRCODE='23514'; END IF;
    ELSE
      IF row_json ? 'sourceKind' OR row_json->>'refundLineEventId' IS DISTINCT FROM claim.refund_line_event_id::text
        OR parent_batch.assessment_id IS NULL THEN
        RAISE EXCEPTION 'payroll_correction_release_legacy_source_invalid' USING ERRCODE='23514'; END IF;
    END IF;
    total:=total+parent.amount_cents; n:=n+1;
  END LOOP;
  EXECUTE format('SELECT count(*),COALESCE(sum(a.amount_cents),0) FROM %I.payroll_correction_events a WHERE a.venue_id=$1 AND a.target_entry_id=$2 AND a.kind=''apply'' AND NOT EXISTS(SELECT 1 FROM %I.payroll_correction_events r WHERE r.venue_id=a.venue_id AND r.reverses_event_id=a.id)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
    INTO actual_count,actual_total USING NEW.venue_id,target.id;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',TG_TABLE_SCHEMA)
    INTO used USING NEW.venue_id,target.id;
  IF n<>NEW.event_count OR total<>NEW.total_cents OR n<>actual_count OR total<>actual_total
    OR gross-used IS DISTINCT FROM NEW.target_before_cents::numeric OR p->>'ledgerHash' IS DISTINCT FROM NEW.ledger_hash::text THEN
    RAISE EXCEPTION 'payroll_correction_release_coverage_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_refund_aware_release_batch_guard ON payroll_correction_batches;
CREATE TRIGGER payroll_refund_aware_release_batch_guard BEFORE INSERT ON payroll_correction_batches
  FOR EACH ROW WHEN (NEW.operation='release') EXECUTE FUNCTION payroll_refund_aware_release_batch_validate();

CREATE OR REPLACE FUNCTION payroll_correction_validate_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch record; p jsonb;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO batch USING NEW.venue_id,NEW.batch_id;
  p:=NEW.response_payload::jsonb;
  IF batch.id IS NULL OR batch.created_by<>NEW.created_by THEN
    RAISE EXCEPTION 'payroll_correction_response_context_invalid' USING ERRCODE='23514'; END IF;
  IF batch.cohort_assessment_id IS NOT NULL THEN
    IF p->'schemaVersion' IS DISTINCT FROM '3'::jsonb
      OR p->>'policyCode' IS DISTINCT FROM 'reviewed_period_variable_pay_only_v1'
      OR (SELECT count(*) FROM jsonb_object_keys(p))<>12
      OR p->>'batchId' IS DISTINCT FROM NEW.batch_id::text
      OR p->>'operation' IS DISTINCT FROM batch.operation
      OR p->>'planHash' IS DISTINCT FROM batch.plan_hash::text
      OR p->>'totalCents' IS DISTINCT FROM batch.total_cents::text
      OR p->'targetEntryId' IS DISTINCT FROM COALESCE(to_jsonb(batch.target_entry_id),'null'::jsonb)
      OR p->'targetAfterCents' IS DISTINCT FROM COALESCE(to_jsonb(batch.target_after_cents),'null'::jsonb)
      OR p->'residualReviewCents' IS DISTINCT FROM COALESCE(to_jsonb((batch.plan_payload::jsonb->>'residualReviewCents')::bigint),'0'::jsonb)
      OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb
      OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
      OR p->'replayed' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'payroll_refund_aware_response_invalid' USING ERRCODE='23514'; END IF;
  ELSE
    IF p->>'batchId' IS DISTINCT FROM NEW.batch_id::text
      OR p->>'operation' IS DISTINCT FROM batch.operation
      OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb
      OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb
      OR p->'replayed' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'payroll_correction_response_context_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION payroll_refund_aware_period_validate_event(schema_name text,event_row payroll_correction_events)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE claim record; batch record; parent record; parent_batch record; assessment record;
  p jsonb; line jsonb; review jsonb; match_count integer; potential numeric; used numeric; disposed numeric;
  seq integer; previous_global bigint; highwater numeric; conflict boolean;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_correction_claims WHERE venue_id=$1 AND id=$2 FOR UPDATE',schema_name)
    INTO claim USING event_row.venue_id,event_row.claim_id;
  EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',schema_name)
    INTO batch USING event_row.venue_id,event_row.batch_id;
  IF claim.id IS NULL OR claim.source_kind<>'period_v2' OR batch.id IS NULL
    OR claim.employee_id<>event_row.employee_id OR batch.employee_id<>event_row.employee_id
    OR batch.operation<>event_row.kind OR batch.target_entry_id IS DISTINCT FROM event_row.target_entry_id
    OR (event_row.kind<>'release' AND (batch.original_entry_id IS DISTINCT FROM claim.original_entry_id
      OR batch.cohort_assessment_id IS NULL OR batch.assessment_id IS NOT NULL))
    OR (event_row.kind='release' AND batch.cohort_assessment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'payroll_refund_aware_event_context_invalid' USING ERRCODE='23514'; END IF;
  IF event_row.kind<>'release' THEN
    EXECUTE format('SELECT * FROM %I.payroll_refund_aware_paid_assessments WHERE venue_id=$1 AND id=$2',schema_name)
      INTO assessment USING event_row.venue_id,batch.cohort_assessment_id;
    IF assessment.id IS NULL OR assessment.run_id<>claim.original_run_id
      OR assessment.assessment_hash<>batch.assessment_hash OR assessment.source_hash<>batch.source_hash
      OR assessment.provenance_sha256<>claim.original_provenance_sha256 THEN
      RAISE EXCEPTION 'payroll_refund_aware_event_assessment_invalid' USING ERRCODE='23514'; END IF;
    p:=batch.plan_payload::jsonb;
    SELECT count(*),(jsonb_agg(value)->0),max((value->>'potentialReductionReviewCents')::numeric)
      INTO match_count,review,potential
      FROM jsonb_array_elements(assessment.payload::jsonb->'paidReviews') value
      WHERE value->>'entryId'=claim.original_entry_id::text AND value->>'employeeId'=claim.employee_id::text;
    IF match_count<>1 THEN RAISE EXCEPTION 'payroll_refund_aware_event_review_missing' USING ERRCODE='23514'; END IF;
    SELECT count(*),(jsonb_agg(value)->0) INTO match_count,line
      FROM jsonb_array_elements(p->'allocations') value
      WHERE value->>'basisKind'='period_variable'
        AND (value->'claimId' IS NOT DISTINCT FROM to_jsonb(claim.id) OR value->'claimId'='null'::jsonb)
        AND value->>'assessedCents'=potential::text AND value->>'firstAssessedCents'=claim.assessed_cents::text
        AND value->>(CASE event_row.kind WHEN 'apply' THEN 'applyCents' ELSE 'waiveCents' END)=event_row.amount_cents::text;
  ELSE
    EXECUTE format('SELECT * FROM %I.payroll_correction_events WHERE venue_id=$1 AND id=$2',schema_name)
      INTO parent USING event_row.venue_id,event_row.reverses_event_id;
    IF parent.id IS NOT NULL THEN
      EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',schema_name)
        INTO parent_batch USING parent.venue_id,parent.batch_id;
    END IF;
    p:=batch.plan_payload::jsonb;
    SELECT count(*),(jsonb_agg(value)->0) INTO match_count,line
      FROM jsonb_array_elements(p->'releases') value
      WHERE value->>'reversesEventId'=event_row.reverses_event_id::text
        AND value->>'originalEntryId'=claim.original_entry_id::text
        AND value->>'sourceKind' IS NOT DISTINCT FROM 'period_v2' AND value->>'cohortClaimId'=claim.id::text
        AND value->>'cohortAssessmentId'=parent_batch.cohort_assessment_id::text
        AND value->'amountCents'=to_jsonb(event_row.amount_cents);
    IF parent.id IS NULL OR parent.kind<>'apply' OR parent.claim_id<>claim.id OR parent.employee_id<>event_row.employee_id
      OR parent.target_entry_id<>event_row.target_entry_id OR parent.amount_cents<>event_row.amount_cents
      OR parent.sequence_no>=event_row.sequence_no OR parent_batch.cohort_assessment_id IS NULL THEN
      RAISE EXCEPTION 'payroll_refund_aware_release_parent_invalid' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_correction_events r WHERE r.venue_id=$1 AND r.reverses_event_id=$2)',schema_name)
      INTO conflict USING event_row.venue_id,parent.id;
    IF conflict THEN RAISE EXCEPTION 'payroll_refund_aware_release_parent_invalid' USING ERRCODE='23514'; END IF;
  END IF;
  IF match_count<>1 THEN
    RAISE EXCEPTION 'payroll_refund_aware_event_plan_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(max(claim_sequence_no),0),COALESCE(max(sequence_no),0),COALESCE(sum(CASE WHEN kind=''release'' THEN -amount_cents ELSE amount_cents END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND claim_id=$2',schema_name)
    INTO seq,previous_global,used USING event_row.venue_id,claim.id;
  IF event_row.claim_sequence_no<>seq+1 OR event_row.sequence_no<=previous_global THEN
    RAISE EXCEPTION 'payroll_refund_aware_event_sequence_invalid' USING ERRCODE='23514'; END IF;
  IF event_row.kind<>'release' THEN
    disposed:=(line->>'alreadyDisposedCents')::numeric;
    IF disposed IS DISTINCT FROM used OR used+event_row.amount_cents>potential THEN
      RAISE EXCEPTION 'payroll_refund_aware_current_potential_exceeded' USING ERRCODE='23514'; END IF;
  END IF;
  IF event_row.kind='release' THEN used:=used-event_row.amount_cents;
  ELSE used:=used+event_row.amount_cents; END IF;
  IF used<0 THEN RAISE EXCEPTION 'payroll_refund_aware_disposition_negative' USING ERRCODE='23514'; END IF;
  -- Historical high-water is recorded for audit only. The current assessment
  -- is the only apply/waive cap; releases are tied solely to their parent.
  IF event_row.kind<>'release' THEN
    EXECUTE format('SELECT COALESCE(max((x->>''potentialReductionReviewCents'')::numeric),0) FROM %I.payroll_refund_aware_paid_assessments a CROSS JOIN LATERAL jsonb_array_elements(a.payload::jsonb->''paidReviews'') x WHERE a.venue_id=$1 AND a.run_id=$2 AND x->>''entryId''=$3 AND x->>''employeeId''=$4',schema_name)
      INTO highwater USING event_row.venue_id,claim.original_run_id,claim.original_entry_id::text,claim.employee_id::text;
    IF line->>'highWaterAssessedCents' IS DISTINCT FROM highwater::text
      OR line->>'alreadyDisposedCents' IS DISTINCT FROM (used-event_row.amount_cents)::text THEN
      RAISE EXCEPTION 'payroll_refund_aware_audit_highwater_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION payroll_correction_validate_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim record; batch record; parent record; assessment record; seq integer; previous_global bigint; used numeric;
  matching integer; assessed numeric; planned numeric; planned_disposed numeric;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_correction_claims WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO claim USING NEW.venue_id,NEW.claim_id;
  IF claim.id IS NULL THEN RAISE EXCEPTION 'payroll_correction_event_context_invalid' USING ERRCODE='23514'; END IF;
  IF claim.source_kind='period_v2' THEN
    PERFORM payroll_refund_aware_period_validate_event(TG_TABLE_SCHEMA,NEW);
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO batch USING NEW.venue_id,NEW.batch_id;
  IF batch.id IS NULL OR claim.employee_id<>NEW.employee_id OR batch.employee_id<>NEW.employee_id
    OR batch.operation<>NEW.kind OR batch.target_entry_id IS DISTINCT FROM NEW.target_entry_id
    OR (NEW.kind<>'release' AND batch.original_entry_id IS DISTINCT FROM claim.original_entry_id) THEN
    RAISE EXCEPTION 'payroll_correction_event_context_invalid' USING ERRCODE='23514'; END IF;
  IF NEW.kind<>'release' THEN
    EXECUTE format('SELECT payload FROM %I.payroll_refund_review_assessments WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO assessment USING NEW.venue_id,batch.assessment_id;
    SELECT count(*),max(-(line->>'salaryImpactCents')::numeric) INTO matching,assessed
      FROM jsonb_array_elements(assessment.payload::jsonb->'lines') line
      WHERE line->>'refundLineEventId'=claim.refund_line_event_id::text AND line->>'employeeId'=NEW.employee_id::text
        AND line->>'sourceSnapshotLineId'=claim.source_snapshot_line_id::text AND line->'reasons'='[]'::jsonb;
    IF matching<>1 OR assessed IS DISTINCT FROM claim.assessed_cents::numeric THEN
      RAISE EXCEPTION 'payroll_correction_claim_assessment_changed' USING ERRCODE='23514'; END IF;
    SELECT count(*),max((line->>(CASE NEW.kind WHEN 'apply' THEN 'applyCents' ELSE 'waiveCents' END))::numeric),max((line->>'alreadyDisposedCents')::numeric) INTO matching,planned,planned_disposed
      FROM jsonb_array_elements(batch.plan_payload::jsonb->'allocations') line
      WHERE line->>'refundLineEventId'=claim.refund_line_event_id::text AND line->>'sourceSnapshotLineId'=claim.source_snapshot_line_id::text
        AND line->'assessedCents'=to_jsonb(claim.assessed_cents);
  ELSE
    SELECT count(*),max((line->>'amountCents')::numeric) INTO matching,planned
      FROM jsonb_array_elements(batch.plan_payload::jsonb->'releases') line
      WHERE line->>'reversesEventId'=NEW.reverses_event_id::text AND line->>'originalEntryId'=claim.original_entry_id::text
        AND line->>'refundLineEventId'=claim.refund_line_event_id::text;
  END IF;
  IF matching<>1 OR planned IS DISTINCT FROM NEW.amount_cents::numeric THEN
    RAISE EXCEPTION 'payroll_correction_event_plan_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(max(claim_sequence_no),0),COALESCE(max(sequence_no),0),COALESCE(sum(CASE WHEN kind=''release'' THEN -amount_cents ELSE amount_cents END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND claim_id=$2',TG_TABLE_SCHEMA)
    INTO seq,previous_global,used USING NEW.venue_id,NEW.claim_id;
  IF NEW.claim_sequence_no<>seq+1 OR NEW.sequence_no<=previous_global THEN
    RAISE EXCEPTION 'payroll_correction_claim_sequence_conflict' USING ERRCODE='23514'; END IF;
  IF NEW.kind<>'release' AND planned_disposed IS DISTINCT FROM used THEN
    RAISE EXCEPTION 'payroll_correction_plan_ledger_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW.kind='release' THEN
    EXECUTE format('SELECT * FROM %I.payroll_correction_events WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
      INTO parent USING NEW.venue_id,NEW.reverses_event_id;
    IF parent.id IS NULL OR parent.kind<>'apply' OR parent.claim_id<>NEW.claim_id OR parent.employee_id<>NEW.employee_id
      OR parent.target_entry_id<>NEW.target_entry_id OR parent.amount_cents<>NEW.amount_cents OR parent.sequence_no>=NEW.sequence_no THEN
      RAISE EXCEPTION 'payroll_correction_release_invalid' USING ERRCODE='23514'; END IF;
    used:=used-NEW.amount_cents;
  ELSE used:=used+NEW.amount_cents;
  END IF;
  IF used<0 OR used>claim.assessed_cents THEN RAISE EXCEPTION 'payroll_correction_source_overallocated' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payroll_correction_validate ON payroll_correction_events;
CREATE TRIGGER payroll_correction_validate BEFORE INSERT ON payroll_correction_events
  FOR EACH ROW EXECUTE FUNCTION payroll_correction_validate_event();

-- Existing deferred amount/release guards remain active; v2 money transitions
-- are narrowly enabled below for the exact verified refund-aware capability.

-- Narrow v2 approval and pay to source-backed v2 runs; 205 still checks lifecycle proof.
CREATE OR REPLACE FUNCTION payroll_block_v2_money_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE engine_v2 boolean; supported_v2 boolean;
BEGIN
  IF NEW.action IN ('approve','pay') THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 AND engine_version=''payroll-verified-remaining-net-v2'')',TG_TABLE_SCHEMA)
      INTO engine_v2 USING NEW.venue_id,NEW.calculation_run_id;
    IF engine_v2 THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_runs r JOIN %I.payroll_run_provenance p ON p.venue_id=r.venue_id AND p.run_id=r.id WHERE r.venue_id=$1 AND r.id=$2 AND r.status=''ready'' AND r.currency=''RUB'' AND r.engine_version=''payroll-verified-remaining-net-v2'' AND p.schema_version=2 AND p.capability_version=''employee_attributed_remaining_net_refund_v2'' AND p.evidence_sha256=r.input_checksum AND p.evidence_sha256=$3)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
        INTO supported_v2 USING NEW.venue_id,NEW.calculation_run_id,NEW.provenance_sha256;
      IF NOT supported_v2 THEN RAISE EXCEPTION 'payroll_run_payout_not_enabled' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

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
      OR (r.engine_version='payroll-verified-remaining-net-v2' AND r.provenance_schema_version=2 AND r.provenance_capability_version='employee_attributed_remaining_net_refund_v2')) OR r.currency<>'RUB'
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
