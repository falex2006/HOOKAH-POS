-- Storage contract only. Neither these constraints nor supplied snapshots
-- attest upstream sources or authorize an official run/payment.
ALTER TABLE payroll_daily_snapshots
  ADD COLUMN IF NOT EXISTS snapshot_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS calculation_kind text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS team_fund_pay numeric(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS incentive_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE payroll_daily_snapshot_lines
  ADD COLUMN IF NOT EXISTS snapshot_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS calculation_kind text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS commission_kind text NOT NULL DEFAULT 'scalar',
  ADD COLUMN IF NOT EXISTS incentive_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cost_snapshot_json jsonb,
  ADD COLUMN IF NOT EXISTS net_cost_amount numeric(16,2),
  ADD COLUMN IF NOT EXISTS signed_margin_amount numeric(16,2),
  ADD COLUMN IF NOT EXISTS team_pool_snapshot_id uuid,
  ADD COLUMN IF NOT EXISTS pool_included boolean,
  ADD COLUMN IF NOT EXISTS pool_basis_amount numeric(16,2),
  ADD COLUMN IF NOT EXISTS pool_exclusion_reason text;
ALTER TABLE payroll_daily_snapshot_lines ALTER COLUMN applied_rate_bps DROP NOT NULL;

ALTER TABLE payroll_daily_snapshots DROP CONSTRAINT IF EXISTS payroll_daily_snapshots_typed_check;
ALTER TABLE payroll_daily_snapshots ADD CONSTRAINT payroll_daily_snapshots_typed_check CHECK (
  snapshot_schema_version IN (1,2) AND jsonb_typeof(incentive_json) = 'object' AND team_fund_pay >= 0
  AND ((snapshot_schema_version=1 AND calculation_kind='legacy' AND team_fund_pay=0 AND incentive_json='{}'::jsonb)
    OR (snapshot_schema_version=2 AND calculation_kind IN ('progressive_daily','stable_percent','percent_only','final_month_threshold','personal_target','team_fund','margin_target')
      AND amount_before_cap=base_pay+commission_pay+milestone_bonus+item_adjustments+team_fund_pay
      AND final_amount=amount_before_cap-cap_reduction
      AND (calculation_kind='team_fund' OR team_fund_pay=0)
      AND (calculation_kind NOT IN ('personal_target','margin_target') OR incentive_json<>'{}'::jsonb)))
);
ALTER TABLE payroll_daily_snapshot_lines DROP CONSTRAINT IF EXISTS payroll_daily_snapshot_lines_typed_check;
ALTER TABLE payroll_daily_snapshot_lines ADD CONSTRAINT payroll_daily_snapshot_lines_typed_check CHECK (
  snapshot_schema_version IN (1,2) AND jsonb_typeof(incentive_json)='object'
  AND ((snapshot_schema_version=1 AND calculation_kind='legacy' AND commission_kind='scalar' AND applied_rate_bps IS NOT NULL
      AND incentive_json='{}'::jsonb AND cost_snapshot_json IS NULL AND net_cost_amount IS NULL AND signed_margin_amount IS NULL
      AND team_pool_snapshot_id IS NULL AND pool_included IS NULL AND pool_basis_amount IS NULL AND pool_exclusion_reason IS NULL)
    OR (snapshot_schema_version=2 AND calculation_kind IN ('progressive_daily','stable_percent','percent_only','final_month_threshold','personal_target','team_fund','margin_target')
      AND ((commission_kind='scalar' AND applied_rate_bps IS NOT NULL AND calculation_kind<>'team_fund')
        OR (commission_kind='personal_target' AND calculation_kind='personal_target' AND applied_rate_bps IS NULL AND incentive_json<>'{}'::jsonb)
        OR (commission_kind='margin_target' AND calculation_kind='margin_target' AND applied_rate_bps IS NULL AND incentive_json<>'{}'::jsonb)
        OR (commission_kind='team_source' AND calculation_kind='team_fund' AND applied_rate_bps IS NOT NULL))
      AND ((calculation_kind='margin_target' AND cost_snapshot_json IS NOT NULL AND jsonb_typeof(cost_snapshot_json)='object'
          AND length(btrim(COALESCE(cost_snapshot_json->>'id',''))) BETWEEN 1 AND 160
          AND length(btrim(COALESCE(cost_snapshot_json->>'version',''))) BETWEEN 1 AND 160
          AND COALESCE(jsonb_typeof(cost_snapshot_json->'id'),'')='string'
          AND COALESCE(jsonb_typeof(cost_snapshot_json->'version'),'')='string'
          AND COALESCE(jsonb_typeof(cost_snapshot_json->'currency'),'')='string'
          AND COALESCE(cost_snapshot_json->>'currency','') ~ '^[A-Z]{3}$'
          AND net_cost_amount IS NOT NULL AND net_cost_amount>=0 AND signed_margin_amount IS NOT NULL
          AND CASE WHEN COALESCE(jsonb_typeof(cost_snapshot_json->'costCents'),'')='number'
              AND COALESCE(cost_snapshot_json->>'costCents','') ~ '^[0-9]+$'
            THEN (cost_snapshot_json->>'costCents')::numeric BETWEEN 0 AND 9007199254740991
              AND (cost_snapshot_json->>'costCents')::numeric=net_cost_amount*100 ELSE false END
          AND signed_margin_amount=commission_base_net-net_cost_amount)
        OR (calculation_kind<>'margin_target' AND cost_snapshot_json IS NULL AND net_cost_amount IS NULL AND signed_margin_amount IS NULL))
      AND ((calculation_kind='team_fund' AND team_pool_snapshot_id IS NOT NULL AND pool_included IS NOT NULL AND pool_basis_amount IS NOT NULL
          AND ((pool_included AND pool_basis_amount=commission_base_net AND pool_exclusion_reason IS NULL)
            OR (NOT pool_included AND pool_basis_amount=0 AND pool_exclusion_reason IS NOT NULL AND pool_exclusion_reason IN ('item_replacement','department_outside_pool'))))
        OR (calculation_kind<>'team_fund' AND team_pool_snapshot_id IS NULL AND pool_included IS NULL AND pool_basis_amount IS NULL AND pool_exclusion_reason IS NULL))))
);

CREATE OR REPLACE FUNCTION payroll_typed_departments_valid(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; seen text[]:='{}'; label text;
BEGIN
  IF value IS NULL OR jsonb_typeof(value)<>'array' OR jsonb_array_length(value)=0 THEN RETURN false; END IF;
  FOR item IN SELECT v FROM jsonb_array_elements(value) AS entries(v) LOOP
    IF jsonb_typeof(item)<>'string' THEN RETURN false; END IF;
    label:=item#>>'{}';
    IF label<>btrim(label) OR length(label) NOT BETWEEN 1 AND 80 OR label=ANY(seen) THEN RETURN false; END IF;
    seen:=array_append(seen,label);
  END LOOP;
  RETURN true;
END;
$$;
CREATE TABLE IF NOT EXISTS payroll_team_fund_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  local_date date NOT NULL,
  pool_key text NOT NULL CHECK (length(btrim(pool_key)) BETWEEN 1 AND 160),
  departments_json jsonb NOT NULL CHECK (payroll_typed_departments_valid(departments_json)),
  distribution_policy text NOT NULL CHECK (distribution_policy IN ('approved_minutes','configured_weights')),
  basis_amount numeric(16,2) NOT NULL CHECK (basis_amount>=0),
  target_amount numeric(16,2) NOT NULL CHECK (target_amount>=0),
  below_target_amount numeric(16,2) NOT NULL CHECK (below_target_amount>=0),
  excess_amount numeric(16,2) NOT NULL CHECK (excess_amount>=0),
  base_basis_amount numeric(16,2) NOT NULL CHECK (base_basis_amount>=0),
  base_rate_bps integer NOT NULL CHECK (base_rate_bps BETWEEN 0 AND 10000),
  bonus_rate_bps integer NOT NULL CHECK (bonus_rate_bps BETWEEN 0 AND 10000),
  excess_rate_policy text NOT NULL CHECK (excess_rate_policy IN ('replace_base','add_to_base')),
  base_commission numeric(16,2) NOT NULL CHECK (base_commission>=0),
  excess_commission numeric(16,2) NOT NULL CHECK (excess_commission>=0),
  fund_amount numeric(16,2) NOT NULL CHECK (fund_amount>=0),
  rounding_policy text NOT NULL CHECK (rounding_policy='component_half_up_v1'),
  evidence_json jsonb NOT NULL CHECK (jsonb_typeof(evidence_json)='object'),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,id,run_id,local_date),
  UNIQUE (venue_id,run_id,local_date,pool_key),
  FOREIGN KEY (venue_id,run_id) REFERENCES payroll_calculation_runs(venue_id,id) ON DELETE RESTRICT,
  CHECK (below_target_amount=LEAST(basis_amount,target_amount) AND excess_amount=basis_amount-below_target_amount),
  CHECK (base_basis_amount=CASE excess_rate_policy WHEN 'replace_base' THEN below_target_amount ELSE basis_amount END),
  CHECK (base_commission=round(base_basis_amount*base_rate_bps/10000,2)
    AND excess_commission=round(excess_amount*bonus_rate_bps/10000,2)
    AND fund_amount=base_commission+excess_commission)
);
CREATE TABLE IF NOT EXISTS payroll_team_fund_snapshot_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  local_date date NOT NULL,
  pool_snapshot_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  weight bigint NOT NULL CHECK (weight BETWEEN 0 AND 9007199254740991),
  allocated_amount numeric(16,2) NOT NULL CHECK (allocated_amount>=0),
  allocation_policy text NOT NULL CHECK (allocation_policy='largest_remainder_code_unit_v1'),
  CHECK (weight>0 OR allocated_amount=0),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,run_id,local_date,employee_id),
  UNIQUE (venue_id,pool_snapshot_id,employee_id),
  FOREIGN KEY (venue_id,pool_snapshot_id,run_id,local_date)
    REFERENCES payroll_team_fund_snapshots(venue_id,id,run_id,local_date) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,snapshot_id,run_id,employee_id,local_date)
    REFERENCES payroll_daily_snapshots(venue_id,id,run_id,employee_id,local_date) ON DELETE RESTRICT
);
ALTER TABLE payroll_daily_snapshot_lines DROP CONSTRAINT IF EXISTS payroll_snapshot_line_team_pool_fk;
ALTER TABLE payroll_daily_snapshot_lines ADD CONSTRAINT payroll_snapshot_line_team_pool_fk
  FOREIGN KEY (venue_id,team_pool_snapshot_id,run_id,local_date)
  REFERENCES payroll_team_fund_snapshots(venue_id,id,run_id,local_date) ON DELETE RESTRICT;

