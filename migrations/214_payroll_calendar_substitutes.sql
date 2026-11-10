-- A receipt identifies a worker enrolled from the owner's shift calendar.
-- Ordinary employees have no receipt. The referenced scheme version retains
-- the selected rate configuration even after the worker changes position.
CREATE TABLE IF NOT EXISTS payroll_calendar_substitutes (
  venue_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  enrolled_by uuid NOT NULL,
  scheme_version_id uuid NOT NULL,
  source_version_id uuid NOT NULL,
  draft_digest text NOT NULL CHECK (draft_digest ~ '^[0-9a-f]{64}$'),
  role_key text NOT NULL CHECK (length(btrim(role_key)) BETWEEN 1 AND 80),
  effective_from date NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, employee_id),
  UNIQUE (venue_id, idempotency_key),
  UNIQUE (venue_id, scheme_version_id),
  CHECK (source_version_id <> scheme_version_id),
  FOREIGN KEY (venue_id, employee_id) REFERENCES users (venue_id, id),
  FOREIGN KEY (venue_id, enrolled_by) REFERENCES users (venue_id, id),
  FOREIGN KEY (venue_id, source_version_id) REFERENCES payroll_scheme_versions (venue_id, id),
  FOREIGN KEY (venue_id, scheme_version_id) REFERENCES payroll_scheme_versions (venue_id, id)
);

CREATE OR REPLACE FUNCTION payroll_calendar_substitute_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE matched boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payroll_calendar_enrollment_immutable' USING ERRCODE='55000';
  END IF;
  EXECUTE format('SELECT EXISTS(
    SELECT 1 FROM %1$I.payroll_role_assignments a
    JOIN %1$I.payroll_scheme_versions v ON v.venue_id=a.venue_id AND v.id=a.scheme_version_id
    JOIN %1$I.users u ON u.venue_id=a.venue_id AND u.id=$6
    WHERE a.venue_id=$1 AND a.employee_id=$2 AND a.scheme_version_id=$3 AND a.role_key=$4
      AND a.effective_from=$5 AND a.effective_to=$5 AND v.status=''draft''
      AND u.role=''owner'' AND u.is_active AND u.deleted_at IS NULL)', TG_TABLE_SCHEMA)
    INTO matched USING NEW.venue_id,NEW.employee_id,NEW.scheme_version_id,NEW.role_key,NEW.effective_from,NEW.enrolled_by;
  IF NOT matched THEN
    RAISE EXCEPTION 'payroll_calendar_enrollment_basis_invalid' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_calendar_substitute_guard ON payroll_calendar_substitutes;
CREATE TRIGGER payroll_calendar_substitute_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_calendar_substitutes
  FOR EACH ROW EXECUTE FUNCTION payroll_calendar_substitute_guard();

-- An explicit owner switch replaces an entire version in one transaction.
-- Keep the outgoing version's exact date window for reproducible paid runs.
CREATE TABLE IF NOT EXISTS payroll_calendar_substitute_applications (
  venue_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  prior_version_id uuid,
  actor_id uuid NOT NULL,
  applied_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id,draft_id),
  FOREIGN KEY (venue_id,draft_id) REFERENCES payroll_scheme_versions(venue_id,id),
  FOREIGN KEY (venue_id,prior_version_id) REFERENCES payroll_scheme_versions(venue_id,id),
  FOREIGN KEY (venue_id,actor_id) REFERENCES users(venue_id,id)
);

