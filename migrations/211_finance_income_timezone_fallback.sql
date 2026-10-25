-- Keep the immutable POS income snapshot validator aligned with the runtime:
-- valid venue timezone -> valid organization timezone -> product default.
-- Existing invalid legacy values remain untouched and auditable.
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
         COALESCE(
           (SELECT name FROM pg_catalog.pg_timezone_names WHERE lower(name)=lower(btrim(v.timezone)) LIMIT 1),
           (SELECT name FROM pg_catalog.pg_timezone_names WHERE lower(name)=lower(btrim(org.timezone)) LIMIT 1),
           'Asia/Yekaterinburg')
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
