-- Orders capture the active redemption version when opened; the due base is captured on first redemption.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_loyalty_redemption_snapshot_check;
ALTER TABLE orders ADD CONSTRAINT orders_loyalty_redemption_snapshot_check CHECK (
  (loyalty_redemption_policy_version IS NULL AND loyalty_redemption_rate IS NULL AND loyalty_redemption_cap_percent IS NULL AND loyalty_redemption_min_points IS NULL AND loyalty_redemption_base IS NULL)
  OR (
    loyalty_redemption_policy_version IS NOT NULL AND loyalty_redemption_policy_version >= 0
    AND loyalty_redemption_rate IS NOT NULL AND loyalty_redemption_rate > 0
    AND loyalty_redemption_cap_percent IS NOT NULL AND loyalty_redemption_cap_percent BETWEEN 0 AND 100
    AND loyalty_redemption_min_points IS NOT NULL AND loyalty_redemption_min_points >= 1
    AND (loyalty_redemption_base IS NULL OR loyalty_redemption_base >= 0)
  )
);