CREATE OR REPLACE FUNCTION payroll_verify_calendar_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid boolean; allowed_ids uuid[]; relation_name text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payroll_calendar_application_immutable' USING ERRCODE='55000';
  END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %1$I.payroll_calendar_substitutes s
    JOIN %1$I.payroll_scheme_versions v ON v.venue_id=s.venue_id AND v.id=s.scheme_version_id
    JOIN %1$I.users u ON u.venue_id=s.venue_id AND u.id=$3
    WHERE s.venue_id=$1 AND s.scheme_version_id=$2 AND v.status=''active'' AND v.status_changed_by=$3
      AND v.xmin::text::bigint=mod(txid_current(),4294967296::bigint)
      AND s.draft_digest=v.config_json->''payoutRiskAcknowledgement''->>''configDigest''
      AND u.role=''owner'' AND u.is_active AND u.deleted_at IS NULL
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM %1$I.payroll_scheme_versions p
        WHERE p.id=$4 AND p.venue_id=v.venue_id AND p.scheme_id=v.scheme_id AND p.status=''retired''
          AND p.effective_from=v.effective_from AND p.effective_to IS NOT DISTINCT FROM v.effective_to
          AND p.mode=v.mode AND p.currency=v.currency AND p.engine_version=v.engine_version
          AND (p.config_json-''payoutRiskAcknowledgement'')=(v.config_json-''payoutRiskAcknowledgement'')
          AND p.status_changed_by=$3 AND p.xmin::text::bigint=mod(txid_current(),4294967296::bigint))))', TG_TABLE_SCHEMA)
    INTO valid USING NEW.venue_id,NEW.draft_id,NEW.actor_id,NEW.prior_version_id;
  IF NOT valid OR NEW.applied_xid<>pg_current_xact_id() THEN
    RAISE EXCEPTION 'payroll_calendar_application_incomplete' USING ERRCODE='23514';
  END IF;
  IF NEW.prior_version_id IS NOT NULL THEN
    -- Follow only the actual enrollment chain back to the outgoing version.
    EXECUTE format('WITH RECURSIVE chain AS (
      SELECT employee_id,scheme_version_id,source_version_id FROM %1$I.payroll_calendar_substitutes WHERE venue_id=$1 AND scheme_version_id=$2
      UNION SELECT s.employee_id,s.scheme_version_id,s.source_version_id FROM %1$I.payroll_calendar_substitutes s
        JOIN chain c ON c.source_version_id=s.scheme_version_id AND c.source_version_id<>$3 WHERE s.venue_id=$1)
      SELECT array_agg(employee_id) FILTER (WHERE employee_id IS NOT NULL) FROM chain
        HAVING bool_or(source_version_id=$3)', TG_TABLE_SCHEMA)
      INTO allowed_ids USING NEW.venue_id,NEW.draft_id,NEW.prior_version_id;
    IF allowed_ids IS NULL THEN RAISE EXCEPTION 'payroll_calendar_application_lineage_invalid' USING ERRCODE='23514'; END IF;

    -- Compare multisets after stripping only identity/audit metadata. New
    -- column additions therefore participate in the financial comparison.
    FOREACH relation_name IN ARRAY ARRAY['payroll_role_assignments','payroll_employee_overrides','payroll_item_commission_rules'] LOOP
      EXECUTE format('WITH rows AS (SELECT a.scheme_version_id AS version_id,
        to_jsonb(a) - ARRAY[''id'',''scheme_version_id'',''created_at'',''created_by'',''created_by_name''] AS terms
        FROM %1$I.%2$I a WHERE a.venue_id=$1 AND a.scheme_version_id IN ($2,$3)
        AND NOT ($5=''payroll_role_assignments'' AND a.scheme_version_id=$3 AND EXISTS (
          SELECT 1 FROM %1$I.payroll_calendar_substitutes s
          WHERE s.venue_id=$1 AND s.employee_id=ANY($4) AND s.employee_id::text=to_jsonb(a)->>''employee_id''
            AND s.role_key=to_jsonb(a)->>''role_key'' AND s.effective_from::text=to_jsonb(a)->>''effective_from''
            AND s.effective_from::text=to_jsonb(a)->>''effective_to'')))
        SELECT jsonb_agg(terms ORDER BY terms) FILTER (WHERE version_id=$2) IS NOT DISTINCT FROM
               jsonb_agg(terms ORDER BY terms) FILTER (WHERE version_id=$3) FROM rows', TG_TABLE_SCHEMA,relation_name)
        INTO valid USING NEW.venue_id,NEW.prior_version_id,NEW.draft_id,allowed_ids,relation_name;
      IF NOT valid THEN RAISE EXCEPTION 'payroll_calendar_application_terms_changed' USING ERRCODE='23514'; END IF;
    END LOOP;
    EXECUTE format('SELECT count(*)=cardinality($3) FROM %1$I.payroll_calendar_substitutes s JOIN %1$I.payroll_role_assignments a
      ON a.venue_id=s.venue_id AND a.employee_id=s.employee_id AND a.role_key=s.role_key
      AND a.effective_from=s.effective_from AND a.effective_to=s.effective_from AND a.scheme_version_id=$2
      WHERE s.venue_id=$1 AND s.employee_id=ANY($3)', TG_TABLE_SCHEMA)
      INTO valid USING NEW.venue_id,NEW.draft_id,allowed_ids;
    IF NOT valid THEN RAISE EXCEPTION 'payroll_calendar_application_assignment_missing' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS payroll_calendar_application_complete ON payroll_calendar_substitute_applications;
CREATE CONSTRAINT TRIGGER payroll_calendar_application_complete AFTER INSERT OR UPDATE OR DELETE ON payroll_calendar_substitute_applications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_verify_calendar_application();

CREATE OR REPLACE FUNCTION payroll_guard_scheme_version_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  window_lock bigint;
  conflicting_version uuid;
  invalid_child boolean;
  calendar_switch boolean;
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
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.payroll_calendar_substitute_applications
      WHERE venue_id=$1 AND prior_version_id=$2 AND actor_id=$3 AND applied_xid=pg_current_xact_id())', TG_TABLE_SCHEMA)
      INTO calendar_switch USING NEW.venue_id,NEW.id,NEW.status_changed_by;
    IF (NEW.effective_to IS NULL AND NOT (calendar_switch AND OLD.effective_to IS NULL)) OR NEW.effective_to < NEW.effective_from
      OR (OLD.effective_to IS NOT NULL AND NEW.effective_to > OLD.effective_to) THEN
      RAISE EXCEPTION 'retiring a payroll scheme version requires a valid closing date' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
