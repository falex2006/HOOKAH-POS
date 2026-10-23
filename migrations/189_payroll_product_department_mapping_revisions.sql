-- Immutable, venue-scoped payroll classification snapshots for product UUIDs.
-- Product IDs intentionally have no FK: old payroll evidence must survive catalog deletion.
-- No catalog, POS, sales, payment, loyalty, shift, payroll-entry or expense rows are changed.

CREATE TABLE IF NOT EXISTS payroll_product_department_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  supersedes_revision_id uuid,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 8 AND 1000),
  idempotency_key text NOT NULL CHECK (char_length(btrim(idempotency_key)) BETWEEN 8 AND 160),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  mapping_count integer NOT NULL CHECK (mapping_count BETWEEN 0 AND 10000),
  effective_from date NOT NULL,
  retroactive_attested boolean NOT NULL DEFAULT false,
  retroactive_reason text,
  created_by uuid NOT NULL,
  created_by_name text NOT NULL CHECK (char_length(btrim(created_by_name)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  created_transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,revision_no),
  UNIQUE (venue_id,idempotency_key),
  CONSTRAINT payroll_product_department_revision_previous_fk
    FOREIGN KEY (venue_id,supersedes_revision_id)
    REFERENCES payroll_product_department_revisions(venue_id,id) ON DELETE RESTRICT,
  CONSTRAINT payroll_product_department_revision_actor_fk
    FOREIGN KEY (venue_id,created_by) REFERENCES users(venue_id,id) ON DELETE RESTRICT,
  CHECK ((revision_no=1 AND supersedes_revision_id IS NULL)
      OR (revision_no>1 AND supersedes_revision_id IS NOT NULL)),
  CHECK ((retroactive_attested=false AND retroactive_reason IS NULL)
      OR (retroactive_attested=true AND char_length(btrim(retroactive_reason)) BETWEEN 8 AND 500))
);

CREATE INDEX IF NOT EXISTS payroll_product_department_revision_latest_idx
  ON payroll_product_department_revisions(venue_id,revision_no DESC);

CREATE TABLE IF NOT EXISTS payroll_product_department_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_name_snapshot text NOT NULL CHECK (char_length(btrim(product_name_snapshot)) BETWEEN 1 AND 160
    AND product_name_snapshot=btrim(product_name_snapshot)),
  department_code text NOT NULL CHECK (department_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  department_name_snapshot text NOT NULL CHECK (char_length(btrim(department_name_snapshot)) BETWEEN 1 AND 160
    AND department_name_snapshot=btrim(department_name_snapshot)),
  effective_from date NOT NULL,
  effective_to date,
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,revision_id,product_id,effective_from),
  CHECK (effective_to IS NULL OR effective_to>=effective_from),
  CONSTRAINT payroll_product_department_mapping_revision_fk
    FOREIGN KEY (venue_id,revision_id)
    REFERENCES payroll_product_department_revisions(venue_id,id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS payroll_product_department_mapping_lookup_idx
  ON payroll_product_department_mappings(venue_id,revision_id,product_id,effective_from,effective_to);

CREATE OR REPLACE FUNCTION payroll_guard_product_department_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  venue_timezone text;
  local_today date;
  actor_role text;
  actor_active boolean;
  actor_deleted_at timestamptz;
  actor_name text;
  expected_revision integer;
  expected_previous uuid;
BEGIN
  -- Match the payroll source fence before taking the venue row lock. This
  -- protects direct SQL writers as well as the owner API transaction wrapper.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('payroll-official-source-v1:'||NEW.venue_id::text,0));
  -- A row lock serializes concurrent owners before revision chain validation.
  SELECT timezone INTO venue_timezone FROM venues WHERE id=NEW.venue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payroll product department venue missing' USING ERRCODE='23503'; END IF;
  IF venue_timezone IS NULL OR btrim(venue_timezone)='' THEN
    RAISE EXCEPTION 'payroll product department venue timezone missing' USING ERRCODE='22023';
  END IF;
  local_today := (transaction_timestamp() AT TIME ZONE venue_timezone)::date;

  SELECT role::text,is_active,deleted_at,full_name INTO actor_role,actor_active,actor_deleted_at,actor_name
    FROM users WHERE venue_id=NEW.venue_id AND id=NEW.created_by FOR SHARE;
  IF actor_role IS DISTINCT FROM 'owner' OR actor_active IS DISTINCT FROM true OR actor_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'payroll product department revisions require active venue owner' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(MAX(revision_no),0)::int+1,(array_agg(id ORDER BY revision_no DESC))[1]
    INTO expected_revision,expected_previous
    FROM payroll_product_department_revisions WHERE venue_id=NEW.venue_id;
  IF NEW.revision_no IS DISTINCT FROM expected_revision OR NEW.supersedes_revision_id IS DISTINCT FROM expected_previous THEN
    RAISE EXCEPTION 'payroll product department revision sequence is invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.retroactive_attested AND NEW.effective_from>local_today THEN
    RAISE EXCEPTION 'future payroll product department revision cannot be retroactively attested' USING ERRCODE='23514';
  END IF;
  IF NOT NEW.retroactive_attested AND NEW.effective_from<>local_today+1 THEN
    RAISE EXCEPTION 'normal payroll product department revision must begin next venue local day' USING ERRCODE='23514';
  END IF;
  IF NEW.effective_from<=local_today AND (NEW.retroactive_attested IS DISTINCT FROM true OR NEW.retroactive_reason IS NULL) THEN
    RAISE EXCEPTION 'past payroll product department revision requires explicit attestation' USING ERRCODE='23514';
  END IF;

  NEW.created_by_name:=actor_name;
  NEW.created_at:=transaction_timestamp();
  NEW.created_transaction_id:=pg_current_xact_id();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_guard_product_department_mapping() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  revision_created_at timestamptz;
  revision_transaction_id xid8;
  declared_count integer;
  inserted_count integer;
