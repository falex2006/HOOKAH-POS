-- Close the database-boundary gaps left by the original POS income snapshot
-- migration. Sealed rows must reconcile one-to-one with immutable pricing.

-- The previous lifecycle allowed interrupted building rows to commit. Do not
-- install the stricter contract until those legacy rows are reconciled.
-- Hold the table lock across the check and trigger installation so old writers
-- cannot commit a new building row between the preflight and the new guards.
LOCK TABLE pos_order_income_category_snapshots IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pos_order_income_category_snapshots WHERE status='building') THEN
    RAISE EXCEPTION 'finance_pos_income_snapshot_legacy_building_rows_require_repair';
  END IF;
END $$;

ALTER TABLE pos_order_income_category_snapshots
  ADD COLUMN IF NOT EXISTS venue_timezone_snapshot text;

-- POS source mappings only target income articles. Lock the category row so
-- this check serializes with concurrent direction changes.
CREATE OR REPLACE FUNCTION validate_finance_income_category_mapping_category()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE category_name text; category_kind text; category_active boolean;
BEGIN
  SELECT name,kind,active INTO category_name,category_kind,category_active
    FROM finance_categories WHERE venue_id=NEW.venue_id AND id=NEW.category_id FOR SHARE;
  IF NOT FOUND OR category_kind<>'income' OR NOT category_active THEN
    RAISE EXCEPTION 'finance_income_mapping_requires_active_income_category' USING ERRCODE='23514';
  END IF;
  IF NEW.category_name_snapshot IS DISTINCT FROM category_name THEN
    RAISE EXCEPTION 'finance_income_mapping_category_name_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_income_mapping_category_guard ON finance_income_category_mappings;
CREATE TRIGGER finance_income_mapping_category_guard
  BEFORE INSERT ON finance_income_category_mappings
  FOR EACH ROW EXECUTE FUNCTION validate_finance_income_category_mapping_category();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance_income_category_mappings m
    JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id
    WHERE c.kind<>'income'
  ) THEN
    RAISE EXCEPTION 'finance_income_mapping_existing_category_kind_invalid';
  END IF;
END $$;

-- Direction stays immutable for every persisted source reference, including
-- the mapping row used to classify a sealed POS income snapshot.
CREATE OR REPLACE FUNCTION guard_finance_category_source_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND (
       EXISTS (SELECT 1 FROM payroll_entries pe WHERE pe.venue_id=OLD.venue_id AND pe.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM inventory_purchase_documents d WHERE d.venue_id=OLD.venue_id AND d.finance_category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_other_income_documents d WHERE d.venue_id=OLD.venue_id AND d.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM finance_income_category_mappings m WHERE m.venue_id=OLD.venue_id AND m.category_id=OLD.id)
       OR EXISTS (SELECT 1 FROM pos_order_income_category_allocations a WHERE a.venue_id=OLD.venue_id AND a.category_id=OLD.id)
     ) THEN
    RAISE EXCEPTION 'finance_category_source_kind_immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS finance_category_source_kind_guard ON finance_categories;
CREATE TRIGGER finance_category_source_kind_guard
  BEFORE UPDATE OF kind ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION guard_finance_category_source_kind();

