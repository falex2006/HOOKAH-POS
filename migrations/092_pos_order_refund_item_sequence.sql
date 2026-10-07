-- Attested per-source ordering for POS item returns. Existing 091 rows remain unsequenced.
ALTER TABLE pos_order_item_return_balances
  ADD COLUMN IF NOT EXISTS return_sequence bigint NOT NULL DEFAULT 0;
ALTER TABLE pos_order_item_return_balances
  DROP CONSTRAINT IF EXISTS pos_order_item_return_balances_sequence_check;
ALTER TABLE pos_order_item_return_balances
  ADD CONSTRAINT pos_order_item_return_balances_sequence_check CHECK (return_sequence>=0);

ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS producer_sequence bigint;
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS previous_returned_quantity numeric(12,3);
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS cumulative_returned_quantity numeric(12,3);
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS previous_returned_item_value_minor bigint;
ALTER TABLE order_refund_items ADD COLUMN IF NOT EXISTS cumulative_returned_item_value_minor bigint;
ALTER TABLE order_refund_items
  DROP CONSTRAINT IF EXISTS order_refund_items_sequence_lineage_check;
ALTER TABLE order_refund_items
  ADD CONSTRAINT order_refund_items_sequence_lineage_check CHECK (
    (producer_sequence IS NULL
      AND previous_returned_quantity IS NULL
      AND cumulative_returned_quantity IS NULL
      AND previous_returned_item_value_minor IS NULL
      AND cumulative_returned_item_value_minor IS NULL)
    OR
    (producer_sequence IS NOT NULL AND producer_sequence>0
      AND previous_returned_quantity IS NOT NULL AND previous_returned_quantity>=0
      AND cumulative_returned_quantity IS NOT NULL
      AND previous_returned_item_value_minor IS NOT NULL AND previous_returned_item_value_minor>=0
      AND cumulative_returned_item_value_minor IS NOT NULL
      AND cumulative_returned_quantity=previous_returned_quantity+returned_quantity
      AND cumulative_returned_item_value_minor=previous_returned_item_value_minor+returned_item_value_minor)
  );
CREATE UNIQUE INDEX IF NOT EXISTS order_refund_items_source_sequence_uq
  ON order_refund_items (venue_id,snapshot_id,order_id,order_item_id,producer_sequence)
  WHERE producer_sequence IS NOT NULL;

-- Do not derive sequence from 091 created_at/id. Validate, but preserve, the existing aggregate baseline.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pos_order_pricing_snapshot_lines l
    LEFT JOIN pos_order_item_return_balances b
      ON b.venue_id=l.venue_id AND b.snapshot_id=l.snapshot_id AND b.order_id=l.order_id AND b.order_item_id=l.order_item_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(ri.returned_quantity),0) AS quantity,
        COALESCE(sum(ri.returned_item_value_minor),0) AS value_minor
      FROM order_refund_items ri
      WHERE ri.venue_id=l.venue_id AND ri.snapshot_id=l.snapshot_id AND ri.order_id=l.order_id AND ri.order_item_id=l.order_item_id
    ) e ON true
    WHERE b.order_item_id IS NULL
      OR b.returned_quantity<>e.quantity
      OR b.returned_item_value_minor<>e.value_minor
  ) THEN
    RAISE EXCEPTION 'pos_order_item_return_balance_legacy_reconciliation_failed' USING ERRCODE='23514';
  END IF;
END $$;

-- Replace the 091 writer with an ordered append-only producer. The balance row lock assigns
-- sequence and freezes both sides of the transition in the same transaction.
CREATE OR REPLACE FUNCTION validate_order_refund_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  refund_status text;
  header_created_at timestamptz;
  line record;
  previous_sequence bigint;
  previous_quantity numeric(12,3);
  previous_value bigint;
  next_quantity numeric(12,3);
  next_value bigint;
BEGIN
  SELECT item_attribution_status,created_at INTO refund_status,header_created_at
    FROM order_refunds WHERE venue_id=NEW.venue_id AND id=NEW.refund_id AND order_id=NEW.order_id;
  IF refund_status IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'order_refund_item_requires_complete_attribution' USING ERRCODE='23514';
  END IF;
  SELECT quantity,net_minor INTO line FROM pos_order_pricing_snapshot_lines
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_source_unavailable' USING ERRCODE='23514'; END IF;

  SELECT return_sequence,returned_quantity,returned_item_value_minor
    INTO previous_sequence,previous_quantity,previous_value
    FROM pos_order_item_return_balances
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order_refund_item_balance_unavailable' USING ERRCODE='23514'; END IF;
  next_quantity:=previous_quantity+NEW.returned_quantity;
  IF next_quantity>line.quantity THEN
    RAISE EXCEPTION 'order_refund_item_quantity_exceeds_remaining' USING ERRCODE='23514';
  END IF;
  next_value:=round(line.net_minor::numeric*next_quantity/line.quantity,0)::bigint;
  IF previous_value>next_value THEN
    RAISE EXCEPTION 'order_refund_item_value_reconciliation_failed' USING ERRCODE='23514';
  END IF;

  UPDATE pos_order_item_return_balances
    SET return_sequence=previous_sequence+1,
        returned_quantity=next_quantity,
        returned_item_value_minor=next_value
    WHERE venue_id=NEW.venue_id AND snapshot_id=NEW.snapshot_id AND order_id=NEW.order_id AND order_item_id=NEW.order_item_id;

  NEW.producer_sequence:=previous_sequence+1;
  NEW.previous_returned_quantity:=previous_quantity;
  NEW.cumulative_returned_quantity:=next_quantity;
  NEW.previous_returned_item_value_minor:=previous_value;
  NEW.cumulative_returned_item_value_minor:=next_value;
  NEW.returned_item_value_minor:=next_value-previous_value;
  NEW.created_at:=header_created_at;
  RETURN NEW;
END $$;

