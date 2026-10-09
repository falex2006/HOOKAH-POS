-- Immutable item-sale return facts. Actual cash/card/QR payout remains in 088.
ALTER TABLE order_refunds DROP CONSTRAINT IF EXISTS order_refunds_item_attribution_status_check;
ALTER TABLE order_refunds ADD CONSTRAINT order_refunds_item_attribution_status_check
  CHECK (item_attribution_status IN ('unattributed','complete','not_applicable'));

CREATE UNIQUE INDEX IF NOT EXISTS pos_order_pricing_snapshot_lines_return_source_uq
  ON pos_order_pricing_snapshot_lines (venue_id,snapshot_id,order_id,order_item_id);

CREATE TABLE IF NOT EXISTS pos_order_item_return_balances (
  venue_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  returned_quantity numeric(12,3) NOT NULL DEFAULT 0 CHECK (returned_quantity>=0),
  returned_item_value_minor bigint NOT NULL DEFAULT 0 CHECK (returned_item_value_minor>=0),
  PRIMARY KEY (venue_id,snapshot_id,order_id,order_item_id),
  FOREIGN KEY (venue_id,snapshot_id,order_id,order_item_id)
    REFERENCES pos_order_pricing_snapshot_lines (venue_id,snapshot_id,order_id,order_item_id) ON DELETE RESTRICT
);

-- This mutable row is a serialization/cap guard only. Append-only return rows remain the evidence.
-- The migration runner replays all files. Suspend only the balance-row guard for this
-- idempotent seed; the migration is applied atomically, then the guard is recreated below.
DROP TRIGGER IF EXISTS pos_order_item_return_balance_internal ON pos_order_item_return_balances;
INSERT INTO pos_order_item_return_balances (venue_id,snapshot_id,order_id,order_item_id)
SELECT venue_id,snapshot_id,order_id,order_item_id FROM pos_order_pricing_snapshot_lines
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION guard_pos_order_item_return_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' OR TG_OP='DELETE' OR pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'pos_order_item_return_balance_internal_only' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pos_order_item_return_balance_internal BEFORE INSERT OR UPDATE OR DELETE ON pos_order_item_return_balances
  FOR EACH ROW EXECUTE FUNCTION guard_pos_order_item_return_balance();
DROP TRIGGER IF EXISTS pos_order_item_return_balance_no_truncate ON pos_order_item_return_balances;
CREATE TRIGGER pos_order_item_return_balance_no_truncate BEFORE TRUNCATE ON pos_order_item_return_balances
  FOR EACH STATEMENT EXECUTE FUNCTION guard_pos_order_item_return_balance();

