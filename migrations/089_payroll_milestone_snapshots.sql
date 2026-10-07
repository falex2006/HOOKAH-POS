-- Durable supplied milestone evidence only; this does not authorize official
-- calculation or attest canonical sales/pricing/refund/cost source coverage.
ALTER TABLE payroll_calculation_runs
  ADD COLUMN IF NOT EXISTS milestone_evidence_version integer NOT NULL DEFAULT 0;
ALTER TABLE payroll_calculation_runs DROP CONSTRAINT IF EXISTS payroll_runs_milestone_version_check;
ALTER TABLE payroll_calculation_runs ADD CONSTRAINT payroll_runs_milestone_version_check
  CHECK (milestone_evidence_version IN (0,1));
ALTER TABLE payroll_employee_overrides DROP CONSTRAINT IF EXISTS payroll_employee_overrides_parameter_path_check;
ALTER TABLE payroll_employee_overrides ADD CONSTRAINT payroll_employee_overrides_parameter_path_check
  CHECK (parameter_path ~ '^(mode|applyMilestones|milestoneEligibility|perShiftCents|stableRateBps|targetCents|baseRateBps|bonusRateBps|excessRatePolicy|teamWeight|lossPolicy|itemRuleBasis|bracketRatesBps\.[0-9]+|cap\.(rateBps|basis)|milestoneBonusesCents\.[0-9]+)$');

