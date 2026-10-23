-- Atomic replacement of an unpaid v2 calculation. No approval or payout for v2.
CREATE TABLE IF NOT EXISTS payroll_run_supersession_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  original_run_id uuid NOT NULL,
  replacement_run_id uuid NOT NULL CHECK(replacement_run_id<>original_run_id),
  idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[!-~]{8,120}$'),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  plan_hash char(64) NOT NULL CHECK(plan_hash ~ '^[0-9a-f]{64}$'),
  plan_payload text NOT NULL CHECK(octet_length(plan_payload)<=16777216 AND jsonb_typeof(plan_payload::jsonb)='object'
    AND encode(sha256(convert_to(plan_payload,'UTF8')),'hex')=plan_hash),
  response_payload text NOT NULL CHECK(octet_length(response_payload)<=4194304 AND jsonb_typeof(response_payload::jsonb)='object'),
  response_sha256 char(64) NOT NULL CHECK(response_sha256 ~ '^[0-9a-f]{64}$'
    AND encode(sha256(convert_to(response_payload,'UTF8')),'hex')=response_sha256),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK(length(btrim(created_by_name)) BETWEEN 1 AND 160),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp() CHECK(isfinite(created_at)),
  UNIQUE(venue_id,id), UNIQUE(venue_id,original_run_id), UNIQUE(venue_id,replacement_run_id), UNIQUE(venue_id,idempotency_key),
  FOREIGN KEY(venue_id,original_run_id) REFERENCES payroll_calculation_runs(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,replacement_run_id) REFERENCES payroll_calculation_runs(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_v2_single_replacement_uq
  ON payroll_calculation_runs(venue_id,supersedes_run_id)
  WHERE engine_version='payroll-verified-remaining-net-v2' AND supersedes_run_id IS NOT NULL;
DO $$ DECLARE idx record; BEGIN
  SELECT i.* INTO idx FROM pg_index i JOIN pg_class x ON x.oid=i.indexrelid
    WHERE i.indrelid='payroll_calculation_runs'::regclass AND x.relname='payroll_v2_single_replacement_uq';
  IF idx.indexrelid IS NULL OR NOT idx.indisunique OR NOT idx.indisvalid OR NOT idx.indisready OR idx.indnkeyatts<>2
    OR pg_get_indexdef(idx.indexrelid,1,true)<>'venue_id' OR pg_get_indexdef(idx.indexrelid,2,true)<>'supersedes_run_id'
    OR regexp_replace(pg_get_expr(idx.indpred,idx.indrelid),'\s','','g') IS DISTINCT FROM '((engine_version=''payroll-verified-remaining-net-v2''::text)AND(supersedes_run_idISNOTNULL))' THEN
    RAISE EXCEPTION 'payroll_supersession_branch_index_invalid' USING ERRCODE='23514'; END IF;
END $$;

CREATE OR REPLACE FUNCTION payroll_supersession_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll_supersession_history_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS payroll_supersession_immutable ON payroll_run_supersession_requests;
CREATE TRIGGER payroll_supersession_immutable BEFORE UPDATE OR DELETE ON payroll_run_supersession_requests
  FOR EACH ROW EXECUTE FUNCTION payroll_supersession_reject_mutation();
DROP TRIGGER IF EXISTS payroll_supersession_truncate ON payroll_run_supersession_requests;
CREATE TRIGGER payroll_supersession_truncate BEFORE TRUNCATE ON payroll_run_supersession_requests
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_supersession_reject_mutation();

CREATE OR REPLACE FUNCTION payroll_validate_unpaid_supersession(target_schema text,target_venue uuid,target_replacement uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE j record; old_run record; new_run record; owner_row record; old_proof record; new_proof record;
  plan jsonb; response jsonb; old_evidence jsonb; new_evidence jsonb; old_ids jsonb; new_ids jsonb;
  input_ids jsonb; amounts jsonb; actual_old jsonb; actual_new jsonb; bad boolean; n bigint;
BEGIN
  EXECUTE format('SELECT * FROM %I.payroll_run_supersession_requests WHERE venue_id=$1 AND replacement_run_id=$2',target_schema)
    INTO j USING target_venue,target_replacement;
  IF j.id IS NULL THEN RAISE EXCEPTION 'payroll_supersession_journal_required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',target_schema)
    INTO old_run USING target_venue,j.original_run_id;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',target_schema)
    INTO new_run USING target_venue,j.replacement_run_id;
  IF old_run.id IS NULL OR new_run.id IS NULL OR old_run.status<>'ready' OR new_run.status<>'ready'
    OR old_run.engine_version<>'payroll-verified-remaining-net-v2' OR new_run.engine_version<>'payroll-verified-remaining-net-v2'
    OR old_run.scheme_version_id IS DISTINCT FROM new_run.scheme_version_id
    OR old_run.period_from IS DISTINCT FROM new_run.period_from OR old_run.period_to IS DISTINCT FROM new_run.period_to
    OR old_run.venue_timezone IS DISTINCT FROM new_run.venue_timezone OR old_run.currency IS DISTINCT FROM new_run.currency
    OR old_run.currency<>'RUB' OR new_run.supersedes_run_id IS DISTINCT FROM old_run.id
    OR new_run.recalculation_reason IS DISTINCT FROM j.reason OR new_run.created_by IS DISTINCT FROM j.created_by
    OR new_run.created_by_name IS DISTINCT FROM j.created_by_name THEN
    RAISE EXCEPTION 'payroll_supersession_run_context_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT id,full_name FROM %I.users WHERE venue_id=$1 AND id=$2 AND role=''owner'' AND is_active=true AND deleted_at IS NULL FOR SHARE',target_schema)
    INTO owner_row USING target_venue,j.created_by;
  IF owner_row.id IS NULL OR owner_row.full_name IS DISTINCT FROM j.created_by_name THEN
    RAISE EXCEPTION 'payroll_supersession_owner_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',target_schema)
    INTO old_proof USING target_venue,old_run.id;
  EXECUTE format('SELECT * FROM %I.payroll_run_provenance WHERE venue_id=$1 AND run_id=$2',target_schema)
    INTO new_proof USING target_venue,new_run.id;
  IF old_proof.run_id IS NULL OR new_proof.run_id IS NULL OR old_proof.schema_version<>2 OR new_proof.schema_version<>2
    OR old_proof.capability_version<>'employee_attributed_remaining_net_refund_v2'
    OR new_proof.capability_version<>'employee_attributed_remaining_net_refund_v2'
    OR old_proof.evidence_sha256 IS DISTINCT FROM old_run.input_checksum
    OR new_proof.evidence_sha256 IS DISTINCT FROM new_run.input_checksum THEN
    RAISE EXCEPTION 'payroll_supersession_provenance_invalid' USING ERRCODE='23514'; END IF;
  old_evidence:=old_proof.evidence_payload::jsonb; new_evidence:=new_proof.evidence_payload::jsonb;
  plan:=j.plan_payload::jsonb; response:=j.response_payload::jsonb;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(plan) key) IS DISTINCT FROM
      ARRAY['currency','employeeAmounts','historicalSchemeSha256','oldEntries','originalCapabilityVersion','originalInputWatermark','originalProvenanceSha256','originalRunId','periodFrom','periodTo','replacementCapabilityVersion','replacementInputWatermark','schemaVersion']::text[]
    OR plan->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR plan->>'originalRunId' IS DISTINCT FROM old_run.id::text
    OR plan->>'originalProvenanceSha256' IS DISTINCT FROM old_proof.evidence_sha256::text
    OR plan->>'originalInputWatermark' IS DISTINCT FROM old_run.input_watermark
    OR plan->>'originalCapabilityVersion' IS DISTINCT FROM old_proof.capability_version
    OR plan->>'replacementCapabilityVersion' IS DISTINCT FROM new_proof.capability_version
    OR plan->>'replacementInputWatermark' IS DISTINCT FROM new_run.input_watermark
    OR COALESCE(plan->>'historicalSchemeSha256','') !~ '^[a-f0-9]{64}$'
    OR old_evidence->'schemeSnapshot' IS DISTINCT FROM new_evidence->'schemeSnapshot'
    OR plan->>'periodFrom' IS DISTINCT FROM old_run.period_from::text OR plan->>'periodTo' IS DISTINCT FROM old_run.period_to::text
    OR plan->>'currency' IS DISTINCT FROM old_run.currency
    OR jsonb_typeof(plan->'employeeAmounts') IS DISTINCT FROM 'array' OR jsonb_typeof(plan->'oldEntries') IS DISTINCT FROM 'array'
    OR jsonb_typeof(old_evidence->'calculatorReplay'->'result'->'employees') IS DISTINCT FROM 'array'
    OR jsonb_typeof(new_evidence->'calculatorReplay'->'result'->'employees') IS DISTINCT FROM 'array'
    OR jsonb_typeof(old_evidence->'calculatorReplay'->'input'->'employees') IS DISTINCT FROM 'array'
    OR jsonb_typeof(new_evidence->'calculatorReplay'->'input'->'employees') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'payroll_supersession_plan_invalid' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value->>'employeeId' ORDER BY value->>'employeeId'),'[]'::jsonb),count(*) INTO old_ids,n
    FROM jsonb_array_elements(old_evidence->'calculatorReplay'->'result'->'employees');
  IF n=0 OR n>500 OR n<>(SELECT count(DISTINCT value->>'employeeId') FROM jsonb_array_elements(old_evidence->'calculatorReplay'->'result'->'employees')) THEN
    RAISE EXCEPTION 'payroll_supersession_cohort_invalid' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value->>'employeeId' ORDER BY value->>'employeeId'),'[]'::jsonb) INTO new_ids
    FROM jsonb_array_elements(new_evidence->'calculatorReplay'->'result'->'employees');
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb) INTO input_ids
    FROM jsonb_array_elements(old_evidence->'calculatorReplay'->'input'->'employees');
  IF old_ids IS DISTINCT FROM new_ids OR old_ids IS DISTINCT FROM input_ids THEN
    RAISE EXCEPTION 'payroll_supersession_cohort_changed' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value->>'id' ORDER BY value->>'id'),'[]'::jsonb) INTO input_ids
    FROM jsonb_array_elements(new_evidence->'calculatorReplay'->'input'->'employees');
  IF new_ids IS DISTINCT FROM input_ids THEN RAISE EXCEPTION 'payroll_supersession_cohort_changed' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('employeeId',value->>'employeeId','amountCents',value->'amountCents') ORDER BY value->>'employeeId'),'[]'::jsonb)
    INTO amounts FROM jsonb_array_elements(new_evidence->'calculatorReplay'->'result'->'employees');
  IF amounts IS DISTINCT FROM plan->'employeeAmounts' THEN RAISE EXCEPTION 'payroll_supersession_amounts_changed' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(jsonb_agg(value->>'employeeId' ORDER BY value->>'employeeId'),'[]'::jsonb) INTO input_ids
    FROM jsonb_array_elements(plan->'oldEntries');
  IF old_ids IS DISTINCT FROM input_ids THEN RAISE EXCEPTION 'payroll_supersession_original_cohort_incomplete' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 AND (status<>''cancelled'' OR expense_id IS NOT NULL OR approved_at IS NOT NULL OR approved_by IS NOT NULL OR paid_at IS NOT NULL OR paid_by IS NOT NULL OR payment_date IS NOT NULL))',target_schema)
    INTO bad USING target_venue,old_run.id;
  IF bad THEN RAISE EXCEPTION 'payroll_supersession_original_not_unpaid_cancelled' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(jsonb_build_object(''employeeId'',user_id,''entryId'',id,''grossCents'',calculation_gross_cents,''amountCents'',amount*100,''financeCategoryId'',finance_category_id) ORDER BY user_id),''[]''::jsonb) FROM %I.payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2',target_schema)
    INTO actual_old USING target_venue,old_run.id;
  IF actual_old IS DISTINCT FROM (SELECT COALESCE(jsonb_agg(value-ARRAY['status','stateHash','ledgerHash'] ORDER BY value->>'employeeId'),'[]'::jsonb) FROM jsonb_array_elements(plan->'oldEntries'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(plan->'oldEntries') e WHERE
      (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(e) key) IS DISTINCT FROM ARRAY['amountCents','employeeId','entryId','financeCategoryId','grossCents','ledgerHash','stateHash','status']::text[]
      OR COALESCE(e->>'status','') NOT IN ('draft','cancelled') OR COALESCE(e->>'stateHash','') !~ '^[a-f0-9]{64}$' OR COALESCE(e->>'ledgerHash','') !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'payroll_supersession_original_entries_changed' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries e JOIN jsonb_array_elements($3) p ON p->>''entryId''=e.id::text WHERE e.venue_id=$1 AND e.calculation_run_id=$2 AND p->>''status''=''draft'' AND (e.cancelled_by IS DISTINCT FROM $4 OR e.cancellation_reason IS DISTINCT FROM $5))',target_schema)
    INTO bad USING target_venue,old_run.id,plan->'oldEntries',j.created_by,j.reason;
  IF bad THEN RAISE EXCEPTION 'payroll_supersession_cancellation_context_invalid' USING ERRCODE='23514'; END IF;
  -- Cancellation deliberately retains its historical net, even when incoming
  -- allocations are released. Bind the preview to that immutable receipt, not
  -- to a hypothetical gross amount after release. Previously cancelled entries
  -- keep their existing actor and receipt.
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries e JOIN jsonb_array_elements($3) p ON p->>''entryId''=e.id::text LEFT JOIN %I.payroll_calculation_entry_transitions t ON t.venue_id=e.venue_id AND t.entry_id=e.id AND t.action=''cancel'' WHERE e.venue_id=$1 AND e.calculation_run_id=$2 AND p->>''status''=''draft'' AND (t.id IS NULL OR t.transaction_id<>txid_current() OR t.from_status<>''draft'' OR t.to_status<>''cancelled'' OR t.created_by IS DISTINCT FROM $4 OR t.created_by_name IS DISTINCT FROM $5 OR t.reason IS DISTINCT FROM $6 OR t.created_at IS DISTINCT FROM e.cancelled_at OR t.net_cents::numeric IS DISTINCT FROM (p->>''amountCents'')::numeric OR t.net_cents::numeric IS DISTINCT FROM e.amount*100 OR t.gross_cents IS DISTINCT FROM e.calculation_gross_cents OR t.ledger_hash::text IS DISTINCT FROM p->>''ledgerHash''))',target_schema,target_schema)
    INTO bad USING target_venue,old_run.id,plan->'oldEntries',j.created_by,j.created_by_name,j.reason;
  IF bad THEN RAISE EXCEPTION 'payroll_supersession_cancellation_receipt_required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries e JOIN %I.payroll_correction_events a ON a.venue_id=e.venue_id AND a.target_entry_id=e.id AND a.kind=''apply'' WHERE e.venue_id=$1 AND e.calculation_run_id=$2 AND NOT EXISTS(SELECT 1 FROM %I.payroll_correction_events r WHERE r.venue_id=a.venue_id AND r.reverses_event_id=a.id))',target_schema,target_schema,target_schema)
    INTO bad USING target_venue,old_run.id;
  IF bad THEN RAISE EXCEPTION 'payroll_supersession_correction_release_required' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2 AND (status<>''draft'' OR expense_id IS NOT NULL OR amount*100 IS DISTINCT FROM calculation_gross_cents::numeric OR materialized_by IS DISTINCT FROM $3 OR materialized_by_name IS DISTINCT FROM $4))',target_schema)
    INTO bad USING target_venue,new_run.id,j.created_by,j.created_by_name;
  IF bad THEN RAISE EXCEPTION 'payroll_supersession_replacement_not_draft' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(jsonb_build_object(''employeeId'',user_id,''amountCents'',calculation_gross_cents) ORDER BY user_id),''[]''::jsonb) FROM %I.payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2',target_schema)
    INTO actual_new USING target_venue,new_run.id;
  IF amounts IS DISTINCT FROM actual_new THEN RAISE EXCEPTION 'payroll_supersession_replacement_cohort_incomplete' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_entries e JOIN jsonb_array_elements($3) p ON p->>''employeeId''=e.user_id::text WHERE e.venue_id=$1 AND e.calculation_run_id=$2 AND to_jsonb(e.finance_category_id) IS DISTINCT FROM NULLIF(p->''financeCategoryId'',''null''::jsonb))',target_schema)
    INTO bad USING target_venue,new_run.id,plan->'oldEntries';
  IF bad THEN RAISE EXCEPTION 'payroll_supersession_finance_category_changed' USING ERRCODE='23514'; END IF;
  IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(response) key) IS DISTINCT FROM ARRAY['entries','journalId','originalRunId','planHash','replacementRunId','replayed','schemaVersion']::text[]
    OR response->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR response->'replayed' IS DISTINCT FROM 'false'::jsonb
    OR response->>'journalId' IS DISTINCT FROM j.id::text OR response->>'originalRunId' IS DISTINCT FROM old_run.id::text
    OR response->>'replacementRunId' IS DISTINCT FROM new_run.id::text OR response->>'planHash' IS DISTINCT FROM j.plan_hash::text
    OR jsonb_typeof(response->'entries') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'payroll_supersession_response_invalid' USING ERRCODE='23514'; END IF;
  EXECUTE format('SELECT COALESCE(jsonb_agg(jsonb_build_object(''employeeId'',user_id,''entryId'',id,''amountCents'',calculation_gross_cents,''financeCategoryId'',finance_category_id) ORDER BY user_id),''[]''::jsonb) FROM %I.payroll_entries WHERE venue_id=$1 AND calculation_run_id=$2',target_schema)
    INTO actual_new USING target_venue,new_run.id;
  IF actual_new IS DISTINCT FROM response->'entries' THEN RAISE EXCEPTION 'payroll_supersession_response_entries_invalid' USING ERRCODE='23514'; END IF;