-- Resolve through the trigger's schema, never an ambient search_path.
CREATE OR REPLACE FUNCTION payroll_validate_typed_snapshot_context() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_kind text; parent_schema integer; run_currency text;
BEGIN
  IF TG_TABLE_NAME='payroll_daily_snapshot_lines' THEN
    EXECUTE format('SELECT calculation_kind,snapshot_schema_version FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND id=$2 AND run_id=$3 AND employee_id=$4 AND local_date=$5',TG_TABLE_SCHEMA)
      INTO parent_kind,parent_schema USING NEW.venue_id,NEW.snapshot_id,NEW.run_id,NEW.employee_id,NEW.local_date;
    IF parent_kind IS DISTINCT FROM NEW.calculation_kind OR parent_schema IS DISTINCT FROM NEW.snapshot_schema_version THEN
      RAISE EXCEPTION 'typed payroll line/daily schema mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.calculation_kind='margin_target' THEN
      EXECUTE format('SELECT currency FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2',TG_TABLE_SCHEMA)
        INTO run_currency USING NEW.venue_id,NEW.run_id;
      IF run_currency IS NULL OR NEW.cost_snapshot_json->>'currency' IS DISTINCT FROM btrim(run_currency) THEN
        RAISE EXCEPTION 'margin cost currency does not match run' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='payroll_team_fund_snapshot_allocations' THEN
    EXECUTE format('SELECT calculation_kind,snapshot_schema_version FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND id=$2 AND run_id=$3 AND employee_id=$4 AND local_date=$5',TG_TABLE_SCHEMA)
      INTO parent_kind,parent_schema USING NEW.venue_id,NEW.snapshot_id,NEW.run_id,NEW.employee_id,NEW.local_date;
    IF parent_kind IS DISTINCT FROM 'team_fund' OR parent_schema IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'team allocation requires typed team employee snapshot' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_validate_typed_snapshot_totals() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE pool record; employee record; source_line record; member record; shift jsonb; shift_ids text[]; worked_total numeric; shift_pay numeric; member_value jsonb; member_text text; member_ids text[]; eligible boolean; expected_exclusion text; allocated numeric; basis numeric; total_weight numeric; count_rows bigint; mismatch_count bigint;