CREATE TABLE IF NOT EXISTS payroll_milestone_day_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  local_date date NOT NULL,
  attendance_approval_id uuid NOT NULL,
  previous_venue_turnover numeric(16,2) NOT NULL CHECK (previous_venue_turnover>=0 AND previous_venue_turnover<>'NaN'::numeric),
  cumulative_venue_turnover numeric(16,2) NOT NULL CHECK (cumulative_venue_turnover>=previous_venue_turnover AND cumulative_venue_turnover<>'NaN'::numeric),
  decision_count integer NOT NULL CHECK (decision_count>=0),
  awarded_total numeric(16,2) NOT NULL CHECK (awarded_total>=0 AND awarded_total<>'NaN'::numeric),
  UNIQUE (venue_id,id,run_id,local_date),
  UNIQUE (venue_id,run_id,local_date),
  FOREIGN KEY (venue_id,run_id) REFERENCES payroll_calculation_runs(venue_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,attendance_approval_id) REFERENCES payroll_attendance_approvals(venue_id,id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS payroll_milestone_decision_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  day_snapshot_id uuid NOT NULL,
  local_date date NOT NULL,
  employee_id uuid NOT NULL,
  employee_name_snapshot text NOT NULL CHECK (length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160),
  role_key_snapshot text NOT NULL CHECK (length(btrim(role_key_snapshot)) BETWEEN 1 AND 80),
  threshold_amount numeric(16,2) NOT NULL CHECK (threshold_amount>0 AND threshold_amount<>'NaN'::numeric),
  declared_bonus numeric(16,2) NOT NULL CHECK (declared_bonus>0 AND declared_bonus<>'NaN'::numeric),
  eligibility text NOT NULL CHECK (eligibility IN ('all_active','worked_on_threshold_day')),
  apply_milestones boolean NOT NULL,
  employee_active boolean NOT NULL,
  eligible boolean NOT NULL,
  reason text NOT NULL CHECK (reason IN ('eligible','milestones_disabled','employee_inactive','no_approved_positive_work_on_threshold_day')),
  approved_worked_minutes integer NOT NULL CHECK (approved_worked_minutes>=0),
  awarded_amount numeric(16,2) NOT NULL CHECK (awarded_amount>=0 AND awarded_amount<>'NaN'::numeric),
  qualifying_shift_ids uuid[] NOT NULL,
  CHECK (eligible=(apply_milestones AND employee_active AND (eligibility='all_active' OR approved_worked_minutes>0))),
  CHECK (reason=CASE WHEN NOT apply_milestones THEN 'milestones_disabled' WHEN NOT employee_active THEN 'employee_inactive'
    WHEN eligibility='worked_on_threshold_day' AND approved_worked_minutes=0 THEN 'no_approved_positive_work_on_threshold_day' ELSE 'eligible' END),
  CHECK (awarded_amount=CASE WHEN eligible THEN declared_bonus ELSE 0 END),
  UNIQUE (venue_id,run_id,local_date,employee_id,threshold_amount),
  FOREIGN KEY (venue_id,day_snapshot_id,run_id,local_date)
    REFERENCES payroll_milestone_day_snapshots(venue_id,id,run_id,local_date) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,employee_id) REFERENCES users(venue_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payroll_require_milestone_context() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  EXECUTE format('SELECT status,period_from,period_to,milestone_evidence_version FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO parent USING NEW.venue_id,NEW.run_id;
  IF parent.status IS DISTINCT FROM 'ready' OR parent.milestone_evidence_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'milestone snapshots require a ready evidence version 1 run' USING ERRCODE='55000';
  END IF;
  IF NEW.local_date<parent.period_from OR NEW.local_date>parent.period_to THEN
    RAISE EXCEPTION 'milestone date outside run' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_validate_milestone_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE run record; day record; decision record; target_run uuid; count_rows bigint; mismatch bigint;
  count_decisions bigint; total_award numeric; approval_count bigint; previous_date date; previous_total numeric;
  expected_shifts uuid[]; actual_shifts uuid[]; worked_total bigint;
BEGIN
  IF TG_TABLE_NAME='payroll_calculation_runs' THEN target_run:=NEW.id;
  ELSE target_run:=NEW.run_id; END IF;
  EXECUTE format('SELECT * FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA)
    INTO run USING NEW.venue_id,target_run;
  IF run.milestone_evidence_version=0 THEN RETURN NEW; END IF;
  IF run.status<>'ready' THEN
    RAISE EXCEPTION 'version 1 milestone evidence requires ready run' USING ERRCODE='23514';
  END IF;
  EXECUTE format('SELECT count(*),count(DISTINCT attendance_approval_id) FROM %I.payroll_milestone_day_snapshots WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA)
    INTO count_rows,approval_count USING NEW.venue_id,target_run;
  IF count_rows<>run.period_to-run.period_from+1 OR approval_count<>1 THEN
    RAISE EXCEPTION 'milestone evidence must cover every run day with one approval' USING ERRCODE='23514';
  END IF;
  FOR day IN EXECUTE format('SELECT d.*,a.period_from AS approval_from,a.period_to AS approval_to,a.venue_timezone AS approval_timezone FROM %I.payroll_milestone_day_snapshots d JOIN %I.payroll_attendance_approvals a ON a.venue_id=d.venue_id AND a.id=d.attendance_approval_id WHERE d.venue_id=$1 AND d.run_id=$2 ORDER BY d.local_date',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      USING NEW.venue_id,target_run LOOP
    IF day.approval_from<>date_trunc('month',run.period_from)::date OR day.approval_to<run.period_to
      OR date_trunc('month',day.approval_to)<>date_trunc('month',run.period_from)
      OR day.approval_timezone IS DISTINCT FROM run.venue_timezone
      OR (previous_date IS NULL AND run.period_from=date_trunc('month',run.period_from)::date AND day.previous_venue_turnover<>0)
      OR (previous_date IS NOT NULL AND (day.local_date<>previous_date+1 OR day.previous_venue_turnover<>previous_total)) THEN
      RAISE EXCEPTION 'milestone approval or turnover continuity mismatch' USING ERRCODE='23514';
    END IF;
    previous_date:=day.local_date; previous_total:=day.cumulative_venue_turnover;
    EXECUTE format('SELECT count(*),COALESCE(sum(awarded_amount),0) FROM %I.payroll_milestone_decision_snapshots WHERE venue_id=$1 AND run_id=$2 AND day_snapshot_id=$3',TG_TABLE_SCHEMA)
      INTO count_decisions,total_award USING NEW.venue_id,target_run,day.id;
    IF count_decisions<>day.decision_count OR total_award<>day.awarded_total THEN
      RAISE EXCEPTION 'milestone decision count or award total mismatch' USING ERRCODE='23514';
    END IF;
    EXECUTE format('SELECT count(*) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND local_date=$3 AND (venue_turnover<>$4 OR cumulative_venue_turnover<>$5)',TG_TABLE_SCHEMA)
      INTO mismatch USING NEW.venue_id,target_run,day.local_date,day.cumulative_venue_turnover-day.previous_venue_turnover,day.cumulative_venue_turnover;
    IF mismatch<>0 THEN RAISE EXCEPTION 'milestone daily turnover mismatch' USING ERRCODE='23514'; END IF;
    FOR decision IN EXECUTE format('SELECT * FROM %I.payroll_milestone_decision_snapshots WHERE venue_id=$1 AND run_id=$2 AND day_snapshot_id=$3',TG_TABLE_SCHEMA)
        USING NEW.venue_id,target_run,day.id LOOP
      IF decision.threshold_amount<=day.previous_venue_turnover OR decision.threshold_amount>day.cumulative_venue_turnover
        OR (cardinality(decision.qualifying_shift_ids)>0 AND array_ndims(decision.qualifying_shift_ids)<>1) THEN
        RAISE EXCEPTION 'milestone crossing or shift array invalid' USING ERRCODE='23514';
      END IF;
      IF array_position(decision.qualifying_shift_ids,NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'milestone null shift invalid' USING ERRCODE='23514';
      END IF;
      SELECT COALESCE(array_agg(s ORDER BY s),ARRAY[]::uuid[]) INTO actual_shifts FROM unnest(decision.qualifying_shift_ids) AS s;
      EXECUTE format('SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[]),COALESCE(sum(worked_minutes),0) FROM %I.payroll_attendance_approval_shifts WHERE venue_id=$1 AND approval_id=$2 AND employee_id=$3 AND work_date=$4 AND worked_minutes>0',TG_TABLE_SCHEMA)
        INTO expected_shifts,worked_total USING NEW.venue_id,day.attendance_approval_id,decision.employee_id,day.local_date;
      IF actual_shifts IS DISTINCT FROM expected_shifts OR worked_total<>decision.approved_worked_minutes THEN
        RAISE EXCEPTION 'milestone frozen attendance mismatch' USING ERRCODE='23514';
      END IF;
      EXECUTE format('SELECT count(*) FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND local_date=$3 AND employee_id=$4 AND (role_key_snapshot<>$5 OR employee_name_snapshot<>$6)',TG_TABLE_SCHEMA)
        INTO mismatch USING NEW.venue_id,target_run,day.local_date,decision.employee_id,decision.role_key_snapshot,decision.employee_name_snapshot;
      IF mismatch<>0 THEN RAISE EXCEPTION 'milestone employee snapshot context mismatch' USING ERRCODE='23514'; END IF;
    END LOOP;
    EXECUTE format($query$
      WITH awards AS (SELECT employee_id,sum(awarded_amount) AS amount FROM %1$I.payroll_milestone_decision_snapshots WHERE venue_id=$1 AND run_id=$2 AND local_date=$3 GROUP BY employee_id),
      paid AS (SELECT employee_id,milestone_bonus AS amount FROM %1$I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND local_date=$3)
      SELECT count(*) FROM awards FULL JOIN paid USING(employee_id) WHERE COALESCE(awards.amount,0)<>COALESCE(paid.amount,0)
    $query$,TG_TABLE_SCHEMA) INTO mismatch USING NEW.venue_id,target_run,day.local_date;
    IF mismatch<>0 THEN RAISE EXCEPTION 'milestone employee bonus conservation mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['payroll_milestone_day_snapshots','payroll_milestone_decision_snapshots'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_context',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION payroll_require_milestone_context()',table_name||'_context',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_reject_history_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_no_truncate',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_history_mutation()',table_name||'_no_truncate',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['payroll_calculation_runs','payroll_daily_snapshots','payroll_milestone_day_snapshots','payroll_milestone_decision_snapshots'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_milestone_totals',table_name);
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_milestone_totals()',table_name||'_milestone_totals',table_name);
  END LOOP;
END;
$$;
