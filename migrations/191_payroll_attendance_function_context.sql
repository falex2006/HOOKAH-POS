-- Preserve the scheduled work-function context in each immutable payroll
-- attendance approval. This is descriptive context only: it is not a POS
-- department/station or proof of a sale.
ALTER TABLE payroll_attendance_approval_shifts
  ADD COLUMN IF NOT EXISTS scheduled_function_id_snapshot uuid,
  ADD COLUMN IF NOT EXISTS scheduled_function_name_snapshot text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='payroll_attendance_approval_shifts'::regclass
      AND conname='payroll_attendance_function_context_pair_check') THEN
    ALTER TABLE payroll_attendance_approval_shifts
      ADD CONSTRAINT payroll_attendance_function_context_pair_check
      CHECK ((scheduled_function_id_snapshot IS NULL AND scheduled_function_name_snapshot IS NULL)
        OR (scheduled_function_id_snapshot IS NOT NULL AND scheduled_function_name_snapshot IS NOT NULL
          AND length(btrim(scheduled_function_name_snapshot)) BETWEEN 1 AND 80));
  END IF;
END $$;

COMMENT ON COLUMN payroll_attendance_approval_shifts.scheduled_function_id_snapshot IS
  'Opaque scheduled work-function ID captured by payroll; not a payroll role, POS department, or station.';
COMMENT ON COLUMN payroll_attendance_approval_shifts.scheduled_function_name_snapshot IS
  'Name of the scheduled work function at approval time; descriptive payroll context only.';