CREATE OR REPLACE FUNCTION seed_pos_order_item_return_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pos_order_item_return_balances (venue_id,snapshot_id,order_id,order_item_id)
  VALUES (NEW.venue_id,NEW.snapshot_id,NEW.order_id,NEW.order_item_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pos_order_item_return_balance_seed ON pos_order_pricing_snapshot_lines;
CREATE TRIGGER pos_order_item_return_balance_seed AFTER INSERT ON pos_order_pricing_snapshot_lines
  FOR EACH ROW EXECUTE FUNCTION seed_pos_order_item_return_balance();

CREATE TABLE IF NOT EXISTS order_refund_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL,
  refund_id uuid NOT NULL,
  order_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  returned_quantity numeric(12,3) NOT NULL CHECK (returned_quantity>0),
  returned_item_value_minor bigint NOT NULL CHECK (returned_item_value_minor>=0),
  return_policy_version integer NOT NULL DEFAULT 1 CHECK (return_policy_version=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id,id),
  UNIQUE (venue_id,refund_id,order_item_id),
  FOREIGN KEY (venue_id,refund_id,order_id)
    REFERENCES order_refunds (venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,snapshot_id,order_id)
    REFERENCES pos_order_pricing_snapshots (venue_id,id,order_id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id,snapshot_id,order_id,order_item_id)
    REFERENCES pos_order_pricing_snapshot_lines (venue_id,snapshot_id,order_id,order_item_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS order_refund_items_source_idx
  ON order_refund_items (venue_id,snapshot_id,order_item_id,created_at,id);
CREATE INDEX IF NOT EXISTS order_refund_items_refund_idx
  ON order_refund_items (venue_id,refund_id,created_at,id);

CREATE OR REPLACE FUNCTION guard_order_refund_item_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'order refund items are append-only' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS order_refund_items_immutable ON order_refund_items;
CREATE TRIGGER order_refund_items_immutable BEFORE UPDATE OR DELETE ON order_refund_items
  FOR EACH ROW EXECUTE FUNCTION guard_order_refund_item_mutation();
DROP TRIGGER IF EXISTS order_refund_items_no_truncate ON order_refund_items;
CREATE TRIGGER order_refund_items_no_truncate BEFORE TRUNCATE ON order_refund_items
  FOR EACH STATEMENT EXECUTE FUNCTION guard_order_refund_item_mutation();

CREATE OR REPLACE FUNCTION validate_order_refund_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE refund_status text; header_created_at timestamptz; line record; next_quantity numeric(12,3); next_value bigint;
BEGIN
  SELECT item_attribution_status,created_at INTO refund_status,header_created_at
    FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id AND order_id=NEW.order_id;
  IF refund_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'order_refund_item_requires_complete_attribution' USING ERRCODE='23514';
  END IF;
  SELECT quantity,net_minor INTO line FROM pos_order_pricing_snapshot_lines
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_source_unavailable' USING ERRCODE='23514'; END IF;
  UPDATE pos_order_item_return_balances b
    SET returned_quantity=b.returned_quantity+NEW.returned_quantity,
        returned_item_value_minor=round(line.net_minor::numeric*(b.returned_quantity+NEW.returned_quantity)/line.quantity,0)::bigint
    WHERE b.venue_id=NEW.venue_id AND b.snapshot_id=NEW.snapshot_id AND b.order_id=NEW.order_id AND b.order_item_id=NEW.order_item_id
      AND b.returned_quantity+NEW.returned_quantity<=line.quantity
    RETURNING b.returned_quantity,b.returned_item_value_minor INTO next_quantity,next_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_quantity_exceeds_remaining' USING ERRCODE='23514'; END IF;
  NEW.returned_item_value_minor:=next_value-round(line.net_minor::numeric*(next_quantity-NEW.returned_quantity)/line.quantity,0)::bigint;
  NEW.created_at:=header_created_at;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_refund_items_validate_insert ON order_refund_items;
CREATE TRIGGER order_refund_items_validate_insert BEFORE INSERT ON order_refund_items
  FOR EACH ROW EXECUTE FUNCTION validate_order_refund_item_insert();

CREATE OR REPLACE FUNCTION validate_order_refund_item_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_count bigint; has_snapshot boolean;
BEGIN
  SELECT count(*) INTO item_count FROM order_refund_items WHERE venue_id=NEW.venue_id AND refund_id=NEW.id;
  SELECT EXISTS(SELECT 1 FROM pos_order_pricing_snapshots s WHERE s.venue_id=NEW.venue_id AND s.order_id=NEW.order_id) INTO has_snapshot;
  IF (NEW.item_attribution_status='complete' AND item_count=0)
      OR (NEW.item_attribution_status='unattributed' AND item_count>0)
      OR (NEW.item_attribution_status='not_applicable' AND (item_count>0 OR NOT has_snapshot)) THEN
    RAISE EXCEPTION 'order_refund_item_attribution_reconciliation_failed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS order_refund_item_attribution_validate ON order_refunds;
CREATE CONSTRAINT TRIGGER order_refund_item_attribution_validate AFTER INSERT ON order_refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_order_refund_item_attribution();

-- Verify the 090 evaluator's deterministic largest-remainder allocation at the database boundary.
CREATE OR REPLACE FUNCTION validate_pos_order_pricing_snapshot_allocations(p_snapshot_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE header pos_order_pricing_snapshots%ROWTYPE; mismatch boolean;
BEGIN
  SELECT * INTO header FROM pos_order_pricing_snapshots WHERE id=p_snapshot_id;
  IF NOT FOUND THEN RETURN; END IF;
  WITH raw AS (
    SELECT l.order_item_id,l.gross_minor,l.discount_minor,l.eligible,
      l.quantity*l.unit_price*100 AS exact_gross,
      floor(l.quantity*l.unit_price*100)::bigint AS floor_gross
    FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=p_snapshot_id
  ), ranked AS (
    SELECT r.*,row_number() OVER (ORDER BY (exact_gross-floor_gross) DESC,order_item_id) AS gross_rank,
      sum(floor_gross) OVER () AS floor_total
    FROM raw r
  )
  SELECT EXISTS(SELECT 1 FROM ranked r WHERE r.gross_minor<>r.floor_gross+CASE WHEN r.gross_rank<=header.subtotal_minor-r.floor_total THEN 1 ELSE 0 END)
    INTO mismatch;
  IF mismatch THEN RAISE EXCEPTION 'pos_order_pricing_snapshot_gross_allocation_mismatch' USING ERRCODE='23514'; END IF;
  WITH raw AS (
    SELECT l.order_item_id,l.discount_minor,l.eligible,l.gross_minor,
      sum(l.gross_minor) FILTER (WHERE l.eligible) OVER () AS eligible_total
    FROM pos_order_pricing_snapshot_lines l WHERE l.snapshot_id=p_snapshot_id
  ), parts AS (
    SELECT r.*,CASE WHEN eligible AND eligible_total>0 THEN floor(header.discount_minor::numeric*gross_minor/eligible_total)::bigint ELSE 0::bigint END AS floor_discount,
      CASE WHEN eligible AND eligible_total>0 THEN mod(header.discount_minor::numeric*gross_minor,eligible_total)::bigint ELSE 0::bigint END AS discount_remainder
    FROM raw r
  ), ranked AS (
    SELECT p.*,row_number() OVER (ORDER BY CASE WHEN eligible THEN discount_remainder END DESC NULLS LAST,order_item_id) AS discount_rank,
      sum(floor_discount) OVER () AS floor_total
    FROM parts p
  )
  SELECT EXISTS(SELECT 1 FROM ranked r WHERE r.discount_minor<>r.floor_discount+CASE WHEN r.eligible AND r.discount_rank<=header.discount_minor-r.floor_total THEN 1 ELSE 0 END)
    INTO mismatch;
  IF mismatch THEN RAISE EXCEPTION 'pos_order_pricing_snapshot_discount_allocation_mismatch' USING ERRCODE='23514'; END IF;
END $$;

CREATE OR REPLACE FUNCTION trigger_validate_pos_order_pricing_snapshot_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='pos_order_pricing_snapshots' THEN
    PERFORM validate_pos_order_pricing_snapshot_allocations(NEW.id);
  ELSE
    PERFORM validate_pos_order_pricing_snapshot_allocations(NEW.snapshot_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_allocations_header_validate ON pos_order_pricing_snapshots;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_allocations_header_validate AFTER INSERT ON pos_order_pricing_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trigger_validate_pos_order_pricing_snapshot_allocations();
DROP TRIGGER IF EXISTS pos_order_pricing_snapshot_allocations_lines_validate ON pos_order_pricing_snapshot_lines;
CREATE CONSTRAINT TRIGGER pos_order_pricing_snapshot_allocations_lines_validate AFTER INSERT ON pos_order_pricing_snapshot_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trigger_validate_pos_order_pricing_snapshot_allocations();
