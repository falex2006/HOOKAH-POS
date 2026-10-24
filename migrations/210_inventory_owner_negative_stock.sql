ALTER TABLE ingredients
  ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT false;

-- Inventory can be negative only through owner-authorized sales. Purchase
-- snapshots must therefore be able to record a negative before/after balance.
ALTER TABLE inventory_purchase_document_lines
  DROP CONSTRAINT IF EXISTS inventory_purchase_line_reversal_snapshot_check;

ALTER TABLE inventory_purchase_document_lines
  ADD CONSTRAINT inventory_purchase_line_reversal_snapshot_check
  CHECK ((on_hand_before_snapshot IS NULL AND cost_before_snapshot IS NULL AND on_hand_after_snapshot IS NULL AND cost_after_snapshot IS NULL AND movement_version_before_snapshot IS NULL AND movement_version_after_snapshot IS NULL)
      OR (cost_before_snapshot >= 0 AND on_hand_after_snapshot > on_hand_before_snapshot AND cost_after_snapshot >= 0 AND movement_version_before_snapshot >= 0 AND movement_version_after_snapshot = movement_version_before_snapshot + 1));
