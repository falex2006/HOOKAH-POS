-- Optional recurring local-time window for a table's minimum order amount.
-- NULL/NULL preserves the previous always-on behavior.
ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS minimum_order_start_time time,
  ADD COLUMN IF NOT EXISTS minimum_order_end_time time;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='tables'::regclass AND conname='tables_minimum_order_schedule_pair_check'
  ) THEN
    ALTER TABLE tables ADD CONSTRAINT tables_minimum_order_schedule_pair_check
      CHECK ((minimum_order_start_time IS NULL) = (minimum_order_end_time IS NULL)
        AND (minimum_order_start_time IS NULL OR minimum_order_start_time <> minimum_order_end_time));
  END IF;
END $$;
