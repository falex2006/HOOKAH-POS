ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS group_discount_group_id uuid,
  ADD COLUMN IF NOT EXISTS group_discount_name text,
  ADD COLUMN IF NOT EXISTS group_discount_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS group_discount_base numeric(12,2),
  ADD COLUMN IF NOT EXISTS group_discount_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS effective_discount_source text,
  ADD COLUMN IF NOT EXISTS subtotal_snapshot numeric(12,2),
  ADD COLUMN IF NOT EXISTS discount_total_snapshot numeric(12,2),
  ADD COLUMN IF NOT EXISTS minimum_adjustment_snapshot numeric(12,2),
  ADD COLUMN IF NOT EXISTS final_total_snapshot numeric(12,2),
  ADD COLUMN IF NOT EXISTS pricing_version smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_group_discount_percent_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_group_discount_percent_check CHECK (group_discount_percent BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_group_discount_amount_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_group_discount_amount_check CHECK (
      (group_discount_base IS NULL AND group_discount_amount IS NULL)
      OR (group_discount_base IS NOT NULL AND group_discount_amount IS NOT NULL
        AND group_discount_base >= 0 AND group_discount_amount >= 0 AND group_discount_amount <= group_discount_base)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_effective_discount_source_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_effective_discount_source_check CHECK (effective_discount_source IN ('none','guest_group','manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_pricing_snapshot_nonnegative_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_pricing_snapshot_nonnegative_check CHECK (
      (subtotal_snapshot IS NULL OR subtotal_snapshot >= 0)
      AND (discount_total_snapshot IS NULL OR discount_total_snapshot >= 0)
      AND (minimum_adjustment_snapshot IS NULL OR minimum_adjustment_snapshot >= 0)
      AND (final_total_snapshot IS NULL OR final_total_snapshot >= 0)
      AND (pricing_version IS NULL OR pricing_version > 0)
    );
  END IF;
END
$$;