END $$;

CREATE OR REPLACE FUNCTION payroll_unpaid_supersession_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='payroll_run_supersession_requests' THEN
    PERFORM payroll_validate_unpaid_supersession(TG_TABLE_SCHEMA,NEW.venue_id,NEW.replacement_run_id);
  ELSIF NEW.engine_version='payroll-verified-remaining-net-v2' AND NEW.supersedes_run_id IS NOT NULL THEN
    PERFORM payroll_validate_unpaid_supersession(TG_TABLE_SCHEMA,NEW.venue_id,NEW.id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS payroll_unpaid_supersession_commit ON payroll_run_supersession_requests;
CREATE CONSTRAINT TRIGGER payroll_unpaid_supersession_commit AFTER INSERT ON payroll_run_supersession_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_unpaid_supersession_commit();
DROP TRIGGER IF EXISTS payroll_run_unpaid_supersession_commit ON payroll_calculation_runs;
CREATE CONSTRAINT TRIGGER payroll_run_unpaid_supersession_commit AFTER INSERT ON payroll_calculation_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_unpaid_supersession_commit();

CREATE OR REPLACE FUNCTION payroll_block_v2_money_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_v2 boolean;
BEGIN
  IF NEW.action IN ('approve','pay') THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 AND engine_version=''payroll-verified-remaining-net-v2'')',TG_TABLE_SCHEMA)
      INTO is_v2 USING NEW.venue_id,NEW.calculation_run_id;
    IF is_v2 THEN RAISE EXCEPTION 'payroll_run_payout_not_enabled' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_v2_money_transition_block ON payroll_calculation_entry_transitions;
CREATE TRIGGER payroll_v2_money_transition_block BEFORE INSERT ON payroll_calculation_entry_transitions
  FOR EACH ROW EXECUTE FUNCTION payroll_block_v2_money_transition();

-- The complete 205 entry guard follows, with narrow additive v2 draft gates.

CREATE OR REPLACE FUNCTION payroll_validate_calculation_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p jsonb; actor record; employee record; total numeric; member_count integer; input_count integer; replay_amount numeric; names integer; transition record; next_action text; is_v2 boolean; replaced boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.calculation_run_id IS NOT NULL THEN RAISE EXCEPTION 'payroll_calculation_entry_immutable' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  -- New v2 runs support only draft materialization and cancellation.
  IF NEW.calculation_run_id IS NOT NULL THEN
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 AND engine_version=''payroll-verified-remaining-net-v2'')',TG_TABLE_SCHEMA)
      INTO is_v2 USING NEW.venue_id,NEW.calculation_run_id;
    IF is_v2 AND NEW.status IN ('approved','paid') THEN
      RAISE EXCEPTION 'payroll_run_payout_not_enabled' USING ERRCODE='23514'; END IF;
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
