-- Freeze redemption settings when an order is opened; capture the due base on first bonus tender.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS loyalty_redemption_policy_version integer,
  ADD COLUMN IF NOT EXISTS loyalty_redemption_rate numeric(8,4),
  ADD COLUMN IF NOT EXISTS loyalty_redemption_cap_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS loyalty_redemption_min_points integer,
  ADD COLUMN IF NOT EXISTS loyalty_redemption_base numeric(12,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_loyalty_redemption_snapshot_check' AND conrelid='orders'::regclass) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_loyalty_redemption_snapshot_check CHECK (
      (loyalty_redemption_policy_version IS NULL AND loyalty_redemption_rate IS NULL AND loyalty_redemption_cap_percent IS NULL AND loyalty_redemption_min_points IS NULL AND loyalty_redemption_base IS NULL)
      OR (loyalty_redemption_policy_version >= 0 AND loyalty_redemption_rate > 0 AND loyalty_redemption_cap_percent BETWEEN 0 AND 100 AND loyalty_redemption_min_points >= 1 AND loyalty_redemption_base >= 0)
    );
  END IF;
END $$;
