-- Prospective valuation evidence only. No stock/payment/COGS rewrites or backfill.
CREATE TABLE IF NOT EXISTS pos_sale_cost_epochs (
  venue_id uuid PRIMARY KEY REFERENCES venues(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version=1),
  activated_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);
INSERT INTO pos_sale_cost_epochs(venue_id)
  SELECT id FROM venues v WHERE NOT EXISTS(SELECT 1 FROM pos_sale_cost_epochs e WHERE e.venue_id=v.id);
CREATE OR REPLACE FUNCTION create_pos_sale_cost_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO pos_sale_cost_epochs(venue_id) VALUES(NEW.id); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS pos_sale_cost_epoch_create ON venues;
CREATE TRIGGER pos_sale_cost_epoch_create AFTER INSERT ON venues FOR EACH ROW EXECUTE FUNCTION create_pos_sale_cost_epoch();
CREATE OR REPLACE FUNCTION guard_pos_sale_cost_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<2 THEN RAISE EXCEPTION 'sale_cost_epoch_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_sale_cost_epoch_guard ON pos_sale_cost_epochs;
CREATE TRIGGER pos_sale_cost_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_sale_cost_epochs
  FOR EACH ROW EXECUTE FUNCTION guard_pos_sale_cost_epoch();
DROP TRIGGER IF EXISTS pos_sale_cost_epoch_no_truncate ON pos_sale_cost_epochs;
CREATE TRIGGER pos_sale_cost_epoch_no_truncate BEFORE TRUNCATE ON pos_sale_cost_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_sale_cost_epoch();

CREATE TABLE IF NOT EXISTS pos_sale_cost_evidence (
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  order_id uuid PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version=1),
  captured_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  watermark text NOT NULL CHECK(watermark ~ '^[a-f0-9]{64}$'),
  UNIQUE(venue_id,order_id)
);

