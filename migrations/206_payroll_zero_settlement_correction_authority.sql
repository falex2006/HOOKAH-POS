-- A paid zero settlement is economic completion without a fabricated expense.
-- Existing positive-expense v1 plans/receipts remain unchanged.
ALTER TABLE payroll_correction_claims ADD COLUMN IF NOT EXISTS original_settlement_transition_id uuid;
ALTER TABLE payroll_correction_claims ALTER COLUMN original_expense_id DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_claims'::regclass AND conname='payroll_correction_claim_settlement_fk') THEN
    ALTER TABLE payroll_correction_claims ADD CONSTRAINT payroll_correction_claim_settlement_fk
      FOREIGN KEY(venue_id,original_settlement_transition_id) REFERENCES payroll_calculation_entry_transitions(venue_id,id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='payroll_correction_claims'::regclass AND conname='payroll_correction_claim_authority_xor') THEN
    ALTER TABLE payroll_correction_claims ADD CONSTRAINT payroll_correction_claim_authority_xor
      CHECK((original_expense_id IS NOT NULL)<>(original_settlement_transition_id IS NOT NULL));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION payroll_correction_require_zero_settlement(schema_name text,venue uuid,entry uuid,transition uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE original record; receipt record; gross numeric; fixed numeric; used numeric; journaled boolean;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_entries WHERE venue_id=$1 AND id=$2 FOR SHARE',schema_name) INTO original USING venue,entry;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_entry_transitions WHERE venue_id=$1 AND id=$2 FOR SHARE',schema_name) INTO receipt USING venue,transition;
  IF original.id IS NULL OR original.status<>'paid' OR original.amount IS DISTINCT FROM 0::numeric
    OR original.expense_id IS NOT NULL OR original.calculation_run_id IS NULL
    OR receipt.id IS NULL OR receipt.entry_id IS DISTINCT FROM original.id OR receipt.employee_id IS DISTINCT FROM original.user_id
    OR receipt.action IS DISTINCT FROM 'pay' OR receipt.from_status IS DISTINCT FROM 'approved' OR receipt.to_status IS DISTINCT FROM 'paid'
    OR receipt.settlement_kind IS DISTINCT FROM 'zero' OR receipt.net_cents IS DISTINCT FROM 0::bigint
    OR receipt.protected_fixed_cents IS DISTINCT FROM 0::bigint
    OR receipt.calculation_run_id IS DISTINCT FROM original.calculation_run_id
    OR receipt.provenance_sha256 IS DISTINCT FROM original.calculation_provenance_sha256
    OR receipt.gross_cents IS DISTINCT FROM original.calculation_gross_cents
    OR original.paid_at IS NULL OR original.paid_by IS NULL OR original.payment_date IS NULL
    OR receipt.created_at IS DISTINCT FROM original.paid_at OR receipt.created_by IS DISTINCT FROM original.paid_by
    OR receipt.payment_date IS DISTINCT FROM original.payment_date
    OR receipt.expense_id IS NOT NULL OR receipt.finance_account_id IS NOT NULL OR receipt.finance_account_name_snapshot IS NOT NULL
    OR receipt.payment_method IS NOT NULL OR receipt.shift_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll_correction_zero_settlement_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_entry_transition_requests WHERE venue_id=$1 AND transition_id=$2 AND created_by=$3)',schema_name)
    INTO journaled USING venue,transition,original.paid_by;
  EXECUTE format('SELECT COALESCE(sum(final_amount*100),0),COALESCE(sum(LEAST(base_pay,final_amount)*100),0) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3',schema_name)
    INTO gross,fixed USING venue,original.calculation_run_id,original.user_id;
  EXECUTE format('SELECT COALESCE(sum(CASE WHEN kind=''apply'' THEN amount_cents WHEN kind=''release'' THEN -amount_cents ELSE 0 END),0) FROM %I.payroll_correction_events WHERE venue_id=$1 AND target_entry_id=$2',schema_name)
    INTO used USING venue,entry;
  IF NOT journaled OR fixed IS DISTINCT FROM 0::numeric OR gross IS DISTINCT FROM original.calculation_gross_cents::numeric OR used IS DISTINCT FROM gross THEN
    RAISE EXCEPTION 'payroll_correction_zero_settlement_reconciliation_invalid' USING ERRCODE='23514'; END IF;
END $$;

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
  IF NEW.original_settlement_transition_id IS NOT NULL THEN
    PERFORM payroll_correction_require_zero_settlement(TG_TABLE_SCHEMA,NEW.venue_id,NEW.original_entry_id,NEW.original_settlement_transition_id);
  ELSE
  EXECUTE format('SELECT * FROM %I.expenses WHERE venue_id=$1 AND id=$2 FOR SHARE',TG_TABLE_SCHEMA)
    INTO expense USING NEW.venue_id,NEW.original_expense_id;
  IF expense.id IS NULL OR expense.source<>'payroll' OR expense.amount IS DISTINCT FROM original.amount THEN
    RAISE EXCEPTION 'payroll_correction_original_expense_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
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