BEGIN
  -- Every insertion serializes on its immutable parent run; deferred checks see
  -- the complete atomic batch regardless of INSERT ordering within that batch.
  EXECUTE format('SELECT id FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE',TG_TABLE_SCHEMA) USING NEW.venue_id,NEW.run_id;
  FOR pool IN EXECUTE format('SELECT id,fund_amount,basis_amount,departments_json,evidence_json,distribution_policy FROM %I.payroll_team_fund_snapshots WHERE venue_id=$1 AND run_id=$2',TG_TABLE_SCHEMA) USING NEW.venue_id,NEW.run_id LOOP
    IF jsonb_typeof(pool.evidence_json->'memberIds') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'team pool member evidence is missing' USING ERRCODE='23514';
    END IF;
    member_ids:=ARRAY[]::text[];
    FOR member_value IN SELECT value FROM jsonb_array_elements(pool.evidence_json->'memberIds') AS members(value) LOOP
      IF jsonb_typeof(member_value)<>'string' THEN RAISE EXCEPTION 'team pool member evidence is invalid' USING ERRCODE='23514'; END IF;
      member_text:=lower(member_value#>>'{}');
      IF member_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR member_text=ANY(member_ids) THEN
        RAISE EXCEPTION 'team pool member evidence is invalid' USING ERRCODE='23514';
      END IF;
      member_ids:=array_append(member_ids,member_text);
    END LOOP;
    EXECUTE format('SELECT COALESCE(sum(allocated_amount),0),count(*),COALESCE(sum(weight),0) FROM %I.payroll_team_fund_snapshot_allocations WHERE venue_id=$1 AND pool_snapshot_id=$2',TG_TABLE_SCHEMA)
      INTO allocated,count_rows,total_weight USING NEW.venue_id,pool.id;
    EXECUTE format('SELECT count(*) FILTER (WHERE employee_id::text <> ALL($3)) FROM %I.payroll_team_fund_snapshot_allocations WHERE venue_id=$1 AND pool_snapshot_id=$2',TG_TABLE_SCHEMA)
      INTO mismatch_count USING NEW.venue_id,pool.id,member_ids;
    IF cardinality(member_ids)=0 OR count_rows<>cardinality(member_ids) OR mismatch_count<>0
      OR allocated<>pool.fund_amount OR (pool.fund_amount>0 AND total_weight=0) THEN
      RAISE EXCEPTION 'team pool allocations do not conserve fund' USING ERRCODE='23514';
    END IF;
    -- Validate frozen attendance arithmetic, without attesting source approval.
    IF pool.distribution_policy='approved_minutes' THEN
      FOR member IN EXECUTE format('SELECT a.weight,d.explanation_json,d.eligible_shift_count,d.base_pay FROM %I.payroll_team_fund_snapshot_allocations a JOIN %I.payroll_daily_snapshots d ON d.venue_id=a.venue_id AND d.id=a.snapshot_id WHERE a.venue_id=$1 AND a.pool_snapshot_id=$2',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA) USING NEW.venue_id,pool.id LOOP
        IF jsonb_typeof(member.explanation_json->'shiftDetails') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'team attendance details missing' USING ERRCODE='23514'; END IF;
        shift_ids:=ARRAY[]::text[]; worked_total:=0; shift_pay:=0;
        FOR shift IN SELECT value FROM jsonb_array_elements(member.explanation_json->'shiftDetails') AS details(value) LOOP
          IF jsonb_typeof(shift) IS DISTINCT FROM 'object' OR jsonb_typeof(shift->'shiftId') IS DISTINCT FROM 'string'
            OR length(shift->>'shiftId') NOT BETWEEN 1 AND 160 OR (shift->>'shiftId')=ANY(shift_ids)
            OR jsonb_typeof(shift->'workedMinutes') IS DISTINCT FROM 'number' OR COALESCE(shift->>'workedMinutes','') !~ '^[0-9]+$'
            OR jsonb_typeof(shift->'plannedMinutes') IS DISTINCT FROM 'number' OR COALESCE(shift->>'plannedMinutes','') !~ '^[0-9]+$'
            OR jsonb_typeof(shift->'amountCents') IS DISTINCT FROM 'number' OR COALESCE(shift->>'amountCents','') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'team attendance details invalid' USING ERRCODE='23514';
          END IF;
          IF (shift->>'workedMinutes')::numeric>9007199254740991 OR (shift->>'plannedMinutes')::numeric NOT BETWEEN 1 AND 9007199254740991 OR (shift->>'amountCents')::numeric>9007199254740991 THEN
            RAISE EXCEPTION 'team attendance details out of range' USING ERRCODE='23514';
          END IF;
          shift_ids:=array_append(shift_ids,shift->>'shiftId'); worked_total:=worked_total+(shift->>'workedMinutes')::numeric; shift_pay:=shift_pay+(shift->>'amountCents')::numeric;
        END LOOP;
        IF worked_total<>member.weight OR cardinality(shift_ids)<>member.eligible_shift_count OR shift_pay<>member.base_pay*100 THEN
          RAISE EXCEPTION 'team attendance weight mismatch' USING ERRCODE='23514';
        END IF;
      END LOOP;
    END IF;
    -- Exact integer quotient and canonical code-unit UUID tie break.
    EXECUTE format($query$
      WITH weighted AS (
        SELECT employee_id,weight::numeric AS weight_value,allocated_amount*100 AS actual_cents,
          $3::numeric*100 AS fund_cents,SUM(weight::numeric) OVER() AS total_weight
        FROM %1$I.payroll_team_fund_snapshot_allocations WHERE venue_id=$1 AND pool_snapshot_id=$2
      ),quotients AS (
        SELECT *,CASE WHEN total_weight>0 THEN div(fund_cents*weight_value,total_weight) ELSE 0 END AS base_cents,
          CASE WHEN total_weight>0 THEN mod(fund_cents*weight_value,total_weight) ELSE 0 END AS remainder
        FROM weighted
      ),ranked AS (
        SELECT *,SUM(base_cents) OVER() AS base_sum,
          row_number() OVER (ORDER BY remainder DESC,lower(employee_id::text) COLLATE "C" ASC) AS share_rank
        FROM quotients
      )
      SELECT count(*) FROM ranked
      WHERE actual_cents<>base_cents+CASE WHEN share_rank<=fund_cents-base_sum THEN 1 ELSE 0 END
    $query$,TG_TABLE_SCHEMA) INTO mismatch_count USING NEW.venue_id,pool.id,pool.fund_amount;
    IF mismatch_count<>0 THEN RAISE EXCEPTION 'team fund allocations do not match recorded weights' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT COALESCE(sum(pool_basis_amount),0) FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND team_pool_snapshot_id=$2',TG_TABLE_SCHEMA)
      INTO basis USING NEW.venue_id,pool.id;
    IF basis<>pool.basis_amount THEN RAISE EXCEPTION 'team pool source basis mismatch' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT count(*) FROM %I.payroll_daily_snapshot_lines l WHERE l.venue_id=$1 AND l.team_pool_snapshot_id=$2 AND NOT EXISTS (SELECT 1 FROM %I.payroll_team_fund_snapshot_allocations a WHERE a.venue_id=l.venue_id AND a.pool_snapshot_id=l.team_pool_snapshot_id AND a.employee_id=l.employee_id)',TG_TABLE_SCHEMA,TG_TABLE_SCHEMA)
      INTO count_rows USING NEW.venue_id,pool.id;
    IF count_rows<>0 THEN RAISE EXCEPTION 'team pool source employee is not a member' USING ERRCODE='23514'; END IF;
    FOR source_line IN EXECUTE format('SELECT department_key,pool_included,pool_exclusion_reason,incentive_json FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND team_pool_snapshot_id=$2',TG_TABLE_SCHEMA) USING NEW.venue_id,pool.id LOOP
      eligible:=(pool.departments_json ? source_line.department_key) AND COALESCE(source_line.incentive_json->>'itemRuleMode','')<>'replace';
      expected_exclusion:=CASE WHEN eligible THEN NULL WHEN source_line.incentive_json->>'itemRuleMode'='replace' THEN 'item_replacement' ELSE 'department_outside_pool' END;
      IF source_line.pool_included IS DISTINCT FROM eligible OR source_line.pool_exclusion_reason IS DISTINCT FROM expected_exclusion THEN
        RAISE EXCEPTION 'team pool source eligibility mismatch' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END LOOP;
  FOR employee IN EXECUTE format('SELECT id,employee_id,local_date,calculation_kind,team_fund_pay,commission_pay FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND snapshot_schema_version=2',TG_TABLE_SCHEMA) USING NEW.venue_id,NEW.run_id LOOP
    EXECUTE format('SELECT COALESCE(sum(commission_amount),0) FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND snapshot_id=$2',TG_TABLE_SCHEMA)
      INTO allocated USING NEW.venue_id,employee.id;
    IF allocated<>employee.commission_pay THEN RAISE EXCEPTION 'typed daily commission does not match lines' USING ERRCODE='23514'; END IF;
    EXECUTE format('SELECT COALESCE(sum(allocated_amount),0),count(*) FROM %I.payroll_team_fund_snapshot_allocations WHERE venue_id=$1 AND snapshot_id=$2',TG_TABLE_SCHEMA)
      INTO allocated,count_rows USING NEW.venue_id,employee.id;
    IF allocated<>employee.team_fund_pay OR (employee.calculation_kind='team_fund' AND count_rows<>1)
      OR (employee.calculation_kind<>'team_fund' AND count_rows<>0) THEN
      RAISE EXCEPTION 'typed daily team share does not match membership' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_reject_typed_snapshot_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'payroll snapshots cannot be truncated' USING ERRCODE='55000'; END; $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['payroll_daily_snapshots','payroll_daily_snapshot_lines','payroll_team_fund_snapshots','payroll_team_fund_snapshot_allocations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_typed_totals',table_name);
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_typed_snapshot_totals()',table_name||'_typed_totals',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_truncate_guard',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_typed_snapshot_truncate()',table_name||'_truncate_guard',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['payroll_team_fund_snapshots','payroll_team_fund_snapshot_allocations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_immutable',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_reject_history_mutation()',table_name||'_immutable',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I',table_name||'_ready_run_guard',table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION payroll_require_ready_run()',table_name||'_ready_run_guard',table_name);
  END LOOP;
END;
$$;
DROP TRIGGER IF EXISTS payroll_snapshot_line_typed_context ON payroll_daily_snapshot_lines;
CREATE TRIGGER payroll_snapshot_line_typed_context BEFORE INSERT ON payroll_daily_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_typed_snapshot_context();
DROP TRIGGER IF EXISTS payroll_team_allocation_typed_context ON payroll_team_fund_snapshot_allocations;
CREATE TRIGGER payroll_team_allocation_typed_context BEFORE INSERT ON payroll_team_fund_snapshot_allocations
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_typed_snapshot_context();
