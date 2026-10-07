-- Canonical immutable line pricing evidence created by the first tender or direct close.
CREATE TABLE IF NOT EXISTS pos_order_pricing_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version=1),
  currency_code text NOT NULL DEFAULT 'RUB' CHECK (currency_code='RUB'),
  currency_scale smallint NOT NULL DEFAULT 2 CHECK (currency_scale=2),
  sold_at timestamptz NOT NULL,
  transaction_at timestamptz NOT NULL DEFAULT now(),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor>=0),
  discount_minor bigint NOT NULL CHECK (discount_minor>=0 AND discount_minor<=subtotal_minor),
  minimum_adjustment_minor bigint NOT NULL CHECK (minimum_adjustment_minor>=0),
  final_total_minor bigint NOT NULL CHECK (final_total_minor=subtotal_minor-discount_minor+minimum_adjustment_minor),
  discount_source text NOT NULL CHECK (discount_source IN ('none','manual','guest_group','promotion')),
  winner_source_id text,
  winner_source_ids uuid[] NOT NULL DEFAULT '{}',
  winner_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligible_item_ids uuid[] NOT NULL DEFAULT '{}',
  frozen_terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (venue_id,order_id),
  UNIQUE (venue_id,id,order_id),
  FOREIGN KEY (venue_id,order_id) REFERENCES orders(venue_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS order_items_order_id_id_uq ON order_items(order_id,id);
CREATE TABLE IF NOT EXISTS pos_order_pricing_snapshot_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  seller_id uuid,
  sold_at timestamptz,
  quantity numeric(12,3) NOT NULL CHECK(quantity>0),
  unit_price numeric(12,2) NOT NULL CHECK(unit_price>=0),
  gross_minor bigint NOT NULL CHECK(gross_minor>=0),
  discount_minor bigint NOT NULL CHECK(discount_minor>=0 AND discount_minor<=gross_minor),
  net_minor bigint NOT NULL CHECK(net_minor=gross_minor-discount_minor),
  eligible boolean NOT NULL DEFAULT false,
  product_facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(snapshot_id,order_item_id),
  FOREIGN KEY(venue_id,snapshot_id,order_id) REFERENCES pos_order_pricing_snapshots(venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY(order_id,order_item_id) REFERENCES order_items(order_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS pos_order_pricing_snapshot_lines_item_idx ON pos_order_pricing_snapshot_lines(order_id,order_item_id);

CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot_line_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_item record; source_product record;
BEGIN
  SELECT oi.*,o.venue_id AS source_venue_id INTO source_item
    FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE oi.order_id=NEW.order_id AND oi.id=NEW.order_item_id;
  IF NOT FOUND OR source_item.source_venue_id IS DISTINCT FROM NEW.venue_id THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_line_source_missing_or_tenant_mismatch' USING ERRCODE='23514';
  END IF;
  SELECT p.* INTO source_product FROM products p
    WHERE p.id=source_item.product_id AND p.venue_id=NEW.venue_id;
  IF NOT FOUND
      OR NEW.quantity IS DISTINCT FROM source_item.quantity
      OR NEW.unit_price IS DISTINCT FROM source_item.unit_price
      OR NEW.seller_id IS DISTINCT FROM source_item.sales_employee_id
      OR NEW.sold_at IS DISTINCT FROM source_item.sold_at
      OR NEW.product_facts->>'productId' IS DISTINCT FROM source_item.product_id::text
      OR NEW.product_facts->>'productName' IS DISTINCT FROM source_product.name
      OR NEW.product_facts->>'category' IS DISTINCT FROM source_product.category
      OR NEW.product_facts->'productActive' IS DISTINCT FROM to_jsonb(source_product.is_active)
      OR NEW.product_facts->>'station' IS DISTINCT FROM source_item.station THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_line_source_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_line_source_validate ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_line_source_validate BEFORE INSERT ON pos_order_pricing_snapshot_lines FOR EACH ROW EXECUTE FUNCTION validate_pos_order_pricing_snapshot_line_source();

CREATE OR REPLACE FUNCTION guard_pos_order_pricing_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pos_order_pricing_snapshot_immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_immutable ON pos_order_pricing_snapshots;
CREATE TRIGGER pos_order_pricing_snapshot_immutable BEFORE UPDATE OR DELETE ON pos_order_pricing_snapshots FOR EACH ROW EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_no_truncate ON pos_order_pricing_snapshots;
CREATE TRIGGER pos_order_pricing_snapshot_no_truncate BEFORE TRUNCATE ON pos_order_pricing_snapshots FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_immutable ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_lines_immutable BEFORE UPDATE OR DELETE ON pos_order_pricing_snapshot_lines FOR EACH ROW EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_no_truncate ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_pricing_snapshot_lines_no_truncate BEFORE TRUNCATE ON pos_order_pricing_snapshot_lines FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_order_pricing_snapshot_immutable();

CREATE OR REPLACE FUNCTION guard_pos_order_item_after_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='UPDATE' AND (EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=OLD.order_id) OR EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=NEW.order_id)))
    OR (TG_OP='DELETE' AND EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=OLD.order_id))
    OR (TG_OP='INSERT' AND EXISTS (SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.order_id=NEW.order_id)) THEN
    RAISE EXCEPTION 'order_item_pricing_snapshot_locked' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_item_after_snapshot ON order_items;
