-- Additive payroll configuration and calculation history.
-- This migration intentionally does not alter payroll_entries or expenses and
-- does not create a payout/expense path. Existing history is not backfilled.

CREATE UNIQUE INDEX IF NOT EXISTS users_venue_id_id_uq
  ON users (venue_id, id);

CREATE TABLE IF NOT EXISTS payroll_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  CONSTRAINT payroll_schemes_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payroll_scheme_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  scheme_id uuid NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  mode text NOT NULL CHECK (mode IN ('progressive_daily','stable_percent','percent_only','final_month_threshold')),
  currency char(3) NOT NULL DEFAULT 'RUB' CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from date NOT NULL,
  effective_to date,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_json) = 'object'),
  engine_version text NOT NULL DEFAULT 'payroll-schemes-v1',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_by uuid,
  status_changed_by_name text,
  status_changed_at timestamptz,
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, scheme_id, version_no),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK ((status = 'draft' AND status_changed_by IS NULL AND status_changed_at IS NULL AND status_changed_by_name IS NULL)
      OR (status <> 'draft' AND status_changed_by IS NOT NULL AND status_changed_at IS NOT NULL
          AND status_changed_by_name IS NOT NULL AND length(btrim(status_changed_by_name)) BETWEEN 1 AND 160)),
  CONSTRAINT payroll_scheme_versions_scheme_venue_fk
    FOREIGN KEY (venue_id, scheme_id) REFERENCES payroll_schemes (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_scheme_versions_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_scheme_versions_status_actor_venue_fk
    FOREIGN KEY (venue_id, status_changed_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_scheme_versions_effective_idx
  ON payroll_scheme_versions (venue_id, scheme_id, effective_from DESC, effective_to);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_scheme_versions_one_active_window_uq
  ON payroll_scheme_versions (venue_id, scheme_id, effective_from)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS payroll_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  scheme_version_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  role_key text NOT NULL CHECK (length(btrim(role_key)) BETWEEN 1 AND 80),
  effective_from date NOT NULL,
  effective_to date,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, scheme_version_id, employee_id, effective_from),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_role_assignments_version_venue_fk
    FOREIGN KEY (venue_id, scheme_version_id) REFERENCES payroll_scheme_versions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_role_assignments_employee_venue_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_role_assignments_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_role_assignments_employee_period_idx
  ON payroll_role_assignments (venue_id, employee_id, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS payroll_employee_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  scheme_version_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  parameter_path text NOT NULL CHECK (parameter_path ~ '^(mode|applyMilestones|perShiftCents|stableRateBps|bracketRatesBps\.[0-9]+|cap\.(rateBps|basis)|milestoneBonusesCents\.[0-9]+)$'),
  override_mode text NOT NULL CHECK (override_mode IN ('inherit','override')),
  value_json jsonb,
  effective_from date NOT NULL,
  effective_to date,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, scheme_version_id, employee_id, parameter_path, effective_from),
  CHECK ((override_mode = 'inherit' AND value_json IS NULL) OR (override_mode = 'override' AND value_json IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT payroll_employee_overrides_version_venue_fk
    FOREIGN KEY (venue_id, scheme_version_id) REFERENCES payroll_scheme_versions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_employee_overrides_employee_venue_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_employee_overrides_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_employee_overrides_lookup_idx
  ON payroll_employee_overrides (venue_id, scheme_version_id, employee_id, effective_from, effective_to);

CREATE TABLE IF NOT EXISTS payroll_item_commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  scheme_version_id uuid NOT NULL,
  product_id uuid NOT NULL,
  role_key text,
  employee_id uuid,
  rule_mode text NOT NULL CHECK (rule_mode IN ('replace','additive')),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  priority integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  CHECK ((role_key IS NOT NULL AND employee_id IS NULL AND length(btrim(role_key)) BETWEEN 1 AND 80)
      OR (role_key IS NULL AND employee_id IS NOT NULL)),
  CONSTRAINT payroll_item_commission_rules_version_venue_fk
    FOREIGN KEY (venue_id, scheme_version_id) REFERENCES payroll_scheme_versions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_item_commission_rules_product_venue_fk
    FOREIGN KEY (venue_id, product_id) REFERENCES products (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_item_commission_rules_employee_venue_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_item_commission_rules_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_item_commission_role_rule_uq
  ON payroll_item_commission_rules (venue_id, scheme_version_id, product_id, role_key)
  WHERE role_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_item_commission_employee_rule_uq
  ON payroll_item_commission_rules (venue_id, scheme_version_id, product_id, employee_id)
  WHERE employee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_calculation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  scheme_version_id uuid NOT NULL,
  period_from date NOT NULL,
  period_to date NOT NULL,
  status text NOT NULL CHECK (status IN ('blocked','ready')),
  source_coverage text NOT NULL CHECK (source_coverage IN ('unknown','incomplete','complete')),
  commission_basis text NOT NULL CHECK (commission_basis IN ('unknown','net_after_discounts_refunds')),
  eligible_line_count integer NOT NULL CHECK (eligible_line_count >= 0),
  unattributed_line_count integer NOT NULL CHECK (unattributed_line_count >= 0),
  missing_net_line_count integer NOT NULL CHECK (missing_net_line_count >= 0),
  input_watermark text NOT NULL CHECK (length(btrim(input_watermark)) BETWEEN 1 AND 500),
  input_checksum char(64) CHECK (input_checksum IS NULL OR input_checksum ~ '^[0-9a-f]{64}$'),
  engine_version text NOT NULL CHECK (length(btrim(engine_version)) BETWEEN 1 AND 120),
  blocked_reason text,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 160),
  supersedes_run_id uuid,
  recalculation_reason text,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, idempotency_key),
  CHECK (period_to >= period_from),
  CHECK (status <> 'ready' OR (source_coverage = 'complete'
    AND commission_basis = 'net_after_discounts_refunds'
    AND unattributed_line_count = 0 AND missing_net_line_count = 0
    AND input_checksum IS NOT NULL AND blocked_reason IS NULL)),
  CHECK (status <> 'blocked' OR length(btrim(COALESCE(blocked_reason,''))) BETWEEN 1 AND 1000),
  CHECK (supersedes_run_id IS NULL OR length(btrim(COALESCE(recalculation_reason,''))) BETWEEN 3 AND 1000),
  CONSTRAINT payroll_calculation_runs_version_venue_fk
    FOREIGN KEY (venue_id, scheme_version_id) REFERENCES payroll_scheme_versions (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_calculation_runs_supersedes_venue_fk
    FOREIGN KEY (venue_id, supersedes_run_id) REFERENCES payroll_calculation_runs (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_calculation_runs_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_calculation_runs_period_idx
  ON payroll_calculation_runs (venue_id, period_from, period_to, created_at DESC);

CREATE TABLE IF NOT EXISTS payroll_daily_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name_snapshot text NOT NULL CHECK (length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160),
  role_key_snapshot text NOT NULL CHECK (length(btrim(role_key_snapshot)) BETWEEN 1 AND 80),
  local_date date NOT NULL,
  eligible_shift_count integer NOT NULL DEFAULT 0 CHECK (eligible_shift_count >= 0),
  venue_turnover numeric(16,2) NOT NULL DEFAULT 0 CHECK (venue_turnover >= 0),
  cumulative_venue_turnover numeric(16,2) NOT NULL DEFAULT 0 CHECK (cumulative_venue_turnover >= 0),
  base_pay numeric(16,2) NOT NULL DEFAULT 0 CHECK (base_pay >= 0),
  commission_pay numeric(16,2) NOT NULL DEFAULT 0 CHECK (commission_pay >= 0),
  milestone_bonus numeric(16,2) NOT NULL DEFAULT 0 CHECK (milestone_bonus >= 0),
  item_adjustments numeric(16,2) NOT NULL DEFAULT 0 CHECK (item_adjustments >= 0),
  amount_before_cap numeric(16,2) NOT NULL CHECK (amount_before_cap >= 0),
  cap_amount numeric(16,2) CHECK (cap_amount IS NULL OR cap_amount >= 0),
  cap_reduction numeric(16,2) NOT NULL DEFAULT 0 CHECK (cap_reduction >= 0),
  final_amount numeric(16,2) NOT NULL CHECK (final_amount >= 0),
  explanation_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(explanation_json) = 'object'),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, run_id, employee_id, local_date),
  UNIQUE (venue_id, id, run_id, employee_id, local_date),
  CONSTRAINT payroll_daily_snapshots_run_venue_fk
    FOREIGN KEY (venue_id, run_id) REFERENCES payroll_calculation_runs (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_daily_snapshots_employee_venue_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_daily_snapshots_employee_date_idx
  ON payroll_daily_snapshots (venue_id, employee_id, local_date DESC);

CREATE TABLE IF NOT EXISTS payroll_daily_snapshot_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  employee_name_snapshot text NOT NULL CHECK (length(btrim(employee_name_snapshot)) BETWEEN 1 AND 160),
  menu_item_id uuid NOT NULL,
  menu_item_name_snapshot text NOT NULL CHECK (length(btrim(menu_item_name_snapshot)) BETWEEN 1 AND 160),
  department_key text NOT NULL CHECK (length(btrim(department_key)) BETWEEN 1 AND 80),
  sold_at timestamptz NOT NULL,
  local_date date NOT NULL,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  gross_amount numeric(16,2) NOT NULL CHECK (gross_amount >= 0),
  discount_amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  refund_amount numeric(16,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  commission_base_net numeric(16,2) NOT NULL CHECK (commission_base_net >= 0),
  applied_rate_bps integer NOT NULL CHECK (applied_rate_bps BETWEEN 0 AND 20000),
  item_rule_id uuid,
  commission_amount numeric(16,2) NOT NULL CHECK (commission_amount >= 0),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, run_id, order_item_id),
  CHECK (discount_amount + refund_amount <= gross_amount),
  CHECK (commission_base_net = gross_amount - discount_amount - refund_amount),
  CONSTRAINT payroll_daily_snapshot_lines_run_venue_fk
    FOREIGN KEY (venue_id, run_id) REFERENCES payroll_calculation_runs (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_daily_snapshot_lines_snapshot_run_fk
    FOREIGN KEY (venue_id, snapshot_id, run_id, employee_id, local_date)
    REFERENCES payroll_daily_snapshots (venue_id, id, run_id, employee_id, local_date) ON DELETE RESTRICT,
  CONSTRAINT payroll_daily_snapshot_lines_order_venue_fk
    FOREIGN KEY (venue_id, order_id) REFERENCES orders (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_daily_snapshot_lines_employee_venue_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_daily_snapshot_lines_item_rule_venue_fk
    FOREIGN KEY (venue_id, item_rule_id) REFERENCES payroll_item_commission_rules (venue_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS payroll_daily_snapshot_lines_source_idx
  ON payroll_daily_snapshot_lines (venue_id, order_id, order_item_id);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  source_snapshot_line_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('refund','void','manual_correction')),
  source_key text NOT NULL CHECK (length(btrim(source_key)) BETWEEN 1 AND 200),
  source_allocation_key text NOT NULL CHECK (length(btrim(source_allocation_key)) BETWEEN 1 AND 200),
  amount_delta numeric(16,2) NOT NULL CHECK (amount_delta <> 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 160),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, source_kind, source_key, source_allocation_key),
  UNIQUE (venue_id, idempotency_key),
  CHECK (source_kind = 'manual_correction' OR amount_delta < 0),
  CONSTRAINT payroll_adjustments_source_line_venue_fk
    FOREIGN KEY (venue_id, source_snapshot_line_id) REFERENCES payroll_daily_snapshot_lines (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_adjustments_employee_venue_fk
    FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_adjustments_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS payroll_adjustment_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  adjustment_id uuid NOT NULL,
  target_run_id uuid NOT NULL,
  applied_amount numeric(16,2) NOT NULL CHECK (applied_amount > 0),
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, id),
  UNIQUE (venue_id, adjustment_id, target_run_id),
  CONSTRAINT payroll_adjustment_applications_adjustment_venue_fk
    FOREIGN KEY (venue_id, adjustment_id) REFERENCES payroll_adjustments (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_adjustment_applications_run_venue_fk
    FOREIGN KEY (venue_id, target_run_id) REFERENCES payroll_calculation_runs (venue_id, id) ON DELETE RESTRICT,
  CONSTRAINT payroll_adjustment_applications_creator_venue_fk
    FOREIGN KEY (venue_id, created_by) REFERENCES users (venue_id, id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION payroll_require_draft_version_for_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
  version_from date;
  version_to date;
  conflict_id uuid;
  overlap_lock bigint;
BEGIN
  EXECUTE format('SELECT status,effective_from,effective_to FROM %I.payroll_scheme_versions WHERE venue_id = $1 AND id = $2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO version_status,version_from,version_to USING NEW.venue_id, NEW.scheme_version_id;
  IF version_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'payroll scheme version children are writable only while draft' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME IN ('payroll_role_assignments','payroll_employee_overrides') THEN
    IF NEW.effective_from < version_from
       OR (version_to IS NOT NULL AND (NEW.effective_to IS NULL OR NEW.effective_to > version_to)) THEN
      RAISE EXCEPTION 'payroll assignment/override window is outside scheme version effective window' USING ERRCODE = '23514';
    END IF;
    overlap_lock := hashtextextended(NEW.venue_id::text || ':' || NEW.scheme_version_id::text || ':' || NEW.employee_id::text || ':' || TG_TABLE_NAME, 0);
    PERFORM pg_advisory_xact_lock(overlap_lock);
  END IF;
  IF TG_TABLE_NAME = 'payroll_role_assignments' THEN
    EXECUTE format('SELECT id FROM %I.payroll_role_assignments WHERE venue_id=$1 AND scheme_version_id=$2 AND employee_id=$3 AND effective_from <= COALESCE($5,''infinity''::date) AND COALESCE(effective_to,''infinity''::date) >= $4 LIMIT 1', TG_TABLE_SCHEMA)
      INTO conflict_id USING NEW.venue_id, NEW.scheme_version_id, NEW.employee_id, NEW.effective_from, NEW.effective_to;
  ELSIF TG_TABLE_NAME = 'payroll_employee_overrides' THEN
    EXECUTE format('SELECT id FROM %I.payroll_employee_overrides WHERE venue_id=$1 AND scheme_version_id=$2 AND employee_id=$3 AND parameter_path=$4 AND effective_from <= COALESCE($6,''infinity''::date) AND COALESCE(effective_to,''infinity''::date) >= $5 LIMIT 1', TG_TABLE_SCHEMA)
      INTO conflict_id USING NEW.venue_id, NEW.scheme_version_id, NEW.employee_id, NEW.parameter_path, NEW.effective_from, NEW.effective_to;
  END IF;
  IF conflict_id IS NOT NULL THEN
    RAISE EXCEPTION 'payroll employee assignment or parameter override windows overlap' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_guard_scheme_version_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  window_lock bigint;
  conflicting_version uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll scheme version history is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'payroll scheme versions must be created as draft' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'status_changed_by' - 'status_changed_by_name' - 'status_changed_at' - 'effective_to')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'status_changed_by' - 'status_changed_by_name' - 'status_changed_at' - 'effective_to') THEN
    RAISE EXCEPTION 'payroll scheme version configuration is immutable; create a new version' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'draft' AND NEW.status = 'active')
       OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'invalid payroll scheme version status transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.status_changed_by IS NULL OR NEW.status_changed_at IS NULL OR length(btrim(COALESCE(NEW.status_changed_by_name,''))) = 0 THEN
    RAISE EXCEPTION 'payroll scheme version transition requires actor and timestamp' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'active' THEN
    IF NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
      RAISE EXCEPTION 'activation cannot change payroll scheme effective window' USING ERRCODE = '55000';
    END IF;
    window_lock := hashtextextended(NEW.venue_id::text || ':' || NEW.scheme_id::text, 0);
    PERFORM pg_advisory_xact_lock(window_lock);
    EXECUTE format('SELECT id FROM %I.payroll_scheme_versions WHERE venue_id = $1 AND scheme_id = $2 AND status = ''active'' AND id <> $3 AND effective_from <= COALESCE($4, ''infinity''::date) AND COALESCE(effective_to, ''infinity''::date) >= $5 LIMIT 1', TG_TABLE_SCHEMA)
      INTO conflicting_version USING NEW.venue_id, NEW.scheme_id, NEW.id, NEW.effective_to, NEW.effective_from;
    IF conflicting_version IS NOT NULL THEN
      RAISE EXCEPTION 'active payroll scheme effective windows overlap' USING ERRCODE = '23P01';
    END IF;
  ELSE
    IF NEW.effective_to IS NULL OR NEW.effective_to < NEW.effective_from
      OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to) THEN
      RAISE EXCEPTION 'retiring a payroll scheme version requires a valid closing date' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_reject_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payroll calculation history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION payroll_require_ready_run() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_run record;
BEGIN
  EXECUTE format('SELECT status,period_from,period_to FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO parent_run USING NEW.venue_id, NEW.run_id;
  IF parent_run.status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'blocked or missing payroll runs cannot own snapshots' USING ERRCODE = '55000';
  END IF;
  IF NEW.local_date < parent_run.period_from OR NEW.local_date > parent_run.period_to THEN
    RAISE EXCEPTION 'payroll snapshot date is outside run period' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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
       OR NEW.period_to <> (date_trunc('month', NEW.period_to) + interval '1 month - 1 day')::date) THEN
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

CREATE OR REPLACE FUNCTION payroll_validate_adjustment_application() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  adjustment_row record;
  target_row record;
  source_date date;
  already_applied numeric(16,2);
  employee_in_target_run boolean;
BEGIN
  EXECUTE format('SELECT amount_delta,source_snapshot_line_id,employee_id FROM %I.payroll_adjustments WHERE venue_id=$1 AND id=$2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO adjustment_row USING NEW.venue_id, NEW.adjustment_id;
  IF adjustment_row.source_snapshot_line_id IS NULL THEN
    RAISE EXCEPTION 'payroll adjustment is missing source lineage' USING ERRCODE = '23503';
  END IF;
  EXECUTE format('SELECT period_from,status FROM %I.payroll_calculation_runs WHERE venue_id=$1 AND id=$2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO target_row USING NEW.venue_id, NEW.target_run_id;
  IF target_row.status IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'adjustments can only apply to a ready payroll run' USING ERRCODE = '55000';
  END IF;
  EXECUTE format('SELECT local_date FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND id=$2', TG_TABLE_SCHEMA)
    INTO source_date USING NEW.venue_id, adjustment_row.source_snapshot_line_id;
  IF source_date IS NULL OR target_row.period_from <= source_date THEN
    RAISE EXCEPTION 'late payroll adjustments must target a later open payroll period' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.payroll_daily_snapshots WHERE venue_id=$1 AND run_id=$2 AND employee_id=$3)', TG_TABLE_SCHEMA)
    INTO employee_in_target_run USING NEW.venue_id, NEW.target_run_id, adjustment_row.employee_id;
  IF NOT employee_in_target_run THEN
    RAISE EXCEPTION 'adjustment employee must be represented in the target run' USING ERRCODE = '23514';
  END IF;
  EXECUTE format('SELECT COALESCE(sum(applied_amount),0) FROM %I.payroll_adjustment_applications WHERE venue_id=$1 AND adjustment_id=$2', TG_TABLE_SCHEMA)
    INTO already_applied USING NEW.venue_id, NEW.adjustment_id;
  IF already_applied + NEW.applied_amount > abs(adjustment_row.amount_delta) THEN
    RAISE EXCEPTION 'payroll adjustment applications exceed source amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_validate_adjustment_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_line record;
  existing_reversal_total numeric(16,2);
BEGIN
  EXECUTE format('SELECT employee_id,commission_amount FROM %I.payroll_daily_snapshot_lines WHERE venue_id=$1 AND id=$2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO source_line USING NEW.venue_id, NEW.source_snapshot_line_id;
  IF source_line.employee_id IS DISTINCT FROM NEW.employee_id THEN
    RAISE EXCEPTION 'payroll adjustment employee must match source sale employee' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_kind IN ('refund','void') THEN
    EXECUTE format('SELECT COALESCE(sum(abs(amount_delta)),0) FROM %I.payroll_adjustments WHERE venue_id=$1 AND source_snapshot_line_id=$2 AND source_kind IN (''refund'',''void'')', TG_TABLE_SCHEMA)
      INTO existing_reversal_total USING NEW.venue_id, NEW.source_snapshot_line_id;
    IF existing_reversal_total + abs(NEW.amount_delta) > source_line.commission_amount THEN
      RAISE EXCEPTION 'refund/void payroll adjustments exceed source line commission' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_scheme_versions_status_guard ON payroll_scheme_versions;
CREATE TRIGGER payroll_scheme_versions_status_guard
  BEFORE INSERT OR UPDATE OR DELETE ON payroll_scheme_versions
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_scheme_version_status();

DROP TRIGGER IF EXISTS payroll_role_assignments_draft_guard ON payroll_role_assignments;
CREATE TRIGGER payroll_role_assignments_draft_guard
  BEFORE INSERT ON payroll_role_assignments
  FOR EACH ROW EXECUTE FUNCTION payroll_require_draft_version_for_child();
DROP TRIGGER IF EXISTS payroll_employee_overrides_draft_guard ON payroll_employee_overrides;
CREATE TRIGGER payroll_employee_overrides_draft_guard
  BEFORE INSERT ON payroll_employee_overrides
  FOR EACH ROW EXECUTE FUNCTION payroll_require_draft_version_for_child();
DROP TRIGGER IF EXISTS payroll_item_commission_rules_draft_guard ON payroll_item_commission_rules;
CREATE TRIGGER payroll_item_commission_rules_draft_guard
  BEFORE INSERT ON payroll_item_commission_rules
  FOR EACH ROW EXECUTE FUNCTION payroll_require_draft_version_for_child();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_schemes', 'payroll_role_assignments', 'payroll_employee_overrides',
    'payroll_item_commission_rules', 'payroll_calculation_runs',
    'payroll_daily_snapshots', 'payroll_daily_snapshot_lines',
    'payroll_adjustments', 'payroll_adjustment_applications'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_reject_history_mutation()', table_name || '_immutable', table_name);
  END LOOP;
END $$;

-- A snapshot line must actually belong to the venue-scoped source order. The
-- source order item itself is copied as immutable values; its ID is retained
-- as provenance without binding payroll retention to mutable POS row lifetime.
CREATE OR REPLACE FUNCTION payroll_check_snapshot_source_order_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  source_order_id uuid;
  source_product_id uuid;
BEGIN
  EXECUTE format('SELECT order_id,product_id FROM %I.order_items WHERE id = $1', TG_TABLE_SCHEMA)
    INTO source_order_id,source_product_id USING NEW.order_item_id;
  IF source_order_id IS DISTINCT FROM NEW.order_id OR source_product_id IS DISTINCT FROM NEW.menu_item_id THEN
    RAISE EXCEPTION 'payroll snapshot source item/order/menu item mismatch' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS payroll_snapshot_line_source_item_guard ON payroll_daily_snapshot_lines;
CREATE TRIGGER payroll_snapshot_line_source_item_guard
  BEFORE INSERT ON payroll_daily_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_check_snapshot_source_order_item();

DROP TRIGGER IF EXISTS payroll_daily_snapshots_ready_run_guard ON payroll_daily_snapshots;
CREATE TRIGGER payroll_daily_snapshots_ready_run_guard
  BEFORE INSERT ON payroll_daily_snapshots
  FOR EACH ROW EXECUTE FUNCTION payroll_require_ready_run();
DROP TRIGGER IF EXISTS payroll_daily_snapshot_lines_ready_run_guard ON payroll_daily_snapshot_lines;
CREATE TRIGGER payroll_daily_snapshot_lines_ready_run_guard
  BEFORE INSERT ON payroll_daily_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION payroll_require_ready_run();
DROP TRIGGER IF EXISTS payroll_calculation_runs_validate ON payroll_calculation_runs;
CREATE TRIGGER payroll_calculation_runs_validate
  BEFORE INSERT ON payroll_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_calculation_run();
DROP TRIGGER IF EXISTS payroll_adjustment_applications_validate ON payroll_adjustment_applications;
CREATE TRIGGER payroll_adjustment_applications_validate
  BEFORE INSERT ON payroll_adjustment_applications
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_adjustment_application();
DROP TRIGGER IF EXISTS payroll_adjustments_source_guard ON payroll_adjustments;
CREATE TRIGGER payroll_adjustments_source_guard
  BEFORE INSERT ON payroll_adjustments
  FOR EACH ROW EXECUTE FUNCTION payroll_validate_adjustment_source();

