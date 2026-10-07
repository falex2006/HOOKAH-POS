-- Snapshot loyalty accrual inputs/results at successful full order settlement.
-- NULL remains the truthful state for historical orders whose program terms
-- cannot be reconstructed; new closures store zero when no bonus applies.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_bonus_percent numeric(5,2)
  CHECK (loyalty_bonus_percent BETWEEN 0 AND 100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_bonus_base numeric(12,2)
  CHECK (loyalty_bonus_base >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_bonus_earned int
  CHECK (loyalty_bonus_earned >= 0);
