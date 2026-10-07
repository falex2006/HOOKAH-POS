ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS selected_promotion_id uuid,
  ADD COLUMN IF NOT EXISTS selected_promotion_version integer,
  ADD COLUMN IF NOT EXISTS selected_promotion_name text,
  ADD COLUMN IF NOT EXISTS selected_promotion_benefit_kind text,
  ADD COLUMN IF NOT EXISTS selected_promotion_benefit_value numeric(10,2),
  ADD COLUMN IF NOT EXISTS selected_promotion_basis numeric(12,2),
  ADD COLUMN IF NOT EXISTS selected_promotion_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS pricing_offers_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_effective_discount_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_effective_discount_source_check
  CHECK (effective_discount_source IN ('none','guest_group','manual','promotion'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_selected_promotion_version_fk' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_selected_promotion_version_fk
      FOREIGN KEY (venue_id,selected_promotion_id,selected_promotion_version)
      REFERENCES loyalty_promotions (venue_id,promotion_id,version) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_promotion_pricing_snapshot_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_promotion_pricing_snapshot_check CHECK (
      (selected_promotion_id IS NULL AND selected_promotion_version IS NULL AND selected_promotion_name IS NULL
        AND selected_promotion_benefit_kind IS NULL AND selected_promotion_benefit_value IS NULL
        AND selected_promotion_basis IS NULL AND selected_promotion_amount IS NULL)
      OR (selected_promotion_id IS NOT NULL AND selected_promotion_version > 0 AND length(btrim(selected_promotion_name)) > 0
        AND selected_promotion_benefit_kind IN ('percent','fixed') AND selected_promotion_benefit_value > 0
        AND selected_promotion_basis >= 0 AND selected_promotion_amount >= 0 AND selected_promotion_amount <= selected_promotion_basis)
    );
  END IF;
END $$;