BEGIN
  SELECT created_at,created_transaction_id,mapping_count
    INTO revision_created_at,revision_transaction_id,declared_count
    FROM payroll_product_department_revisions WHERE venue_id=NEW.venue_id AND id=NEW.revision_id;
  IF revision_created_at IS NULL OR revision_transaction_id IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'payroll product department rows must be inserted with immutable revision' USING ERRCODE='55000';
  END IF;
  -- Full snapshots intentionally retain unchanged intervals that predate the revision switch date.
  IF EXISTS (
    SELECT 1 FROM payroll_product_department_mappings m
    WHERE m.venue_id=NEW.venue_id AND m.revision_id=NEW.revision_id AND m.product_id=NEW.product_id
      AND (m.effective_to IS NULL OR m.effective_to>=NEW.effective_from)
      AND (NEW.effective_to IS NULL OR NEW.effective_to>=m.effective_from)
  ) THEN RAISE EXCEPTION 'payroll product department mapping periods overlap' USING ERRCODE='23P01'; END IF;
  SELECT count(*)::int INTO inserted_count FROM payroll_product_department_mappings
    WHERE venue_id=NEW.venue_id AND revision_id=NEW.revision_id;
  IF inserted_count>=declared_count THEN RAISE EXCEPTION 'payroll product department mapping count exceeded' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_validate_product_department_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actual_count integer; actual_digest text;
BEGIN
  SELECT count(*)::int,
    encode(digest(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
      'productId',product_id::text,'productName',product_name_snapshot,'departmentCode',department_code,
      'departmentName',department_name_snapshot,'effectiveFrom',effective_from::text,
      'effectiveTo',effective_to::text
    ) ORDER BY product_id,effective_from,effective_to NULLS LAST,department_code,department_name_snapshot)::text,'[]'), 'UTF8'),'sha256'),'hex')
    INTO actual_count,actual_digest
    FROM payroll_product_department_mappings WHERE venue_id=NEW.venue_id AND revision_id=NEW.id;
  IF actual_count IS DISTINCT FROM NEW.mapping_count THEN
    RAISE EXCEPTION 'payroll product department revision count mismatch' USING ERRCODE='23514';
  END IF;
  IF actual_digest IS DISTINCT FROM NEW.payload_sha256 THEN
    RAISE EXCEPTION 'payroll product department revision digest mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION payroll_reject_product_department_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payroll product department history is append-only' USING ERRCODE='55000'; END;
$$;

DROP TRIGGER IF EXISTS payroll_product_department_revision_insert_guard ON payroll_product_department_revisions;
CREATE TRIGGER payroll_product_department_revision_insert_guard BEFORE INSERT ON payroll_product_department_revisions
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_product_department_revision();
DROP TRIGGER IF EXISTS payroll_product_department_revision_immutable ON payroll_product_department_revisions;
CREATE TRIGGER payroll_product_department_revision_immutable BEFORE UPDATE OR DELETE ON payroll_product_department_revisions
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_product_department_history_mutation();
DROP TRIGGER IF EXISTS payroll_product_department_mapping_insert_guard ON payroll_product_department_mappings;
CREATE TRIGGER payroll_product_department_mapping_insert_guard BEFORE INSERT ON payroll_product_department_mappings
  FOR EACH ROW EXECUTE FUNCTION payroll_guard_product_department_mapping();
DROP TRIGGER IF EXISTS payroll_product_department_mapping_immutable ON payroll_product_department_mappings;
CREATE TRIGGER payroll_product_department_mapping_immutable BEFORE UPDATE OR DELETE ON payroll_product_department_mappings
  FOR EACH ROW EXECUTE FUNCTION payroll_reject_product_department_history_mutation();
DROP TRIGGER IF EXISTS payroll_product_department_revision_count_guard ON payroll_product_department_revisions;
CREATE CONSTRAINT TRIGGER payroll_product_department_revision_count_guard AFTER INSERT ON payroll_product_department_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION payroll_validate_product_department_revision();
DROP TRIGGER IF EXISTS payroll_product_department_revision_truncate_guard ON payroll_product_department_revisions;
CREATE TRIGGER payroll_product_department_revision_truncate_guard BEFORE TRUNCATE ON payroll_product_department_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_product_department_history_mutation();
DROP TRIGGER IF EXISTS payroll_product_department_mapping_truncate_guard ON payroll_product_department_mappings;
CREATE TRIGGER payroll_product_department_mapping_truncate_guard BEFORE TRUNCATE ON payroll_product_department_mappings
  FOR EACH STATEMENT EXECUTE FUNCTION payroll_reject_product_department_history_mutation();
