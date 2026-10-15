-- Add optimistic concurrency metadata to template bindings without changing
-- existing targets, priorities, or active states. Safe to replay.
ALTER TABLE staff_schedule_template_bindings
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE staff_schedule_template_bindings
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'staff_schedule_template_bindings'::regclass
      AND conname = 'staff_schedule_template_bindings_version_positive_check'
  ) THEN
    ALTER TABLE staff_schedule_template_bindings
      ADD CONSTRAINT staff_schedule_template_bindings_version_positive_check
      CHECK (version > 0);
  END IF;
END $$;
