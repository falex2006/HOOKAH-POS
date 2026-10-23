-- Staged ledger prerequisite only. Migration202 still prohibits linked payouts
-- and amount changes. No flag, setter, endpoint, or automatic deduction is added.
CREATE TABLE IF NOT EXISTS payroll_correction_claims (
  id uuid PRIMARY KEY, venue_id uuid NOT NULL, employee_id uuid NOT NULL, currency text NOT NULL CHECK(currency='RUB'),
  original_entry_id uuid NOT NULL, original_run_id uuid NOT NULL, original_expense_id uuid NOT NULL,
  original_provenance_sha256 char(64) NOT NULL CHECK(original_provenance_sha256 ~ '^[0-9a-f]{64}$'),
  refund_line_event_id uuid NOT NULL REFERENCES pos_payroll_refund_line_events(id) ON DELETE RESTRICT,
  source_snapshot_line_id uuid NOT NULL, assessment_id uuid NOT NULL, assessment_hash char(64) NOT NULL,
  source_hash char(64) NOT NULL CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  assessed_cents bigint NOT NULL CHECK(assessed_cents BETWEEN 1 AND 9007199254740991),
  created_by uuid NOT NULL, created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,id,employee_id), UNIQUE(venue_id,refund_line_event_id,employee_id),
  FOREIGN KEY(venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,original_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,original_run_id) REFERENCES payroll_run_provenance(venue_id,run_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,original_expense_id) REFERENCES expenses(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,source_snapshot_line_id) REFERENCES payroll_daily_snapshot_lines(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,assessment_id) REFERENCES payroll_refund_review_assessments(venue_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS payroll_correction_batches (
  id uuid PRIMARY KEY, venue_id uuid NOT NULL, employee_id uuid NOT NULL, currency text NOT NULL CHECK(currency='RUB'),
  operation text NOT NULL CHECK(operation IN ('apply','waive','release')),
  original_entry_id uuid, target_entry_id uuid, target_sequence_no integer,
  assessment_id uuid, assessment_hash char(64) CHECK(assessment_hash ~ '^[0-9a-f]{64}$'),
  source_hash char(64) CHECK(source_hash ~ '^[0-9a-f]{64}$'),
  ledger_hash char(64) NOT NULL CHECK(ledger_hash ~ '^[0-9a-f]{64}$'),
  plan_payload text NOT NULL CHECK(octet_length(plan_payload)<=4194304 AND jsonb_typeof(plan_payload::jsonb)='object'),
  plan_hash char(64) NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$' AND encode(sha256(convert_to(plan_payload,'UTF8')),'hex')=plan_hash),
  event_count integer NOT NULL CHECK(event_count BETWEEN 1 AND 20000),
  total_cents bigint NOT NULL CHECK(total_cents BETWEEN 1 AND 9007199254740991),
  target_before_cents bigint, target_after_cents bigint, protected_fixed_cents bigint,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 2000),
  created_by uuid NOT NULL, created_by_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,id,employee_id), UNIQUE(venue_id,target_entry_id,target_sequence_no),
  FOREIGN KEY(venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,original_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,target_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,assessment_id) REFERENCES payroll_refund_review_assessments(venue_id,id) ON DELETE RESTRICT,
  CHECK((operation='release' AND original_entry_id IS NULL AND assessment_id IS NULL AND assessment_hash IS NULL AND source_hash IS NULL)
    OR (operation<>'release' AND original_entry_id IS NOT NULL AND assessment_id IS NOT NULL AND assessment_hash IS NOT NULL AND source_hash IS NOT NULL)),
  CHECK((operation='waive' AND target_entry_id IS NULL AND target_sequence_no IS NULL AND target_before_cents IS NULL
    AND target_after_cents IS NULL AND protected_fixed_cents IS NULL)
    OR (operation IN ('apply','release') AND target_entry_id IS NOT NULL AND target_sequence_no IS NOT NULL AND target_sequence_no>0
      AND target_before_cents BETWEEN 0 AND 9007199254740991 AND target_after_cents BETWEEN 0 AND 9007199254740991
      AND protected_fixed_cents BETWEEN 0 AND 9007199254740991 AND target_after_cents>=protected_fixed_cents
      AND target_before_cents IS NOT NULL AND target_after_cents IS NOT NULL AND protected_fixed_cents IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS payroll_correction_events (
  id uuid PRIMARY KEY, sequence_no bigserial NOT NULL UNIQUE, venue_id uuid NOT NULL, employee_id uuid NOT NULL,
  claim_id uuid NOT NULL, batch_id uuid NOT NULL, claim_sequence_no integer NOT NULL CHECK(claim_sequence_no>0),
  kind text NOT NULL CHECK(kind IN ('apply','waive','release')), amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 9007199254740991),
  target_entry_id uuid, reverses_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(venue_id,id), UNIQUE(venue_id,claim_id,claim_sequence_no), UNIQUE(venue_id,reverses_event_id),
  FOREIGN KEY(venue_id,claim_id,employee_id) REFERENCES payroll_correction_claims(venue_id,id,employee_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,batch_id,employee_id) REFERENCES payroll_correction_batches(venue_id,id,employee_id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,target_entry_id) REFERENCES payroll_entries(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,reverses_event_id) REFERENCES payroll_correction_events(venue_id,id) ON DELETE RESTRICT,
  CHECK((kind='waive' AND target_entry_id IS NULL AND reverses_event_id IS NULL)
    OR (kind='apply' AND target_entry_id IS NOT NULL AND reverses_event_id IS NULL)
    OR (kind='release' AND target_entry_id IS NOT NULL AND reverses_event_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS payroll_correction_events_employee ON payroll_correction_events(venue_id,employee_id,sequence_no);
CREATE INDEX IF NOT EXISTS payroll_correction_events_target ON payroll_correction_events(venue_id,target_entry_id,sequence_no);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_correction_events_batch_claim ON payroll_correction_events(venue_id,batch_id,claim_id) WHERE kind<>'release';
CREATE TABLE IF NOT EXISTS payroll_correction_requests (
  venue_id uuid NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 120),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'), batch_id uuid NOT NULL,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  response_payload text NOT NULL CHECK(octet_length(response_payload)<=8388608 AND jsonb_typeof(response_payload::jsonb)='object'),
  response_hash char(64) NOT NULL CHECK(response_hash ~ '^[0-9a-f]{64}$' AND encode(sha256(convert_to(response_payload,'UTF8')),'hex')=response_hash),
  PRIMARY KEY(venue_id,idempotency_key),
  FOREIGN KEY(venue_id,batch_id) REFERENCES payroll_correction_batches(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payroll_correction_validate_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original record; expense record; assessment record; source_line record; refund record; actor record; matching integer; assessed numeric;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO original USING NEW.venue_id,NEW.original_entry_id;
  IF original.id IS NULL OR original.status<>'paid' OR original.calculation_run_id IS DISTINCT FROM NEW.original_run_id
    OR original.user_id<>NEW.employee_id OR original.expense_id IS DISTINCT FROM NEW.original_expense_id
    OR original.calculation_provenance_sha256 IS DISTINCT FROM NEW.original_provenance_sha256
    OR original.paid_at IS NULL OR original.paid_by IS NULL OR original.payment_date IS NULL THEN
    RAISE EXCEPTION 'payroll_correction_original_paid_basis_required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.expenses WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO expense USING NEW.venue_id,NEW.original_expense_id;
  IF expense.id IS NULL OR expense.source<>'payroll' OR expense.amount IS DISTINCT FROM original.amount THEN
    RAISE EXCEPTION 'payroll_correction_original_expense_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_refund_review_assessments WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO assessment USING NEW.venue_id,NEW.assessment_id;
  IF assessment.id IS NULL OR assessment.run_id<>NEW.original_run_id OR assessment.assessment_hash<>NEW.assessment_hash
    OR assessment.source_hash<>NEW.source_hash OR assessment.coverage<>'complete'
    OR assessment.payload::jsonb->>'provenanceSha256' IS DISTINCT FROM NEW.original_provenance_sha256::text THEN
    RAISE EXCEPTION 'payroll_correction_assessment_mismatch' USING ERRCODE='23514'; END IF;
  SELECT count(*),max(-(line->>'salaryImpactCents')::numeric) INTO matching,assessed
    FROM jsonb_array_elements(assessment.payload::jsonb->'lines') line
    WHERE line->>'refundLineEventId'=NEW.refund_line_event_id::text AND line->>'employeeId'=NEW.employee_id::text
      AND line->>'sourceSnapshotLineId'=NEW.source_snapshot_line_id::text AND line->'reasons'='[]'::jsonb;
  IF matching<>1 OR assessed IS DISTINCT FROM NEW.assessed_cents::numeric THEN
    RAISE EXCEPTION 'payroll_correction_assessed_amount_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO source_line USING NEW.venue_id,NEW.source_snapshot_line_id;
  EXECUTE format('SELECT * FROM %I.pos_payroll_refund_line_events WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO refund USING NEW.venue_id,NEW.refund_line_event_id;
  IF source_line.id IS NULL OR refund.id IS NULL OR source_line.run_id<>NEW.original_run_id
    OR source_line.employee_id<>NEW.employee_id OR source_line.order_id<>refund.order_id OR source_line.order_item_id<>refund.order_item_id THEN
    RAISE EXCEPTION 'payroll_correction_source_lineage_mismatch' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL',TG_TABLE_SCHEMA)
    INTO actor USING NEW.venue_id,NEW.created_by;
  IF actor.id IS NULL OR actor.full_name IS DISTINCT FROM NEW.created_by_name THEN
    RAISE EXCEPTION 'payroll_correction_owner_required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
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
  EXECUTE format('SELECT * FROM %I.expenses WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO expense USING NEW.venue_id,original.expense_id;
  IF expense.id IS NULL OR expense.source<>'payroll' OR expense.amount IS DISTINCT FROM original.amount THEN
    RAISE EXCEPTION 'payroll_correction_original_expense_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  plan:=NEW.plan_payload::jsonb;
  IF plan->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR plan->>'policyVersion' IS DISTINCT FROM 'owner-reviewed-variable-correction-v1'
    OR plan->>'venueId' IS DISTINCT FROM NEW.venue_id::text OR plan->>'employeeId' IS DISTINCT FROM NEW.employee_id::text
    OR plan->>'currency' IS DISTINCT FROM NEW.currency
    OR plan->>'ledgerHash' IS DISTINCT FROM NEW.ledger_hash::text OR plan->'officialReady' IS DISTINCT FROM 'false'::jsonb
    OR plan->'payoutEligible' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'payroll_correction_plan_context_invalid' USING ERRCODE='23514'; END IF;
  IF NEW.operation<>'release' THEN
    IF plan->>'originalEntryId' IS DISTINCT FROM NEW.original_entry_id::text
      OR plan->>'originalProvenanceSha256' IS DISTINCT FROM original.calculation_provenance_sha256::text
      OR plan->>'originalExpenseId' IS DISTINCT FROM original.expense_id::text
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
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0),COALESCE(sum(final_amount*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed,gross USING NEW.venue_id,target.calculation_run_id,NEW.employee_id;
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

CREATE OR REPLACE FUNCTION payroll_correction_validate_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim record; batch record; parent record; assessment record; seq integer; previous_global bigint; used numeric; matching integer; assessed numeric; planned numeric; planned_disposed numeric;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_correction_claims WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO claim USING NEW.venue_id,NEW.claim_id;
  EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO batch USING NEW.venue_id,NEW.batch_id;
  IF claim.id IS NULL OR batch.id IS NULL OR claim.employee_id<>NEW.employee_id OR batch.employee_id<>NEW.employee_id
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
  EXECUTE format('SELECT COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',TG_TABLE_SCHEMA)
    INTO fixed USING v,target.calculation_run_id,target.user_id;
  IF used<0 OR target.calculation_gross_cents-used<fixed OR target.amount*100 IS DISTINCT FROM target.calculation_gross_cents-used THEN
    RAISE EXCEPTION 'payroll_correction_target_net_reconciliation_required' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION payroll_correction_protect_original() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE referenced boolean;
BEGIN
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_correction_claims WHERE venue_id=$1 AND original_entry_id=$2)',TG_TABLE_SCHEMA)
    INTO referenced USING OLD.venue_id,OLD.id;
  IF referenced AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'payroll_correction_original_history_immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_correction_validate_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch record; p jsonb;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_correction_batches WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
    INTO batch USING NEW.venue_id,NEW.batch_id;
  p:=NEW.response_payload::jsonb;
  IF batch.id IS NULL OR batch.created_by<>NEW.created_by OR p->>'batchId' IS DISTINCT FROM NEW.batch_id::text
    OR p->>'operation' IS DISTINCT FROM batch.operation OR p->'officialReady' IS DISTINCT FROM 'false'::jsonb
    OR p->'payoutEligible' IS DISTINCT FROM 'false'::jsonb OR p->'replayed' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'payroll_correction_response_context_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payroll_correction_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll_correction_history_immutable' USING ERRCODE='55000'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['claims','batches','events','requests'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_correction_validate ON payroll_correction_%I',t);
    EXECUTE format('CREATE TRIGGER payroll_correction_validate BEFORE INSERT ON payroll_correction_%I FOR EACH ROW EXECUTE FUNCTION payroll_correction_validate_%s()',t,CASE t WHEN 'claims' THEN 'claim' WHEN 'batches' THEN 'batch' WHEN 'events' THEN 'event' ELSE 'request' END);
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_correction_immutable ON payroll_correction_%I',t);
    EXECUTE format('CREATE TRIGGER payroll_correction_immutable BEFORE UPDATE OR DELETE ON payroll_correction_%I FOR EACH ROW EXECUTE FUNCTION payroll_correction_reject_mutation()',t);
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_correction_truncate ON payroll_correction_%I',t);
    EXECUTE format('CREATE TRIGGER payroll_correction_truncate BEFORE TRUNCATE ON payroll_correction_%I FOR EACH STATEMENT EXECUTE FUNCTION payroll_correction_reject_mutation()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['payroll_correction_batches','payroll_correction_events','payroll_entries'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_correction_commit ON %I',t);
    EXECUTE format('CREATE CONSTRAINT TRIGGER payroll_correction_commit AFTER INSERT OR UPDATE ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_correction_validate_commit()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['payroll_entries'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS payroll_correction_original_guard ON %I',t);
    EXECUTE format('CREATE TRIGGER payroll_correction_original_guard BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_correction_protect_original()',t);
  END LOOP;
END $$;