CREATE OR REPLACE FUNCTION assert_pos_order_income_category_snapshot(
  p_snapshot pos_order_income_category_snapshots
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  allocation_total numeric;
  unmapped_total numeric;
  allocation_count bigint;
  source_total bigint;
  minimum_source bigint;
  item_count bigint;
  adjustment_count bigint;
  source_closed_at timestamptz;
  source_timezone text;
BEGIN
  IF p_snapshot.status NOT IN ('complete','unmapped') THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_not_terminal' USING ERRCODE='23514';
  END IF;

  SELECT COALESCE(SUM(a.amount_minor),0),
         COALESCE(SUM(a.amount_minor) FILTER (WHERE a.category_id IS NULL),0),
         COUNT(*),
         COUNT(*) FILTER (WHERE a.allocation_kind='minimum_adjustment')
    INTO allocation_total,unmapped_total,allocation_count,adjustment_count
    FROM pos_order_income_category_allocations a
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id;

  SELECT s.final_total_minor,s.minimum_adjustment_minor,o.closed_at,
         COALESCE(NULLIF(v.timezone,''),NULLIF(org.timezone,''),'Asia/Yekaterinburg')
    INTO source_total,minimum_source,source_closed_at,source_timezone
    FROM pos_order_pricing_snapshots s
    JOIN orders o ON o.venue_id=s.venue_id AND o.id=s.order_id
    JOIN venues v ON v.id=o.venue_id
    LEFT JOIN organizations org ON org.id=v.organization_id
    WHERE s.venue_id=p_snapshot.venue_id AND s.id=p_snapshot.pricing_snapshot_id AND s.order_id=p_snapshot.order_id
    FOR SHARE OF v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_order_income_category_pricing_source_missing' USING ERRCODE='23514';
  END IF;
  IF p_snapshot.closed_at IS DISTINCT FROM source_closed_at
      OR p_snapshot.venue_timezone_snapshot IS DISTINCT FROM source_timezone
      OR p_snapshot.venue_date IS DISTINCT FROM (source_closed_at AT TIME ZONE source_timezone)::date THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_date_mismatch' USING ERRCODE='23514';
  END IF;

  -- Lock every mapped category before checking activity. Archiving then either
  -- precedes this check (and blocks a new snapshot) or waits until this close
  -- transaction seals its historical category facts.
  PERFORM c.id
    FROM finance_categories c
    WHERE EXISTS (
      SELECT 1 FROM pos_order_income_category_allocations a
      WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
        AND a.mapping_id IS NOT NULL AND a.category_id=c.id AND c.venue_id=a.venue_id
    )
    ORDER BY c.id
    FOR SHARE OF c;
  IF EXISTS (
    SELECT 1
    FROM pos_order_income_category_allocations a
    JOIN finance_categories c ON c.venue_id=a.venue_id AND c.id=a.category_id
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
      AND a.mapping_id IS NOT NULL AND (c.kind<>'income' OR NOT c.active)
  ) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_requires_active_income_category' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*) INTO item_count
    FROM pos_order_pricing_snapshot_lines l
    WHERE l.venue_id=p_snapshot.venue_id AND l.snapshot_id=p_snapshot.pricing_snapshot_id AND l.order_id=p_snapshot.order_id;

  IF allocation_total<>p_snapshot.recognized_total_minor
      OR source_total<>p_snapshot.recognized_total_minor
      OR unmapped_total<>p_snapshot.unmapped_minor
      OR allocation_count<>item_count + (CASE WHEN minimum_source>0 THEN 1 ELSE 0 END)
      OR adjustment_count<>(CASE WHEN minimum_source>0 THEN 1 ELSE 0 END)
      OR p_snapshot.status IS DISTINCT FROM (CASE WHEN unmapped_total>0 THEN 'unmapped' ELSE 'complete' END) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pos_order_income_category_allocations a
    LEFT JOIN pos_order_pricing_snapshot_lines l
      ON l.venue_id=a.venue_id AND l.snapshot_id=p_snapshot.pricing_snapshot_id
      AND l.order_id=a.order_id AND l.order_item_id=a.order_item_id
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
      AND a.allocation_kind='item'
      AND (
        l.order_item_id IS NULL
        OR a.amount_minor IS DISTINCT FROM l.net_minor
        OR a.source_menu_category IS DISTINCT FROM COALESCE(l.product_facts->>'category','')
        OR a.source_station_snapshot IS DISTINCT FROM LEFT(COALESCE(l.product_facts->>'station',''),80)
        OR a.source_product_name IS DISTINCT FROM LEFT(COALESCE(NULLIF(l.product_facts->>'productName',''),'Позиция'),200)
        OR a.source_key IS DISTINCT FROM CASE
          WHEN COALESCE(l.product_facts->>'category','')='' OR LENGTH(COALESCE(l.product_facts->>'category',''))>500 THEN '@unclassified'
          WHEN l.product_facts->>'category'='@minimum-adjustment' THEN '@menu:@minimum-adjustment'
          WHEN l.product_facts->>'category'='@unclassified' THEN '@menu:@unclassified'
          ELSE l.product_facts->>'category'
        END
        OR (a.mapping_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM finance_income_category_mappings m
          JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id AND c.kind='income' AND c.active=true
          WHERE m.venue_id=a.venue_id AND m.id=a.mapping_id AND m.source_key=a.source_key
            AND m.category_id=a.category_id AND m.category_name_snapshot=a.category_name_snapshot
            AND m.effective_from<=p_snapshot.venue_date
        ))
      )
  ) OR EXISTS (
    SELECT 1
    FROM pos_order_pricing_snapshot_lines l
    WHERE l.venue_id=p_snapshot.venue_id AND l.snapshot_id=p_snapshot.pricing_snapshot_id AND l.order_id=p_snapshot.order_id
      AND NOT EXISTS (
        SELECT 1 FROM pos_order_income_category_allocations a
        WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
          AND a.order_id=p_snapshot.order_id AND a.allocation_kind='item' AND a.order_item_id=l.order_item_id
      )
  ) THEN
    RAISE EXCEPTION 'pos_order_income_category_item_allocation_mismatch' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pos_order_income_category_allocations a
    WHERE a.venue_id=p_snapshot.venue_id AND a.income_snapshot_id=p_snapshot.id
      AND a.allocation_kind='minimum_adjustment'
      AND (
        a.order_id IS DISTINCT FROM p_snapshot.order_id
        OR a.order_item_id IS NOT NULL
        OR a.source_key IS DISTINCT FROM '@minimum-adjustment'
        OR a.source_station_snapshot IS DISTINCT FROM ''
        OR a.source_menu_category IS DISTINCT FROM ''
        OR a.source_product_name IS DISTINCT FROM ''
        OR a.amount_minor IS DISTINCT FROM minimum_source
        OR (a.mapping_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM finance_income_category_mappings m
          JOIN finance_categories c ON c.venue_id=m.venue_id AND c.id=m.category_id AND c.kind='income' AND c.active=true
          WHERE m.venue_id=a.venue_id AND m.id=a.mapping_id AND m.source_key=a.source_key
            AND m.category_id=a.category_id AND m.category_name_snapshot=a.category_name_snapshot
            AND m.effective_from<=p_snapshot.venue_date
        ))
      )
  ) THEN
    RAISE EXCEPTION 'pos_order_income_category_adjustment_mismatch' USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_pos_order_income_category_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation_total numeric; unmapped_total numeric; source_total bigint; item_count bigint; allocation_count bigint; minimum_source bigint;