CREATE TRIGGER pos_order_item_after_snapshot BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION guard_pos_order_item_after_snapshot();

CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_snapshot_id uuid; expected_count bigint; actual_count bigint; gross_sum bigint; discount_sum bigint; net_sum bigint; header pos_order_pricing_snapshots%ROWTYPE;
BEGIN
  v_snapshot_id := COALESCE(NEW.snapshot_id,OLD.snapshot_id);
  SELECT * INTO header FROM pos_order_pricing_snapshots s WHERE s.id=v_snapshot_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO expected_count FROM order_items WHERE order_id=header.order_id;
  SELECT count(*),COALESCE(sum(gross_minor),0),COALESCE(sum(discount_minor),0),COALESCE(sum(net_minor),0)
    INTO actual_count,gross_sum,discount_sum,net_sum FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=v_snapshot_id;
  IF actual_count<>expected_count OR gross_sum<>header.subtotal_minor OR discount_sum<>header.discount_minor OR net_sum<>header.subtotal_minor-header.discount_minor THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_lines_validate ON pos_order_pricing_snapshot_lines;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_lines_validate AFTER INSERT ON pos_order_pricing_snapshot_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_pos_order_pricing_snapshot();
CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_count bigint; actual_count bigint; gross_sum bigint; discount_sum bigint; net_sum bigint; eligible_ids uuid[];
BEGIN
  SELECT count(*) INTO expected_count FROM order_items WHERE order_id=NEW.order_id;
  SELECT count(*),COALESCE(sum(gross_minor),0),COALESCE(sum(discount_minor),0),COALESCE(sum(net_minor),0)
    INTO actual_count,gross_sum,discount_sum,net_sum FROM pos_order_pricing_snapshot_lines WHERE snapshot_id=NEW.id;
  SELECT COALESCE(array_agg(l.order_item_id ORDER BY l.order_item_id) FILTER(WHERE l.eligible),'{}'::uuid[]) INTO eligible_ids FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=NEW.id;
  IF actual_count<>expected_count OR gross_sum<>NEW.subtotal_minor OR discount_sum<>NEW.discount_minor OR net_sum<>NEW.subtotal_minor-NEW.discount_minor OR eligible_ids<>NEW.eligible_item_ids THEN
    RAISE EXCEPTION 'pos_order_pricing_snapshot_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_header_validate ON pos_order_pricing_snapshots;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_header_validate AFTER INSERT ON pos_order_pricing_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_pos_order_pricing_snapshot_header();
