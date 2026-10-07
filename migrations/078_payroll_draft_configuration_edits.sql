-- Allow owners to edit an unactivated scheme draft while keeping activated
-- configuration immutable and retaining the existing audited status workflow.

CREATE OR REPLACE FUNCTION payroll_guard_scheme_version_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  window_lock bigint;
  conflicting_version uuid;
  invalid_child boolean;
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

  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF (to_jsonb(NEW) - 'mode' - 'currency' - 'effective_from' - 'effective_to' - 'config_json' - 'engine_version')
         IS DISTINCT FROM
       (to_jsonb(OLD) - 'mode' - 'currency' - 'effective_from' - 'effective_to' - 'config_json' - 'engine_version') THEN
      RAISE EXCEPTION 'payroll scheme draft identity and audit fields are immutable' USING ERRCODE = '55000';
    END IF;

    EXECUTE format('SELECT EXISTS (
      SELECT 1 FROM %I.payroll_role_assignments
      WHERE venue_id=$1 AND scheme_version_id=$2
        AND (effective_from < $3 OR ($4 IS NOT NULL AND (effective_to IS NULL OR effective_to > $4)))
    ) OR EXISTS (
      SELECT 1 FROM %I.payroll_employee_overrides
      WHERE venue_id=$1 AND scheme_version_id=$2
        AND (effective_from < $3 OR ($4 IS NOT NULL AND (effective_to IS NULL OR effective_to > $4)))
    )', TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
      INTO invalid_child USING NEW.venue_id, NEW.id, NEW.effective_from, NEW.effective_to;
    IF invalid_child THEN
      RAISE EXCEPTION 'payroll draft window excludes configured assignment or override dates' USING ERRCODE = '23514';
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
    EXECUTE format('SELECT id FROM %I.payroll_scheme_versions
      WHERE venue_id=$1 AND scheme_id=$2 AND status=''active'' AND id<>$3
        AND effective_from <= COALESCE($4,''infinity''::date)
        AND COALESCE(effective_to,''infinity''::date) >= $5 LIMIT 1', TG_TABLE_SCHEMA)
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

CREATE OR REPLACE FUNCTION payroll_guard_draft_child_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  version_status text;
  source_venue uuid;
  source_version uuid;
BEGIN
  source_venue := OLD.venue_id;
  source_version := OLD.scheme_version_id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.scheme_version_id IS DISTINCT FROM OLD.scheme_version_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_by_name IS DISTINCT FROM OLD.created_by_name
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'payroll draft child identity and audit fields are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  EXECUTE format('SELECT status FROM %I.payroll_scheme_versions WHERE venue_id=$1 AND id=$2 FOR UPDATE', TG_TABLE_SCHEMA)
    INTO version_status USING source_venue, source_version;
  IF version_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'payroll calculation history is append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'replace payroll draft configuration rows instead of updating them' USING ERRCODE = '55000';
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'payroll_role_assignments', 'payroll_employee_overrides', 'payroll_item_commission_rules'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_immutable', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_draft_mutation_guard', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION payroll_guard_draft_child_mutation()', table_name || '_draft_mutation_guard', table_name);
  END LOOP;
END $$;