BEGIN
  IF TG_OP<>'UPDATE' OR OLD.status<>'building' OR NEW.status NOT IN ('complete','unmapped')
      OR NEW.venue_id IS DISTINCT FROM OLD.venue_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
      OR NEW.pricing_snapshot_id IS DISTINCT FROM OLD.pricing_snapshot_id OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
      OR NEW.venue_date IS DISTINCT FROM OLD.venue_date OR NEW.venue_timezone_snapshot IS DISTINCT FROM OLD.venue_timezone_snapshot
      OR NEW.recognized_total_minor IS DISTINCT FROM OLD.recognized_total_minor
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pos_order_income_snapshot_transition_invalid' USING ERRCODE='55000';
  END IF;
  SELECT COALESCE(SUM(a.amount_minor),0),
         COALESCE(SUM(a.amount_minor) FILTER (WHERE a.category_id IS NULL),0),
         COUNT(*)
    INTO allocation_total,unmapped_total,allocation_count
    FROM pos_order_income_category_allocations a
    WHERE a.venue_id=NEW.venue_id AND a.income_snapshot_id=NEW.id;
  SELECT s.final_total_minor,s.minimum_adjustment_minor
    INTO source_total,minimum_source
    FROM pos_order_pricing_snapshots s
    WHERE s.venue_id=NEW.venue_id AND s.id=NEW.pricing_snapshot_id AND s.order_id=NEW.order_id;
  SELECT COUNT(*) INTO item_count
    FROM pos_order_pricing_snapshot_lines l
    WHERE l.venue_id=NEW.venue_id AND l.snapshot_id=NEW.pricing_snapshot_id AND l.order_id=NEW.order_id;
  IF allocation_total<>NEW.recognized_total_minor
      OR source_total IS DISTINCT FROM NEW.recognized_total_minor
      OR unmapped_total<>NEW.unmapped_minor
      OR allocation_count<>item_count + (CASE WHEN COALESCE(minimum_source,0)>0 THEN 1 ELSE 0 END)
      OR NEW.status IS DISTINCT FROM (CASE WHEN unmapped_total>0 THEN 'unmapped' ELSE 'complete' END) THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_pos_order_income_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'building' THEN
      RAISE EXCEPTION 'pos_order_income_snapshot_must_start_building' USING ERRCODE='55000';
    END IF;
    IF NEW.venue_timezone_snapshot IS NULL OR btrim(NEW.venue_timezone_snapshot)='' THEN
      RAISE EXCEPTION 'pos_order_income_snapshot_timezone_required' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='building' AND NEW.status IN ('complete','unmapped') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'pos_order_income_category_snapshots_immutable' USING ERRCODE='55000';
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_no_mutation ON pos_order_income_category_snapshots;
CREATE TRIGGER pos_order_income_snapshot_no_mutation BEFORE INSERT OR UPDATE OR DELETE ON pos_order_income_category_snapshots
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_income_snapshot_immutable();

CREATE OR REPLACE FUNCTION validate_pos_order_income_category_snapshot_at_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_snapshot pos_order_income_category_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO final_snapshot FROM pos_order_income_category_snapshots
    WHERE venue_id=NEW.venue_id AND id=NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pos_order_income_category_snapshot_missing_at_commit' USING ERRCODE='23514';
  END IF;
  PERFORM assert_pos_order_income_category_snapshot(final_snapshot);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_income_snapshot_commit_validate ON pos_order_income_category_snapshots;
CREATE CONSTRAINT TRIGGER pos_order_income_snapshot_commit_validate
  AFTER INSERT OR UPDATE ON pos_order_income_category_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION validate_pos_order_income_category_snapshot_at_commit();