CREATE OR REPLACE FUNCTION guard_pos_sale_cost_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE sale record; epoch timestamptz; order_cost numeric; item jsonb; component jsonb; movement jsonb;
        allocated numeric; actual record; total numeric; line_count integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'sale_cost_evidence_immutable' USING ERRCODE='55000'; END IF;
  SELECT venue_id,status,closed_at INTO sale FROM public.orders WHERE id=NEW.order_id;
  SELECT activated_at INTO epoch FROM public.pos_sale_cost_epochs WHERE venue_id=NEW.venue_id;
  SELECT cost INTO order_cost FROM public.order_costs WHERE venue_id=NEW.venue_id AND order_id=NEW.order_id;
  IF sale.venue_id IS DISTINCT FROM NEW.venue_id OR sale.status::text IS DISTINCT FROM 'closed'
     OR sale.closed_at IS DISTINCT FROM transaction_timestamp() OR epoch IS NULL
     OR NEW.captured_at IS DISTINCT FROM transaction_timestamp() OR NEW.captured_at<epoch OR order_cost IS NULL
     OR NEW.payload->>'venueId' IS DISTINCT FROM NEW.venue_id::text
     OR NEW.payload->>'orderId' IS DISTINCT FROM NEW.order_id::text
     OR NEW.payload->>'currency' IS DISTINCT FROM 'RUB'
     OR NEW.payload->>'scope' IS DISTINCT FROM 'sale_depletion_cost'
     OR NEW.payload->>'schemaVersion' IS DISTINCT FROM '1'
     OR NEW.payload->>'policyVersion' IS DISTINCT FROM '1'
     OR NEW.payload->>'refundAdjustedReady' IS DISTINCT FROM 'false'
     OR (NEW.payload->>'epochActivatedAt')::timestamptz IS DISTINCT FROM epoch
     OR (NEW.payload->>'observedOrderCostMinor')::numeric IS DISTINCT FROM order_cost*100
     OR COALESCE(NEW.payload->>'status','') NOT IN ('complete','incomplete') THEN
    RAISE EXCEPTION 'sale_cost_evidence_scope_invalid' USING ERRCODE='23514';
  END IF;
  IF NEW.payload->>'status'='incomplete' THEN
    IF NEW.payload->'totalCostMinor' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'sale_cost_incomplete_total_invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payload#>>'{capture,status}' IS DISTINCT FROM 'captured'
     OR NEW.payload#>>'{capture,captureVersion}' IS DISTINCT FROM '1'
     OR NEW.payload->'reasons' IS DISTINCT FROM '[]'::jsonb
     OR NEW.payload#>'{capture,reasons}' IS DISTINCT FROM '[]'::jsonb
     OR NEW.payload#>'{allocation,reasons}' IS DISTINCT FROM '[]'::jsonb
     OR NEW.payload#>>'{allocation,status}' IS DISTINCT FROM 'complete'
     OR (NEW.payload->>'totalCostMinor')::numeric IS DISTINCT FROM order_cost*100
     OR (NEW.payload#>>'{allocation,totalCostMinor}')::numeric IS DISTINCT FROM order_cost*100
     OR jsonb_typeof(NEW.payload#>'{capture,lines}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload#>'{capture,components}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload#>'{capture,movements}') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.payload#>'{allocation,lines}') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'sale_cost_complete_payload_invalid' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO line_count FROM public.order_items WHERE order_id=NEW.order_id;
  IF jsonb_array_length(NEW.payload#>'{capture,lines}')<>line_count
     OR (SELECT count(DISTINCT x->>'orderItemId') FROM jsonb_array_elements(NEW.payload#>'{capture,lines}') x)<>line_count THEN
    RAISE EXCEPTION 'sale_cost_line_coverage_invalid' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(NEW.payload#>'{allocation,lines}')<>line_count
     OR (SELECT count(DISTINCT x->>'orderItemId') FROM jsonb_array_elements(NEW.payload#>'{allocation,lines}') x)<>line_count
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload#>'{allocation,lines}') a
       WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload#>'{capture,lines}') c
         WHERE a->>'orderItemId'=c->>'orderItemId' AND a->>'productId'=c->>'productId'
           AND (a->>'quantity')::numeric=(c->>'quantity')::numeric)) THEN
    RAISE EXCEPTION 'sale_cost_allocation_line_coverage_invalid' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(DISTINCT x->>'movementId') FROM jsonb_array_elements(NEW.payload#>'{capture,movements}') x)
     <>jsonb_array_length(NEW.payload#>'{capture,movements}') THEN
    RAISE EXCEPTION 'sale_cost_duplicate_movement' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.payload#>'{capture,lines}') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.order_items oi JOIN public.products p ON p.id=oi.product_id
      WHERE oi.id=(item->>'orderItemId')::uuid AND oi.order_id=NEW.order_id
        AND oi.product_id=(item->>'productId')::uuid AND oi.quantity=(item->>'quantity')::numeric
        AND p.venue_id=NEW.venue_id AND p.inventory_mode=item->>'inventoryMode') THEN
      RAISE EXCEPTION 'sale_cost_line_scope_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR movement IN SELECT * FROM jsonb_array_elements(NEW.payload#>'{capture,movements}') LOOP
    SELECT * INTO actual FROM public.stock_movements WHERE id=(movement->>'movementId')::uuid;
    IF actual.venue_id IS DISTINCT FROM NEW.venue_id OR actual.order_id IS DISTINCT FROM NEW.order_id
       OR actual.ingredient_id IS DISTINCT FROM (movement->>'ingredientId')::uuid
       OR actual.direction::text IS DISTINCT FROM 'out' OR actual.quantity IS DISTINCT FROM (movement->>'quantity')::numeric
       OR actual.created_at IS DISTINCT FROM transaction_timestamp() THEN
      RAISE EXCEPTION 'sale_cost_movement_scope_invalid' USING ERRCODE='23514';
    END IF;
    SELECT sum((x->>'quantity')::numeric) INTO allocated FROM jsonb_array_elements(NEW.payload#>'{capture,components}') x
      WHERE x->>'movementId'=movement->>'movementId';
    IF allocated IS DISTINCT FROM actual.quantity THEN RAISE EXCEPTION 'sale_cost_movement_quantity_invalid' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.stock_movements WHERE venue_id=NEW.venue_id AND order_id=NEW.order_id AND direction='out')
      <>jsonb_array_length(NEW.payload#>'{capture,movements}') THEN
    RAISE EXCEPTION 'sale_cost_movement_coverage_invalid' USING ERRCODE='23514';
  END IF;
  FOR component IN SELECT * FROM jsonb_array_elements(NEW.payload#>'{capture,components}') LOOP
    IF COALESCE((component->>'quantity')::numeric,0)<=0 OR COALESCE((component->>'unitCost')::numeric,0)<=0
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload#>'{capture,movements}') m
        WHERE m->>'movementId'=component->>'movementId' AND m->>'ingredientId'=component->>'ingredientId')
      OR NOT EXISTS(SELECT 1 FROM public.ingredients i WHERE i.id=(component->>'ingredientId')::uuid
      AND i.venue_id=NEW.venue_id AND i.cost=(component->>'unitCost')::numeric AND i.unit=component->>'stockUnit')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.payload#>'{capture,lines}') x WHERE x->>'orderItemId'=component->>'orderItemId') THEN
      RAISE EXCEPTION 'sale_cost_valuation_scope_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT sum((x->>'totalCostMinor')::numeric) INTO total FROM jsonb_array_elements(NEW.payload#>'{allocation,lines}') x;
  IF COALESCE(total,0)<>order_cost*100 THEN RAISE EXCEPTION 'sale_cost_total_invalid' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_sale_cost_evidence_guard ON pos_sale_cost_evidence;
CREATE TRIGGER pos_sale_cost_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_sale_cost_evidence
  FOR EACH ROW EXECUTE FUNCTION guard_pos_sale_cost_evidence();
DROP TRIGGER IF EXISTS pos_sale_cost_evidence_no_truncate ON pos_sale_cost_evidence;
CREATE TRIGGER pos_sale_cost_evidence_no_truncate BEFORE TRUNCATE ON pos_sale_cost_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_sale_cost_evidence();
